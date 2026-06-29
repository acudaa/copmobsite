// ---------------------------------------------------------------------------
// TRACE — Content Graph Viewer
// Reads content/manifest.json, loads every need/use_case/case_study item,
// and renders nodes + relation edges on an SVG canvas with pan/zoom, drag,
// search, relation-type + segment filtering, type toggles, and a detail panel.
// ---------------------------------------------------------------------------

const CONTENT_DIR = "content/";
const MANIFEST_PATH = CONTENT_DIR + "manifest.json";

const RELATION_LABELS = {
  addresses:      "addresses",
  instantiates:   "instantiates",
  illustrates:    "illustrates",
  demonstrates:   "demonstrates",
  satisfied_by:   "satisfied by",
  derives_from:   "derives from",
  depends_on:     "depends on",
  conflicts_with: "conflicts with",
  duplicates:     "duplicates",
  consolidates:   "consolidates",
  part_of:        "part of",
  supersedes:     "supersedes",
  related:        "related",
};

const KIND_LABELS = { need: "need", requirement: "requirement", use_case: "use case", case_study: "case study" };
function nodeKindClass(kind){ return kind === "requirement" ? "need" : kind; }

const state = {
  items: new Map(),
  segments: [],
  nodes: [],
  nodesById: new Map(),
  edges: [],
  selectedId: null,
  searchTerm: "",
  relationFilter: "",
  segmentFilter: "",
  kindsOn: { need: true, use_case: true, case_study: true },
  transform: { x: 0, y: 0, k: 1 },
  drag: null,
  panState: null,
};

