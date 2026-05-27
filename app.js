// 写词人 — static lyrics search

document.addEventListener("contextmenu", (e) => e.preventDefault());

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
  quotes: loadQuotes(),
  q: "",
  scope: "title",
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

// ── quotes (saved highlights) ──────────────────────
const QUOTES_KEY = "xieciren-quotes-v1";
function loadQuotes() {
  try { return JSON.parse(localStorage.getItem(QUOTES_KEY) || "[]") || []; }
  catch { return []; }
}
function saveQuotes() {
  try { localStorage.setItem(QUOTES_KEY, JSON.stringify(state.quotes)); }
  catch (e) { console.warn("quote save failed", e); }
}
function quotesForSong(songId) {
  return state.quotes.filter((q) => q.songId === songId);
}

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
const QUOTE_INTERVAL_MS = 15_000;
let footRotateTimer = null;
let footStartTimer = null;
let lastShownText = "";

function quotePool() {
  const fromUser = (state.quotes || []).map((q) => q.text);
  return [...FOOT_QUOTES, ...fromUser];
}

function showCountInFoot() {
  if (!state.stats) return;
  const { totalSongs, lyricistsCount } = state.stats;
  elFootContent.innerHTML = `共有中文词库 <b>${totalSongs.toLocaleString()}</b> 首，来自于 <b>${lyricistsCount.toLocaleString()}</b> 位写词人`;
}
function showRandomQuote() {
  const pool = quotePool();
  if (!pool.length) return;
  let pick;
  for (let tries = 0; tries < 8; tries++) {
    pick = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length === 1 || pick !== lastShownText) break;
  }
  lastShownText = pick;
  elFootContent.innerHTML = `<span class="quote">${escapeHtml(pick)}</span>`;
}
function startFootRotation() {
  clearTimeout(footStartTimer);
  clearInterval(footRotateTimer);
  showCountInFoot();
  footStartTimer = setTimeout(() => {
    showRandomQuote();
    footRotateTimer = setInterval(showRandomQuote, QUOTE_INTERVAL_MS);
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
  const isHomeIdle = !state.q && !state.featureFilter;
  if (isHomeIdle) {
    renderQuoteWall();
    return;
  }
  const list = state.lastResults;
  if (list.length === 0) {
    elResults.innerHTML = `<div class="empty">没有匹配的歌曲</div>`;
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
  const tile = e.target.closest(".quote-tile");
  if (tile) {
    openSongFromQuote(tile.dataset.id);
    return;
  }
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

function quoteTextFontSize(text) {
  const len = text.replace(/\n/g, "").length;
  if (len <= 10) return 36;
  if (len <= 20) return 30;
  if (len <= 40) return 24;
  if (len <= 60) return 20;
  return 17;
}

function renderQuoteWall() {
  const items = state.quotes.length
    ? state.quotes.slice().sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
      )
    : FOOT_QUOTES.map((text, i) => ({
        id: `seed-${i}`,
        text,
        lyricists: [],
        songTitle: null,
        seed: true,
      }));
  const tiles = items.map((it) => {
    const lyricistName = (it.lyricists || [])[0] || "";
    const fs = quoteTextFontSize(it.text);
    return `
      <article class="quote-tile${it.seed ? " seed" : ""}" data-id="${escapeAttr(it.id)}">
        <div class="quote-text" style="font-size:${fs}px">${escapeHtml(it.text)}</div>
        ${lyricistName ? `<div class="quote-author">${escapeHtml(lyricistName)}</div>` : ""}
        ${it.songTitle ? `<div class="quote-song">${escapeHtml(it.songTitle)}</div>` : ""}
      </article>`;
  }).join("");
  elResults.innerHTML = `<div class="quotewall">${tiles}</div>`;
}

function openSongFromQuote(quoteId) {
  const q = state.quotes.find((x) => x.id === quoteId);
  if (!q) return;
  const song = state.corpus.find((s) => s.id === q.songId);
  if (!song) { showToast("原曲未在当前词库中"); return; }
  state.selectedId = song.id;
  renderDetail(song);
  document.body.classList.add("show-detail");
  setTimeout(() => {
    const target = elDetailInner.querySelector(`.saved-quote[data-id="${quoteId}"]`);
    if (target) target.scrollIntoView({ block: "center", behavior: "smooth" });
  }, 60);
}

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
  applyQuoteHighlights();

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

// ── quotes: select → save, click → manage ─────────
const elPopover = $("#quotePopover");
const elToast = $("#toast");
let popoverState = null; // { mode: 'save'|'manage', songId, range?, quoteId? }

function textOffsetIn(container, node, offset) {
  if (node === container) return offset;
  let pos = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) {
    if (n === node) return pos + offset;
    if (node.contains && node.contains(n)) return pos + n.textContent.length;
    pos += n.textContent.length;
  }
  return pos;
}

function getLyricsContainer() { return elDetailInner.querySelector(".lyrics"); }

function showPopover(rect, mode, ctx) {
  // place below the selection; flip above if running off the viewport bottom
  const PAD = 10;
  let top = window.scrollY + rect.bottom + PAD;
  if (rect.bottom + 60 > window.innerHeight) {
    top = window.scrollY + rect.top - 44;
  }
  const left = window.scrollX + rect.left + rect.width / 2;
  elPopover.style.top = Math.max(8, top) + "px";
  elPopover.style.left = left + "px";
  elPopover.dataset.mode = mode;
  popoverState = { mode, ...ctx };
  elPopover.hidden = false;
}
function hidePopover() {
  elPopover.hidden = true;
  popoverState = null;
}

function showToast(msg) {
  elToast.textContent = msg;
  elToast.hidden = false;
  clearTimeout(elToast._t);
  elToast._t = setTimeout(() => { elToast.hidden = true; }, 1600);
}

// detect new selection in the lyrics block
function onLyricsPointerUp(e) {
  // give the browser a tick to finalize the selection
  setTimeout(() => {
    const lyricsEl = getLyricsContainer();
    if (!lyricsEl) return hidePopover();

    // case 1: tap on an already-saved quote
    const hit = e.target.closest(".saved-quote");
    if (hit && (!window.getSelection().toString().trim())) {
      const rect = hit.getBoundingClientRect();
      showPopover(rect, "manage", { quoteId: hit.dataset.id });
      return;
    }

    // case 2: a fresh selection that lives entirely inside .lyrics
    const sel = window.getSelection();
    if (!sel.rangeCount) return hidePopover();
    const range = sel.getRangeAt(0);
    if (range.collapsed) return hidePopover();
    const text = sel.toString().trim();
    if (!text) return hidePopover();
    if (!lyricsEl.contains(range.commonAncestorContainer)) return hidePopover();

    const start = textOffsetIn(lyricsEl, range.startContainer, range.startOffset);
    const end = textOffsetIn(lyricsEl, range.endContainer, range.endOffset);
    const lo = Math.min(start, end), hi = Math.max(start, end);
    if (hi <= lo) return hidePopover();

    const rect = range.getBoundingClientRect();
    showPopover(rect, "save", {
      songId: state.selectedId,
      start: lo,
      end: hi,
      text: sel.toString(),
    });
  }, 0);
}

elDetailInner.addEventListener("mouseup", onLyricsPointerUp);
elDetailInner.addEventListener("touchend", onLyricsPointerUp);
elDetail.addEventListener("scroll", hidePopover, { passive: true });
window.addEventListener("scroll", hidePopover, { passive: true });
window.addEventListener("resize", hidePopover);

elPopover.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn || !popoverState) return;
  const action = btn.dataset.action;
  if (action === "save") saveQuoteFromSelection();
  else if (action === "share") shareQuoteAsImage();
  else if (action === "copy") copyQuoteText();
  else if (action === "delete") deleteQuoteById();
});

