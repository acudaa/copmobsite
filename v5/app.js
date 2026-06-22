// Shared helpers for Copernicus for Transport site
let SITE = null;
const CONTENT_BASE = 'content/';
async function fetchJSON(path){
  const r = await fetch(path);
  if (!r.ok) throw new Error('Failed to load ' + path + ' (' + r.status + ')');
  return r.json();
}
// Assemble the site from per-item content files listed in content/manifest.json.
// Returns the same shape the pages expect: {site, services, segments, usecases, casestudies, news}.
async function loadContent() {
  if (SITE) return SITE;
  const m = await fetchJSON(CONTENT_BASE + 'manifest.json');
  const [site, services, segments] = await Promise.all([
    fetchJSON(CONTENT_BASE + (m.site || 'site.json')),
    fetchJSON(CONTENT_BASE + (m.services || 'services.json')),
    fetchJSON(CONTENT_BASE + (m.segments || 'segments.json')),
  ]);
  const loadAll = (type) => Promise.all((m[type] || []).map(
    f => fetchJSON(CONTENT_BASE + type + '/' + f).catch(err => { console.error(err); return null; })
  )).then(arr => arr.filter(Boolean));
  const [usecases, casestudies, news] = await Promise.all([
    loadAll('usecases'), loadAll('casestudies'), loadAll('news'),
  ]);
  SITE = { site, services, segments, usecases, casestudies, news, _manifest: m };
  return SITE;
}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

function svcBadge(data, id){
  const svc = data.services.find(s => s.id === id);
  if (svc) return `<span class="badge" style="background:${svc.bg};color:${svc.color}">${svc.id}</span>`;
  return `<span class="badge" style="background:var(--bg-subtle);color:var(--text-muted)">${esc(id)}</span>`;
}
function segBadge(seg){ return `<span class="badge" style="background:${seg.colorBg};color:${seg.colorText}">${esc(seg.name)}</span>`; }
function maturityBadge(m){
  const label = { research:'Research', trial:'Trial', operational:'Operational' }[m] || esc(m);
  return `<span class="maturity ${esc(m)}">${label}</span>`;
}
// Integration-mode pill for "role of Copernicus" on use cases
function modeBadge(mode){
  const m = (mode||'').toLowerCase();
  let cls = 'mode-fusion';
  if (m.startsWith('directly')) cls = 'mode-direct';
  else if (m.startsWith('requires')) cls = 'mode-process';
  else if (m.includes('processing')) cls = 'mode-mixed';
  return `<span class="mode-badge ${cls}">${esc(mode)}</span>`;
}

function renderNav(data, active){
  const segItems = data.segments.map(s => `<a href="segments.html?segment=${s.id}" role="menuitem">${esc(s.name)}</a>`).join('');
  const pages = [
    { id:'index', label:'Home', href:'index.html' },
    { id:'usecases', label:'Use cases', href:'usecases.html' },
    { id:'casestudies', label:'Case studies', href:'casestudies.html' },
    { id:'news', label:'News', href:'news.html' },
    { id:'about', label:'About', href:'about.html' }
  ];
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
      <a href="usecases.html" ${active==='usecases'?'class="active"':''}>Use cases</a>
      <a href="casestudies.html" ${active==='casestudies'?'class="active"':''}>Case studies</a>
      <a href="news.html" ${active==='news'?'class="active"':''}>News</a>
      <a href="about.html" ${active==='about'?'class="active"':''}>About</a>
    </div>
    <a href="${data.site.copernicusUrl}" target="_blank" rel="noopener" class="nav-ext">↗ EUSPA Copernicus</a>
  `;
}
function renderFooter(data){
  return `
    <div class="footer-inner">
      <div class="footer-brand"><strong>${esc(data.site.title)}</strong>${esc(data.site.tagline)}</div>
      <div class="footer-links"><h4>Explore</h4><ul>
        <li><a href="segments.html">Segments</a></li>
        <li><a href="usecases.html">Use cases</a></li>
        <li><a href="casestudies.html">Case studies</a></li>
        <li><a href="news.html">News</a></li>
        <li><a href="about.html">About</a></li>
      </ul></div>
      <div class="footer-links"><h4>Segments</h4><ul>${data.segments.map(s => `<li><a href="segments.html?segment=${s.id}">${esc(s.name)}</a></li>`).join('')}</ul></div>
      <div class="footer-links"><h4>Copernicus services</h4><ul>${data.services.filter(s=>s.id!=='Sentinel').map(s => `<li><a href="${s.url}" target="_blank" rel="noopener">${s.id}</a></li>`).join('')}</ul></div>
    </div>
    <div class="footer-bottom">A EUSPA market-uptake resource · Built on free and open Copernicus data · <a href="admin.html">Admin</a></div>
  `;
}
function mountChrome(data, active){
  const nav = document.getElementById('sitenav'); if (nav) nav.innerHTML = renderNav(data, active);
  const ft = document.getElementById('sitefooter'); if (ft) ft.innerHTML = renderFooter(data);
}

// Minimal filter BUTTONS that filter client-side (no reload). onSelect(segId) on click.
function buildFilterButtons(container, data, active, onSelect){
  const opts = [{ id:'all', name:'All segments' }, ...data.segments.map(s => ({ id:s.id, name:s.name }))];
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