async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Could not load ${path} (HTTP ${res.status})`);
  return res.json();
}

async function loadAll() {
  const manifest = await fetchJSON(MANIFEST_PATH);
  state.segments = await fetchJSON(CONTENT_DIR + (manifest.segments || "market-segments.json")).catch(() => []);

  const folders = [
    { files: manifest.needs || [], folder: "needs", fallbackKind: "need" },
    { files: manifest.usecases || [], folder: "usecases", fallbackKind: "use_case" },
    { files: manifest.casestudies || [], folder: "casestudies", fallbackKind: "case_study" },
  ];

  const failures = [];
  for (const { files, folder, fallbackKind } of folders) {
    const results = await Promise.allSettled(files.map(f => fetchJSON(CONTENT_DIR + folder + "/" + f)));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        const item = r.value;
        const kind = item.kind || fallbackKind;
        const titleOrStatement = item.title || item.statement;
        if (!item.id || !titleOrStatement) {
          failures.push(`${folder}/${files[i]}: missing required field (id + title/statement)`);
          return;
        }
        item._kind = kind;
        state.items.set(item.id, item);
      } else {
        failures.push(`${folder}/${files[i]}: ${r.reason.message}`);
      }
    });
  }
  return failures;
}

function segName(id) {
  const s = state.segments.find(x => x.id === id);
  return s ? s.name : id;
}

function buildGraph() {
  state.nodes = [];
  state.nodesById.clear();
  state.edges = [];

  for (const item of state.items.values()) {
    const node = { id: item.id, item, x: 0, y: 0, w: 190, h: 64 };
    state.nodes.push(node);
    state.nodesById.set(item.id, node);
  }

  for (const item of state.items.values()) {
    for (const rel of (item.relations || [])) {
      if (!state.items.has(rel.target)) continue;
      state.edges.push({ source: item.id, target: rel.target, type: rel.type });
    }
  }
}

function layoutGraph() {
  const idx = state.nodesById;
  const n = state.nodes.length;
  if (n === 0) return;

  const R = 60 + n * 22;
  state.nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / n;
    node.x = Math.cos(angle) * R;
    node.y = Math.sin(angle) * R;
  });

  const iterations = 400;
  const k = 230;
  const minSep = 230;
  for (let iter = 0; iter < iterations; iter++) {
    const forces = new Map();
    state.nodes.forEach(node => forces.set(node.id, { fx: 0, fy: 0 }));

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = state.nodes[i], b = state.nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let dist2 = dx * dx + dy * dy;
        if (dist2 < 1) dist2 = 1;
        const dist = Math.sqrt(dist2);
        const force = (k * k) / dist2;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        forces.get(a.id).fx += fx; forces.get(a.id).fy += fy;
        forces.get(b.id).fx -= fx; forces.get(b.id).fy -= fy;
      }
    }

    state.edges.forEach(e => {
      const a = idx.get(e.source), b = idx.get(e.target);
      if (!a || !b) return;
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist * dist) / k / 6;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      forces.get(a.id).fx += fx; forces.get(a.id).fy += fy;
      forces.get(b.id).fx -= fx; forces.get(b.id).fy -= fy;
    });

    const cooling = Math.max(0.02, 1 - iter / iterations);
    state.nodes.forEach(node => {
      const f = forces.get(node.id);
      node.x += Math.max(-14, Math.min(14, f.fx * 0.02)) * cooling;
      node.y += Math.max(-14, Math.min(14, f.fy * 0.02)) * cooling;
    });
  }

  for (let pass = 0; pass < 40; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = state.nodes[i], b = state.nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
        if (dist < minSep) {
          const push = (minSep - dist) / 2;
          const ux = dx / dist, uy = dy / dist;
          a.x -= ux * push; a.y -= uy * push;
          b.x += ux * push; b.y += uy * push;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
}

const svg = document.getElementById("graph");
const viewport = document.getElementById("viewport");
const edgesLayer = document.getElementById("edges-layer");
const nodesLayer = document.getElementById("nodes-layer");
const statusEl = document.getElementById("status");
const overlayMsg = document.getElementById("overlay-msg");

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function wrapText(text, maxChars) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
    if (lines.length === 2) break;
  }
  if (cur && lines.length < 2) lines.push(cur);
  return lines.slice(0, 2);
}

function nodeAnchorPoint(node, towardX, towardY) {
  const dx = towardX - node.x, dy = towardY - node.y;
  const hw = node.w / 2, hh = node.h / 2;
  if (dx === 0 && dy === 0) return { x: node.x, y: node.y + hh };
  const scaleX = hw / Math.abs(dx || 1e-6);
  const scaleY = hh / Math.abs(dy || 1e-6);
  const scale = Math.min(scaleX, scaleY);
  return { x: node.x + dx * scale, y: node.y + dy * scale };
}

function orthogonalPath(p1, p2) {
  const midX = (p1.x + p2.x) / 2;
  return `M ${p1.x} ${p1.y} L ${midX} ${p1.y} L ${midX} ${p2.y} L ${p2.x} ${p2.y}`;
}

function itemSummaryText(item) {
  return item.summary || item.statement || item.description || item.narrative || "";
}

function nodeMatchesSegmentFilter(item) {
  if (!state.segmentFilter) return true;
  const segs = (item.classification && item.classification.market_segments) || [];
  return segs.includes(state.segmentFilter);
}

function render() {
  edgesLayer.innerHTML = "";
  nodesLayer.innerHTML = "";

  const filterActive = state.relationFilter !== "";
  const searchActive = state.searchTerm.trim() !== "";
  const term = state.searchTerm.trim().toLowerCase();

  function nodeHidden(n) {
    if (!state.kindsOn[nodeKindClass(n.item._kind)]) return true;
    if (!nodeMatchesSegmentFilter(n.item)) return true;
    return false;
  }

  const visibleIds = new Set(state.nodes.filter(n => !nodeHidden(n)).map(n => n.id));

  const matchedIds = new Set();
  if (searchActive) {
    state.nodes.forEach(n => {
      if (!visibleIds.has(n.id)) return;
      const hay = (n.id + " " + (n.item.title || "") + " " + itemSummaryText(n.item)).toLowerCase();
      if (hay.includes(term)) matchedIds.add(n.id);
    });
  }

  let relatedToSelected = null;
  if (state.selectedId && visibleIds.has(state.selectedId)) {
    relatedToSelected = new Set([state.selectedId]);
    state.edges.forEach(e => {
      if (e.source === state.selectedId) relatedToSelected.add(e.target);
      if (e.target === state.selectedId) relatedToSelected.add(e.source);
    });
  }

  state.edges.forEach(e => {
    const a = state.nodesById.get(e.source);
    const b = state.nodesById.get(e.target);
    if (!a || !b) return;
    if (!visibleIds.has(a.id) || !visibleIds.has(b.id)) return;

    const typeMatch = !filterActive || e.type === state.relationFilter;
    const touchesSelection = relatedToSelected &&
      (e.source === state.selectedId || e.target === state.selectedId);
    const touchesSearch = searchActive && (matchedIds.has(e.source) && matchedIds.has(e.target));

    let dimmed = false;
    if (filterActive && !typeMatch) dimmed = true;
    if (searchActive && !touchesSearch) dimmed = true;
    if (state.selectedId && !touchesSelection) dimmed = true;

    const highlighted = touchesSelection && !dimmed;

    const p1 = nodeAnchorPoint(a, b.x, b.y);
    const p2 = nodeAnchorPoint(b, a.x, a.y);

    const path = svgEl("path", {
      class: "edge-path" + (dimmed ? " dimmed" : "") + (highlighted ? " highlighted" : ""),
      d: orthogonalPath(p1, p2),
      "marker-end": highlighted ? "url(#arrow-highlight)" : "url(#arrow)",
    });
    edgesLayer.appendChild(path);

    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    const label = RELATION_LABELS[e.type] || e.type;
    const labelWidth = Math.max(46, label.length * 5.6 + 10);

    const bg = svgEl("rect", {
      class: "edge-label-bg" + (highlighted ? " highlighted" : ""),
      x: midX - labelWidth / 2, y: midY - 8, width: labelWidth, height: 16, rx: 2,
      style: dimmed ? "opacity:0.12" : "",
    });
    const text = svgEl("text", {
      class: "edge-label" + (highlighted ? " highlighted" : ""),
      x: midX, y: midY + 3.5,
      style: dimmed ? "opacity:0.12" : "",
    });
    text.textContent = label;
    edgesLayer.appendChild(bg);
    edgesLayer.appendChild(text);
  });

  state.nodes.forEach(node => {
    if (!visibleIds.has(node.id)) return;
    const item = node.item;
    const kindClass = nodeKindClass(item._kind);
    const g = svgEl("g", {
      class: "node-group " + kindClass +
        (node.id === state.selectedId ? " selected" : "") +
        (searchActive && !matchedIds.has(node.id) ? " dimmed" : "") +
        (state.selectedId && relatedToSelected && !relatedToSelected.has(node.id) ? " dimmed" : ""),
      transform: `translate(${node.x - node.w / 2}, ${node.y - node.h / 2})`,
      tabindex: "0",
      role: "button",
      "aria-label": `${KIND_LABELS[item._kind] || item._kind} ${item.id}: ${item.title || item.summary || itemSummaryText(item)}`,
      "data-id": node.id,
    });

    const shape = kindClass === "need"
      ? svgEl("rect", { class: "node-shape", x: 0, y: 0, width: node.w, height: node.h, rx: node.h / 2 })
      : svgEl("rect", { class: "node-shape", x: 0, y: 0, width: node.w, height: node.h, rx: 4 });
    g.appendChild(shape);

    const tag = svgEl("text", { class: "node-kind-tag", x: 10, y: 13 });
    tag.textContent = (KIND_LABELS[item._kind] || item._kind).toUpperCase();
    g.appendChild(tag);

    const idText = svgEl("text", { class: "node-id", x: 10, y: 28 });
    idText.textContent = node.id;
    g.appendChild(idText);

    const titleSrc = item.title || item.summary || (item.statement || "").replace(/[*_`#]/g, "");
    const lines = wrapText(titleSrc, 30);
    lines.forEach((line, i) => {
      const t = svgEl("text", { class: "node-summary", x: 10, y: 42 + i * 12 });
      t.textContent = line;
      g.appendChild(t);
    });

    g.addEventListener("mousedown", (ev) => startNodeDrag(ev, node));
    g.addEventListener("click", (ev) => {
      if (state.drag && state.drag.moved) return;
      ev.stopPropagation();
      selectNode(node.id);
    });
    g.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); selectNode(node.id); }
    });

    nodesLayer.appendChild(g);
  });

  applyTransform();
}

