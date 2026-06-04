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

import opencc
_T2S = opencc.OpenCC("t2s")


def _to_simplified(name: str) -> str:
    return _T2S.convert(name)

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

# ── Credit-line detection ──────────────────────────────────────
_CREDIT_LABELS = {
    "词", "曲", "编", "监", "詞", "編", "監", "编曲", "編曲", "监制", "監製",
    "作词", "作曲", "作詞", "填词", "填詞", "词曲", "曲/编", "曲/编/监",
    "编曲/监制", "作词人", "作曲人", "填词人", "编曲人",
    "词Lyrics", "曲Composer", "编曲Arranger", "编曲 Arranger", "编曲 Arrangement",
    "作 曲", "作曲/编", "作曲 / 编曲", "作曲．编曲",
    "Rap词", "Rap作词", "rap作词人", "RAP词/曲",
    "英文词", "改编词", "原词", "改编", "谱曲", "重新编曲",
    "唱", "原唱", "翻唱", "演唱", "演唱者", "主唱", "歌手",
    "演 唱", "合 唱", "合唱",
    "制作人", "执行制作", "制作助理", "制作协力",
    "配唱制作人", "配唱制作", "配唱编写", "声乐指导", "演唱设计",
    "音乐制作", "音乐制作人", "音乐制作助理", "音乐制作发行",
    "音乐总监", "音乐监制", "出品监制", "监制/制作人",
    "录音室", "录音工程", "录音工程师", "录音师", "录音棚", "录音工作室",
    "录音混音", "录音助理", "录音及混音工程师", "录音工程室",
    "混音室", "混音工程", "混音工程师", "混音师", "混音助理", "混音录音室",
    "混音工作室", "混音/母带", "混音&母带", "混音&母带工程师",
    "母带工程师", "母带后期处理录音室", "母带后期处理工程师",
    "母带后期处理制作人", "母带后期处理", "母带处理", "母带工作室", "母带制作",
    "音频工程师", "音频编辑", "音频助理",
    "人声录音", "人声录音工程师", "人声录音室",
    "钢琴", "吉他", "电吉他", "木吉他", "低音吉他", "贝斯",
    "大提琴", "中提琴", "小提琴", "电小提琴", "二胡", "萨克斯",
    "小号", "长号", "口琴", "箫", "打击乐", "合成器",
    "弦乐编写", "弦乐团", "弦乐录音室", "弦乐录音师", "弦乐监制",
    "弦乐录音", "弦乐录音棚", "弦乐编写助理", "铜管乐编写",
    "结他", "鼓手", "鼓/打击乐", "编程", "电脑编程",
    "钢琴伴奏", "大提琴独奏", "指挥家", "乐团",
    "和声编写", "合声编写", "和音编写", "和声编写/和声", "人声",
    "主唱录音", "主唱/和声录音", "主人声",
    "发行公司", "唱片公司", "出品公司", "制作及经纪公司",
    "音乐发行营销", "专辑出品", "制作发行", "出品",
    "企划", "企划总监", "项目统筹", "总策划",
    "制作统筹", "制作行政统筹", "制作执行",
    "封面", "ISRC", "专辑", "歌曲名称", "歌曲", "歌名", "歌曲时间",
    "导演", "舞蹈", "音乐工程", "音乐编辑",
    "原曲", "收录于大碟", "曲OP", "词OP", "歌词翻译",
    "LP转录", "歌词上载", "歌词编辑",
    "OP", "SP", "OT", "O.P.", "O.P",
    "发行日", "发行", "专辑名称", "出品人", "唱片",
    "词/曲", "曲/词", "配唱", "中文词",
    "原声吉他", "贝司", "和声", "合声", "合音", "和音",
    "Mixed by", "Mastered by", "Mastering Engineer", "Mixing Engineer",
    "Mixing Studio", "Recording Studio", "Recording Engineer",
    "Recorded by", "Recorded", "Vocal Producer",
    "Drums by", "Bass by", "Guitars by", "Guitars", "Cellos by",
    "Backing Vocal", "Backing vocal", "Chorus by",
    "All instruments by", "All Guitars by", "Electric Guitars",
    "Programmer", "Programer", "Programmed", "Programming", "Program",
    "Publisher", "Production Credits", "Special thanks", "Remix",
    "Strings Arrangement", "String Arrangement",
    "单簧管", "双簧管", "长笛", "短笛", "竖琴", "琵琶", "古筝", "笛子",
    "营销推广", "营销", "推广", "宣传", "宣传推广",
    "和弦", "编辑", "音频编辑", "PGM",
    "艺术指导", "视觉设计", "平面设计", "封面设计", "封面摄影",
    "MV导演", "MV制作", "音乐视频",
}
_CREDIT_KW = [
    "录音", "混音", "母带", "编曲", "制作", "工程", "监制", "编写", "弦乐",
    "人声", "吉他", "键盘", "鼓", "提琴", "贝斯", "萨克斯", "编程", "演奏",
    "和声", "合声", "版权", "出品", "发行", "指挥", "四重奏", "营销", "推广",
    "单簧管", "双簧管", "长笛", "竖琴", "古筝", "琵琶",
    "Recording", "Mixing", "Mixed", "Master", "Producer", "Arrange",
    "Guitar", "Violin", "Viola", "Cello", "Piano", "Drum", "Bass",
    "Vocal", "Studio", "Program", "Remix", "Keyboard", "Trumpet",
    "Trombone", "Strings", "Chorus", "Scratch", "Copyright", "Publish",
]
_CREDIT_EXCLUDE = {
    "男", "女", "合", "男独白", "女白", "(合)", "(女)", "(男)", "男女",
    "三人合", "独白", "侧",
}
_LYRICIST_PREFIXES = ("词", "詞", "作词", "作詞", "填词", "填詞", "Lyric")
_COMPOSER_PREFIXES = ("曲", "作曲", "Compos", "谱曲")
_NOT_COMPOSER = {"曲OP", "歌曲", "歌曲名称", "歌曲时间", "歌曲制作", "歌曲制作公司", "歌曲监制"}


