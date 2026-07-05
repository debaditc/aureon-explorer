// app.js — UI state machine. Wires the controls to the backend API and drives
// the 3D scene + router HUD + results panel.

import { scene } from "/static/scene.js";

const $ = (id) => document.getElementById(id);

const state = {
  method: "adaptive",
  alpha: 0.5,
  files: [],       // File objects staged for upload
  hasIndex: false,
  lastResults: [], // for panel<->scene highlight sync
};

// ── boot ────────────────────────────────────────────────────────────────
scene.init($("scene"));
scene.onNodeClick((id) => openDetail(id));
scene.onNodeHover((id) => syncHover(id));
initTheme();
restoreState();

// ── Theme (light / dark) ──────────────────────────────────────────────────
function currentTheme() {
  return document.documentElement.getAttribute("data-theme") || "dark";
}
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("aureon_theme", theme); } catch { /* ignore */ }
  $("theme-btn").textContent = theme === "light" ? "☀" : "☾";
  $("theme-btn").title = theme === "light" ? "Switch to dark" : "Switch to light";
  scene.setTheme(theme);
}
function initTheme() { applyTheme(currentTheme()); }
$("theme-btn").addEventListener("click", () =>
  applyTheme(currentTheme() === "light" ? "dark" : "light"));

// ── SOURCE: file drop / picker ────────────────────────────────────────────
const drop = $("drop");
const fileInput = $("file-input");
drop.addEventListener("click", () => fileInput.click());
["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hover"); }));
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("hover"); }));
drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
fileInput.addEventListener("change", () => addFiles(fileInput.files));

function addFiles(list) {
  for (const f of list) state.files.push(f);
  renderFileList();
}
function renderFileList() {
  const el = $("file-list");
  el.innerHTML = "";
  state.files.forEach((f, i) => {
    const div = document.createElement("div");
    div.textContent = `◦ ${f.name}`;
    div.title = "click to remove";
    div.style.cursor = "pointer";
    div.onclick = () => { state.files.splice(i, 1); renderFileList(); };
    el.appendChild(div);
  });
}

// ── INDEX / SAMPLE ─────────────────────────────────────────────────────────
$("index-btn").addEventListener("click", indexDocuments);
$("sample-btn").addEventListener("click", loadSample);

async function indexDocuments() {
  const paste = $("paste").value.trim();
  if (!state.files.length && !paste) {
    toast("Add a file or paste some text first.");
    return;
  }
  const fd = new FormData();
  for (const f of state.files) fd.append("files", f);
  fd.append("text", paste);
  await withBusy($("index-btn"), async () => {
    const data = await postForm("/api/index", fd);
    onIndexed(data);
    toast(`Indexed ${data.count} chunks.`, true);
  });
}

async function loadSample() {
  await withBusy($("sample-btn"), async () => {
    const data = await postJSON("/api/sample", {});
    onIndexed(data);
    toast(`Loaded sample corpus — ${data.count} documents.`, true);
    if (!$("query").value) $("query").value = "gateway GW-09 timeout";
  });
}

function onIndexed(data) {
  state.hasIndex = data.count > 0;
  scene.setNodes(data.nodes);
  const s = $("corpus-status");
  s.textContent = `${data.count} nodes indexed`;
  s.classList.toggle("ready", state.hasIndex);
  $("results-panel").hidden = true;
  $("verdict").textContent = "index ready — run a search";
  scene.clearResults();
  renderGroups();
}

// ── SOURCES legend (color-by-document) ─────────────────────────────────────────
function renderGroups() {
  const groups = scene.getGroups();
  const panel = $("groups");
  const list = $("groups-list");
  list.innerHTML = "";
  // Only worth showing when there's more than one source to distinguish.
  if (groups.length < 2) { panel.hidden = true; return; }
  $("groups-count").textContent = `${groups.length}`;
  for (const g of groups) {
    const el = document.createElement("div");
    el.className = "group-item";
    el.innerHTML = `
      <span class="group-swatch" style="background:${g.colorHex};box-shadow:0 0 8px ${g.colorHex}"></span>
      <span class="group-name" title="${escapeHtml(g.source)}">${escapeHtml(g.source)}</span>
      <span class="group-count">${g.count}</span>`;
    el.addEventListener("mouseenter", () => scene.highlightGroup(g.source, true));
    el.addEventListener("mouseleave", () => scene.highlightGroup(g.source, false));
    el.addEventListener("click", () => scene.focusGroup(g.source));
    list.appendChild(el);
  }
  panel.hidden = false;
}

