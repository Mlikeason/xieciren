"""
Build a unified, deduplicated corpus from:
  - 25 lyricist JSONs (~14k songs, rich metadata + NetEase cover URLs)
  - lyrics.db (~143k songs from ci_ziv, no covers, no year)

Outputs:
  data/corpus.json     -- single array of song records (see SCHEMA below)
  data/lyricists.json  -- 25 featured-lyricist meta for the chip filter

Dedup key: norm(title) + "|" + norm(artist).
Lyricist JSONs win over ci_ziv when keys collide.
"""

from __future__ import annotations

import gzip
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # ~/lyrical/lyrics
OUT = Path(__file__).resolve().parent / "data"
OUT.mkdir(exist_ok=True)

# slug -> Chinese name for the 25 lyricist JSONs
LYRICIST_MAP = {
    "linxi": "林夕",
    "wyman": "黄伟文",
    "fangwenshan": "方文山",
    "yaohqian": "姚谦",
    "yaoruolong": "姚若龙",
    "linzhenqiang": "林振强",
    "chenshaoqi": "陈少琪",
    "zhouyaohui": "周耀辉",
    "lizongsheng": "李宗盛",
    "lizhuoxiong": "李焯雄",
    "liuzhuohui": "刘卓辉",
    "luodayou": "罗大佑",
    "panyuanliang": "潘源良",
    "shirencheng": "施人诚",
    "xiangxuehuai": "向雪怀",
    "yijiayang": "易家扬",
    "zhengguojiang": "郑国江",
    "gedawei": "葛大为",
    "guqianmin": "古倩敏",
    "jianning": "简宁",
    "linruoning": "林若宁",
    "chenyongqian": "陈咏谦",
    # 以下三个不是词人 JSON，是按歌手抓的
    "eason": "(歌手) 陈奕迅",
    "jay": "(歌手) 周杰伦",
    "liming": "(歌手) 黎明",
}

# LRC timestamp like [01:29.00] or [00:32]
LRC_TS_RE = re.compile(r"\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]")
# Credit-style line: starts with a known role label, anywhere in the lyric
CREDIT_LINE_RE = re.compile(
    r"^\s*("
    r"作词|作曲|编曲|监制|制作人?|出品人?|和[声音]|混音|录音|母带|"
    r"吉他|贝斯|鼓|键盘|弦乐|合声|唱片|发行|策划|统筹|经纪|文案|"
    r"配唱录音师|过带录音师|混音录音师|混音师|录音师|"
    r"Producer|Mix|Mixing|Mastering|Vocal[s]?|Guitar|Bass|Drum[s]?|"
    r"Keyboard|Synth|Arrange[r]?|String[s]?|Compose[r]?|Lyric[s]?|"
    r"OP|SP|SOLO|MV|Recording"
    r")\s*[:：.]"
)


def norm(s: str) -> str:
    if not s:
        return ""
    # lower, strip whitespace including full-width, drop common bracketed suffixes
    s = re.sub(r"[\(\（].*?[\)\）]", "", s)  # drop (live), (Demo), etc.
    s = re.sub(r"\s+|　", "", s)
    return s.lower().strip()


def split_credits(s) -> list[str]:
    if not s:
        return []
    if isinstance(s, list):
        return [x for x in s if x]
    parts = re.split(r"[/、,，&\+]", str(s))
    return [p.strip() for p in parts if p.strip()]


def strip_lrc_header(lyric: str) -> str:
    if not lyric:
        return ""
    # remove LRC timestamps anywhere
    lyric = LRC_TS_RE.sub("", lyric)
    # remove any credit-style line (not just leading ones)
    kept = [ln for ln in lyric.split("\n") if not CREDIT_LINE_RE.match(ln)]
    body = "\n".join(kept)
    # collapse 3+ blank lines, trim
    body = re.sub(r"\n{3,}", "\n\n", body).strip()
    return body or lyric.strip()