def _is_lyricist_label(label: str) -> bool:
    if label in _NOT_COMPOSER:
        return False
    return label.startswith(_LYRICIST_PREFIXES) and "编曲" not in label


def _is_composer_label(label: str) -> bool:
    if label in _NOT_COMPOSER:
        return False
    return label.startswith(_COMPOSER_PREFIXES) and "编曲" not in label


_CREDIT_BY_RE = re.compile(
    r"^\s*[﻿]?"
    r"(?:All\s+)?"
    r"(?:Arranged|Produced|Remixed|Conducted|Orchestrated|Engineered"
    r"|Programmed|Supervised|Performed|Directed|Mixed|Recorded|Mastered"
    r"|Guitar|Guitars|Bass|Drums?|Violin|Violins|Viola|Cello|Cellos"
    r"|Piano|Keyboard|Keys|Strings?|Chorus|Harmonica|Synths?"
    r"|[\w\s,&]+(?:Arranged|Performed|Recorded))"
    r"\s+by\b",
    re.IGNORECASE,
)


def _is_credit_line(line: str) -> bool:
    s = line.strip()
    if not s or len(s) > 200:
        return False
    m = re.match(r"^[﻿]?(.{1,40}?)\s*[：:]\s*", s)
    if m:
        label = m.group(1).strip().rstrip("|").strip()
        if label in _CREDIT_EXCLUDE:
            return False
        if label in _CREDIT_LABELS:
            return True
        ll = label.lower()
        if any(kw.lower() in ll for kw in _CREDIT_KW):
            return True
    if _CREDIT_BY_RE.match(s):
        return True
    return False


def _parse_credit_names(line: str) -> tuple[str | None, list[str]]:
    m = re.match(r"^[﻿]?(.{1,40}?)\s*[：:]\s*(.+)", line.strip())
    if not m:
        return None, []
    label = m.group(1).strip().rstrip("|").strip()
    value = m.group(2).strip().rstrip("|;；").strip()
    names = re.split(r"[/,、，]+", value)
    return label, [n.strip() for n in names if n.strip()]


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