// ── METHOD picker ──────────────────────────────────────────────────────────
$("methods").addEventListener("click", (e) => {
  const btn = e.target.closest(".method");
  if (!btn) return;
  state.method = btn.dataset.method;
  document.querySelectorAll(".method").forEach((b) => b.classList.toggle("active", b === btn));
  $("alpha-row").hidden = state.method !== "fixed";
  if (state.hasIndex && $("query").value.trim()) runSearch();  // re-fire live
});
$("alpha").addEventListener("input", (e) => {
  state.alpha = parseFloat(e.target.value);
  $("alpha-val").textContent = state.alpha.toFixed(2);
  if (state.method === "fixed" && state.hasIndex && $("query").value.trim())
    debounceSearch();
});

// ── SEARCH ─────────────────────────────────────────────────────────────────
$("search-form").addEventListener("submit", (e) => { e.preventDefault(); runSearch(); });

let _searchTimer = null;
function debounceSearch() {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(runSearch, 180);
}

async function runSearch() {
  const query = $("query").value.trim();
  if (!query) return;
  if (!state.hasIndex) { toast("Load a corpus or index documents first."); return; }
  try {
    const data = await postJSON("/api/search", {
      query, method: state.method, k: 8, alpha: state.alpha,
    });
    renderRouter(data);
    renderPerf(data.timing);
    renderResults(data);
    scene.showResults(data);
  } catch (err) {
    toast(err.message || "Search failed.");
  }
}

// ── Per-search efficiency readout ──────────────────────────────────────────────
function renderPerf(t) {
  const val = $("perf-val");
  const qps = $("perf-qps");
  if (!t) { val.textContent = "—"; qps.textContent = "—"; return; }
  val.textContent = `${t.mean_ms.toFixed(3)} ms`;
  qps.textContent = `${Math.round(t.qps).toLocaleString()} q/s`;
}

// ── Router HUD ──────────────────────────────────────────────────────────────
function renderRouter(data) {
  const needle = $("gauge-needle");
  const readout = $("alpha-readout");
  const verdict = $("verdict");

  if (data.alpha == null) {
    // Rank fusion / bm25 / dense: alpha is not a dense-weight blend.
    const m = data.method;
    const isRank = /^(rrf|wrrf|isr|borda)/.test(m);
    needle.style.left = m.startsWith("dense") ? "100%"
      : m.startsWith("bm25") ? "0%" : "50%";
    readout.textContent = isRank ? "n/a (rank fusion)" : "—";
  } else {
    needle.style.left = `${data.alpha * 100}%`;
    readout.textContent = data.alpha.toFixed(2);
  }

  if (data.lexicality != null) {
    $("lex-bar").style.width = `${data.lexicality * 100}%`;
    $("lex-val").textContent = data.lexicality.toFixed(2);
    verdict.textContent = data.lexicality > 0.55
      ? "▸ lexical query — router leans SPARSE (exact terms)"
      : data.lexicality < 0.35
        ? "▸ conceptual query — router leans DENSE (meaning)"
        : "▸ mixed query — balanced fusion";
  } else {
    $("lex-bar").style.width = "0%";
    $("lex-val").textContent = "—";
    verdict.textContent = `▸ method: ${data.method} (router bypassed)`;
  }
}

// ── Results panel ────────────────────────────────────────────────────────────
function renderResults(data) {
  state.lastResults = data.results;
  const panel = $("results-panel");
  const list = $("results-list");
  $("results-method").textContent = data.method;
  list.innerHTML = "";

  for (const r of data.results) {
    const el = document.createElement("div");
    el.className = "result";
    el.dataset.id = r.id;
    el.innerHTML = `
      <div class="result-head">
        <span class="result-rank">#${r.rank}</span>
        <span class="result-source">${escapeHtml(r.source)}</span>
      </div>
      <div class="result-text">${escapeHtml(r.text)}</div>
      <div class="score-bars">
        ${bar("dense", r.dense)}
        ${bar("sparse", r.sparse)}
        ${bar("fused", r.fused)}
      </div>`;
    el.addEventListener("mouseenter", () => scene.highlight(r.id, true));
    el.addEventListener("mouseleave", () => scene.highlight(r.id, false));
    el.addEventListener("click", () => { scene.focus(r.id); openDetail(r.id, r); });
    list.appendChild(el);
  }
  panel.hidden = data.results.length === 0;
}

