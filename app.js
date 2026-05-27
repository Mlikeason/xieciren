// 写词人 — static lyrics search

const $ = (sel) => document.querySelector(sel);
const elQ = $("#q");
const elQClear = $("#qclear");
const elScope = $("#scope");
const elChips = $("#chips");
const elResults = $("#results");
const elDetail = $("#detail");
const elDetailInner = $(".detail-inner");
const elBack = $("#back");
const elFootContent = $("#footContent");
const elFootToggle = $("#footToggle");

const state = {
  corpus: [],
  curatedCount: 0,
  extraLoaded: false,
  lyricists: [],
  stats: null,
  ratings: loadRatings(),
  q: "",
  scope: "all",
  featureFilter: null,
  selectedId: null,
  lastResults: [],
};

const MAX_RESULTS = 500;
const SNIPPET_LEN = 56;
const RATINGS_KEY = "xieciren-ratings-v1";

// ── ratings (localStorage) ─────────────────────────
function loadRatings() {
  try {
    return JSON.parse(localStorage.getItem(RATINGS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}
function saveRatings() {
  try { localStorage.setItem(RATINGS_KEY, JSON.stringify(state.ratings)); }
  catch (e) { console.warn("rating save failed", e); }
}
function ratingOf(id) { return state.ratings[id] || 0; }
function applyRatings(rows) { for (const s of rows) s.rating = ratingOf(s.id); }

// 梁伟文 is 林夕's real name — display the pen name everywhere.
const ALIAS = { "梁伟文": "林夕" };
function rename(name) { return ALIAS[name] || name; }
function dedupePreserve(arr) {
  const seen = new Set(), out = [];
  for (const x of arr) { if (!seen.has(x)) { seen.add(x); out.push(x); } }
  return out;
}
function normalizeAliases(rows) {
  for (const s of rows) {
    if (s.lyricists) s.lyricists = dedupePreserve(s.lyricists.map(rename));
    if (s.composers) s.composers = dedupePreserve(s.composers.map(rename));
    if (s.features)  s.features  = dedupePreserve(s.features.map(rename));
    if (s.lyrics)    s.lyrics    = s.lyrics.replace(/梁伟文/g, "林夕");
  }
}

// Group key: same title + same lyricist set → likely a re-release.
// Sort uses the earliest year across the group as the "real" composition year.
function groupKey(s) {
  const title = (s.title || "").toLowerCase().trim();
  const ls = s.lyricists || [];
  if (!title || !ls.length) return null;
  const k = ls.map((x) => String(x).toLowerCase().trim()).sort().join("/");
  return title + "|" + k;
}
function computeSortYears() {
  const earliest = new Map();
  for (const s of state.corpus) {
    const y = parseYear(s.year);
    if (y === -Infinity) continue;
    const k = groupKey(s);
    if (!k) continue;
    const cur = earliest.get(k);
    if (cur === undefined || y < cur) earliest.set(k, y);
  }
  for (const s of state.corpus) {
    const k = groupKey(s);
    const groupY = k ? earliest.get(k) : undefined;
    s.sortYear = groupY !== undefined ? groupY : parseYear(s.year);
  }
}

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
    normalizeAliases(curated);
    applyRatings(curated);
    state.corpus = curated;
    state.curatedCount = curated.length;
    computeSortYears();
    renderChips();
    showCountInFoot();
    triggerSearch();

    loadJson("data/corpus_extra.json")
      .then((extra) => {
        normalizeAliases(extra);
        applyRatings(extra);
        state.corpus = state.corpus.concat(extra);
        state.extraLoaded = true;
        computeSortYears();
        triggerSearch();
      })
      .catch((e) => console.warn("extra corpus failed", e));
  } catch (e) {
    elResults.innerHTML = `<div class="empty">数据加载失败<br>${escapeHtml(e.message)}</div>`;
  }
}

// ── footer messages: count + lyric quotes ─────────
const FOOT_QUOTES = [
  "俗透的歌词，煽动你恻隐",
  "毫无代价唱最幸福的歌",
  "在有生的瞬间能遇到你，竟花光所有运气",
];
let footRotateTimer = null;
let footStartTimer = null;
let lastQuoteIdx = -1;

function showCountInFoot() {
  if (!state.stats) return;
  const { totalSongs, lyricistsCount } = state.stats;
  elFootContent.innerHTML = `共有中文词库 <b>${totalSongs.toLocaleString()}</b> 首，来自于 <b>${lyricistsCount.toLocaleString()}</b> 位写词人`;
}
function showRandomQuote() {
  if (!FOOT_QUOTES.length) return;
  let i;
  do { i = Math.floor(Math.random() * FOOT_QUOTES.length); }
  while (FOOT_QUOTES.length > 1 && i === lastQuoteIdx);
  lastQuoteIdx = i;
  elFootContent.innerHTML = `<span class="quote">${escapeHtml(FOOT_QUOTES[i])}</span>`;
}
function startFootRotation() {
  clearTimeout(footStartTimer);
  clearInterval(footRotateTimer);
  showCountInFoot();
  footStartTimer = setTimeout(() => {
    showRandomQuote();
    footRotateTimer = setInterval(showRandomQuote, 60_000);
  }, 3000);
}
function stopFootRotation() {
  clearTimeout(footStartTimer);
  clearInterval(footRotateTimer);
  footStartTimer = null;
  footRotateTimer = null;
}

// ── chips ───────────────────────────────────────────
function renderChips() {
  elChips.innerHTML = state.lyricists.map((l) => {
    const active = state.featureFilter === l.name ? " active" : "";
    return `<button class="tag${active}" data-name="${escapeAttr(l.name)}">${escapeHtml(l.name)}</button>`;
  }).join("");
}

elChips.addEventListener("click", (e) => {
  const btn = e.target.closest(".tag");
  if (!btn) return;
  const name = btn.dataset.name;
  state.featureFilter = state.featureFilter === name ? null : name;
  renderChips();
  triggerSearch();
});

// ── search ──────────────────────────────────────────
let searchTimer = null;
function triggerSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 180);
}