def extract_credits(lyric: str) -> tuple[str, str | None, list[str], list[str]]:
    """Extract credit lines from head/tail of lyrics.

    Returns (cleaned_lyrics, credits_text, lyricists, composers).
    """
    if not lyric:
        return "", None, [], []
    lyric = LRC_TS_RE.sub("", lyric)
    lines = lyric.split("\n")

    # scan head
    head_end = 0
    has_head = False
    for i, ln in enumerate(lines):
        s = ln.strip()
        if not s:
            if has_head:
                break
            continue
        if _is_credit_line(s):
            has_head = True
            head_end = i + 1
        else:
            break
    if not has_head:
        head_end = 0

    # scan tail (don't overlap with head)
    tail_start = len(lines)
    has_tail = False
    for i in range(len(lines) - 1, max(head_end - 1, -1), -1):
        s = lines[i].strip()
        if not s:
            if has_tail:
                break
            continue
        if _is_credit_line(s):
            has_tail = True
            tail_start = i
        else:
            break
    if not has_tail:
        tail_start = len(lines)

    # collect credits and kept lyrics in one pass, preserving original order
    credit_lines: list[str] = []
    kept_lines: list[str] = []
    for i, ln in enumerate(lines):
        s = ln.strip()
        in_head = i < head_end
        in_tail = i >= tail_start
        if in_head or in_tail:
            if s:
                credit_lines.append(s)
        elif s and _is_credit_line(s):
            credit_lines.append(s)
        else:
            kept_lines.append(ln)

    if not credit_lines:
        body = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
        return body or lyric.strip(), None, [], []

    # parse lyricist / composer names from credits
    lyricists: list[str] = []
    composers: list[str] = []
    for cl in credit_lines:
        label, names = _parse_credit_names(cl)
        if not label or not names:
            continue
        if _is_lyricist_label(label):
            lyricists = names
        elif _is_composer_label(label):
            composers = names

    body = "\n".join(kept_lines)
    body = re.sub(r"\n{3,}", "\n\n", body).strip()
    credits_text = "\n".join(credit_lines)
    return body, credits_text, lyricists, composers


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
        cleaned, credits_text, cr_lyricists, cr_composers = extract_credits(
            r.get("lyric") or ""
        )
        if not lyricists and cr_lyricists:
            lyricists = cr_lyricists
        if not composers and cr_composers:
            composers = cr_composers
        out.append({
            "id": f"ne:{r.get('song_id','')}",
            "title": title,
            "artist": artist,
            "album": (r.get("album_name") or "").strip(),
            "year": (str(r.get("album_year") or "")).strip() or None,
            "lyricists": lyricists,
            "composers": composers,
            "lyrics": cleaned,
            "credits": credits_text,
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
        cleaned, credits_text, cr_lyricists, cr_composers = extract_credits(lyric)
        if not lyricists and cr_lyricists:
            lyricists = cr_lyricists
        if not composers and cr_composers:
            composers = cr_composers
        out.append({
            "id": f"cz:{r['id']}",
            "title": r["title"].strip(),
            "artist": r["artist"].strip(),
            "album": (r["album"] or "").strip(),
            "year": None,
            "lyricists": lyricists,
            "composers": composers,
            "lyrics": cleaned,
            "credits": credits_text,
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

    # 3) finalize: normalize names, drop bookkeeping, drop empty-valued keys
    ALIASES = {"梁伟文": "林夕"}

    def simplify_names(names: list[str]) -> list[str]:
        seen_n: set[str] = set()
        out: list[str] = []
        for n in names:
            s = ALIASES.get(_to_simplified(n), _to_simplified(n))
            if s not in seen_n:
                seen_n.add(s)
                out.append(s)
        return out

    KEEP_IF_TRUTHY = {"album", "year", "lyricists", "composers",
                      "cover_url", "popularity", "features", "credits"}
    curated = []  # netease (richer, faster to load)
    extra = []   # ci_ziv (massive, lazy-loaded)
    for rec in seen.values():
        rec.pop("feature", None)
        if rec.get("lyricists"):
            rec["lyricists"] = simplify_names(rec["lyricists"])
        if rec.get("composers"):
            rec["composers"] = simplify_names(rec["composers"])
        if rec.get("features"):
            rec["features"] = simplify_names(rec["features"])
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
    f_raw, f_gz = dump_and_measure(OUT / "corpus_full.json", curated + extra)

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
    print(f"full   (merged)  : {len(curated)+len(extra):6d}  "
          f"{f_raw/1024/1024:.1f} MB  (gzip {f_gz/1024/1024:.1f} MB)")
    print(f"distinct lyricists: {len(all_lyricists):6d}")
    print(f"elapsed          : {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