def parse_credit_field(credits, key: str) -> list:
    """`credits` may be a dict (most JSONs) or a Python-repr str (legacy)."""
    if not credits:
        return []
    if isinstance(credits, dict):
        return split_credits(credits.get(key))
    if isinstance(credits, str):
        m = re.search(rf"'{key}'\s*:\s*'([^']*)'", credits)
        return split_credits(m.group(1)) if m else []
    return []


def load_lyricist_json(path: Path, slug: str) -> list[dict]:
    """Convert one lyricist JSON to corpus records."""
    feature = LYRICIST_MAP.get(slug, slug)
    with path.open("r", encoding="utf-8") as f:
        rows = json.load(f)
    out = []
    for r in rows:
        title = (r.get("title") or "").strip()
        artist = (r.get("artist_primary") or "").strip()
        if not title or not artist:
            continue
        credits = r.get("credits") or ""
        lyricists = parse_credit_field(credits, "作词")
        if not lyricists:
            # If this JSON was curated by a known lyricist, attribute to them.
            if not feature.startswith("("):  # exclude (歌手) Xs
                lyricists = [feature]
        composers = parse_credit_field(credits, "作曲")
        try:
            pop = float(r.get("popularity") or 0)
        except (TypeError, ValueError):
            pop = 0.0
        out.append({
            "id": f"ne:{r.get('song_id','')}",
            "title": title,
            "artist": artist,
            "album": (r.get("album_name") or "").strip(),
            "year": (str(r.get("album_year") or "")).strip() or None,
            "lyricists": lyricists,
            "composers": composers,
            "lyrics": strip_lrc_header(r.get("lyric") or ""),
            "cover_url": (r.get("album_cover_url") or "").strip() or None,
            "popularity": pop,
            "source": "netease",
            "feature": feature if not feature.startswith("(") else None,
        })
    return out


MIN_LYRIC_LEN = 30
MAX_LYRIC_LEN = 5000


def load_ciziv(db_path: Path) -> list:
    """Pull rows from lyrics.db; drop noise, cap very-long lyrics."""
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    cur = con.execute("""
        SELECT s.id, s.title, s.lyrics, s.lyricists, s.composers,
               a.name AS artist, al.name_clean AS album
        FROM songs s
        JOIN artists a  ON a.id = s.artist_id
        LEFT JOIN albums al ON al.id = s.album_id
        WHERE s.has_lyrics = 1 AND s.title != '' AND a.name != ''
    """)
    out = []
    for r in cur:
        lyric = r["lyrics"] or ""
        # drop ci_ziv noise: too-short lyrics are often just "instrumental" markers
        if len(re.sub(r"\s", "", lyric)) < MIN_LYRIC_LEN:
            continue
        if len(lyric) > MAX_LYRIC_LEN:
            lyric = lyric[:MAX_LYRIC_LEN] + "\n…"
        try:
            lyricists = json.loads(r["lyricists"] or "[]")
        except Exception:
            lyricists = []
        try:
            composers = json.loads(r["composers"] or "[]")
        except Exception:
            composers = []
        out.append({
            "id": f"cz:{r['id']}",
            "title": r["title"].strip(),
            "artist": r["artist"].strip(),
            "album": (r["album"] or "").strip(),
            "year": None,
            "lyricists": lyricists,
            "composers": composers,
            "lyrics": lyric,
            "cover_url": None,
            "popularity": 0.0,
            "source": "ciziv",
            "feature": None,
        })
    con.close()
    return out