function applyTransform() {
  const t = state.transform;
  viewport.setAttribute("transform", `translate(${t.x},${t.y}) scale(${t.k})`);
}

function screenToWorld(clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  const x = clientX - rect.left, y = clientY - rect.top;
  return {
    x: (x - state.transform.x) / state.transform.k,
    y: (y - state.transform.y) / state.transform.k,
  };
}

function fitToView() {
  const visible = state.nodes.filter(n => state.kindsOn[nodeKindClass(n.item._kind)] && nodeMatchesSegmentFilter(n.item));
  if (!visible.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  visible.forEach(n => {
    minX = Math.min(minX, n.x - n.w / 2);
    minY = Math.min(minY, n.y - n.h / 2);
    maxX = Math.max(maxX, n.x + n.w / 2);
    maxY = Math.max(maxY, n.y + n.h / 2);
  });
  const rect = svg.getBoundingClientRect();
  const pad = 60;
  const graphW = (maxX - minX) || 1, graphH = (maxY - minY) || 1;
  const k = Math.min((rect.width - pad * 2) / graphW, (rect.height - pad * 2) / graphH, 1.4);
  state.transform.k = Math.max(0.08, k);
  state.transform.x = rect.width / 2 - ((minX + maxX) / 2) * state.transform.k;
  state.transform.y = rect.height / 2 - ((minY + maxY) / 2) * state.transform.k;
  applyTransform();
}

svg.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const rect = svg.getBoundingClientRect();
  const cx = ev.clientX - rect.left, cy = ev.clientY - rect.top;
  const before = screenToWorld(ev.clientX, ev.clientY);
  const delta = -ev.deltaY * 0.0014;
  const newK = Math.min(4, Math.max(0.06, state.transform.k * (1 + delta)));
  state.transform.k = newK;
  state.transform.x = cx - before.x * newK;
  state.transform.y = cy - before.y * newK;
  applyTransform();
}, { passive: false });