function currentDetailSong() {
  return state.corpus.find((s) => s.id === state.selectedId);
}

function saveQuoteFromSelection() {
  const ps = popoverState; if (!ps || ps.mode !== "save") return;
  const song = currentDetailSong(); if (!song) return;
  const q = {
    id: "q-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
    songId: song.id,
    songTitle: song.title,
    artist: song.artist,
    lyricists: song.lyricists || [],
    year: song.year || null,
    cover_url: song.cover_url || null,
    start: ps.start,
    end: ps.end,
    text: ps.text,
    createdAt: new Date().toISOString(),
  };
  state.quotes.push(q);
  saveQuotes();
  hidePopover();
  window.getSelection().removeAllRanges();
  applyQuoteHighlights();
  showToast("已收藏金句");
}

function copyQuoteText() {
  const ps = popoverState; if (!ps) return;
  const q = state.quotes.find((x) => x.id === ps.quoteId);
  if (!q) return;
  navigator.clipboard?.writeText(q.text).then(
    () => showToast("已复制"),
    () => showToast("复制失败"),
  );
  hidePopover();
}

function deleteQuoteById() {
  const ps = popoverState; if (!ps) return;
  state.quotes = state.quotes.filter((x) => x.id !== ps.quoteId);
  saveQuotes();
  hidePopover();
  applyQuoteHighlights();
  showToast("已删除");
}

