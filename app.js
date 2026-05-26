// 写词人 — static lyrics search
// Loads data/corpus.json (curated, fast) then data/corpus_extra.json (large,
// background). All search runs client-side over an in-memory array.

const $ = (sel) => document.querySelector(sel);
const elQ = $("#q");
const elQClear = $("#qclear");
const elScope = $("#scope");
const elChips = $("#chips");
const elResults = $("#results");
const elDetail = $("#detail");
const elDetailInner = $(".detail-inner");
const elBack = $("#back");
const elFoot = $("#foot");

const state = {
  corpus: [],
  curatedCount: 0,
  extraLoaded: false,
  lyricists: [],
  stats: null,
  q: "",
  scope: "all",
  featureFilter: null,
  selectedId: null,
  lastResults: [],
};

const MAX_RESULTS = 500;
const SNIPPET_LEN = 60;

// ── data loading ────────────────────────────────────
async function loadJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function bootstrap() {
  try {
    const [lyricists, stats, curated] = await Promise.all([
      loadJson("data/lyricists.json"),
      loadJson("data/stats.json"),
      loadJson("data/corpus.json"),
    ]);
    state.lyricists = lyricists;
    state.stats = stats;
    state.corpus = curated;
    state.curatedCount = curated.length;
    renderChips();
    renderFoot();
    triggerSearch();

    loadJson("data/corpus_extra.json")
      .then((extra) => {
        state.corpus = state.corpus.concat(extra);
        state.extraLoaded = true;
        triggerSearch();
      })
      .catch((e) => console.warn("extra corpus failed", e));
  } catch (e) {
    elResults.innerHTML = `<div class="empty">数据加载失败<br>${escapeHtml(e.message)}</div>`;
  }
}

function renderFoot() {
  if (!state.stats) return;
  const { totalSongs, lyricistsCount } = state.stats;
  elFoot.innerHTML = `共有中文词库 <b>${totalSongs.toLocaleString()}</b> 首，来自于 <b>${lyricistsCount.toLocaleString()}</b> 位写词人`;
}

// ── chips ───────────────────────────────────────────
function renderChips() {
  const buttons = state.lyricists.map((l) => {
    const active = state.featureFilter === l.name ? " active" : "";
    return `<button class="chip${active}" data-name="${escapeAttr(l.name)}">${escapeHtml(l.name)}<span class="n">${l.count}</span></button>`;
  });
  const clear = state.featureFilter
    ? `<button class="chip clear" data-name="__clear__">清除筛选</button>`
    : "";
  elChips.innerHTML = buttons.join("") + clear;
}

elChips.addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  const name = btn.dataset.name;
  state.featureFilter = name === "__clear__" || state.featureFilter === name ? null : name;
  renderChips();
  triggerSearch();
});

// ── search ──────────────────────────────────────────
let searchTimer = null;
function triggerSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 180);
}

function runSearch() {
  const q = state.q.trim().toLowerCase();
  const scope = state.scope;
  const feat = state.featureFilter;

  const out = [];
  const corpus = state.corpus;
  const cap = MAX_RESULTS * 4;
  for (let i = 0; i < corpus.length; i++) {
    const s = corpus[i];
    if (feat) {
      if (!s.features || s.features.indexOf(feat) === -1) continue;
    }
    if (q) {
      let hit = false;
      const t = s.title.toLowerCase();
      const a = s.artist.toLowerCase();
      const l = s.lyrics ? s.lyrics.toLowerCase() : "";
      const ls = s.lyricists || [];
      if (scope === "title") hit = t.indexOf(q) !== -1;
      else if (scope === "artist") hit = a.indexOf(q) !== -1;
      else if (scope === "lyric") hit = l.indexOf(q) !== -1;
      else if (scope === "lyricist")
        hit = ls.some((x) => x.toLowerCase().indexOf(q) !== -1);
      else
        hit =
          t.indexOf(q) !== -1 ||
          a.indexOf(q) !== -1 ||
          l.indexOf(q) !== -1 ||
          ls.some((x) => x.toLowerCase().indexOf(q) !== -1);
      if (!hit) continue;
    }
    out.push(s);
    if (out.length >= cap) break;
  }
  out.sort((a, b) => {
    const af = a.features ? 1 : 0;
    const bf = b.features ? 1 : 0;
    if (af !== bf) return bf - af;
    const ap = a.popularity || 0;
    const bp = b.popularity || 0;
    if (ap !== bp) return bp - ap;
    return a.title.localeCompare(b.title);
  });
  state.lastResults = out.slice(0, MAX_RESULTS);
  renderResults(out.length);
}