svg.addEventListener("mousedown", (ev) => {
  if (ev.target.closest(".node-group")) return;
  state.panState = { startX: ev.clientX, startY: ev.clientY, origX: state.transform.x, origY: state.transform.y };
  svg.classList.add("panning");
  deselect();
});

window.addEventListener("mousemove", (ev) => {
  if (state.panState) {
    const dx = ev.clientX - state.panState.startX;
    const dy = ev.clientY - state.panState.startY;
    state.transform.x = state.panState.origX + dx;
    state.transform.y = state.panState.origY + dy;
    applyTransform();
  } else if (state.drag) {
    const world = screenToWorld(ev.clientX, ev.clientY);
    state.drag.node.x = world.x - state.drag.offsetX;
    state.drag.node.y = world.y - state.drag.offsetY;
    state.drag.moved = true;
    render();
  }
});

window.addEventListener("mouseup", () => {
  state.panState = null;
  svg.classList.remove("panning");
  if (state.drag) {
    setTimeout(() => { state.drag = null; }, 0);
  }
});

function startNodeDrag(ev, node) {
  ev.stopPropagation();
  const world = screenToWorld(ev.clientX, ev.clientY);
  state.drag = { node, offsetX: world.x - node.x, offsetY: world.y - node.y, moved: false };
}

document.getElementById("zoom-in").addEventListener("click", () => zoomBy(1.25));
document.getElementById("zoom-out").addEventListener("click", () => zoomBy(0.8));
document.getElementById("zoom-reset").addEventListener("click", fitToView);

function zoomBy(factor) {
  const rect = svg.getBoundingClientRect();
  const cx = rect.width / 2, cy = rect.height / 2;
  const worldX = (cx - state.transform.x) / state.transform.k;
  const worldY = (cy - state.transform.y) / state.transform.k;
  state.transform.k = Math.min(4, Math.max(0.06, state.transform.k * factor));
  state.transform.x = cx - worldX * state.transform.k;
  state.transform.y = cy - worldY * state.transform.k;
  applyTransform();
}

const panel = document.getElementById("panel");
const panelInner = document.getElementById("panel-inner");

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/\n/g, "<br>");
  return html;
}

function selectNode(id) {
  state.selectedId = id;
  render();
  openPanel(id);
}

function deselect() {
  if (state.selectedId) {
    state.selectedId = null;
    render();
  }
  closePanel();
}

function closePanel() {
  panel.classList.remove("open");
  panel.setAttribute("aria-hidden", "true");
}

