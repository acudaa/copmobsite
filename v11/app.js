// Shared helpers for Copernicus for Transport site
let SITE = null;
const CONTENT_BASE = 'content/';
async function fetchJSON(path){
  const r = await fetch(path);
  if (!r.ok) throw new Error('Failed to load ' + path + ' (' + r.status + ')');
  return r.json();
}

// Walk a product's 'parent' chain up to the root. Mirrors product_taxonomy.py
// so the front end can resolve a tag at ANY taxonomy level (mission/product/
// sub-product) uniformly, without needing the precomputed products.index.json.
function productAncestors(productsById, pid){
  const out = []; let cur = productsById.get(pid);
  while (cur && cur.parent) { out.push(cur.parent); cur = productsById.get(cur.parent); }
  return out;
}

// Assemble the site from per-item content files listed in content/manifest.json,
// then resolve the relation graph into convenient reverse-edge arrays so page
// code can keep doing simple array lookups instead of scanning relations itself.
async function loadContent() {
  if (SITE) return SITE;
  const m = await fetchJSON(CONTENT_BASE + 'manifest.json');
  const [site, products, segments] = await Promise.all([
    fetchJSON(CONTENT_BASE + (m.site || 'site.json')),
    fetchJSON(CONTENT_BASE + (m.products || 'products.json')),
    fetchJSON(CONTENT_BASE + (m.segments || 'market-segments.json')),
  ]);
  const loadAll = (type) => Promise.all((m[type] || []).map(
    f => fetchJSON(CONTENT_BASE + type + '/' + f).catch(err => { console.error(err); return null; })
  )).then(arr => arr.filter(Boolean));
  const [needs, usecases, casestudies, tools, news] = await Promise.all([
    loadAll('needs'), loadAll('usecases'), loadAll('casestudies'), loadAll('tools'), loadAll('news'),
  ]);

  const data = { site, products, segments, needs, usecases, casestudies, tools, news, _manifest: m };
  resolveGraph(data);
  SITE = data;
  return SITE;
}

// Builds reverse/forward lookup arrays from the typed relations[] graph so existing
// render code can read e.g. `usecase._caseStudies` or `need._usecases` directly,
// the same way the old site read `usecase.relatedCaseStudies` or `need.usecases`.
// Also expands classification.products tags by taxonomy ancestry for filtering.
function resolveGraph(data){
  const byId = new Map();
  [...data.needs, ...data.usecases, ...data.casestudies, ...data.tools].forEach(it => byId.set(it.id, it));
  data.needs.forEach(n => { n._usecases = []; });
  data.usecases.forEach(u => { u._caseStudies = []; u._needs = []; });
  data.casestudies.forEach(c => { c._usecases = []; });

  data.usecases.forEach(u => {
    (u.relations || []).forEach(rel => {
      if (rel.type === 'addresses' && (rel.target_kind === 'need' || rel.target_kind === 'requirement')) {
        const need = byId.get(rel.target);
        if (need) { need._usecases.push(u.id); u._needs.push(need.id); }
      }
    });
  });
  data.casestudies.forEach(c => {
    (c.relations || []).forEach(rel => {
      if (rel.type === 'instantiates' && rel.target_kind === 'use_case') {
        const uc = byId.get(rel.target);
        if (uc) { uc._caseStudies.push(c.id); c._usecases.push(uc.id); }
      }
    });
  });

  const productsById = new Map(data.products.map(p => [p.id, p]));
  [...data.needs, ...data.usecases, ...data.casestudies, ...data.tools].forEach(it => {
    const tags = (it.classification && it.classification.products) || [];
    const expanded = new Set();
    tags.forEach(pid => { expanded.add(pid); productAncestors(productsById, pid).forEach(a => expanded.add(a)); });
    it._productsExpanded = [...expanded];
  });
}

// Convenience: the single market segment id a use case/case study/need belongs
// to. The schema allows classification.market_segments to hold more than one,
// but this site's content model is currently 1 segment per item; pages that
// need multi-segment support later can read classification.market_segments directly.
function primarySegmentId(item){
  const ms = item.classification && item.classification.market_segments;
  return ms && ms[0];
}
function segmentById(data, id){ return data.segments.find(s => s.id === id); }

function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

// Resolves a product id (any taxonomy level) to a themed badge, coloured by
// taxonomy family. Falls back to a generic style + the raw id if not found.
const PRODUCT_BADGE_COLORS = {
  copernicus_sentinel: { color:'#185FA5', bg:'#E6F1FB' },
  copernicus_service:  { color:'#27500A', bg:'#EAF3DE' },
  copernicus_contributing: { color:'#633806', bg:'#FAEEDA' },
  reanalysis: { color:'#3C3489', bg:'#EEEDFE' },
  commercial: { color:'#791F1F', bg:'#FCEBEB' },
  in_situ: { color:'#085041', bg:'#E1F5EE' },
  other: { color:'#444', bg:'#ECEAE5' },
};
function svcBadge(data, id){
  const p = data.products.find(x => x.id === id);
  if (!p) return `<span class="badge" style="background:var(--bg-subtle);color:var(--text-muted)">${esc(id)}</span>`;
  const theme = PRODUCT_BADGE_COLORS[p.family] || PRODUCT_BADGE_COLORS.other;
  return `<span class="badge" title="${esc(p.url || '')}" style="background:${theme.bg};color:${theme.color}">${esc(p.name)}</span>`;
}
function segBadge(seg){
  const s = (seg && seg.site) || {};
  return `<span class="badge" style="background:${s.color_bg || 'var(--bg-subtle)'};color:${s.color_text || 'var(--text-muted)'}">${esc(seg.name)}</span>`;
}
function maturityBadge(m){
  const label = { concept:'Concept', pilot:'Pilot', demonstrated:'Demonstrated', operational:'Operational', scaled:'Scaled' }[m] || esc(m);
  return `<span class="maturity ${esc(m)}">${label}</span>`;
}
// Integration-mode pill for "role of Copernicus" on use cases, read from the
// site-specific classification.site extension (see common.schema.json#/$defs/classification).
function modeBadge(mode){
  const m = (mode||'').toLowerCase();
  let cls = 'mode-fusion';
  if (m.startsWith('directly')) cls = 'mode-direct';
  else if (m.startsWith('requires')) cls = 'mode-process';
  else if (m.includes('processing')) cls = 'mode-mixed';
  return `<span class="mode-badge ${cls}">${esc(mode)}</span>`;
}