// ── render results ─────────────────────────────────
function renderResults(totalHits) {
  const list = state.lastResults;
  if (list.length === 0) {
    elResults.innerHTML = state.q || state.featureFilter
      ? `<div class="empty">没有匹配的歌曲</div>`
      : `<div class="empty">输入关键词开始搜索<br>或点击上方词人快筛</div>`;
    return;
  }
  const q = state.q.trim();
  const showSnip = q && state.scope !== "title" && state.scope !== "artist";
  const html = list.map((s) => {
    const meta = [s.artist, s.album, s.year].filter(Boolean).join(" · ");
    const lyricistsText = (s.lyricists || []).join(" / ");
    const lyricLine = showSnip ? makeSnippet(s.lyrics || "", q) : "";
    return `
      <div class="row${state.selectedId === s.id ? " active" : ""}" data-id="${escapeAttr(s.id)}">
        <div class="title">${escapeHtml(s.title)}</div>
        <div class="meta">${escapeHtml(meta)}</div>
        ${lyricistsText ? `<div class="lyricist">词：${escapeHtml(lyricistsText)}</div>` : ""}
        ${lyricLine ? `<div class="snip">${lyricLine}</div>` : ""}
      </div>`;
  });
  let header = "";
  if (totalHits > MAX_RESULTS) {
    header = `<div class="empty" style="padding:14px 28px;text-align:left;font-size:12px;">命中 ${totalHits.toLocaleString()} 条 · 仅显示前 ${MAX_RESULTS}，请细化关键词</div>`;
  }
  elResults.innerHTML = header + html.join("");
}

elResults.addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  if (!row) return;
  state.selectedId = row.dataset.id;
  const song = state.lastResults.find((s) => s.id === state.selectedId);
  if (song) {
    renderDetail(song);
    document.body.classList.add("show-detail");
  }
  document.querySelectorAll(".row.active").forEach((el) => el.classList.remove("active"));
  row.classList.add("active");
});

elBack.addEventListener("click", () => {
  document.body.classList.remove("show-detail");
});

// ── detail ─────────────────────────────────────────
function renderDetail(s) {
  const meta = [s.album, s.year].filter(Boolean).join(" · ");
  const cover = s.cover_url
    ? `<img class="cover" src="${escapeAttr(s.cover_url)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">`
    : `<div class="cover" aria-hidden="true"></div>`;
  const credits = [];
  if (s.lyricists && s.lyricists.length)
    credits.push(`<span class="credit-row"><b>词</b>${escapeHtml(s.lyricists.join(" / "))}</span>`);
  if (s.composers && s.composers.length)
    credits.push(`<span class="credit-row"><b>曲</b>${escapeHtml(s.composers.join(" / "))}</span>`);

  const q = state.q.trim();
  const lyrics = highlight(escapeHtml(s.lyrics || "（暂无歌词）"), q);

  elDetailInner.innerHTML = `
    <div class="cover-wrap">
      ${cover}
      <div class="head">
        <h1>${escapeHtml(s.title)}</h1>
        <div class="artist">${escapeHtml(s.artist)}</div>
        <div class="meta">${meta ? escapeHtml(meta) + '<br>' : ''}${credits.join("")}</div>
      </div>
    </div>
    <div class="lyrics">${lyrics}</div>
  `;
  elDetail.scrollTop = 0;
}

// ── helpers ────────────────────────────────────────
function makeSnippet(text, q) {
  if (!text || !q) return "";
  const lower = text.toLowerCase();
  const i = lower.indexOf(q.toLowerCase());
  if (i < 0) return "";
  const start = Math.max(0, i - 20);
  const end = Math.min(text.length, i + q.length + SNIPPET_LEN);
  let snip = text.slice(start, end).replace(/\n+/g, " · ");
  if (start > 0) snip = "…" + snip;
  if (end < text.length) snip += "…";
  return highlight(escapeHtml(snip), q);
}

function highlight(html, q) {
  if (!q) return html;
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html.replace(new RegExp(safe, "gi"), (m) => `<mark>${m}</mark>`);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}
const escapeAttr = escapeHtml;

// ── wire up inputs ─────────────────────────────────
elQ.addEventListener("input", (e) => {
  state.q = e.target.value;
  elQClear.hidden = !state.q;
  triggerSearch();
});
elQClear.addEventListener("click", () => {
  elQ.value = "";
  state.q = "";
  elQClear.hidden = true;
  elQ.focus();
  triggerSearch();
});
elScope.addEventListener("change", (e) => {
  state.scope = e.target.value;
  triggerSearch();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== elQ && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    elQ.focus();
    elQ.select();
  } else if (e.key === "Escape") {
    if (document.activeElement === elQ) {
      elQ.value = "";
      state.q = "";
      elQClear.hidden = true;
      triggerSearch();
    } else if (document.body.classList.contains("show-detail")) {
      document.body.classList.remove("show-detail");
    }
  }
});

bootstrap();