function openPanel(id) {
  const item = state.items.get(id);
  if (!item) return;

  const incoming = state.edges.filter(e => e.target === id);
  const outgoing = state.edges.filter(e => e.source === id);
  const kindClass = nodeKindClass(item._kind);

  const body = item.statement || item.description || item.narrative || "";

  let html = `<button class="close-btn" id="panel-close" aria-label="Close panel">close ✕</button>`;
  html += `<div class="panel-kind ${kindClass}">${escapeHtml(KIND_LABELS[item._kind] || item._kind)}</div>`;
  html += `<h2>${escapeHtml(item.title || item.id)}</h2>`;
  html += `<div class="summary" style="font-family:var(--mono);font-size:10.5px;">${escapeHtml(item.id)}</div>`;
  if (item.summary) html += `<p class="summary">${escapeHtml(item.summary)}</p>`;
  if (body) html += `<div class="statement">${renderMarkdown(body)}</div>`;

  html += `<div class="field-row">`;
  if (item.status) html += `<span class="pill">status: ${escapeHtml(item.status)}</span>`;
  if (item.maturity) html += `<span class="pill">maturity: ${escapeHtml(item.maturity)}</span>`;
  if (item.priority) html += `<span class="pill">priority: ${escapeHtml(item.priority)}</span>`;
  if (item.confidence) html += `<span class="pill">confidence: ${escapeHtml(item.confidence)}</span>`;
  html += `</div>`;

  const segs = (item.classification && item.classification.market_segments) || [];
  const products = (item.classification && item.classification.products) || [];
  if (segs.length) html += `<div class="field-row">` + segs.map(s => `<span class="pill">${escapeHtml(segName(s))}</span>`).join("") + `</div>`;
  if (products.length) html += `<div class="field-row">` + products.map(p => `<span class="pill">${escapeHtml(p)}</span>`).join("") + `</div>`;

  if (item.tags && item.tags.length) {
    html += `<div class="field-row">` + item.tags.map(t => `<span class="pill">#${escapeHtml(t)}</span>`).join("") + `</div>`;
  }

  if (item.rationale) {
    html += `<h3>Rationale</h3><div class="statement">${renderMarkdown(item.rationale)}</div>`;
  }

  if (outgoing.length || incoming.length) {
    html += `<h3>Relations</h3><ul class="rel-list">`;
    outgoing.forEach(e => {
      const label = RELATION_LABELS[e.type] || e.type;
      const t = state.items.get(e.target);
      html += `<li data-jump="${escapeHtml(e.target)}"><span class="arrow">→</span> <span class="rel-type">${escapeHtml(label)}</span> ${escapeHtml(e.target)}${t ? `<span class="rel-kind">${escapeHtml(KIND_LABELS[t._kind]||t._kind)}</span>` : ""}</li>`;
    });
    incoming.forEach(e => {
      const label = RELATION_LABELS[e.type] || e.type;
      const s = state.items.get(e.source);
      html += `<li data-jump="${escapeHtml(e.source)}"><span class="arrow">←</span> <span class="rel-type">${escapeHtml(label)} (from)</span> ${escapeHtml(e.source)}${s ? `<span class="rel-kind">${escapeHtml(KIND_LABELS[s._kind]||s._kind)}</span>` : ""}</li>`;
    });
    html += `</ul>`;
  }

  if (item.stakeholders && item.stakeholders.length) {
    html += `<h3>Stakeholders</h3><ul class="stakeholder-list">`;
    item.stakeholders.forEach(s => {
      html += `<li>${escapeHtml(s.name)}${s.role ? `<br><span class="role">${escapeHtml(s.role)}</span>` : ""}</li>`;
    });
    html += `</ul>`;
  }

  if (item.sources && item.sources.length) {
    html += `<h3>Sources</h3><ul class="source-list">`;
    item.sources.forEach(s => {
      html += `<li><span class="type">${escapeHtml(s.type)}</span><br>${escapeHtml(s.reference)}${s.date ? ` &middot; ${escapeHtml(s.date)}` : ""}</li>`;
    });
    html += `</ul>`;
  }

  if (item.attributes && Object.keys(item.attributes).length) {
    html += `<h3>Attributes</h3><table class="attr-table">`;
    for (const [k, v] of Object.entries(item.attributes)) {
      html += `<tr><td class="key">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`;
    }
    html += `</table>`;
  }

  if (item.history && item.history.length) {
    html += `<h3>History</h3>`;
    item.history.forEach(h => {
      html += `<div class="history-item"><span class="ts">${escapeHtml(h.timestamp)}</span> &middot; <span class="author">${escapeHtml(h.author)}</span>`;
      if (h.comment) html += `<br>${escapeHtml(h.comment)}`;
      html += `</div>`;
    });
  }

  panelInner.innerHTML = html;
  panel.classList.add("open");
  panel.setAttribute("aria-hidden", "false");

  document.getElementById("panel-close").addEventListener("click", deselect);
  panelInner.querySelectorAll("[data-jump]").forEach(li => {
    li.addEventListener("click", () => {
      const targetId = li.getAttribute("data-jump");
      if (state.items.has(targetId)) selectNode(targetId);
    });
  });
}