function parseYear(y) {
  if (!y) return -Infinity;
  const n = parseInt(String(y).slice(0, 4), 10);
  return Number.isFinite(n) ? n : -Infinity;
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
  // sort: rating ↓ → earliest year for (title+lyricist set) ↓ → popularity ↓ → title
  out.sort((a, b) => {
    const ar = a.rating || 0, br = b.rating || 0;
    if (ar !== br) return br - ar;
    const ay = a.sortYear ?? -Infinity, by = b.sortYear ?? -Infinity;
    if (ay !== by) return by - ay;
    const ap = a.popularity || 0, bp = b.popularity || 0;
    if (ap !== bp) return bp - ap;
    return a.title.localeCompare(b.title);
  });
  state.lastResults = out.slice(0, MAX_RESULTS);
  renderResults();
}

// ── render results ─────────────────────────────────
function renderResults() {
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
    const meta = s.year
      ? `${escapeHtml(s.artist)}<span class="year">${escapeHtml(s.year)}</span>`
      : escapeHtml(s.artist);
    const lyricistsText = (s.lyricists || []).join(" / ");
    const lyricLine = showSnip ? makeSnippet(s.lyrics || "", q) : "";
    const ratingMini = s.rating
      ? `<span class="rating-mini"><span class="heart">♥</span><span class="num">${s.rating}</span></span>`
      : "";
    return `
      <div class="row${state.selectedId === s.id ? " active" : ""}" data-id="${escapeAttr(s.id)}">
        <div class="title"><span>${escapeHtml(s.title)}</span>${ratingMini}</div>
        <div class="meta">${meta}</div>
        ${lyricistsText ? `<div class="lyricist"><b>词</b>${escapeHtml(lyricistsText)}</div>` : ""}
        ${lyricLine ? `<div class="snip">${lyricLine}</div>` : ""}
      </div>`;
  });
  elResults.innerHTML = html.join("");
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
  document.body.classList.remove("detail-scrolled");
});