function shareQuoteAsImage() {
  const ps = popoverState; if (!ps) return;
  let text, lyricist, songTitle;
  if (ps.mode === "save") {
    text = ps.text;
    const song = currentDetailSong();
    lyricist = song?.lyricists?.join(" / ") || "";
    songTitle = song?.title || "";
  } else {
    const q = state.quotes.find((x) => x.id === ps.quoteId);
    if (!q) return;
    text = q.text;
    lyricist = q.lyricists?.join(" / ") || "";
    songTitle = q.songTitle || "";
  }

  const COLORS = [
    "#1a1a1a", "#2c2018", "#2a3037", "#3d2b1f", "#1b3a4b",
    "#2d4a3e", "#4a2c40", "#2b2d42", "#5c3a23", "#3a3a5c",
  ];
  const bg = COLORS[Math.floor(Math.random() * COLORS.length)];

  const W = 900, H = 1200;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const lines = text.trim().split(/\n/);
  const fontSize = Math.min(52, Math.floor(700 / (lines.length || 1)));
  ctx.font = `500 ${fontSize}px "Noto Serif SC", "Songti SC", serif`;
  const lineHeight = fontSize * 1.8;
  const totalH = lines.length * lineHeight;
  const startY = (H - totalH) / 2 + lineHeight / 2;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], W / 2, startY + i * lineHeight, W - 120);
  }

  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = "rgba(255,255,255,.55)";
  ctx.font = '400 22px -apple-system, "PingFang SC", sans-serif';
  const credit = `${lyricist}${lyricist && songTitle ? "　" : ""}「${songTitle}」`;
  ctx.fillText(credit, 48, H - 48, W - 96);

  canvas.toBlob((blob) => {
    if (!blob) return showToast("生成失败");
    const file = new File([blob], "quote.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file] }).catch(() => {});
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "quote.png";
      a.click();
      URL.revokeObjectURL(a.href);
      showToast("已保存图片");
    }
    hidePopover();
  }, "image/png");
}

// Walk text nodes in .lyrics and wrap each saved range in a <span>
function applyQuoteHighlights() {
  const container = getLyricsContainer();
  if (!container) return;
  const song = currentDetailSong(); if (!song) return;

  // re-render lyrics fresh (strip existing .saved-quote spans by resetting innerHTML)
  const q = state.q.trim();
  container.innerHTML = highlight(escapeHtml(song.lyrics || "（暂无歌词）"), q);

  const songQuotes = quotesForSong(song.id)
    .slice()
    .sort((a, b) => b.start - a.start);
  for (const sq of songQuotes) wrapTextRange(container, sq.start, sq.end, sq.id);
}

function wrapTextRange(container, start, end, id) {
  let pos = 0;
  let startNode = null, startOffset = 0, endNode = null, endOffset = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) {
    const len = n.textContent.length;
    if (!startNode && pos + len > start) {
      startNode = n; startOffset = start - pos;
    }
    if (startNode && pos + len >= end) {
      endNode = n; endOffset = end - pos;
      break;
    }
    pos += len;
  }
  if (!startNode || !endNode) return;
  const range = document.createRange();
  try {
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
  } catch { return; }
  const span = document.createElement("span");
  span.className = "saved-quote";
  span.dataset.id = id;
  try {
    range.surroundContents(span);
  } catch {
    span.appendChild(range.extractContents());
    range.insertNode(span);
  }
}

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