document.getElementById("search").addEventListener("input", (ev) => {
  state.searchTerm = ev.target.value;
  render();
});

document.getElementById("relation-filter").addEventListener("change", (ev) => {
  state.relationFilter = ev.target.value;
  render();
});

document.getElementById("segment-filter").addEventListener("change", (ev) => {
  state.segmentFilter = ev.target.value;
  render();
  fitToView();
  updateStatus();
});

document.getElementById("legend").addEventListener("click", (ev) => {
  const item = ev.target.closest(".item");
  if (!item) return;
  const kind = item.getAttribute("data-kind");
  state.kindsOn[kind] = !state.kindsOn[kind];
  item.classList.toggle("off", !state.kindsOn[kind]);
  const sel = state.selectedId ? state.items.get(state.selectedId) : null;
  if (sel && nodeKindClass(sel._kind) === kind && !state.kindsOn[kind]) {
    deselect();
  }
  render();
  updateStatus();
});

function populateRelationFilter() {
  const select = document.getElementById("relation-filter");
  const present = new Set(state.edges.map(e => e.type));
  [...present].sort().forEach(type => {
    const opt = document.createElement("option");
    opt.value = type;
    opt.textContent = RELATION_LABELS[type] || type;
    select.appendChild(opt);
  });
}

function populateSegmentFilter() {
  const select = document.getElementById("segment-filter");
  const present = new Set();
  state.items.forEach(item => (item.classification && item.classification.market_segments || []).forEach(s => present.add(s)));
  [...present].sort((a, b) => segName(a).localeCompare(segName(b))).forEach(segId => {
    const opt = document.createElement("option");
    opt.value = segId;
    opt.textContent = segName(segId);
    select.appendChild(opt);
  });
}

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") deselect();
});

function updateStatus() {
  const visible = state.nodes.filter(n => state.kindsOn[nodeKindClass(n.item._kind)] && nodeMatchesSegmentFilter(n.item));
  const needCount = visible.filter(n => nodeKindClass(n.item._kind) === "need").length;
  const ucCount = visible.filter(n => n.item._kind === "use_case").length;
  const csCount = visible.filter(n => n.item._kind === "case_study").length;
  statusEl.textContent = `${needCount} needs · ${ucCount} use cases · ${csCount} case studies · ${state.edges.length} relations`;
}

async function boot() {
  overlayMsg.textContent = "Loading manifest…";
  try {
    const failures = await loadAll();
    if (state.items.size === 0) {
      overlayMsg.textContent = "No items could be loaded. Check content/manifest.json and referenced JSON files.";
      overlayMsg.classList.add("error");
      statusEl.textContent = "0 items";
      return;
    }

    buildGraph();
    layoutGraph();
    populateRelationFilter();
    populateSegmentFilter();
    render();
    fitToView();

    overlayMsg.textContent = "";
    updateStatus();

    if (failures.length) {
      statusEl.textContent += ` · ${failures.length} file(s) failed to load (see console)`;
      console.warn("TRACE: some manifest entries failed to load:\n" + failures.join("\n"));
    }
  } catch (err) {
    overlayMsg.textContent = "Failed to load: " + err.message +
      "\n\nMake sure this page is served over http(s) (not opened directly as a file://) " +
      "and that content/manifest.json exists.";
    overlayMsg.classList.add("error");
    statusEl.textContent = "error";
    console.error(err);
  }
}

window.addEventListener("resize", () => { /* layout stays; user can re-fit */ });

boot();
