#!/usr/bin/env python3
"""Build golden_quotes.json from combined_corpus.json.

Filters songs with popularity >= 90, deduplicates by (title, artist),
cleans lyrics, and heuristically picks 1-3 golden quote lines per song.
Consecutive selected lines are merged into a single quote object.
"""

import json, re, os
from collections import defaultdict, Counter
from pathlib import Path

CORPUS = Path(__file__).parent.parent / "combined_corpus.json"
OUT = Path(__file__).parent / "data" / "golden_quotes.json"

# ── Metadata line detection ──────────────────────────────────────────
META_RE = re.compile(
    r"^\s*("
    r"作词|作曲|编曲|监制|制作人?|录音|混音|母带|弦乐|配唱|和声|"
    r"鼓\s|键盘|吉他|贝斯|贝司|低音|钢琴|小提琴|中提琴|大提琴|长笛|短笛|"
    r"小号|圆号|木管|铜管|打击|定音|竖琴|电子|合成|萨克斯|"
    r"第一小提|第二小提|"
    r"OP\s|SP\s|词\s*[：:]|曲\s*[：:]|唱\s*[：:]|"
    r"Lyric|Music|Produc|Arrang|Record|Mix|Master|Vocal|Choir|"
    r"String|Guitar|Bass|Drum|Piano|Violin|Keyboard|Saxophone|"
    r"Trumpet|Horn|Flute|Percussion|Synth|Program"
    r")",
    re.IGNORECASE,
)

CREDIT_LINE_RE = re.compile(r"^[^，。！？…]+[：:]\s*\S+$")

FILLER_RE = re.compile(
    r"^[\s啊呀哦噢嗯哼唔喔啦嘿嘻哈呜耶"
    r"la|na|da|oh|ah|uh|hey|yeah|ya|wo|oo|mm|hm|ha|ho"
    r"\s~～…·\.\-,，。！？!?；;：:\s]+$",
    re.IGNORECASE,
)


def is_meta(line: str) -> bool:
    s = line.strip()
    if not s:
        return True
    if META_RE.match(s):
        return True
    if CREDIT_LINE_RE.match(s) and len(s) < 60 and not any(c in s for c in "，。！？…"):
        return True
    return False


def is_filler(line: str) -> bool:
    s = line.strip()
    if len(s) < 2:
        return True
    if FILLER_RE.match(s):
        return True
    return False


def clean_lyrics(raw: str) -> list[str]:
    lines = raw.split("\n")
    cleaned = []
    for line in lines:
        s = line.strip()
        if not s:
            continue
        if is_meta(s):
            continue
        if is_filler(s):
            continue
        cleaned.append(s)
    return cleaned


def score_line(line: str, freq: int) -> float:
    length = len(line)
    score = 0.0

    if 10 <= length <= 25:
        score += 3.0
    elif 8 <= length <= 30:
        score += 2.0
    elif 6 <= length <= 40:
        score += 1.0
    elif length < 6:
        score -= 2.0

    if freq > 2:
        score -= 3.0
    elif freq > 1:
        score -= 1.0

    if line.endswith(("的", "了", "着", "过", "吧", "吗", "呢", "啊", "呀")):
        score -= 0.5

    contrast_pairs = [
        ("爱", "恨"), ("生", "死"), ("来", "去"), ("有", "无"),
        ("笑", "哭"), ("聚", "散"), ("得", "失"), ("真", "假"),
        ("梦", "醒"), ("远", "近"), ("深", "浅"), ("轻", "重"),
        ("始", "终"), ("黑", "白"), ("冷", "暖"),
    ]
    for a, b in contrast_pairs:
        if a in line and b in line:
            score += 1.5
            break

    if "？" in line or "?" in line:
        score += 0.5

    if "不过是" in line or "原来" in line or "如果" in line or "最怕" in line:
        score += 0.5
    if "谁" in line and ("？" in line or "?" in line):
        score += 0.5

    return score


def pick_quotes(lyrics: list[str], max_quotes: int = 3) -> list[int]:
    if not lyrics:
        return []

    freq = Counter(lyrics)
    scored = [(i, score_line(line, freq[line])) for i, line in enumerate(lyrics)]
    scored.sort(key=lambda x: -x[1])

    picked = []
    picked_set = set()
    for idx, sc in scored:
        if sc < 0:
            break
        if any(abs(idx - p) <= 1 for p in picked_set):
            continue
        picked.append(idx)
        picked_set.add(idx)
        if len(picked) >= max_quotes:
            break

    return sorted(picked)


def merge_consecutive(indices: list[int]) -> list[list[int]]:
    if not indices:
        return []
    groups = []
    current = [indices[0]]
    for i in indices[1:]:
        if i == current[-1] + 1:
            current.append(i)
        else:
            groups.append(current)
            current = [i]
    groups.append(current)
    return groups


def main():
    with open(CORPUS, "r", encoding="utf-8") as f:
        data = json.load(f)

    candidates = [d for d in data if (d.get("popularity") or 0) >= 90]

    groups: dict[tuple, list] = defaultdict(list)
    for d in candidates:
        key = (d["title"].strip(), d["artist_primary"].strip())
        groups[key].append(d)

    songs = []
    for (title, artist), items in groups.items():
        with_year = [i for i in items if i.get("album_year")]
        best = min(with_year, key=lambda x: x["album_year"]) if with_year else items[0]

        raw_lyric = best.get("lyric", "")
        lyrics = clean_lyrics(raw_lyric)
        if not lyrics:
            continue

        quote_indices = pick_quotes(lyrics)
        quote_groups = merge_consecutive(quote_indices)
        quotes = []
        for grp in quote_groups:
            text = "\n".join(lyrics[i] for i in grp)
            quotes.append({"lines": grp, "text": text})

        lyricist = best.get("lyricist", "")
        if not lyricist:
            cred = best.get("credits", {})
            lyricist = cred.get("作词", cred.get("词", ""))

        songs.append({
            "id": best["song_id"],
            "title": best["title"],
            "artist": best["artist_primary"],
            "lyricist": lyricist,
            "year": best.get("album_year"),
            "popularity": best["popularity"],
            "lyrics": lyrics,
            "quotes": quotes,
        })

    songs.sort(key=lambda x: (-x["popularity"], x["title"]))

    os.makedirs(OUT.parent, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(songs, f, ensure_ascii=False, indent=2)

    total_quotes = sum(len(s["quotes"]) for s in songs)
    print(f"Done: {len(songs)} songs, {total_quotes} quotes → {OUT}")


if __name__ == "__main__":
    main()