function renderNav(data, active){
  const segItems = data.segments.filter(s => s.site).map(s => `<a href="segments.html?segment=${s.id}" role="menuitem">${esc(s.name)}</a>`).join('');
  return `
    <a href="index.html" class="nav-logo">
      <div class="nav-logo-mark">🛰</div>
      <span>Copernicus <span class="nav-logo-sub">for Transport</span></span>
    </a>
    <div class="nav-links">
      <a href="index.html" ${active==='index'?'class="active"':''}>Home</a>
      <div class="nav-dd">
        <a href="segments.html" class="nav-dd-trigger ${active==='segments'?'active':''}">Segments <span class="dd-caret">▾</span></a>
        <div class="nav-dd-menu" role="menu">
          <a href="segments.html" role="menuitem" class="dd-all">All segments — overview</a>
          ${segItems}
        </div>
      </div>
      <a href="needs.html" ${active==='needs'?'class="active"':''}>User needs</a>
      <a href="usecases.html" ${active==='usecases'?'class="active"':''}>Use cases</a>
      <a href="casestudies.html" ${active==='casestudies'?'class="active"':''}>Case studies</a>
      <a href="products.html" ${active==='products'?'class="active"':''}>Products</a>
      <a href="tools.html" ${active==='tools'?'class="active"':''}>Tools</a>
      <a href="news.html" ${active==='news'?'class="active"':''}>News</a>
      <a href="about.html" ${active==='about'?'class="active"':''}>About</a>
    </div>
    <a href="${data.site.copernicusUrl}" target="_blank" rel="noopener" class="nav-ext">↗ EUSPA Copernicus</a>
  `;
}
function renderFooter(data){
  const themedSegments = data.segments.filter(s => s.site);
  return `
    <div class="footer-inner">
      <div class="footer-brand"><strong>${esc(data.site.title)}</strong>${esc(data.site.tagline)}</div>
      <div class="footer-links"><h4>Explore</h4><ul>
        <li><a href="segments.html">Segments</a></li>
        <li><a href="needs.html">User needs</a></li>
        <li><a href="usecases.html">Use cases</a></li>
        <li><a href="casestudies.html">Case studies</a></li>
        <li><a href="products.html">Products</a></li>
        <li><a href="tools.html">Tools</a></li>
        <li><a href="news.html">News</a></li>
        <li><a href="about.html">About</a></li>
      </ul></div>
      <div class="footer-links"><h4>Segments</h4><ul>${themedSegments.map(s => `<li><a href="segments.html?segment=${s.id}">${esc(s.name)}</a></li>`).join('')}</ul></div>
      <div class="footer-links"><h4>Copernicus services</h4><ul>${data.products.filter(p=>p.level==='service').map(p => `<li><a href="${esc(p.url||'#')}" target="_blank" rel="noopener">${esc(p.name)}</a></li>`).join('')}</ul></div>
    </div>
    <div class="footer-bottom">A EUSPA market-uptake resource · Built on free and open Copernicus data · <a href="admin.html">Admin</a></div>
  `;
}
function mountChrome(data, active){
  const nav = document.getElementById('sitenav'); if (nav) nav.innerHTML = renderNav(data, active);
  const ft = document.getElementById('sitefooter'); if (ft) ft.innerHTML = renderFooter(data);
}

// Minimal filter BUTTONS that filter client-side (no reload). onSelect(segId) on click.
// Only segments with a 'site' block (the 5 themed transport segments) are offered as
// filters; vocabulary-only segments (e.g. 'infrastructure') have no listing page yet.
function buildFilterButtons(container, data, active, onSelect){
  const themed = data.segments.filter(s => s.site);
  const opts = [{ id:'all', name:'All segments' }, ...themed.map(s => ({ id:s.id, name:s.name }))];
  container.innerHTML = opts.map(o =>
    `<button type="button" class="filter-btn ${active===o.id?'active':''}" data-seg="${o.id}">${esc(o.name)}</button>`
  ).join('');
  container.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const seg = btn.getAttribute('data-seg');
      const url = new URL(location.href);
      if (seg === 'all') url.searchParams.delete('segment'); else url.searchParams.set('segment', seg);
      history.replaceState(null, '', url);
      onSelect(seg);
    });
  });
}