def main() -> None:
    t0 = time.time()
    seen: dict[str, dict] = {}
    counts: dict[str, int] = {}

    # 1) lyricist JSONs (richer data wins)
    lyricist_files = sorted(ROOT.glob("*_lyrics.json"))
    for f in lyricist_files:
        slug = f.stem.replace("_lyrics", "")
        recs = load_lyricist_json(f, slug)
        added = 0
        for rec in recs:
            key = norm(rec["title"]) + "|" + norm(rec["artist"])
            if not key.strip("|"):
                continue
            if key in seen:
                # Merge feature lyricist (a song may appear in multiple lyricist
                # JSONs, e.g. a 林夕+黄伟文 co-write). Keep first record but accumulate features.
                ex = seen[key]
                if rec.get("feature"):
                    feats = ex.get("features") or ([ex["feature"]] if ex.get("feature") else [])
                    if rec["feature"] not in feats:
                        feats.append(rec["feature"])
                    ex["features"] = feats
                continue
            if rec.get("feature"):
                rec["features"] = [rec["feature"]]
            seen[key] = rec
            added += 1
        counts[slug] = added
        print(f"  + {f.name:35s} new: {added:5d}  total: {len(seen):6d}")

    netease_count = len(seen)

    # 2) ci_ziv fallback
    db_path = ROOT / "lyrics.db"
    print(f"loading {db_path.name} …")
    ciziv = load_ciziv(db_path)
    ciziv_added = 0
    for rec in ciziv:
        key = norm(rec["title"]) + "|" + norm(rec["artist"])
        if not key.strip("|"):
            continue
        if key in seen:
            continue
        seen[key] = rec
        ciziv_added += 1
    print(f"  + lyrics.db                            new: {ciziv_added:5d}  total: {len(seen):6d}")

    # 3) finalize: drop the bookkeeping `feature`, drop empty-valued keys
    KEEP_IF_TRUTHY = {"album", "year", "lyricists", "composers",
                      "cover_url", "popularity", "features"}
    curated = []  # netease (richer, faster to load)
    extra = []   # ci_ziv (massive, lazy-loaded)
    for rec in seen.values():
        rec.pop("feature", None)
        clean = {}
        for k, v in rec.items():
            if k in KEEP_IF_TRUTHY and not v:
                continue
            clean[k] = v
        if clean.get("source") == "netease":
            curated.append(clean)
        else:
            extra.append(clean)

    # 4) write outputs
    def dump_and_measure(path: Path, data) -> tuple:
        with path.open("w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        raw = path.stat().st_size
        with path.open("rb") as f:
            gz = gzip.compress(f.read(), compresslevel=6)
        # write a .gz alongside so static hosts that don't auto-gzip can serve it
        path.with_suffix(path.suffix + ".gz").write_bytes(gz)
        return raw, len(gz)

    c_raw, c_gz = dump_and_measure(OUT / "corpus.json", curated)
    e_raw, e_gz = dump_and_measure(OUT / "corpus_extra.json", extra)

    # lyricist meta (for the chip filter — only featured/curated lyricists)
    lyricist_meta = []
    for slug, name in LYRICIST_MAP.items():
        if name.startswith("("):
            continue
        n = sum(1 for r in curated if r.get("features") and name in r["features"])
        lyricist_meta.append({"slug": slug, "name": name, "count": n})
    lyricist_meta.sort(key=lambda x: -x["count"])
    with (OUT / "lyricists.json").open("w", encoding="utf-8") as f:
        json.dump(lyricist_meta, f, ensure_ascii=False, indent=2)

    # global stats — count all distinct lyricist names across the WHOLE corpus.
    # ci_ziv has noisy lyricist strings (e.g. blanks, "佚名", "?"), filter those.
    all_lyricists = set()
    NOISE = {"", "未知", "佚名", "无", "无名", "-", "—", "/", "??", "?", "..", "...", "Unknown"}
    for rec in curated + extra:
        for name in rec.get("lyricists") or []:
            name = name.strip()
            if not name or name in NOISE or len(name) > 30:
                continue
            all_lyricists.add(name)
    stats = {
        "totalSongs": len(curated) + len(extra),
        "lyricistsCount": len(all_lyricists),
    }
    with (OUT / "stats.json").open("w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)

    print()
    print(f"curated (netease): {len(curated):6d}  "
          f"{c_raw/1024/1024:.1f} MB  (gzip {c_gz/1024/1024:.1f} MB)")
    print(f"extra   (ci_ziv) : {len(extra):6d}  "
          f"{e_raw/1024/1024:.1f} MB  (gzip {e_gz/1024/1024:.1f} MB)")
    print(f"total            : {len(curated)+len(extra):6d}")
    print(f"distinct lyricists: {len(all_lyricists):6d}")
    print(f"elapsed          : {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