function bar(kind, v) {
  const pct = Math.round(Math.max(0, Math.min(1, v)) * 100);
  return `<div class="score-bar ${kind}">
      <span class="lbl">${kind}</span>
      <span class="track"><i style="width:${pct}%"></i></span>
      <span class="num">${v.toFixed(2)}</span>
    </div>`;
}

// ── Node detail popover + hover sync ──────────────────────────────────────────
function openDetail(id, result) {
  const node = scene.byId.get(id);
  if (!node) return;
  $("detail-source").textContent = node.source || "";
  $("detail-text").textContent = node.text || "";
  $("detail").hidden = false;
  // Highlight matching row.
  document.querySelectorAll(".result").forEach((el) =>
    el.classList.toggle("hot", el.dataset.id == id));
}
$("detail-close").addEventListener("click", () => { $("detail").hidden = true; });

function syncHover(id) {
  document.querySelectorAll(".result").forEach((el) =>
    el.classList.toggle("hot", id != null && el.dataset.id == id));
}

// ── Viewport controls (zoom / reset / labels) ─────────────────────────────────
$("zoom-in").addEventListener("click", () => scene.zoomBy(0.75));
$("zoom-out").addEventListener("click", () => scene.zoomBy(1.33));
$("reset-view").addEventListener("click", () => scene.resetView());
$("toggle-labels").addEventListener("click", (e) => {
  const on = !e.currentTarget.classList.contains("active");
  e.currentTarget.classList.toggle("active", on);
  scene.setLabelsVisible(on);
});
$("toggle-web").addEventListener("click", (e) => {
  const on = !e.currentTarget.classList.contains("active");
  e.currentTarget.classList.toggle("active", on);
  scene.setWebVisible(on);
});

// Clear the current search: remove beams/star, reset panels + HUD, refit view.
$("reset-btn").addEventListener("click", resetSearch);
function resetSearch() {
  $("query").value = "";
  scene.clearResults();
  scene.resetView();
  $("results-panel").hidden = true;
  $("detail").hidden = true;
  $("gauge-needle").style.left = "50%";
  $("alpha-readout").textContent = "—";
  $("lex-bar").style.width = "0%";
  $("lex-val").textContent = "—";
  renderPerf(null);
  $("verdict").textContent = state.hasIndex ? "index ready — run a search" : "awaiting query…";
}

// ── Benchmark / Evaluation modal ───────────────────────────────────────────────
const evalModal = $("eval-modal");
let _benchData = null;
$("bench-btn").addEventListener("click", openBenchmark);
$("eval-close").addEventListener("click", () => { evalModal.hidden = true; });
evalModal.addEventListener("click", (e) => { if (e.target === evalModal) evalModal.hidden = true; });

async function openBenchmark() {
  evalModal.hidden = false;
  if (_benchData) { renderBench(_benchData); return; }
  const wrap = $("eval-table-wrap");
  wrap.innerHTML =
    '<div class="eval-loading">▸ running the full sweep across all 14 methods…' +
    '<br><span class="el-sub">(a second or two on the first run)</span></div>';

  // 1) Network.
  let res;
  try {
    res = await fetch("/api/benchmark");
  } catch (err) {
    wrap.innerHTML =
      '<div class="eval-loading">could not reach the server — is it still running?</div>';
    return;
  }
  if (!res.ok) {
    const msg = res.status === 404
      ? "the /api/benchmark endpoint is missing — restart the server to load the new code (Ctrl-C, then ./run.sh)"
      : `server returned HTTP ${res.status}`;
    wrap.innerHTML = `<div class="eval-loading">benchmark unavailable — ${escapeHtml(msg)}</div>`;
    return;
  }

  // 2) Parse + render (separate so a render bug can't masquerade as a network error).
  try {
    const data = await res.json();
    _benchData = data;
    renderBench(data);
  } catch (err) {
    wrap.innerHTML =
      `<div class="eval-loading">could not render results — ${escapeHtml(String(err))}</div>`;
  }
}