// ── detail ─────────────────────────────────────────
function renderDetail(s) {
  const albumLine = [s.album, s.year].filter(Boolean).join(" · ");
  const coverInner = s.cover_url
    ? `<img class="cover" src="${escapeAttr(s.cover_url)}" alt="" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`
    : `<div class="cover" aria-hidden="true"></div>`;
  const r = s.rating || 0;
  const rateBtn = `<button class="rate-btn rate-overlay" id="rateBtn" data-id="${escapeAttr(s.id)}" aria-label="加一个 rating">
      <span class="heart">♥</span><span class="num">${r}</span>
    </button>`;

  // order: 词人 tags then 歌手 tag (lyricists first per request)
  const lyricistTags = (s.lyricists || []).map(
    (n) => `<span class="tag static" title="作词">${escapeHtml(n)}</span>`
  ).join("");
  const artistTag = `<span class="tag static artist">${escapeHtml(s.artist)}</span>`;
  const creditRow = `<div class="credit-row">${lyricistTags}${artistTag}</div>`;

  const q = state.q.trim();
  const lyrics = highlight(escapeHtml(s.lyrics || "（暂无歌词）"), q);

  // detail content order: title → album·year → 词人 + 歌手 → lyrics
  elDetailInner.innerHTML = `
    <div class="cover-wrap">
      <figure class="cover-box">${coverInner}${rateBtn}</figure>
      <div class="head">
        <h1>${escapeHtml(s.title)}</h1>
        ${albumLine ? `<div class="album-line">${escapeHtml(albumLine)}</div>` : ""}
        ${creditRow}
      </div>
    </div>
    <div class="lyrics">${lyrics}</div>
  `;
  elDetail.scrollTop = 0;
  document.body.classList.remove("detail-scrolled");

  $("#rateBtn").addEventListener("click", (e) => onRateClick(e, s));
}

function onRateClick(e, song) {
  song.rating = (song.rating || 0) + 1;
  state.ratings[song.id] = song.rating;
  saveRatings();

  const btn = e.currentTarget;
  const num = btn.querySelector(".num");
  num.textContent = song.rating;

  btn.classList.remove("pulse");
  void btn.offsetWidth;
  btn.classList.add("pulse");

  // floating "+1"
  const float = document.createElement("span");
  float.className = "rate-float";
  float.textContent = "+1";
  const rect = btn.getBoundingClientRect();
  const parentRect = btn.parentElement.getBoundingClientRect();
  float.style.left = (rect.right - parentRect.left + 4) + "px";
  float.style.top = (rect.top - parentRect.top + 6) + "px";
  btn.parentElement.appendChild(float);
  setTimeout(() => float.remove(), 800);

  // re-sort lazily so the next search reflects the bump without flickering current view
  triggerSearch();
}

// ── auto-hide chips on scroll-down ─────────────────
const HIDE_THRESHOLD = 60;
const SHOW_DELTA = 8;
let lastScrollY = 0;
function onResultsScroll() {
  const y = elResults.scrollTop;
  const dy = y - lastScrollY;
  if (y < HIDE_THRESHOLD) {
    document.body.classList.remove("chips-hidden");
  } else if (dy > 4) {
    document.body.classList.add("chips-hidden");
  } else if (dy < -SHOW_DELTA) {
    document.body.classList.remove("chips-hidden");
  }
  lastScrollY = y;
}
elResults.addEventListener("scroll", onResultsScroll, { passive: true });

// detail panel: hide topbar when scrolling content up (mobile pattern)
let lastDetailY = 0;
elDetail.addEventListener("scroll", () => {
  const y = elDetail.scrollTop;
  const dy = y - lastDetailY;
  if (y < 30) {
    document.body.classList.remove("detail-scrolled");
  } else if (dy > 4) {
    document.body.classList.add("detail-scrolled");
  } else if (dy < -8) {
    document.body.classList.remove("detail-scrolled");
  }
  lastDetailY = y;
}, { passive: true });

// ── footer toggle ──────────────────────────────────
// Initial:  count visible 3s → collapse
// On open:  count visible 3s → start rotating quotes every 60s; stays open
// Click ▲ again to collapse
let initialCollapseTimer = null;
function collapseFoot() {
  document.body.classList.add("foot-collapsed");
  stopFootRotation();
}
function expandFoot() {
  document.body.classList.remove("foot-collapsed");
  startFootRotation();
}
elFootToggle.addEventListener("click", expandFoot);
elFootContent.addEventListener("click", () => {
  if (!document.body.classList.contains("foot-collapsed")) collapseFoot();
});
// Initial: show count for 3s, then collapse without rotation kicking in
clearTimeout(initialCollapseTimer);
initialCollapseTimer = setTimeout(collapseFoot, 3000);

// ── helpers ────────────────────────────────────────
function makeSnippet(text, q) {
  if (!text || !q) return "";
  const lower = text.toLowerCase();
  const i = lower.indexOf(q.toLowerCase());
  if (i < 0) return "";
  const start = Math.max(0, i - 18);
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

// ── inputs ─────────────────────────────────────────
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
      document.body.classList.remove("detail-scrolled");
    }
  }
});

bootstrap();