function renderBench(data) {
  const c = data.corpus;
  $("eval-sub").innerHTML =
    `Labeled <b>aureon sample corpus</b> · ${c.n_docs} docs · ${c.n_queries} queries ` +
    `(${c.n_lexical} lexical / ${c.n_semantic} semantic) · index build ${c.index_ms.toFixed(1)} ms · ` +
    `latency = ${c.repeat}× repeats`;

  const cols = data.quality_cols;
  const best = {};
  for (const col of cols) best[col] = Math.max(...data.methods.map((m) => m.quality[col]));
  const bestQps = Math.max(...data.methods.map((m) => m.efficiency.qps));

  let h = '<table class="eval-table"><thead><tr><th class="mth">method</th>';
  for (const col of cols) h += `<th title="${col}">${col}</th>`;
  h += '<th>p50 ms</th><th>p95 ms</th><th>QPS</th><th class="vs-h">Δ vs RRF (nDCG@10)</th></tr></thead><tbody>';

  for (const m of data.methods) {
    const fam = m.family.replace(/ /g, "-");
    h += `<tr>`;
    h += `<td class="mth"><span class="fam-dot fam-${fam}"></span>${escapeHtml(m.method)}</td>`;
    for (const col of cols) {
      const v = m.quality[col];
      const cls = Math.abs(v - best[col]) < 1e-9 ? ' class="best"' : "";
      h += `<td${cls}>${v.toFixed(3)}</td>`;
    }
    const e = m.efficiency;
    h += `<td class="dim">${e.p50_ms.toFixed(3)}</td>`;
    h += `<td class="dim">${e.p95_ms.toFixed(3)}</td>`;
    const qcls = Math.abs(e.qps - bestQps) < 1e-9 ? "best" : "dim";
    h += `<td class="${qcls}">${Math.round(e.qps).toLocaleString()}</td>`;
    h += `<td class="vs">${vsCell(m)}</td>`;
    h += "</tr>";
  }
  h += "</tbody></table>";
  $("eval-table-wrap").innerHTML = h;
}

function vsCell(m) {
  if (m.method === "rrf") return '<span class="vs-base">baseline</span>';
  const d = m.vs_rrf.delta, p = m.vs_rrf.p;
  const sig = p < 0.10;
  let dir = "flat", sym = "±";
  if (d > 0.0005) { dir = "up"; sym = "▲"; }
  else if (d < -0.0005) { dir = "down"; sym = "▼"; }
  const star = sig && dir !== "flat" ? ' <b class="sig">✷</b>' : "";
  return `<span class="vs-${dir}">${sym} ${d >= 0 ? "+" : ""}${d.toFixed(3)}</span>` +
         `<span class="vs-p">p=${p.toFixed(2)}${star}</span>`;
}

// ── Help / "How it works" modal ──────────────────────────────────────────────
const helpModal = $("help-modal");
$("help-btn").addEventListener("click", () => { helpModal.hidden = false; });
$("help-close").addEventListener("click", () => { helpModal.hidden = true; });
helpModal.addEventListener("click", (e) => {
  if (e.target === helpModal) helpModal.hidden = true;   // click backdrop to close
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    helpModal.hidden = true; $("detail").hidden = true; $("eval-modal").hidden = true;
  }
});
// Show the explainer automatically on the very first visit.
if (!localStorage.getItem("aureon_seen_help")) {
  helpModal.hidden = false;
  localStorage.setItem("aureon_seen_help", "1");
}

// ── restore on reload ─────────────────────────────────────────────────────────
async function restoreState() {
  try {
    const data = await (await fetch("/api/state")).json();
    if (data.count > 0) onIndexed(data);
  } catch { /* fresh start */ }
  runUrlQuery();
}

// Deep-link a search: ?q=…&method=… runs it once the index is ready (shareable).
function runUrlQuery() {
  const p = new URLSearchParams(location.search);
  const q = p.get("q");
  if (!q || !state.hasIndex) return;
  helpModal.hidden = true;   // a deep-linked query wants results, not the intro
  const m = p.get("method");
  if (m) {
    const btn = document.querySelector(`.method[data-method="${m}"]`);
    if (btn) btn.click();
  }
  $("query").value = q;
  runSearch();
}

// ── fetch helpers ──────────────────────────────────────────────────────────────
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errText(res));
  return res.json();
}
async function postForm(url, fd) {
  const res = await fetch(url, { method: "POST", body: fd });
  if (!res.ok) throw new Error(await errText(res));
  return res.json();
}
async function errText(res) {
  try { return (await res.json()).detail || res.statusText; }
  catch { return res.statusText; }
}
async function withBusy(btn, fn) {
  btn.classList.add("busy");
  try { await fn(); }
  catch (e) { toast(e.message || "Request failed."); }
  finally { btn.classList.remove("busy"); }
}

// ── misc ─────────────────────────────────────────────────────────────────────
let _toastTimer = null;
function toast(msg, ok = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (ok ? " ok" : "");
  t.hidden = false;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
