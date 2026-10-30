'use strict';

/* =====================================================================
 * Safari for Windows — Renderer (browser engine)
 * Talks to the main process only through window.safari (preload.js).
 * ===================================================================== */
(() => {
const S = window.safari;
if (!S) { document.body.textContent = 'Safari bridge unavailable (preload failed).'; return; }
const INFO = S.info || {};
const NS = 'http://www.w3.org/2000/svg';
const DEFAULT_GROUP = '__default__';
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const READER_SIZES = [15, 17, 19, 21, 24, 28, 32];

/* ------------------------------------------------------------------ */
/* DOM + misc helpers                                                 */
/* ------------------------------------------------------------------ */
const E = new Proxy({}, {
  get(cache, key) {
    if (!(key in cache)) cache[key] = document.getElementById(String(key).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`));
    return cache[key];
  }
});
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const tpl = (id) => document.getElementById(id).content.firstElementChild.cloneNode(true);
const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const clamp = (n, a, b) => Math.min(Math.max(n, a), b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function svgIcon(name, cls = 'icon sm') {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('class', cls);
  const u = document.createElementNS(NS, 'use');
  u.setAttribute('href', `#i-${name}`);
  s.appendChild(u);
  return s;
}
function h(tag, props, ...kids) {
  const n = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

let toastTimer;
function toast(msg) {
  E.toast.textContent = msg;
  E.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => E.toast.classList.remove('show'), 2300);
}

/* ------------------------------------------------------------------ */
/* URL helpers                                                        */
/* ------------------------------------------------------------------ */
const parseUrl = (u) => { try { return new URL(u); } catch (_) { return null; } };
const isHttp = (u) => /^https?:/i.test(u || '');
function hostOf(u) { const p = parseUrl(u); return p && isHttp(u) ? p.hostname.replace(/^www\./, '') : ''; }
function displayHost(u) {
  const p = parseUrl(u);
  if (!p) return u || '';
  return isHttp(u) ? p.hostname.replace(/^www\./, '') : u;
}
function searchUrl(text) {
  const eng = (INFO.searchEngines || {})[settings.searchEngine] || (INFO.searchEngines || {}).google;
  return eng.url.replace('%s', encodeURIComponent(text));
}
function engineName() { return ((INFO.searchEngines || {})[settings.searchEngine] || { name: 'Google' }).name; }

/** Turns whatever the user typed into { url } | { start:true } | null */
function resolveInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/^(safari:\/\/start\/?|about:start)$/i.test(text)) return { start: true };
  if (/^about:blank$/i.test(text)) return { url: 'about:blank' };
  if (/^https?:\/\/\S+$/i.test(text)) return { url: text };
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])(:\d+)?([/?#]\S*)?$/i.test(text)) return { url: `http://${text}` };
  if (/^[^\s/?#]+\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(text) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return { url: `https://${text}` };
  return { url: searchUrl(text) };
}

/* ------------------------------------------------------------------ */
/* Favicons / monograms                                               */
/* ------------------------------------------------------------------ */
const PALETTE = ['#FF6B6B', '#F59E0B', '#10B981', '#3B82F6', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316', '#6366F1', '#64748B'];
const favCache = new Map();
try { for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem('safari.favicons') || '{}'))) favCache.set(k, v); } catch (_) { /* ignore */ }
const saveFavCache = debounce(() => {
  try { localStorage.setItem('safari.favicons', JSON.stringify(Object.fromEntries([...favCache].slice(-400)))); } catch (_) { /* ignore */ }
}, 1200);
function rememberFavicon(url, fav) { const hst = hostOf(url); if (hst && fav) { favCache.set(hst, fav); saveFavCache(); } }
function faviconFor(item) { return (item && item.favicon) || favCache.get(hostOf(item && item.url)) || null; }
function monogram(item) {
  const base = hostOf(item.url) || item.title || '?';
  let hash = 0; for (const c of base) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return { letter: (base.replace(/^[^a-z0-9]+/i, '')[0] || '?').toUpperCase(), color: PALETTE[Math.abs(hash) % PALETTE.length] };
}
const probing = new Map();
function probeFavicon(url) {
  const p = parseUrl(url);
  if (!p || !isHttp(url)) return Promise.resolve(null);
  const hst = hostOf(url);
  if (probing.has(hst)) return probing.get(hst);
  const prom = new Promise((resolve) => {
    const img = new Image();
    const done = (v) => { if (v) { favCache.set(hst, v); saveFavCache(); } resolve(v); };
    img.onload = () => done(img.naturalWidth > 1 ? img.src : null);
    img.onerror = () => done(null);
    img.src = `${p.origin}/favicon.ico`;
    setTimeout(() => done(null), 4000);
  });
  probing.set(hst, prom);
  return prom;
}
/** Fills `node` with the site's favicon or a coloured monogram. */
function setIcon(node, item, probe = false) {
  const fav = faviconFor(item);
  if (fav) {
    node.style.backgroundImage = `url("${fav.replace(/"/g, '%22')}")`;
    node.style.backgroundColor = '';
    node.textContent = '';
    return;
  }
  const m = monogram(item);
  node.style.backgroundImage = '';
  node.style.backgroundColor = m.color;
  node.textContent = m.letter;
  if (probe && item.url) probeFavicon(item.url).then((f) => { if (f && node.isConnected) setIcon(node, item); });
}

/* ------------------------------------------------------------------ */
/* Global state                                                       */
/* ------------------------------------------------------------------ */
let settings = {};
let favorites = [];
let bookmarks = [];
let readingList = [];
let historyCache = [];
let groups = [];
let activeGroupId = DEFAULT_GROUP;
let recentlyClosed = [];
const tabsById = new Map();
const tabEls = new Map();
const wcToTab = new Map();
const downloads = new Map();
let privacyStats = { week: 0, total: 0 };

const getGroup = (id) => groups.find((g) => g.id === id) || groups[0];
const curGroup = () => getGroup(activeGroupId);
const curTab = () => { const g = curGroup(); return g ? tabsById.get(g.activeTabId) || null : null; };
const orderedTabs = (g) => [...g.tabs.filter((t) => t.pinned), ...g.tabs.filter((t) => !t.pinned)];

const saveSettings = debounce(async () => {
  try { const cur = await S.store.get('settings'); settings.windowBounds = cur.windowBounds; await S.store.set('settings', settings); } catch (_) { /* ignore */ }
}, 150);
const saveStore = (name) => {
  const map = { favorites, bookmarks, readingList };
  return S.store.set(name, map[name]).catch(() => {});
};
const serializeTab = (t) => ({ id: t.id, url: t.url, title: t.title, favicon: t.favicon, pinned: !!t.pinned });
function sessionData() {
  const def = groups[0];
  return {
    version: 1,
    activeGroupId: activeGroupId === DEFAULT_GROUP ? null : activeGroupId,
    defaultGroup: { tabs: def.tabs.map(serializeTab), activeTabId: def.activeTabId },
    groups: groups.slice(1).map((g) => ({ id: g.id, name: g.name, tabs: g.tabs.map(serializeTab), activeTabId: g.activeTabId })),
    recentlyClosed
  };
}
const saveSession = debounce(() => { S.store.set('session', sessionData()).catch(() => {}); }, 500);

/* ------------------------------------------------------------------ */
/* Popovers & context menus                                           */
/* ------------------------------------------------------------------ */
const pop = { el: null, anchor: null };

function placePopover(p, rect, opts = {}) {
  if (opts.width) p.style.width = `${opts.width}px`;
  const pw = p.offsetWidth, ph = p.offsetHeight;
  const cx = rect.left + rect.width / 2;
  let left = opts.align === 'left' ? rect.left : opts.align === 'right' ? rect.right - pw : cx - pw / 2;
  left = clamp(left, 8, window.innerWidth - pw - 8);
  let top = rect.bottom + 9;
  let above = false;
  if (opts.above || top + ph > window.innerHeight - 8) {
    if (rect.top - ph - 9 > 8) { top = rect.top - ph - 9; above = true; }
    else top = Math.max(8, window.innerHeight - ph - 8);
  }
  p.style.left = `${left}px`;
  p.style.top = `${top}px`;
  const ax = clamp(cx - left, 18, pw - 18);
  p.style.setProperty('--arrow-x', `${ax}px`);
  p.style.setProperty('--origin-x', `${ax}px`);
  p.classList.toggle('above', above);
}
function openPopover(p, anchor, opts = {}) {
  closePopovers(p);
  const rect = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
  placePopover(p, rect, opts);
  p.classList.add('open');
  pop.el = p;
  pop.anchor = anchor.getBoundingClientRect ? anchor : null;
  if (pop.anchor && pop.anchor.classList && pop.anchor.classList.contains('tb-btn')) pop.anchor.classList.add('active');
}
function closePopovers(except) {
  $$('.popover.open').forEach((p) => { if (p !== except && p !== E.popSuggestions) p.classList.remove('open'); });
  if (!except) { pop.el = null; pop.anchor = null; }
  $$('.tb-btn.active').forEach((b) => { if (!except || b !== pop.anchor) b.classList.remove('active'); });
  hideMenus();
  hidePreview();
}
function togglePopover(p, anchor, opts) {
  if (p.classList.contains('open')) closePopovers(); else openPopover(p, anchor, opts);
}
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.menu')) hideMenus();
  if (!$$('.popover.open').some((p) => p !== E.popSuggestions)) return;
  if (e.target.closest('.popover')) return;
  if (pop.anchor && pop.anchor.contains(e.target)) return;
  closePopovers();
}, true);
window.addEventListener('resize', () => { closePopovers(); hideMenus(); });
window.addEventListener('blur', () => { hideMenus(); });

function hideMenus() { E.ctxMenu.classList.remove('open'); E.ctxSubmenu.classList.remove('open'); }
function buildMenu(container, items, isRoot) {
  container.textContent = '';
  for (const it of items) {
    if (it.sep) { container.appendChild(h('div', { class: 'menu-sep' })); continue; }
    const row = tpl('tpl-menu-item');
    $('.mi-label', row).textContent = it.label;
    $('.kbd', row).textContent = it.kbd || '';
    row.classList.toggle('checked', !!it.checked);
    row.classList.toggle('disabled', !!it.disabled);
    row.classList.toggle('danger', !!it.danger);
    row.classList.toggle('has-sub', !!it.sub);
    row.addEventListener('mouseenter', () => {
      if (it.sub && !it.disabled) showSubmenu(row, it.sub); else if (isRoot) E.ctxSubmenu.classList.remove('open');
    });
    row.addEventListener('click', () => { if (it.disabled || it.sub) return; hideMenus(); if (it.action) it.action(); });
    container.appendChild(row);
  }
}
function showMenu(items, x, y) {
  closePopovers();
  const m = E.ctxMenu;
  buildMenu(m, items, true);
  m.classList.add('open');
  const w = m.offsetWidth, hh = m.offsetHeight;
  m.style.left = `${clamp(x, 6, window.innerWidth - w - 6)}px`;
  m.style.top = `${clamp(y, 6, window.innerHeight - hh - 6)}px`;
}
function showSubmenu(row, items) {
  const sm = E.ctxSubmenu;
  buildMenu(sm, items, false);
  sm.classList.add('open');
  const r = row.getBoundingClientRect();
  const w = sm.offsetWidth, hh = sm.offsetHeight;
  let left = r.right + 2;
  if (left + w > window.innerWidth - 6) left = r.left - w - 2;
  sm.style.left = `${left}px`;
  sm.style.top = `${clamp(r.top - 5, 6, window.innerHeight - hh - 6)}px`;
}
// keep text inputs usable: Cut / Copy / Paste menu
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const t = e.target;
  if (t.closest('.tab, .sb-row, .fav-card')) return;
  if (t.matches('input[type="text"], input[type="search"], input[type="password"], textarea')) {
    t.focus();
    showMenu([
      { label: 'Cut', action: () => document.execCommand('cut') },
      { label: 'Copy', action: () => document.execCommand('copy') },
      { label: 'Paste', action: () => document.execCommand('paste') },
      { sep: true },
      { label: 'Select All', action: () => t.select() }
    ], e.clientX, e.clientY);
  }
});

/* ------------------------------------------------------------------ */
/* Window chrome                                                      */
/* ------------------------------------------------------------------ */
function applyWindowState(s) {
  E.app.classList.toggle('window-blurred', !s.focused);
  E.app.classList.toggle('maximized', !!s.maximized);
  E.app.classList.toggle('fullscreen', !!s.fullscreen);
}
function bindWindowControls() {
  E.tlClose.addEventListener('click', () => S.window.close());
  E.tlMin.addEventListener('click', () => S.window.minimize());
  E.tlMax.addEventListener('click', (e) => (e.altKey ? S.window.toggleMaximize() : S.window.toggleFullscreen()));
  S.window.onState(applyWindowState);
  S.window.getState().then(applyWindowState).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Tab model                                                          */
/* ------------------------------------------------------------------ */
function makeTabObj(o) {
  const tab = {
    id: o.id || uid('t'), url: o.url || '', title: o.title || '', favicon: o.favicon || null, pinned: !!o.pinned,
    groupId: o.groupId, wv: null, wcId: null, domReady: false, loading: false, progress: 0,
    canGoBack: false, canGoForward: false, audible: false, muted: false, zoom: 1, blocked: 0,
    themeColor: null, snapshot: null, readerAvailable: false, reader: null, error: null,
    devtoolsWv: null, devtoolsOpen: false, _pt: null
  };
  tabsById.set(tab.id, tab);
  return tab;
}

function newTab({ url = '', group = curGroup(), background = false, afterId = null, focusAddress = false, pinned = false, title = '', favicon = null } = {}) {
  const tab = makeTabObj({ url, title, favicon, pinned, groupId: group.id });
  let idx = group.tabs.length;
  if (afterId) { const i = group.tabs.findIndex((t) => t.id === afterId); if (i >= 0) idx = i + 1; }
  const pc = group.tabs.filter((t) => t.pinned).length;
  idx = pinned ? Math.min(idx, pc) : Math.max(idx, pc);
  group.tabs.splice(idx, 0, tab);
  if (url && background) ensureWebview(tab);
  if (!background) activateTab(tab.id, { focusAddress: focusAddress || !url });
  else { renderTabs(); refreshSidebarIf('tabgroups'); saveSession(); }
  return tab;
}

function activateTab(id, { focusAddress = false, keepFocus = false } = {}) {
  const tab = tabsById.get(id);
  if (!tab) return;
  const group = getGroup(tab.groupId);
  const prev = curTab();
  if (prev && prev !== tab) { snapshotTab(prev); leaveTabUI(prev); }
  activeGroupId = group.id;
  group.activeTabId = id;
  closeFind(true);
  if (tab.url) ensureWebview(tab);
  for (const t of tabsById.values()) if (t.wv) t.wv.classList.toggle('active', t === tab && !!tab.url);
  renderTabs();
  updateAll();
  applyTint(tab);
  refreshSidebarIf('tabgroups');
  saveSession();
  if (focusAddress) focusAddressBar();
  else if (!keepFocus && tab.wv && tab.domReady) { try { tab.wv.focus(); } catch (_) { /* ignore */ } }
}

function leaveTabUI(tab) {
  if (tab.reader) { tab.reader = null; }
  E.reader.classList.remove('open');
  E.app.classList.remove('reader-open');
}

function closeTab(id) {
  const tab = tabsById.get(id);
  if (!tab) return;
  const group = getGroup(tab.groupId);
  const i = group.tabs.indexOf(tab);
  if (tab.url) {
    recentlyClosed.unshift({ url: tab.url, title: tab.title, favicon: tab.favicon, closedAt: Date.now() });
    recentlyClosed.length = Math.min(recentlyClosed.length, 15);
  }
  const wasActive = group.activeTabId === id;
  const node = tabEls.get(id);
  if (node) { node.classList.add('closing'); setTimeout(() => node.remove(), 200); tabEls.delete(id); }
  destroyWebview(tab);
  group.tabs.splice(i, 1);
  tabsById.delete(id);
  if (!group.tabs.length) { newTab({ group, background: group.id !== activeGroupId }); return; }
  if (wasActive) {
    const next = group.tabs[Math.min(i, group.tabs.length - 1)];
    group.activeTabId = next.id;
    if (group.id === activeGroupId) { activateTab(next.id); return; }
  }
  renderTabs();
  refreshSidebarIf('tabgroups');
  saveSession();
}

function destroyWebview(tab) {
  clearInterval(tab._pt);
  if (tab.devtoolsWv) { try { S.devtools.close(tab.wcId); } catch (_) { /* ignore */ } tab.devtoolsWv.remove(); tab.devtoolsWv = null; }
  if (tab.wcId) wcToTab.delete(tab.wcId);
  if (tab.wv) { tab.wv.remove(); tab.wv = null; }
  tab.wcId = null; tab.domReady = false;
}

function togglePin(tab) {
  const g = getGroup(tab.groupId);
  g.tabs.splice(g.tabs.indexOf(tab), 1);
  tab.pinned = !tab.pinned;
  g.tabs.splice(g.tabs.filter((t) => t.pinned).length, 0, tab);
  renderTabs(); saveSession();
}
function toggleMute(tab) {
  if (!tab.wv || !tab.domReady) return;
  try { tab.muted = !tab.muted; tab.wv.setAudioMuted(tab.muted); } catch (_) { /* ignore */ }
  updateTabEl(tab, tabEls.get(tab.id));
}
function closeOthers(tab) { getGroup(tab.groupId).tabs.filter((t) => t !== tab && !t.pinned).forEach((t) => closeTab(t.id)); }
function closeToRight(tab) {
  const g = getGroup(tab.groupId);
  g.tabs.slice(g.tabs.indexOf(tab) + 1).filter((t) => !t.pinned).forEach((t) => closeTab(t.id));
}
function reopenClosedTab() {
  const rec = recentlyClosed.shift();
  if (!rec) { toast('No recently closed tabs'); return; }
  newTab({ url: rec.url, title: rec.title, favicon: rec.favicon });
}
function moveTab(srcId, targetId, after) {
  const src = tabsById.get(srcId), target = tabsById.get(targetId);
  if (!src || !target || src.groupId !== target.groupId) return;
  const g = getGroup(src.groupId);
  g.tabs.splice(g.tabs.indexOf(src), 1);
  let at = g.tabs.indexOf(target) + (after ? 1 : 0);
  g.tabs.splice(at, 0, src);
  g.tabs.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  renderTabs(); saveSession();
}
function moveTabToGroup(tab, target) {
  const from = getGroup(tab.groupId);
  if (from.id === target.id) return;
  const idx = from.tabs.indexOf(tab);
  const wasActive = from.activeTabId === tab.id;
  from.tabs.splice(idx, 1);
  tab.groupId = target.id;
  target.tabs.push(tab);
  if (!target.activeTabId) target.activeTabId = tab.id;
  if (!from.tabs.length) newTab({ group: from, background: true });
  if (wasActive) {
    const next = from.tabs[Math.min(idx, from.tabs.length - 1)];
    from.activeTabId = next.id;
    if (from.id === activeGroupId) { activateTab(next.id); }
  }
  if (tab.wv) tab.wv.classList.remove('active');
  renderTabs(); refreshSidebarIf('tabgroups'); saveSession();
  toast(`Moved to “${target.name}”`);
}

/* ------------------------------------------------------------------ */
/* Tab groups                                                         */
/* ------------------------------------------------------------------ */
function switchGroup(id) {
  const g = getGroup(id);
  if (!g || g.id === activeGroupId) return;
  const prev = curTab();
  if (prev) { snapshotTab(prev); leaveTabUI(prev); }
  closeOverview(true);
  activeGroupId = g.id;
  if (!g.tabs.length) { newTab({ group: g }); return; }
  activateTab((tabsById.get(g.activeTabId) || g.tabs[0]).id);
}
let pendingRenameGroup = null;
function createGroup(name) {
  const n = groups.length;
  const g = { id: uid('g'), name: name || `Untitled Group ${n}`, tabs: [], activeTabId: null };
  groups.push(g);
  pendingRenameGroup = g.id;
  const prev = curTab();
  if (prev) { snapshotTab(prev); leaveTabUI(prev); }
  activeGroupId = g.id;
  newTab({ group: g });
  openSidebar('tabgroups');
  return g;
}
function deleteGroup(g) {
  if (g.id === DEFAULT_GROUP) return;
  [...g.tabs].forEach((t) => { destroyWebview(t); tabsById.delete(t.id); const n = tabEls.get(t.id); if (n) n.remove(); tabEls.delete(t.id); });
  groups = groups.filter((x) => x !== g);
  if (activeGroupId === g.id) { activeGroupId = DEFAULT_GROUP; activateTab((tabsById.get(groups[0].activeTabId) || groups[0].tabs[0]).id); }
  refreshSidebarIf('tabgroups'); saveSession();
}
function renameGroup(g, name) { g.name = name; refreshSidebarIf('tabgroups'); saveSession(); }

function showGroupsMenu() {
  const list = E.groupsMenuList;
  list.textContent = '';
  for (const g of groups) {
    const row = tpl('tpl-menu-item');
    $('.mi-label', row).textContent = g.name;
    $('.kbd', row).textContent = `${g.tabs.length}`;
    row.classList.toggle('checked', g.id === activeGroupId);
    row.addEventListener('click', () => { closePopovers(); switchGroup(g.id); });
    list.appendChild(row);
  }
  togglePopover(E.popGroups, E.btnGroups, { align: 'left' });
}

/* ------------------------------------------------------------------ */
/* Webview lifecycle                                                  */
/* ------------------------------------------------------------------ */
function ensureWebview(tab) {
  if (tab.wv || !tab.url) return tab.wv;
  const wv = document.createElement('webview');
  wv.className = 'wv';
  wv.setAttribute('partition', INFO.partition || 'persist:safari');
  wv.setAttribute('allowpopups', '');
  tab.wv = wv;
  wireWebview(tab, wv);
  E.webviews.appendChild(wv);
  wv.setAttribute('src', tab.url);
  return wv;
}

function errorInfo(code, desc, url) {
  const host = displayHost(url);
  const map = {
    '-105': ['Safari Can’t Find the Server', `Safari can’t open the page because it can’t find the server “${host}”.`],
    '-106': ['You Aren’t Connected to the Internet', 'Safari can’t open the page because your computer isn’t connected to the Internet.'],
    '-102': ['Safari Can’t Connect to the Server', `Safari can’t open the page because the server “${host}” refused the connection.`],
    '-118': ['The Connection Timed Out', `Safari can’t open the page because the server “${host}” took too long to respond.`],
    '-324': ['The Server Closed the Connection', `The server “${host}” closed the connection without sending data.`],
    '-7':   ['The Connection Timed Out', `Safari can’t open the page because the server “${host}” took too long to respond.`]
  };
  if (map[String(code)]) return { title: map[String(code)][0], message: map[String(code)][1] };
  if (code <= -200 && code > -300) return { title: 'This Connection Is Not Private', message: `Safari can’t verify the identity of “${host}”. The certificate is invalid or untrusted.` };
  return { title: 'Safari Can’t Open the Page', message: `${desc || 'An unknown error occurred'} (${code}).` };
}

function wireWebview(tab, wv) {
  const on = (ev, fn) => wv.addEventListener(ev, fn);
  const active = () => tab === curTab();

  on('dom-ready', () => {
    tab.domReady = true;
    try { tab.wcId = wv.getWebContentsId(); wcToTab.set(tab.wcId, tab); } catch (_) { /* ignore */ }
    applyZoom(tab);
    refreshNavState(tab);
    if (active()) { updateAll(); }
  });
  on('did-start-loading', () => {
    tab.loading = true;
    startProgress(tab);
    updateTabEl(tab, tabEls.get(tab.id));
    if (active()) updateToolbar();
  });
  on('did-stop-loading', () => {
    tab.loading = false;
    finishProgress(tab);
    refreshNavState(tab);
    updateTabEl(tab, tabEls.get(tab.id));
    if (active()) updateToolbar();
  });
  on('did-start-navigation', (e) => {
    if (!e.isMainFrame || e.isInPlace) return;
    tab.error = null; tab.blocked = 0; tab.readerAvailable = false;
    if (tab.reader && active()) closeReader(true);
    if (active()) { syncError(); updateToolbar(); }
  });
  on('did-navigate', (e) => {
    if (!isHttp(e.url) && e.url !== 'about:blank') return;
    const changedHost = hostOf(e.url) !== hostOf(tab.url);
    tab.url = e.url;
    if (changedHost) applyZoom(tab);
    S.history.add({ url: e.url, title: tab.title || displayHost(e.url), favicon: tab.favicon }).then(() => refreshSidebarIf('history')).catch(() => {});
    refreshNavState(tab);
    renderTabs(); saveSession();
    if (active()) { updateAll(); }
  });
  on('did-navigate-in-page', (e) => {
    if (!e.isMainFrame || !isHttp(e.url)) return;
    tab.url = e.url;
    refreshNavState(tab);
    saveSession();
    if (active()) updateToolbar();
  });
  on('page-title-updated', (e) => {
    tab.title = e.title || '';
    updateTabEl(tab, tabEls.get(tab.id));
    if (isHttp(tab.url)) S.history.update({ url: tab.url, title: tab.title }).catch(() => {});
    refreshSidebarIf('tabgroups'); saveSession();
    if (overviewIsOpen()) renderOverview();
  });
  on('page-favicon-updated', (e) => {
    const f = e.favicons && e.favicons[0];
    if (!f) return;
    tab.favicon = f;
    rememberFavicon(tab.url, f);
    updateTabEl(tab, tabEls.get(tab.id));
    S.history.update({ url: tab.url, favicon: f }).catch(() => {});
    saveSession();
  });
  on('did-fail-load', (e) => {
    if (!e.isMainFrame || e.errorCode === -3) return;
    tab.loading = false; finishProgress(tab);
    tab.error = Object.assign(errorInfo(e.errorCode, e.errorDescription, e.validatedURL || tab.url), { code: e.errorCode });
    if (active()) { syncError(); updateToolbar(); }
  });
  on('did-finish-load', () => {
    detectArticle(tab);
    setTimeout(() => refreshThemeColor(tab), 300);
    setTimeout(() => snapshotTab(tab), 900);
  });
  on('did-change-theme-color', (e) => {
    tab.themeColor = e.themeColor || null;
    if (active()) applyTint(tab);
  });
  on('media-started-playing', () => { tab.audible = true; updateTabEl(tab, tabEls.get(tab.id)); });
  on('media-paused', () => { tab.audible = false; updateTabEl(tab, tabEls.get(tab.id)); });
  on('found-in-page', (e) => { if (active()) onFound(e.result); });
  on('render-process-gone', () => { tab.error = { title: 'This Webpage Was Reloaded', message: 'A problem occurred with this webpage so it was reloaded.' }; if (active()) syncError(); setTimeout(() => { try { wv.reload(); } catch (_) { /* ignore */ } }, 400); });
  on('focus', () => { closePopovers(); closeSuggestions(); hideMenus(); });
}

function refreshNavState(tab) {
  if (!tab.wv || !tab.domReady) return;
  try { tab.canGoBack = tab.wv.canGoBack(); tab.canGoForward = tab.wv.canGoForward(); } catch (_) { /* ignore */ }
  if (tab === curTab()) updateToolbar();
}

function snapshotTab(tab) {
  if (!tab || !tab.wcId || !tab.domReady || !tab.url) return Promise.resolve();
  return S.page.capture(tab.wcId, 520).then((s) => { if (s) tab.snapshot = s; }).catch(() => {});
}

/* progress */
function startProgress(tab) {
  clearInterval(tab._pt);
  tab.progress = 0.08;
  tab._pt = setInterval(() => { tab.progress += (0.9 - tab.progress) * 0.07; if (tab === curTab()) updateProgress(); }, 180);
  if (tab === curTab()) updateProgress();
}
function finishProgress(tab) {
  clearInterval(tab._pt);
  tab.progress = 1;
  if (tab === curTab()) updateProgress();
  setTimeout(() => { if (!tab.loading) { tab.progress = 0; if (tab === curTab()) updateProgress(); } }, 450);
}
let progressReset;
function updateProgress() {
  const tab = curTab();
  const bar = E.sfProgress;
  clearTimeout(progressReset);
  if (tab && tab.loading) {
    bar.classList.add('active');
    bar.style.width = `${Math.round(tab.progress * 100)}%`;
  } else if (tab && tab.progress >= 1) {
    bar.classList.add('active');
    bar.style.width = '100%';
  } else {
    bar.classList.remove('active');
    progressReset = setTimeout(() => {
      bar.style.transition = 'none'; bar.style.width = '0'; void bar.offsetWidth; bar.style.transition = '';
    }, 600);
  }
}

/* ------------------------------------------------------------------ */
/* Navigation                                                         */
/* ------------------------------------------------------------------ */
function loadInTab(tab, url) {
  tab.url = url; tab.error = null; tab.readerAvailable = false; tab.themeColor = null; tab.loading = false;
  if (tab.reader) closeReader(true);
  if (tab.wv) {
    if (tab.domReady) tab.wv.loadURL(url).catch(() => {}); else tab.wv.setAttribute('src', url);
  } else if (tab === curTab()) {
    ensureWebview(tab);
  }
  if (tab === curTab()) {
    for (const t of tabsById.values()) if (t.wv) t.wv.classList.toggle('active', t === tab);
    updateAll();
  }
  updateTabEl(tab, tabEls.get(tab.id));
  renderTabs(); saveSession();
}
function showStartPage(tab) {
  if (tab.wv) { destroyWebview(tab); }
  tab.url = ''; tab.title = ''; tab.favicon = null; tab.error = null; tab.themeColor = null; tab.canGoBack = tab.canGoForward = false;
  if (tab === curTab()) { applyTint(tab); updateAll(); }
  renderTabs(); saveSession();
}
function navigateActive(url) {
  const tab = curTab() || newTab();
  loadInTab(tab, url);
  if (tab.wv) { try { tab.wv.focus(); } catch (_) { /* ignore */ } }
}
function submitAddress(text, inNewTab) {
  const r = resolveInput(text);
  E.addressInput.blur();
  if (!r) return;
  if (r.start) { const t = curTab(); if (t) showStartPage(t); return; }
  if (inNewTab) newTab({ url: r.url }); else navigateActive(r.url);
}
function goBack() { const t = curTab(); if (t && t.wv && t.domReady && t.canGoBack) t.wv.goBack(); }
function goForward() { const t = curTab(); if (t && t.wv && t.domReady && t.canGoForward) t.wv.goForward(); }
function reloadTab(tab, hard) {
  if (!tab || !tab.url) return;
  tab.error = null;
  if (!tab.wv) { ensureWebview(tab); return; }
  if (!tab.domReady) return;
  if (hard) tab.wv.reloadIgnoringCache(); else tab.wv.reload();
  if (tab === curTab()) syncError();
}
function stopLoading(tab) { if (tab && tab.wv && tab.domReady) { try { tab.wv.stop(); } catch (_) { /* ignore */ } } }

/* ------------------------------------------------------------------ */
/* Tab rendering                                                      */
/* ------------------------------------------------------------------ */
let dragTabId = null;
let previewTimer = null;
let previewTabId = null;

function makeTabEl(tab) {
  const node = tpl('tpl-tab');
  node.dataset.id = tab.id;
  node.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('.tab-close, .tab-audio')) activateTab(tab.id, { keepFocus: true });
  });
  node.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } });
  $('.tab-close', node).addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.id); });
  $('.tab-audio', node).addEventListener('click', (e) => { e.stopPropagation(); toggleMute(tab); });
  node.addEventListener('contextmenu', (e) => { e.preventDefault(); showTabMenu(tab, e.clientX, e.clientY); });
  node.addEventListener('mouseenter', () => schedulePreview(tab, node));
  node.addEventListener('mouseleave', hidePreview);
  node.addEventListener('dragstart', (e) => {
    dragTabId = tab.id; node.classList.add('dragging'); hidePreview();
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', tab.url || '');
  });
  node.addEventListener('dragend', () => { dragTabId = null; $$('.tab.dragging, .tab.drop-before, .tab.drop-after').forEach((n) => n.classList.remove('dragging', 'drop-before', 'drop-after')); });
  node.addEventListener('dragover', (e) => {
    if (!dragTabId || dragTabId === tab.id) return;
    e.preventDefault();
    const r = node.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    node.classList.toggle('drop-before', !after); node.classList.toggle('drop-after', after);
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-before', 'drop-after'));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    const r = node.getBoundingClientRect();
    const id = dragTabId;
    node.classList.remove('drop-before', 'drop-after');
    if (id && id !== tab.id) moveTab(id, tab.id, e.clientX > r.left + r.width / 2);
  });
  return node;
}

function updateTabEl(tab, node) {
  if (!node) return;
  const g = getGroup(tab.groupId);
  node.classList.toggle('active', g.activeTabId === tab.id);
  node.classList.toggle('loading', !!tab.loading);
  node.classList.toggle('pinned', !!tab.pinned);
  node.classList.toggle('playing', !!(tab.audible && !tab.muted));
  node.classList.toggle('muted', !!tab.muted);
  const title = tab.title || (tab.url ? displayHost(tab.url) : 'Start Page');
  $('.tab-title', node).textContent = title;
  node.title = tab.pinned ? `${title} — ${displayHost(tab.url)}` : title;
  setIcon($('.tab-favicon', node), tab.url ? tab : { url: '', title: 'S' });
  if (!tab.url) { const f = $('.tab-favicon', node); f.style.backgroundImage = ''; f.style.backgroundColor = 'var(--accent)'; f.textContent = ''; f.appendChild(svgIcon('star', 'icon xs')); f.style.color = '#fff'; }
  $('.tab-audio use', node).setAttribute('href', tab.muted ? '#i-speaker-mute' : '#i-speaker');
  $('.tab-audio', node).title = tab.muted ? 'Unmute Tab' : 'Mute Tab';
}

function reconcile(container, desired) {
  const kids = () => [...container.children].filter((c) => !c.classList.contains('closing'));
  kids().forEach((c) => { if (!desired.includes(c)) c.remove(); });
  desired.forEach((node, i) => {
    const cur = kids();
    if (cur[i] !== node) container.insertBefore(node, cur[i] || null);
  });
}

function renderTabs() {
  const g = curGroup();
  if (!g) return;
  const ordered = orderedTabs(g);
  const ids = new Set(ordered.map((t) => t.id));
  for (const [id, node] of tabEls) if (!ids.has(id)) { node.remove(); tabEls.delete(id); }
  for (const t of ordered) {
    let node = tabEls.get(t.id);
    if (!node) { node = makeTabEl(t); tabEls.set(t.id, node); }
    updateTabEl(t, node);
  }
  const compact = settings.tabLayout === 'compact';
  E.app.classList.toggle('layout-compact', compact);
  E.app.classList.toggle('layout-separate', !compact);
  if (compact) {
    const ai = ordered.findIndex((t) => t.id === g.activeTabId);
    reconcile(E.compactTabsLeft, ordered.slice(0, Math.max(ai, 0)).map((t) => tabEls.get(t.id)));
    reconcile(E.compactTabsRight, (ai >= 0 ? ordered.slice(ai + 1) : []).map((t) => tabEls.get(t.id)));
    reconcile(E.pinnedTabs, []); reconcile(E.tabs, []);
  } else {
    reconcile(E.pinnedTabs, ordered.filter((t) => t.pinned).map((t) => tabEls.get(t.id)));
    reconcile(E.tabs, ordered.filter((t) => !t.pinned).map((t) => tabEls.get(t.id)));
    reconcile(E.compactTabsLeft, []); reconcile(E.compactTabsRight, []);
  }
  const at = tabEls.get(g.activeTabId);
  if (at && at.scrollIntoView) at.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function showTabMenu(tab, x, y) {
  const g = getGroup(tab.groupId);
  const idx = g.tabs.indexOf(tab);
  const targets = groups.filter((gr) => gr.id !== g.id).map((gr) => ({ label: gr.name, action: () => moveTabToGroup(tab, gr) }));
  targets.push({ sep: true });
  targets.push({ label: 'New Tab Group…', action: () => { const ng = createGroupFor(tab); } });
  showMenu([
    { label: 'New Tab to the Right', action: () => newTab({ afterId: tab.id, group: g, focusAddress: true }) },
    { label: 'Duplicate Tab', disabled: !tab.url, action: () => newTab({ url: tab.url, title: tab.title, favicon: tab.favicon, afterId: tab.id, group: g }) },
    { sep: true },
    { label: tab.pinned ? 'Unpin Tab' : 'Pin Tab', action: () => togglePin(tab) },
    { label: tab.muted ? 'Unmute Tab' : 'Mute Tab', disabled: !tab.url, action: () => toggleMute(tab) },
    { label: 'Move to Tab Group', sub: targets },
    { sep: true },
    { label: 'Reload Tab', disabled: !tab.url, action: () => reloadTab(tab) },
    { label: 'Close Tab', kbd: 'Ctrl+W', action: () => closeTab(tab.id) },
    { label: 'Close Other Tabs', disabled: g.tabs.filter((t) => t !== tab && !t.pinned).length === 0, action: () => closeOthers(tab) },
    { label: 'Close Tabs to the Right', disabled: g.tabs.slice(idx + 1).filter((t) => !t.pinned).length === 0, action: () => closeToRight(tab) }
  ], x, y);
}
function createGroupFor(tab) {
  const g = { id: uid('g'), name: `Untitled Group ${groups.length}`, tabs: [], activeTabId: null };
  groups.push(g);
  moveTabToGroup(tab, g);
  pendingRenameGroup = g.id;
  openSidebar('tabgroups');
  return g;
}

/* tab hover preview */
function schedulePreview(tab, node) {
  clearTimeout(previewTimer);
  if (curGroup().activeTabId === tab.id || dragTabId) return;
  previewTimer = setTimeout(() => showPreview(tab, node), 500);
}
async function showPreview(tab, node) {
  previewTabId = tab.id;
  const p = E.tabPreview;
  E.tpTitle.textContent = tab.title || (tab.url ? displayHost(tab.url) : 'Start Page');
  E.tpDomain.textContent = tab.url ? displayHost(tab.url) : 'safari://start';
  const setImg = (src) => { E.tpImg.style.display = src ? '' : 'none'; if (src) E.tpImg.src = src; E.tpPlaceholder.style.display = src ? 'none' : ''; };
  E.tpPlaceholder.textContent = monogram(tab).letter;
  setImg(tab.snapshot);
  const r = node.getBoundingClientRect();
  p.style.left = `${clamp(r.left + r.width / 2 - 130, 8, window.innerWidth - 276)}px`;
  p.style.top = `${r.bottom + 8}px`;
  p.classList.add('show');
  if (tab.wcId && tab.domReady) {
    const s = await S.page.capture(tab.wcId, 520).catch(() => null);
    if (s) { tab.snapshot = s; if (previewTabId === tab.id && p.classList.contains('show')) setImg(s); }
  }
}
function hidePreview() { clearTimeout(previewTimer); previewTabId = null; E.tabPreview.classList.remove('show'); }

/* ------------------------------------------------------------------ */
/* Toolbar state, tinting, address field                              */
/* ------------------------------------------------------------------ */
function updateAll() {
  const tab = curTab();
  E.app.classList.toggle('start-visible', !(tab && tab.url));
  if (!(tab && tab.url)) renderStartPage();
  syncError();
  updateToolbar();
  syncDevtoolsDock();
  E.linkStatus.classList.remove('show');
  syncFindBar();
}

function updateToolbar() {
  const tab = curTab();
  const has = !!(tab && tab.url);
  E.btnBack.disabled = !(tab && tab.canGoBack);
  E.btnForward.disabled = !(tab && tab.canGoForward);
  E.btnReload.classList.toggle('loading', !!(tab && tab.loading));
  E.btnReload.title = tab && tab.loading ? 'Stop Loading' : 'Reload Page (Ctrl+R)';
  E.btnShare.disabled = !has;
  E.btnAdd.hidden = !has;
  E.btnReload.hidden = !has;
  E.btnPrivacy.hidden = !has;
  E.btnReader.hidden = !(has && isHttp(tab.url));
  E.btnReader.classList.toggle('available', !!(tab && (tab.readerAvailable || tab.reader)));
  E.btnReader.classList.toggle('active', !!(tab && tab.reader));
  E.btnReader.title = tab && tab.reader ? 'Hide Reader View (Ctrl+Shift+R)' : 'Show Reader View (Ctrl+Shift+R)';
  const blocked = tab ? tab.blocked : 0;
  E.privacyCount.hidden = !blocked;
  E.privacyCount.textContent = blocked > 99 ? '99+' : String(blocked);
  updateAddress();
  updateProgress();
}

function updateAddress() {
  if (document.activeElement === E.addressInput) return;
  const tab = curTab();
  const url = (tab && tab.url) || '';
  E.addressInput.value = url ? displayHost(url) : '';
  const secure = /^https:/i.test(url);
  E.sfLock.hidden = !secure;
  E.sfNotsecure.hidden = !/^http:/i.test(url);
}

function parseColor(str) {
  if (!str) return null;
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = '#000';
  c.fillStyle = String(str);
  const v = c.fillStyle;
  if (v[0] === '#') return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)];
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v);
  return m ? [+m[1], +m[2], +m[3]] : null;
}
function applyTint(tab) {
  const rgb = settings.colorInCompactTabBar && tab && tab.url && !tab.error ? parseColor(tab.themeColor) : null;
  const app = E.app;
  if (!rgb) { app.classList.remove('tinted', 'tint-dark', 'tint-light'); return; }
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  if (lum > 0.97) { app.classList.remove('tinted', 'tint-dark', 'tint-light'); return; }
  app.style.setProperty('--tint', `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`);
  app.classList.add('tinted');
  app.classList.toggle('tint-dark', lum < 0.52);
  app.classList.toggle('tint-light', lum >= 0.52);
}
async function refreshThemeColor(tab) {
  if (!tab.wv || !tab.domReady) return;
  let color = null;
  try {
    color = await tab.wv.executeJavaScript(`(() => { const m = [...document.querySelectorAll('meta[name="theme-color"]')]; const p = m.find(x => !x.media || matchMedia(x.media).matches) || m[0]; return p ? p.content : null; })()`);
  } catch (_) { /* ignore */ }
  if (!color && tab.wcId && tab === curTab()) {
    try { const r = await S.page.sampleColor(tab.wcId); if (r) color = r.hex; } catch (_) { /* ignore */ }
  }
  tab.themeColor = color || null;
  if (tab === curTab()) applyTint(tab);
}

function syncError() {
  const tab = curTab();
  const err = tab && tab.url && tab.error;
  E.errorView.hidden = !err;
  if (err) {
    E.errorTitle.textContent = err.title;
    E.errorMessage.textContent = err.message;
    E.errorUrl.textContent = tab.url;
  }
}

function focusAddressBar() { E.addressInput.focus(); E.addressInput.select(); }

/* ------------------------------------------------------------------ */
/* Smart Search suggestions                                           */
/* ------------------------------------------------------------------ */
const sugg = { items: [], rows: [], sel: -1, seq: 0, dirty: false };
let justFocused = false;

function openSuggestions() {
  const wrap = E.smartField.parentElement.getBoundingClientRect();
  const fr = E.smartField.getBoundingClientRect();
  const w = Math.min(760, wrap.width);
  const p = E.popSuggestions;
  p.style.width = `${w}px`;
  p.style.left = `${wrap.left + (wrap.width - w) / 2}px`;
  p.style.top = `${fr.bottom + 6}px`;
  p.style.setProperty('--origin-x', '50%');
  p.classList.add('open');
}
function closeSuggestions() { E.popSuggestions.classList.remove('open'); sugg.seq++; }

function renderFavoritesGrid() {
  E.suggFavorites.textContent = '';
  E.suggList.textContent = '';
  sugg.items = []; sugg.rows = []; sugg.sel = -1;
  for (const fav of favorites) {
    const card = tpl('tpl-fav');
    setIcon($('.fav-icon', card), fav, true);
    $('.fav-title', card).textContent = fav.title;
    card.addEventListener('mousedown', (e) => { e.preventDefault(); closeSuggestions(); E.addressInput.blur(); navigateActive(fav.url); });
    E.suggFavorites.appendChild(card);
  }
}

function matchTokens(text, tokens) { const t = text.toLowerCase(); return tokens.every((k) => t.includes(k)); }

async function updateSuggestions() {
  const seq = ++sugg.seq;
  const q = E.addressInput.value.trim();
  if (!sugg.dirty || !q) { renderFavoritesGrid(); return; }
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  const bm = [];
  (function walk(nodes) { for (const n of nodes) { if (n.type === 'folder') walk(n.children || []); else if (matchTokens(`${n.title} ${n.url}`, tokens)) bm.push({ kind: 'url', text: n.title, url: n.url, sub: displayHost(n.url), favicon: n.favicon }); } })(bookmarks);
  for (const f of favorites) if (matchTokens(`${f.title} ${f.url}`, tokens)) bm.push({ kind: 'url', text: f.title, url: f.url, sub: displayHost(f.url) });
  const tabs = [];
  for (const t of tabsById.values()) if (t.url && matchTokens(`${t.title} ${t.url}`, tokens)) tabs.push({ kind: 'tab', tabId: t.id, text: t.title || displayHost(t.url), url: t.url, sub: 'Switch to Tab', favicon: t.favicon });
  const hist = await S.history.search(q, 6).catch(() => []);
  if (seq !== sugg.seq) return;
  const seen = new Set(bm.map((b) => b.url));
  const histItems = hist.filter((x) => !seen.has(x.url)).map((x) => ({ kind: 'url', text: x.title || x.url, url: x.url, sub: displayHost(x.url), favicon: x.favicon }));
  const local = bm.concat(histItems).slice(0, 6);
  const resolved = resolveInput(q);
  const isUrl = resolved && resolved.url && resolved.url !== searchUrl(q);
  const top = { kind: 'top', text: q, url: resolved && resolved.url, sub: isUrl ? 'Go to website' : `${engineName()} Search`, isUrl };
  paintSuggestions(q, top, [], local, tabs.slice(0, 4));
  S.suggest(settings.searchEngine, q).then((list) => {
    if (seq !== sugg.seq) return;
    paintSuggestions(q, top, (list || []).filter((s) => s.toLowerCase() !== q.toLowerCase()).slice(0, 6).map((s) => ({ kind: 'search', text: s, url: searchUrl(s), sub: '' })), local, tabs.slice(0, 4));
  }).catch(() => {});
}

function paintSuggestions(q, top, remote, local, tabs) {
  E.suggFavorites.textContent = '';
  const list = E.suggList;
  list.textContent = '';
  sugg.items = []; sugg.rows = []; sugg.sel = -1;
  const add = (item) => {
    const row = tpl('tpl-sugg-row');
    const ico = $('.sugg-ico', row);
    if (item.kind === 'top' || item.kind === 'search') { ico.style.backgroundImage = ''; ico.appendChild(svgIcon(item.isUrl ? 'globe' : 'search', 'icon sm')); }
    else if (item.kind === 'tab') { ico.appendChild(svgIcon('overview', 'icon sm')); }
    else setIcon(ico, item);
    const main = $('.sugg-main', row);
    const text = item.text || '';
    if (text.toLowerCase().startsWith(q.toLowerCase()) && item.kind !== 'url' && item.kind !== 'tab') {
      main.append(document.createTextNode(text.slice(0, q.length)), h('b', { text: text.slice(q.length) }));
    } else main.textContent = text;
    $('.sugg-sub', row).textContent = item.sub || '';
    item.fill = item.kind === 'url' || item.kind === 'tab' ? item.url : item.text;
    row.addEventListener('mousedown', (e) => { e.preventDefault(); activateSugg(item, e.altKey || e.ctrlKey); });
    list.appendChild(row);
    sugg.items.push(item); sugg.rows.push(row);
  };
  const header = (t) => { const hd = tpl('tpl-sugg-header'); hd.textContent = t; list.appendChild(hd); };
  add(top);
  if (remote.length) { header(`${engineName()} Suggestions`); remote.forEach(add); }
  if (local.length) { header('Bookmarks and History'); local.forEach(add); }
  if (tabs.length) { header('Open Tabs'); tabs.forEach(add); }
}

function highlightSugg() {
  sugg.rows.forEach((r, i) => r.classList.toggle('selected', i === sugg.sel));
  if (sugg.rows[sugg.sel]) sugg.rows[sugg.sel].scrollIntoView({ block: 'nearest' });
}
function activateSugg(item, inNewTab) {
  closeSuggestions();
  E.addressInput.blur();
  if (item.kind === 'tab') { activateTab(item.tabId); return; }
  if (inNewTab) newTab({ url: item.url }); else navigateActive(item.url);
}

function bindAddressBar() {
  const input = E.addressInput;
  input.addEventListener('focus', () => {
    E.smartField.classList.add('focused');
    const tab = curTab();
    input.value = (tab && tab.url) || '';
    sugg.dirty = false;
    justFocused = true;
    input.select();
    updateSuggestions();
    openSuggestions();
  });
  input.addEventListener('mouseup', (e) => { if (justFocused) { e.preventDefault(); justFocused = false; } });
  input.addEventListener('blur', () => {
    E.smartField.classList.remove('focused');
    closeSuggestions();
    updateAddress();
  });
  const debounced = debounce(updateSuggestions, 90);
  input.addEventListener('input', () => { sugg.dirty = true; debounced(); });
  input.addEventListener('keydown', (e) => {
    const n = sugg.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!n) return;
      sugg.sel = e.key === 'ArrowDown' ? (sugg.sel + 1) % n : (sugg.sel <= 0 ? n - 1 : sugg.sel - 1);
      highlightSugg();
      input.value = sugg.items[sugg.sel].fill;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = sugg.sel >= 0 ? sugg.items[sugg.sel] : null;
      if (item && item.kind === 'tab') activateSugg(item); else submitAddress(input.value, e.altKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      const tab = curTab();
      const orig = (tab && tab.url) || '';
      if (sugg.dirty && input.value !== orig) { input.value = orig; sugg.dirty = false; input.select(); updateSuggestions(); } else input.blur();
    }
  });
  E.smartField.addEventListener('mousedown', (e) => {
    if (e.target.closest('.sf-btn')) return;
    if (document.activeElement !== input) { e.preventDefault(); input.focus(); }
  });
}

/* back / forward (click, long-press, right-click) */
function bindNavButtons() {
  const bind = (btn, dir, go) => {
    let timer = null, fired = false;
    btn.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      fired = false;
      timer = setTimeout(() => { fired = true; showNavStack(dir, btn); }, 450);
    });
    const cancel = () => clearTimeout(timer);
    btn.addEventListener('mouseup', cancel);
    btn.addEventListener('mouseleave', cancel);
    btn.addEventListener('click', () => { if (fired) { fired = false; return; } go(); });
    btn.addEventListener('contextmenu', (e) => { e.preventDefault(); showNavStack(dir, btn); });
  };
  bind(E.btnBack, 'back', goBack);
  bind(E.btnForward, 'forward', goForward);
}
async function showNavStack(dir, anchor) {
  const tab = curTab();
  if (!tab || !tab.wcId) return;
  const st = await S.nav.stack(tab.wcId).catch(() => ({ entries: [], index: -1 }));
  let rows = st.entries.map((e, i) => ({ e, i }));
  rows = dir === 'back' ? rows.filter((x) => x.i < st.index).reverse() : rows.filter((x) => x.i > st.index);
  if (!rows.length) return;
  const list = E.navstackList;
  list.textContent = '';
  for (const { e, i } of rows) {
    const row = tpl('tpl-nav-row');
    setIcon($('.nav-ico', row), { url: e.url, title: e.title });
    $('.nav-title', row).textContent = e.title || displayHost(e.url);
    row.addEventListener('click', () => { closePopovers(); S.nav.goToIndex(tab.wcId, i); });
    list.appendChild(row);
  }
  openPopover(E.popNavstack, anchor, { align: 'left' });
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                            */
/* ------------------------------------------------------------------ */
function applySidebar() {
  const sb = settings.sidebar;
  E.app.classList.toggle('sidebar-open', !!sb.open);
  E.btnSidebar.classList.toggle('active', !!sb.open);
  $$('.sb-tab').forEach((b) => b.classList.toggle('active', b.dataset.section === sb.section));
  $$('.sb-section').forEach((s) => s.classList.toggle('active', s.dataset.section === sb.section));
}
function openSidebar(section) {
  settings.sidebar.open = true;
  if (section) settings.sidebar.section = section;
  applySidebar(); renderSidebar(); saveSettings();
}
function toggleSidebar() {
  settings.sidebar.open = !settings.sidebar.open;
  applySidebar();
  if (settings.sidebar.open) renderSidebar();
  saveSettings();
}
function refreshSidebarIf(section) { if (settings.sidebar.open && settings.sidebar.section === section) renderSidebar(); }
function renderSidebar() {
  switch (settings.sidebar.section) {
    case 'tabgroups': renderGroupsList(); break;
    case 'bookmarks': renderBookmarks(); break;
    case 'reading': renderReading(); break;
    case 'history': renderHistory(true); break;
    default: break;
  }
}
function emptyRow(text) { const n = tpl('tpl-sb-empty'); n.textContent = text; return n; }

function inlineEdit(titleEl, initial, commit) {
  const input = h('input', { class: 'sb-edit-input', type: 'text', spellcheck: 'false' });
  input.value = initial;
  titleEl.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (input.isConnected) input.replaceWith(titleEl);
    if (save && v && v !== initial) commit(v);
  };
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

/* ---- Tab Groups ---- */
function renderGroupsList() {
  const list = E.groupsList;
  list.textContent = '';
  for (const g of groups) {
    const row = tpl('tpl-sb-row');
    const isActive = g.id === activeGroupId;
    $('.sb-ico', row).appendChild(svgIcon('stack', 'icon sm'));
    $('.sb-title', row).textContent = g.id === DEFAULT_GROUP ? 'Tabs' : g.name;
    $('.sb-title', row).style.fontWeight = isActive ? '700' : '500';
    $('.sb-sub', row).remove();
    $('.sb-badge', row).textContent = String(g.tabs.length);
    if (g.id === DEFAULT_GROUP) { $('.sb-edit', row).remove(); $('.sb-del', row).remove(); }
    else {
      $('.sb-edit', row).addEventListener('click', (e) => { e.stopPropagation(); inlineEdit($('.sb-title', row), g.name, (v) => renameGroup(g, v)); });
      $('.sb-del', row).addEventListener('click', (e) => { e.stopPropagation(); deleteGroup(g); });
    }
    row.addEventListener('click', () => switchGroup(g.id));
    list.appendChild(row);
    if (pendingRenameGroup === g.id) {
      pendingRenameGroup = null;
      setTimeout(() => inlineEdit($('.sb-title', row), g.name, (v) => renameGroup(g, v)), 50);
    }
    if (isActive) {
      for (const t of orderedTabs(g)) {
        const tr = tpl('tpl-sb-row');
        tr.classList.add('folder-child');
        tr.classList.toggle('active', g.activeTabId === t.id);
        setIcon($('.sb-ico', tr), t.url ? t : { url: '', title: 'S' });
        $('.sb-title', tr).textContent = t.title || (t.url ? displayHost(t.url) : 'Start Page');
        $('.sb-sub', tr).remove(); $('.sb-edit', tr).remove();
        $('.sb-del', tr).addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); });
        tr.addEventListener('click', () => activateTab(t.id));
        list.appendChild(tr);
      }
    }
  }
}

/* ---- Bookmarks & Favorites ---- */
function findNode(id, nodes = bookmarks) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id === id) return { node: n, list: nodes, index: i };
    if (n.type === 'folder') { const r = findNode(id, n.children || []); if (r) return r; }
  }
  return null;
}
function folderContains(folder, id) {
  return (folder.children || []).some((c) => c.id === id || (c.type === 'folder' && folderContains(c, id)));
}
function addBookmark(node, folderId) {
  const f = folderId ? findNode(folderId) : null;
  if (f && f.node.type === 'folder') { f.node.children = f.node.children || []; f.node.children.push(node); f.node.expanded = true; }
  else bookmarks.push(node);
  saveStore('bookmarks'); refreshSidebarIf('bookmarks');
}
function removeNode(id) {
  const r = findNode(id);
  if (!r) return;
  r.list.splice(r.index, 1);
  saveStore('bookmarks'); refreshSidebarIf('bookmarks');
}
function moveNode(srcId, targetId) {
  if (srcId === targetId) return;
  const src = findNode(srcId), dst = findNode(targetId);
  if (!src || !dst) return;
  if (src.node.type === 'folder' && (folderContains(src.node, targetId))) return;
  src.list.splice(src.index, 1);
  if (dst.node.type === 'folder') { dst.node.children = dst.node.children || []; dst.node.children.push(src.node); dst.node.expanded = true; }
  else { const again = findNode(targetId); again.list.splice(again.index, 0, src.node); }
  saveStore('bookmarks'); refreshSidebarIf('bookmarks');
}
function folderOptions() {
  const out = [{ id: '', label: 'Bookmarks' }];
  (function walk(nodes, depth) { for (const n of nodes) if (n.type === 'folder') { out.push({ id: n.id, label: `${'\u2003'.repeat(depth + 1)}${n.title}` }); walk(n.children || [], depth + 1); } })(bookmarks, 0);
  return out;
}
let dragNodeId = null;
function bookmarkRow({ title, url, favicon, depth, folder, expanded, count, virtual, onClick, onRename, onDelete, id }) {
  const row = tpl('tpl-sb-row');
  row.style.paddingLeft = `${6 + depth * 16}px`;
  const ico = $('.sb-ico', row);
  if (folder) { ico.appendChild(svgIcon(virtual ? 'star' : 'folder', 'icon sm')); ico.style.color = expanded ? 'var(--accent)' : ''; }
  else setIcon(ico, { url, title, favicon });
  $('.sb-title', row).textContent = title;
  if (url) $('.sb-sub', row).textContent = displayHost(url); else $('.sb-sub', row).remove();
  $('.sb-badge', row).textContent = folder ? String(count) : '';
  $('.sb-edit', row).addEventListener('click', (e) => { e.stopPropagation(); inlineEdit($('.sb-title', row), title, onRename); });
  $('.sb-del', row).addEventListener('click', (e) => { e.stopPropagation(); onDelete(); });
  if (virtual && folder) { $('.sb-edit', row).remove(); $('.sb-del', row).remove(); }
  row.addEventListener('click', (e) => onClick(e));
  if (!virtual && id) {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => { dragNodeId = id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', url || ''); });
    row.addEventListener('dragend', () => { dragNodeId = null; $$('.sb-row.dragover').forEach((r) => r.classList.remove('dragover')); });
    row.addEventListener('dragover', (e) => { if (dragNodeId && dragNodeId !== id) { e.preventDefault(); row.classList.add('dragover'); } });
    row.addEventListener('dragleave', () => row.classList.remove('dragover'));
    row.addEventListener('drop', (e) => { e.preventDefault(); row.classList.remove('dragover'); if (dragNodeId) moveNode(dragNodeId, id); });
  }
  return row;
}
function openFromEvent(url, e) { if (e && (e.ctrlKey || e.metaKey || e.button === 1)) newTab({ url, background: true }); else navigateActive(url); }

function renderBookmarks() {
  const list = E.bookmarksList;
  list.textContent = '';
  const favOpen = settings.sidebar.favOpen !== false;
  list.appendChild(bookmarkRow({
    title: 'Favorites', depth: 0, folder: true, virtual: true, expanded: favOpen, count: favorites.length,
    onClick: () => { settings.sidebar.favOpen = !favOpen; saveSettings(); renderBookmarks(); }
  }));
  if (favOpen) {
    for (const f of favorites) {
      list.appendChild(bookmarkRow({
        title: f.title, url: f.url, depth: 1,
        onClick: (e) => openFromEvent(f.url, e),
        onRename: (v) => { f.title = v; saveStore('favorites'); renderBookmarks(); },
        onDelete: () => { favorites = favorites.filter((x) => x !== f); saveStore('favorites'); renderBookmarks(); }
      }));
    }
  }
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      if (n.type === 'folder') {
        list.appendChild(bookmarkRow({
          id: n.id, title: n.title, depth, folder: true, expanded: n.expanded !== false, count: (n.children || []).length,
          onClick: () => { n.expanded = n.expanded === false; saveStore('bookmarks'); renderBookmarks(); },
          onRename: (v) => { n.title = v; saveStore('bookmarks'); renderBookmarks(); },
          onDelete: () => removeNode(n.id)
        }));
        if (n.expanded !== false) walk(n.children || [], depth + 1);
      } else {
        list.appendChild(bookmarkRow({
          id: n.id, title: n.title, url: n.url, favicon: n.favicon, depth,
          onClick: (e) => openFromEvent(n.url, e),
          onRename: (v) => { n.title = v; saveStore('bookmarks'); renderBookmarks(); },
          onDelete: () => removeNode(n.id)
        }));
      }
    }
  };
  walk(bookmarks, 0);
  if (!bookmarks.length && !favorites.length) list.appendChild(emptyRow('No Bookmarks'));
}
function newBookmarkFolder() {
  const node = { id: uid('b'), type: 'folder', title: 'New Folder', children: [], expanded: true };
  bookmarks.push(node);
  saveStore('bookmarks');
  renderBookmarks();
  const rows = $$('.sb-row', E.bookmarksList);
  const row = rows[rows.length - 1];
  if (row) inlineEdit($('.sb-title', row), node.title, (v) => { node.title = v; saveStore('bookmarks'); renderBookmarks(); });
}

/* ---- Reading List ---- */
let readingFilter = 'all';
const META_JS = `(() => {
  const m = (s) => { const e = document.querySelector(s); return e ? (e.content || '').trim() : ''; };
  const p = [...document.querySelectorAll('p')].map((x) => x.textContent.trim()).find((t) => t.length > 80) || '';
  const img = m('meta[property="og:image"]') || m('meta[name="twitter:image"]');
  let image = ''; try { image = img ? new URL(img, location.href).href : ''; } catch (e) {}
  return { desc: m('meta[property="og:description"]') || m('meta[name="description"]') || p.slice(0, 220), image };
})()`;
async function addToReadingList(tab) {
  if (!tab || !isHttp(tab.url)) { toast('Open a web page first'); return; }
  if (readingList.some((r) => r.url === tab.url)) { toast('Already in your Reading List'); return; }
  const item = { id: uid('r'), url: tab.url, title: tab.title || displayHost(tab.url), domain: displayHost(tab.url), favicon: tab.favicon, excerpt: '', thumb: '', added: Date.now(), read: false };
  if (tab.wv && tab.domReady) {
    try { const meta = await tab.wv.executeJavaScript(META_JS); item.excerpt = (meta.desc || '').slice(0, 240); item.thumb = meta.image || ''; } catch (_) { /* ignore */ }
  }
  readingList.unshift(item);
  saveStore('readingList');
  refreshSidebarIf('reading');
  toast('Added to Reading List');
}
function renderReading() {
  const list = E.readingList;
  list.textContent = '';
  $$('button', E.readingFilter).forEach((b) => b.classList.toggle('active', b.dataset.filter === readingFilter));
  const tokens = E.readingSearch.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const items = readingList.filter((r) => (readingFilter === 'all' || !r.read) && matchTokens(`${r.title} ${r.domain} ${r.excerpt || ''}`, tokens));
  if (!items.length) { list.appendChild(emptyRow(readingList.length ? 'No Matching Items' : 'No Items in Reading List')); return; }
  for (const r of items) {
    const row = tpl('tpl-sb-reading');
    row.classList.toggle('read', !!r.read);
    const thumb = $('.sb-thumb', row);
    if (r.thumb) thumb.style.backgroundImage = `url("${r.thumb.replace(/"/g, '%22')}")`;
    else { const m = monogram(r); thumb.style.backgroundColor = m.color; thumb.style.color = '#fff'; thumb.style.display = 'grid'; thumb.style.placeItems = 'center'; thumb.style.fontWeight = '700'; thumb.textContent = m.letter; }
    $('.sb-title', row).textContent = r.title;
    $('.sb-sub', row).textContent = r.domain;
    $('.sb-excerpt', row).textContent = r.excerpt || '';
    row.addEventListener('click', (e) => { r.read = true; saveStore('readingList'); openFromEvent(r.url, e); renderReading(); });
    $('.sb-read', row).addEventListener('click', (e) => { e.stopPropagation(); r.read = !r.read; saveStore('readingList'); renderReading(); });
    $('.sb-del', row).addEventListener('click', (e) => { e.stopPropagation(); readingList = readingList.filter((x) => x !== r); saveStore('readingList'); renderReading(); });
    list.appendChild(row);
  }
}

/* ---- History ---- */
let historyLimit = 400;
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
function dayLabel(t) {
  const sod = startOfDay(t), today = startOfDay(Date.now());
  if (sod === today) return 'Today';
  if (sod === today - 86400000) return 'Yesterday';
  return new Date(t).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}
async function renderHistory(reload) {
  if (reload) { historyCache = await S.store.get('history').catch(() => []); historyLimit = 400; }
  const tokens = E.historySearch.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const items = tokens.length ? historyCache.filter((x) => matchTokens(`${x.title || ''} ${x.url}`, tokens)) : historyCache;
  const list = E.historyList;
  const prevScroll = list.scrollTop;
  list.textContent = '';
  if (!items.length) { list.appendChild(emptyRow(historyCache.length ? 'No Matching History' : 'No History')); return; }
  let lastKey = null, shown = 0;
  for (const it of items) {
    if (shown >= historyLimit) break;
    const key = startOfDay(it.visitTime);
    if (key !== lastKey) { const hd = tpl('tpl-sb-header'); hd.textContent = dayLabel(it.visitTime); list.appendChild(hd); lastKey = key; }
    const row = tpl('tpl-sb-row');
    setIcon($('.sb-ico', row), it);
    $('.sb-title', row).textContent = it.title || it.url;
    $('.sb-sub', row).textContent = `${new Date(it.visitTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${displayHost(it.url)}`;
    $('.sb-edit', row).remove();
    row.addEventListener('click', (e) => openFromEvent(it.url, e));
    $('.sb-del', row).addEventListener('click', (e) => {
      e.stopPropagation();
      S.history.remove([it.id]);
      historyCache = historyCache.filter((x) => x.id !== it.id);
      renderHistory(false);
    });
    list.appendChild(row);
    shown++;
  }
  list.scrollTop = prevScroll;
}
function bindHistoryUI() {
  E.historySearch.addEventListener('input', debounce(() => { historyLimit = 400; renderHistory(false); }, 120));
  E.historyList.addEventListener('scroll', () => {
    const l = E.historyList;
    if (l.scrollTop + l.clientHeight > l.scrollHeight - 80 && historyLimit < historyCache.length) { historyLimit += 400; renderHistory(false); }
  });
  E.btnClearHistory.addEventListener('click', () => togglePopover(E.popClearHistory, E.btnClearHistory, { align: 'right' }));
  $$('[data-clear]', E.popClearHistory).forEach((item) => item.addEventListener('click', async () => {
    const range = item.dataset.clear;
    closePopovers();
    await S.history.clear(range, range === 'all').catch(() => {});
    toast(range === 'all' ? 'History and website data cleared' : 'History cleared');
    renderHistory(true);
    if (!curTab() || !curTab().url) renderStartPage();
  }));
}

/* ------------------------------------------------------------------ */
/* Start Page                                                         */
/* ------------------------------------------------------------------ */
function applyStartBackground() {
  const bg = settings.startPage.background || { type: 'preset', value: 'sequoia' };
  if (bg.type === 'custom' && bg.value) {
    E.startBg.dataset.bg = 'custom';
    E.startBg.style.backgroundImage = `url("${bg.value.replace(/"/g, '%22')}")`;
  } else {
    E.startBg.dataset.bg = bg.value || 'sequoia';
    E.startBg.style.backgroundImage = '';
  }
  $$('.bg-swatch[data-bg]').forEach((s) => s.classList.toggle('active', bg.type !== 'custom' && s.dataset.bg === bg.value));
  E.btnBgUpload.classList.toggle('active', bg.type === 'custom');
}
function renderStartPage() {
  const sp = settings.startPage;
  E.spFavorites.hidden = !sp.showFavorites;
  E.spPrivacy.hidden = !sp.showPrivacyReport;
  E.spReading.hidden = !sp.showReadingList || !readingList.length;
  E.spRecent.hidden = !sp.showRecentlyClosed || !recentlyClosed.length;
  applyStartBackground();
  if (sp.showFavorites) {
    const grid = E.favGrid;
    grid.textContent = '';
    for (const f of favorites) {
      const card = tpl('tpl-fav');
      setIcon($('.fav-icon', card), f, true);
      $('.fav-title', card).textContent = f.title;
      card.title = f.url;
      card.addEventListener('click', (e) => { if (e.target.closest('.fav-remove')) return; openFromEvent(f.url, e); });
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter') openFromEvent(f.url, e); });
      $('.fav-remove', card).addEventListener('click', (e) => { e.stopPropagation(); favorites = favorites.filter((x) => x !== f); saveStore('favorites'); renderStartPage(); refreshSidebarIf('bookmarks'); });
      grid.appendChild(card);
    }
    const add = tpl('tpl-fav-add');
    add.addEventListener('click', () => openBookmarkPopover({ kind: 'favorite', needUrl: true, url: '', title: '', anchor: add }));
    grid.appendChild(add);
  }
  if (sp.showPrivacyReport) {
    E.spTrackerCount.textContent = privacyStats.week.toLocaleString();
    S.privacy.report(0).then((r) => { privacyStats = { week: r.week, total: r.total }; E.spTrackerCount.textContent = r.week.toLocaleString(); }).catch(() => {});
  }
  if (!E.spReading.hidden) {
    const grid = E.spReadingGrid;
    grid.textContent = '';
    const items = [...readingList.filter((r) => !r.read), ...readingList.filter((r) => r.read)].slice(0, 6);
    for (const r of items) {
      const card = tpl('tpl-sp-reading');
      const th = $('.rc-thumb', card);
      if (r.thumb) th.style.backgroundImage = `url("${r.thumb.replace(/"/g, '%22')}")`;
      else { const m = monogram(r); th.style.backgroundColor = m.color; th.style.color = '#fff'; th.style.display = 'grid'; th.style.placeItems = 'center'; th.style.fontSize = '26px'; th.style.fontWeight = '700'; th.textContent = m.letter; }
      $('.rc-title', card).textContent = r.title;
      $('.rc-domain', card).textContent = r.domain;
      $('.rc-excerpt', card).textContent = r.excerpt || '';
      card.addEventListener('click', (e) => { r.read = true; saveStore('readingList'); openFromEvent(r.url, e); });
      grid.appendChild(card);
    }
  }
  if (!E.spRecent.hidden) {
    const row = E.spRecentList;
    row.textContent = '';
    for (const rec of recentlyClosed.slice(0, 8)) {
      const pill = tpl('tpl-pill');
      setIcon($('.pill-ico', pill), rec);
      $('.pill-title', pill).textContent = rec.title || displayHost(rec.url);
      pill.addEventListener('click', () => { recentlyClosed = recentlyClosed.filter((x) => x !== rec); saveSession(); navigateActive(rec.url); });
      row.appendChild(pill);
    }
  }
}
function bindStartPage() {
  E.btnCustomize.addEventListener('click', () => {
    const sp = settings.startPage;
    E.swFavorites.checked = !!sp.showFavorites; E.swPrivacy.checked = !!sp.showPrivacyReport;
    E.swReading.checked = !!sp.showReadingList; E.swRecent.checked = !!sp.showRecentlyClosed;
    applyStartBackground();
    togglePopover(E.popCustomize, E.btnCustomize, { align: 'right', above: true });
  });
  const bindSwitch = (input, key) => input.addEventListener('change', () => { settings.startPage[key] = input.checked; saveSettings(); renderStartPage(); });
  bindSwitch(E.swFavorites, 'showFavorites'); bindSwitch(E.swPrivacy, 'showPrivacyReport');
  bindSwitch(E.swReading, 'showReadingList'); bindSwitch(E.swRecent, 'showRecentlyClosed');
  $$('.bg-swatch[data-bg]').forEach((s) => s.addEventListener('click', () => { settings.startPage.background = { type: 'preset', value: s.dataset.bg }; saveSettings(); applyStartBackground(); }));
  E.btnBgUpload.addEventListener('click', async () => {
    const r = await S.dialogs.pickBackground().catch(() => null);
    if (r && r.url) { settings.startPage.background = { type: 'custom', value: r.url }; saveSettings(); applyStartBackground(); }
  });
  E.spPrivacyCard.addEventListener('click', () => openPrivacyPopover(E.spPrivacyCard));
  E.spPrivacyCard.addEventListener('keydown', (e) => { if (e.key === 'Enter') openPrivacyPopover(E.spPrivacyCard); });
}

/* ------------------------------------------------------------------ */
/* Add Bookmark / Reading List / Favorite popover                     */
/* ------------------------------------------------------------------ */
let bmCtx = null;
function ensureBmUrlRow() {
  if (document.getElementById('bm-url-row')) return;
  const input = h('input', { id: 'bm-url', class: 'input', type: 'text', spellcheck: 'false', placeholder: 'https://example.com' });
  const row = h('div', { class: 'bm-row', id: 'bm-url-row' }, h('span', { class: 'bm-label', text: 'URL' }), input);
  E.popBookmark.insertBefore(row, E.bmFolderRow);
  E.bmUrlRow = row;
  E.bmUrl = input;
}
function setBmKind(kind) {
  bmCtx.kind = kind;
  $$('button', E.bmKind).forEach((b) => b.classList.toggle('active', b.dataset.kind === kind));
  E.bmFolderRow.hidden = kind !== 'bookmark';
  E.bmAdd.textContent = 'Add';
}
function openBookmarkPopover(opts = {}) {
  ensureBmUrlRow();
  const tab = curTab();
  const url = opts.url !== undefined ? opts.url : (tab && tab.url) || '';
  if (!opts.needUrl && !isHttp(url)) { toast('Open a web page first'); return; }
  const title = opts.title !== undefined ? opts.title : (tab && (tab.title || displayHost(tab.url))) || '';
  bmCtx = { kind: opts.kind || 'bookmark', url, title, favicon: tab && tab.favicon, needUrl: !!opts.needUrl, tab };
  E.bmTitle.value = title;
  E.bmUrlRow.hidden = !opts.needUrl;
  E.bmUrl.value = url;
  E.bmKind.hidden = !!opts.needUrl;
  setIcon(E.bmIcon, { url, title, favicon: bmCtx.favicon });
  E.bmFolder.textContent = '';
  folderOptions().forEach((o) => E.bmFolder.appendChild(h('option', { value: o.id, text: o.label })));
  setBmKind(bmCtx.kind);
  const anchor = opts.anchor || (E.btnAdd.hidden ? E.btnShare : E.btnAdd);
  openPopover(E.popBookmark, anchor, { align: opts.anchor ? 'center' : 'right' });
  setTimeout(() => { (opts.needUrl ? E.bmUrl : E.bmTitle).focus(); (opts.needUrl ? E.bmUrl : E.bmTitle).select(); }, 60);
}
function commitBookmarkPopover() {
  if (!bmCtx) return;
  let url = bmCtx.url;
  if (bmCtx.needUrl) {
    const r = resolveInput(E.bmUrl.value);
    if (!r || !r.url || r.url === searchUrl(E.bmUrl.value.trim())) { toast('Enter a valid web address'); return; }
    url = r.url;
  }
  const title = E.bmTitle.value.trim() || displayHost(url);
  if (bmCtx.kind === 'bookmark') {
    addBookmark({ id: uid('b'), type: 'bookmark', title, url, favicon: bmCtx.favicon || null }, E.bmFolder.value);
    toast('Bookmark added');
  } else if (bmCtx.kind === 'favorite') {
    favorites.push({ id: uid('f'), title, url });
    saveStore('favorites'); renderStartPage(); refreshSidebarIf('bookmarks');
    toast('Added to Favorites');
  } else if (bmCtx.tab) {
    bmCtx.tab.title = bmCtx.tab.title || title;
    addToReadingList(bmCtx.tab);
  }
  closePopovers();
}
function bindBookmarkPopover() {
  $$('button', E.bmKind).forEach((b) => b.addEventListener('click', () => setBmKind(b.dataset.kind)));
  E.bmCancel.addEventListener('click', closePopovers);
  E.bmAdd.addEventListener('click', commitBookmarkPopover);
  E.popBookmark.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitBookmarkPopover(); } });
  E.btnAdd.addEventListener('click', () => openBookmarkPopover());
}

/* ------------------------------------------------------------------ */
/* Share                                                              */
/* ------------------------------------------------------------------ */
function bindShare() {
  E.btnShare.addEventListener('click', () => togglePopover(E.popShare, E.btnShare, { align: 'right' }));
  const act = (id, fn) => E[id].addEventListener('click', () => { closePopovers(); fn(curTab()); });
  act('shareCopy', (t) => { if (t && t.url) { S.clipboard.writeText(t.url); toast('Link copied'); } });
  E.shareBookmark.addEventListener('click', () => { closePopovers(); setTimeout(() => openBookmarkPopover({ kind: 'bookmark', anchor: E.btnShare }), 30); });
  act('shareReading', (t) => addToReadingList(t));
  act('sharePdf', async (t) => {
    if (!t || !t.wcId) return;
    const r = await S.page.savePDF(t.wcId, t.title).catch(() => null);
    if (r && r.ok) toast('Saved as PDF'); else if (r && !r.canceled) toast('Could not save PDF');
  });
  act('sharePrint', (t) => { if (t && t.wcId) S.page.print(t.wcId); });
  act('shareEmail', (t) => { if (t && t.url) S.shell.openExternal(`mailto:?subject=${encodeURIComponent(t.title || displayHost(t.url))}&body=${encodeURIComponent(t.url)}`); });
  act('shareSource', () => showViewSource());
  act('shareInspector', () => toggleDevtools());
}

/* ------------------------------------------------------------------ */
/* Privacy Report                                                     */
/* ------------------------------------------------------------------ */
async function openPrivacyPopover(anchor) {
  const tab = curTab();
  const r = await S.privacy.report((tab && tab.wcId) || 0).catch(() => null);
  if (!r) return;
  const host = tab && tab.url ? hostOf(tab.url) : '';
  E.ppTitle.textContent = host ? `Privacy Report for ${host}` : 'Privacy Report';
  E.ppSub.textContent = r.enabled ? 'Safari is helping protect your privacy' : 'Tracker prevention is turned off';
  E.ppPageCount.textContent = String(r.page.count);
  const list = E.ppTrackers;
  list.textContent = '';
  if (!host) list.hidden = true; else list.hidden = false;
  if (host && !r.page.trackers.length) list.appendChild(h('div', { class: 'pp-row' }, h('span', { text: 'No trackers contacted this page' }), h('span', { text: '' })));
  r.page.trackers.slice(0, 6).forEach((t) => list.appendChild(h('div', { class: 'pp-row' }, h('span', { text: t.domain }), h('span', { text: String(t.count) }))));
  E.ppWeekCount.textContent = r.week.toLocaleString();
  E.ppSites.textContent = '';
  r.sites.slice(0, 5).forEach((s) => E.ppSites.appendChild(h('div', { class: 'pp-row' }, h('span', { text: s.host }), h('span', { text: `${s.count} blocked` }))));
  const exceptions = settings.privacyExceptions || [];
  E.ppSiteToggle.checked = !exceptions.includes(host);
  E.ppSiteToggle.disabled = !r.enabled || !host;
  E.ppSiteToggle.closest('.pp-toggle').style.display = host ? '' : 'none';
  openPopover(E.popPrivacy, anchor, { width: 340 });
}
function bindPrivacy() {
  E.btnPrivacy.addEventListener('click', () => { if (E.popPrivacy.classList.contains('open')) closePopovers(); else openPrivacyPopover(E.btnPrivacy); });
  E.ppSiteToggle.addEventListener('change', () => {
    const tab = curTab(); const host = tab && hostOf(tab.url);
    if (!host) return;
    const ex = new Set(settings.privacyExceptions || []);
    if (E.ppSiteToggle.checked) ex.delete(host); else ex.add(host);
    settings.privacyExceptions = [...ex];
    saveSettings();
    setTimeout(() => reloadTab(tab), 200);
  });
  S.privacy.onBlocked((d) => {
    privacyStats = { week: d.weekCount, total: d.total };
    const tab = wcToTab.get(d.webContentsId);
    if (tab) { tab.blocked = d.pageCount; if (tab === curTab()) updateToolbar(); }
    if (!curTab() || !curTab().url) E.spTrackerCount.textContent = d.weekCount.toLocaleString();
  });
}

/* ------------------------------------------------------------------ */
/* Downloads                                                          */
/* ------------------------------------------------------------------ */
const dlEls = new Map();
const RING = 56.55;
function fmtBytes(n) {
  if (!n || n < 0) return '0 KB';
  const u = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
function dlIconFor(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'].includes(ext)) return 'photo';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'iso', 'exe', 'msi', 'dmg'].includes(ext)) return 'download';
  return 'pdf';
}
function renderDownloadItem(rec) {
  let node = dlEls.get(rec.id);
  if (!node) {
    node = tpl('tpl-dl-item');
    dlEls.set(rec.id, node);
    $('.dl-pause', node).addEventListener('click', () => { const r = downloads.get(rec.id); if (r.paused) S.downloads.resume(rec.id); else S.downloads.pause(rec.id); });
    $('.dl-cancel', node).addEventListener('click', () => S.downloads.cancel(rec.id));
    $('.dl-open', node).addEventListener('click', async () => { const r = await S.downloads.open(rec.id).catch(() => null); if (r && !r.ok) { const d = downloads.get(rec.id); if (d) { d.missing = true; renderDownloadItem(d); } } });
    $('.dl-show', node).addEventListener('click', () => S.downloads.show(rec.id));
    $('.dl-remove', node).addEventListener('click', () => { S.downloads.remove(rec.id); downloads.delete(rec.id); node.remove(); dlEls.delete(rec.id); updateDownloadsButton(); });
  }
  const active = rec.state === 'progressing';
  node.classList.toggle('active', active);
  node.classList.toggle('done', rec.state === 'completed');
  node.classList.toggle('failed', rec.state === 'interrupted');
  node.classList.toggle('missing', !!rec.missing);
  $('.dl-name', node).textContent = rec.filename;
  const ico = $('.dl-icon use', node);
  if (ico) ico.setAttribute('href', `#i-${dlIconFor(rec.filename)}`);
  const bar = $('.dl-bar', node);
  const pct = rec.totalBytes > 0 ? Math.min(100, (rec.receivedBytes / rec.totalBytes) * 100) : 0;
  bar.classList.toggle('indeterminate', active && rec.totalBytes <= 0 && !rec.paused);
  $('i', bar).style.width = `${pct}%`;
  let status;
  if (active) {
    const prog = rec.totalBytes > 0 ? `${fmtBytes(rec.receivedBytes)} of ${fmtBytes(rec.totalBytes)}` : fmtBytes(rec.receivedBytes);
    status = rec.paused ? `Paused — ${prog}` : `${prog}${rec.bytesPerSecond ? ` — ${fmtBytes(rec.bytesPerSecond)}/s` : ''}`;
  } else if (rec.state === 'completed') status = rec.missing ? 'File was moved or deleted' : `${fmtBytes(rec.totalBytes)} — Completed`;
  else status = 'Download failed';
  $('.dl-status', node).textContent = status;
  const pauseUse = $('.dl-pause use', node);
  if (pauseUse) pauseUse.setAttribute('href', rec.paused ? '#i-play' : '#i-pause');
  $('.dl-pause', node).title = rec.paused ? 'Resume' : 'Pause';
  return node;
}
function sortDownloadsDom() {
  const list = E.downloadsList;
  [...downloads.values()].sort((a, b) => b.startTime - a.startTime).forEach((rec, i) => {
    const n = dlEls.get(rec.id);
    if (n && list.children[i] !== n) list.insertBefore(n, list.children[i] || null);
  });
}
function updateDownloadsButton() {
  let received = 0, total = 0, active = 0;
  for (const r of downloads.values()) if (r.state === 'progressing') { active++; if (r.totalBytes > 0) { received += r.receivedBytes; total += r.totalBytes; } }
  E.btnDownloads.classList.toggle('idle', active === 0);
  E.btnDownloads.classList.toggle('done', active === 0);
  const frac = total > 0 ? received / total : 0;
  E.dlRingFg.style.strokeDashoffset = String(RING * (1 - frac));
}
function onDownloadUpdate(rec) {
  const isNew = !downloads.has(rec.id);
  downloads.set(rec.id, rec);
  const node = renderDownloadItem(rec);
  if (!node.isConnected) E.downloadsList.appendChild(node);
  sortDownloadsDom();
  if (E.btnDownloads.hidden) {
    E.btnDownloads.hidden = false;
    E.btnDownloads.classList.add('appear');
    setTimeout(() => E.btnDownloads.classList.remove('appear'), 600);
  }
  updateDownloadsButton();
  if (isNew && rec.state === 'progressing') {
    openPopover(E.popDownloads, E.btnDownloads, { align: 'right' });
    setTimeout(() => { if (pop.el === E.popDownloads && !E.popDownloads.matches(':hover')) closePopovers(); }, 4500);
  }
}
function toggleDownloads() {
  const anchor = E.btnDownloads.hidden ? E.btnShare : E.btnDownloads;
  togglePopover(E.popDownloads, anchor, { align: 'right' });
}
async function loadDownloads() {
  const list = await S.downloads.list().catch(() => []);
  for (const rec of list) { downloads.set(rec.id, rec); const n = renderDownloadItem(rec); E.downloadsList.appendChild(n); }
  sortDownloadsDom();
  S.downloads.onUpdate(onDownloadUpdate);
  E.btnDownloads.addEventListener('click', () => toggleDownloads());
  E.btnClearDownloads.addEventListener('click', () => {
    S.downloads.clear();
    for (const [id, r] of [...downloads]) if (r.state !== 'progressing') { downloads.delete(id); const n = dlEls.get(id); if (n) n.remove(); dlEls.delete(id); }
    updateDownloadsButton();
  });
}

/* ------------------------------------------------------------------ */
/* Settings sheet                                                     */
/* ------------------------------------------------------------------ */
function bindSegmented(container, onChange) {
  $$('button', container).forEach((b) => b.addEventListener('click', () => { onChange(b.dataset.value); setSegmented(container, b.dataset.value); }));
}
function setSegmented(container, value) { $$('button', container).forEach((b) => b.classList.toggle('active', b.dataset.value === value)); }
function syncSettingsUI() {
  setSegmented(E.setTheme, settings.theme);
  setSegmented(E.setTablayout, settings.tabLayout);
  E.setColortab.checked = !!settings.colorInCompactTabBar;
  E.setMaterial.value = settings.nativeMaterial || 'none';
  E.setEngine.value = settings.searchEngine;
  E.setHomepage.value = settings.homepage === 'safari://start' ? '' : settings.homepage;
  E.setDownloadsPath.textContent = settings.downloadsPath || INFO.downloadsDir || '';
  E.setBlocktrackers.checked = settings.blockTrackers !== false;
  const v = INFO.versions || {};
  E.setAbout.textContent = `Safari for Windows ${INFO.version || ''} · Chromium ${v.chrome || ''} · Electron ${v.electron || ''}`;
}
function openSettings() {
  closePopovers(); closeSuggestions();
  syncSettingsUI();
  E.settings.classList.add('open');
  E.settings.setAttribute('aria-hidden', 'false');
}
function closeSettings() { E.settings.classList.remove('open'); E.settings.setAttribute('aria-hidden', 'true'); }
function bindSettings() {
  for (const [key, eng] of Object.entries(INFO.searchEngines || {})) E.setEngine.appendChild(h('option', { value: key, text: eng.name }));
  E.btnSettings.addEventListener('click', openSettings);
  E.btnSettingsClose.addEventListener('click', closeSettings);
  E.settings.addEventListener('mousedown', (e) => { if (e.target === E.settings) closeSettings(); });
  bindSegmented(E.setTheme, (v) => { settings.theme = v; saveSettings(); });
  bindSegmented(E.setTablayout, (v) => { settings.tabLayout = v; saveSettings(); renderTabs(); applyTint(curTab()); });
  E.setColortab.addEventListener('change', () => { settings.colorInCompactTabBar = E.setColortab.checked; saveSettings(); applyTint(curTab()); });
  E.setMaterial.addEventListener('change', () => { settings.nativeMaterial = E.setMaterial.value; saveSettings(); });
  E.setEngine.addEventListener('change', () => { settings.searchEngine = E.setEngine.value; saveSettings(); });
  E.setHomepage.addEventListener('change', () => { settings.homepage = E.setHomepage.value.trim() || 'safari://start'; saveSettings(); });
  E.setBlocktrackers.addEventListener('change', () => { settings.blockTrackers = E.setBlocktrackers.checked; saveSettings(); });
  E.btnChooseDownloads.addEventListener('click', async () => { const p = await S.downloads.chooseFolder().catch(() => null); if (p) { settings.downloadsPath = p; E.setDownloadsPath.textContent = p; } });
  E.btnClearCache.addEventListener('click', async () => { await S.privacy.clearData('cache'); toast('Cache cleared'); });
  let armed = false, armTimer;
  E.btnClearWebsiteData.addEventListener('click', async () => {
    if (!armed) { armed = true; E.btnClearWebsiteData.textContent = 'Click Again to Confirm'; armTimer = setTimeout(() => { armed = false; E.btnClearWebsiteData.textContent = 'Remove All Website Data…'; }, 4000); return; }
    clearTimeout(armTimer); armed = false;
    E.btnClearWebsiteData.textContent = 'Remove All Website Data…';
    await S.privacy.clearData('all');
    toast('All website data removed');
  });
  E.btnResetPrivacy.addEventListener('click', async () => { await S.privacy.reset(); privacyStats = { week: 0, total: 0 }; E.spTrackerCount.textContent = '0'; toast('Tracker counts reset'); });
}

/* ------------------------------------------------------------------ */
/* Reader View                                                        */
/* ------------------------------------------------------------------ */
// These two run INSIDE the web page (via executeJavaScript) — they must stay self-contained.
function pageDetectArticle() {
  var ps = Array.prototype.filter.call(document.querySelectorAll('p'), function (p) { return p.textContent.trim().length > 80; });
  var total = 0;
  for (var i = 0; i < ps.length; i++) total += ps[i].textContent.length;
  return (!!document.querySelector('article') && total > 800) || total > 2500;
}
function pageExtractArticle() {
  var BAD = /(comment|sidebar|footer|nav|menu|share|social|related|promo|advert|sponsor|newsletter|subscribe|cookie|popup|modal|breadcrumb|toolbar|widget|outbrain|taboola)/i;
  function cls(n) { return typeof n.className === 'string' ? n.className : ''; }
  function textLen(e) { return (e.textContent || '').replace(/\s+/g, ' ').trim().length; }
  function abs(u) { try { return new URL(u, location.href).href; } catch (e) { return ''; } }
  function meta(n) { var m = document.querySelector('meta[property="' + n + '"],meta[name="' + n + '"]'); return m ? (m.getAttribute('content') || '').trim() : ''; }
  var cands = Array.prototype.slice.call(document.querySelectorAll('article, main, [role=main], [itemprop=articleBody], .post-content, .entry-content, .article-body, .article-content, .story-body, .post, #content, #main, section, div'), 0, 600);
  var scored = [], max = 0;
  cands.forEach(function (c) {
    if (BAD.test((c.id || '') + ' ' + cls(c))) return;
    var ps = c.querySelectorAll('p'), score = 0, i, j;
    for (i = 0; i < ps.length; i++) { var l = textLen(ps[i]); if (l > 60 && !ps[i].closest('nav,footer,aside')) score += l; }
    var links = 0, as = c.querySelectorAll('a');
    for (j = 0; j < as.length; j++) links += textLen(as[j]);
    var total = textLen(c) || 1;
    score = score * (1 - Math.min(0.9, links / total));
    if (c.tagName === 'ARTICLE') score *= 1.25;
    scored.push({ c: c, s: score });
    if (score > max) max = score;
  });
  if (max < 300) return null;
  var best = null, bestLen = Infinity;
  scored.forEach(function (x) { if (x.s >= max * 0.8) { var l = textLen(x.c); if (l < bestLen) { best = x.c; bestLen = l; } } });
  if (!best) return null;
  var root = best.cloneNode(true);
  Array.prototype.forEach.call(root.querySelectorAll('script,style,noscript,nav,aside,footer,form,iframe,button,input,select,textarea,svg,canvas,video,audio,object,embed,[hidden],[aria-hidden="true"]'), function (n) { n.remove(); });
  Array.prototype.forEach.call(root.querySelectorAll('[class],[id]'), function (n) {
    if (BAD.test((n.id || '') + ' ' + cls(n)) && textLen(n) < 500) n.remove();
  });
  Array.prototype.forEach.call(root.querySelectorAll('img'), function (img) {
    var src = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy-src') || (img.getAttribute('srcset') || '').split(',')[0].trim().split(' ')[0] || img.getAttribute('src') || '';
    if (!src || /^data:image\/gif/.test(src)) { img.remove(); return; }
    img.setAttribute('src', abs(src));
    img.removeAttribute('srcset');
  });
  Array.prototype.forEach.call(root.querySelectorAll('a[href]'), function (a) { a.setAttribute('href', abs(a.getAttribute('href'))); });
  var h1 = root.querySelector('h1');
  var title = meta('og:title') || (h1 ? h1.textContent.trim() : '') || document.title;
  if (h1) h1.remove();
  var authorEl = document.querySelector('[rel=author],[itemprop=author],.byline,.author');
  var author = meta('author') || meta('article:author') || (authorEl ? authorEl.textContent.trim().replace(/\s+/g, ' ') : '');
  if (author.length > 80) author = '';
  var time = document.querySelector('time[datetime]');
  var og = meta('og:image');
  return {
    title: title, author: author,
    date: meta('article:published_time') || (time ? time.getAttribute('datetime') : ''),
    site: meta('og:site_name') || location.hostname.replace(/^www\./, ''),
    lead: og ? abs(og) : '', html: root.innerHTML, url: location.href, length: bestLen
  };
}

const READER_ALLOWED = new Set('P H1 H2 H3 H4 H5 H6 UL OL LI BLOCKQUOTE PRE CODE EM STRONG B I U A IMG FIGURE FIGCAPTION BR HR TABLE THEAD TBODY TR TD TH SUP SUB SMALL SPAN DIV SECTION ARTICLE CITE Q MARK DL DT DD'.split(' '));
const READER_DROP = new Set('SCRIPT STYLE NOSCRIPT IFRAME OBJECT EMBED FORM SVG CANVAS TEMPLATE BUTTON INPUT TEXTAREA SELECT NAV ASIDE FOOTER HEAD TITLE META LINK'.split(' '));
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = document.createDocumentFragment();
  const walk = (src, dst) => {
    for (const n of src.childNodes) {
      if (n.nodeType === 3) { dst.appendChild(document.createTextNode(n.nodeValue)); continue; }
      if (n.nodeType !== 1 || READER_DROP.has(n.tagName)) continue;
      if (!READER_ALLOWED.has(n.tagName)) { walk(n, dst); continue; }
      const copy = document.createElement(n.tagName.toLowerCase());
      if (n.tagName === 'A') { const href = n.getAttribute('href') || ''; if (/^(https?:|mailto:)/i.test(href)) copy.setAttribute('href', href); }
      if (n.tagName === 'IMG') {
        const src2 = n.getAttribute('src') || '';
        if (!/^(https?:|data:image\/)/i.test(src2)) continue;
        copy.setAttribute('src', src2); copy.setAttribute('alt', n.getAttribute('alt') || ''); copy.loading = 'lazy';
      }
      if ((n.tagName === 'TD' || n.tagName === 'TH') && n.getAttribute('colspan')) copy.setAttribute('colspan', String(parseInt(n.getAttribute('colspan'), 10) || 1));
      walk(n, copy);
      dst.appendChild(copy);
    }
  };
  walk(doc.body, out);
  $$('p, div, span', out).forEach((p) => { if (!p.textContent.trim() && !p.querySelector('img')) p.remove(); });
  return out;
}

function detectArticle(tab) {
  if (!tab.wv || !tab.domReady || !isHttp(tab.url)) return;
  tab.wv.executeJavaScript(`(${pageDetectArticle.toString()})()`)
    .then((v) => { tab.readerAvailable = !!v; if (tab === curTab()) updateToolbar(); })
    .catch(() => {});
}
function applyReaderPrefs() {
  const r = settings.reader;
  E.reader.dataset.theme = r.theme;
  E.reader.dataset.font = r.font;
  E.reader.style.setProperty('--reader-size', String(r.size));
  $$('[data-reader-theme]', E.readerThemes).forEach((b) => b.classList.toggle('active', b.dataset.readerTheme === r.theme));
  $$('[data-reader-font]', E.readerFonts).forEach((b) => b.classList.toggle('active', b.dataset.readerFont === r.font));
}
async function openReader(tab) {
  if (!tab || !tab.wv || !tab.domReady || !isHttp(tab.url)) { toast('Reader isn’t available for this page'); return; }
  let data = null;
  try { data = await tab.wv.executeJavaScript(`(${pageExtractArticle.toString()})()`); } catch (_) { /* ignore */ }
  if (!data || !data.html || data.length < 200) { toast('Reader isn’t available for this page'); return; }
  if (tab !== curTab()) return;
  tab.reader = data;
  E.readerTitle.textContent = data.title || tab.title;
  const when = data.date ? new Date(data.date) : null;
  E.readerMeta.textContent = [data.site, data.author, when && !isNaN(when) ? when.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : ''].filter(Boolean).join(' · ');
  E.readerBody.textContent = '';
  E.readerBody.appendChild(sanitizeHtml(data.html));
  const hasLead = data.lead && !data.html.includes(data.lead.split('?')[0]);
  E.readerLeadWrap.hidden = !hasLead;
  if (hasLead) E.readerLead.src = data.lead;
  applyReaderPrefs();
  E.reader.classList.add('open');
  E.reader.setAttribute('aria-hidden', 'false');
  E.app.classList.add('reader-open');
  E.readerScroll.scrollTop = 0;
  updateToolbar();
}
function closeReader() {
  const tab = curTab();
  if (tab) tab.reader = null;
  E.reader.classList.remove('open');
  E.reader.setAttribute('aria-hidden', 'true');
  E.app.classList.remove('reader-open');
  if (E.popReader.classList.contains('open')) closePopovers();
  updateToolbar();
}
function toggleReader() {
  const tab = curTab();
  if (!tab || !tab.url) return;
  if (tab.reader) closeReader(); else openReader(tab);
}
function bindReader() {
  E.btnReader.addEventListener('click', toggleReader);
  E.btnReaderClose.addEventListener('click', closeReader);
  E.btnReaderAa.addEventListener('click', () => { applyReaderPrefs(); togglePopover(E.popReader, E.btnReaderAa, { align: 'right' }); });
  const save = () => { applyReaderPrefs(); saveSettings(); };
  E.readerThemes.addEventListener('click', (e) => { const b = e.target.closest('[data-reader-theme]'); if (b) { settings.reader.theme = b.dataset.readerTheme; save(); } });
  E.readerFonts.addEventListener('click', (e) => { const b = e.target.closest('[data-reader-font]'); if (b) { settings.reader.font = b.dataset.readerFont; save(); } });
  const step = (d) => { const i = READER_SIZES.indexOf(settings.reader.size); const idx = clamp((i < 0 ? 2 : i) + d, 0, READER_SIZES.length - 1); settings.reader.size = READER_SIZES[idx]; save(); };
  E.readerSmaller.addEventListener('click', () => step(-1));
  E.readerLarger.addEventListener('click', () => step(1));
  E.readerBody.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    if (/^https?:/i.test(href)) { closeReader(); if (e.ctrlKey) newTab({ url: href }); else navigateActive(href); }
  });
}

/* ------------------------------------------------------------------ */
/* Tab Overview                                                       */
/* ------------------------------------------------------------------ */
const overviewIsOpen = () => E.overview.classList.contains('open');
async function openOverview() {
  closePopovers(); closeSuggestions(); closeFind(true);
  const t = curTab();
  if (t) await Promise.race([snapshotTab(t), sleep(350)]);
  E.overview.classList.add('open');
  E.overview.setAttribute('aria-hidden', 'false');
  E.app.classList.add('overview-open');
  E.overviewSearch.value = '';
  renderOverview();
  E.overviewSearch.focus();
}
function closeOverview() {
  E.overview.classList.remove('open');
  E.overview.setAttribute('aria-hidden', 'true');
  E.app.classList.remove('overview-open');
}
function toggleOverview() { if (overviewIsOpen()) closeOverview(); else openOverview(); }
function renderOverview() {
  const g = curGroup();
  const tokens = E.overviewSearch.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const tabs = orderedTabs(g).filter((t) => matchTokens(`${t.title} ${t.url}`, tokens));
  E.overviewGroup.textContent = g.id === DEFAULT_GROUP ? '' : g.name;
  const grid = E.overviewGrid;
  grid.textContent = '';
  E.overviewEmpty.hidden = tabs.length > 0;
  tabs.forEach((t, i) => {
    const card = tpl('tpl-ov-card');
    card.classList.toggle('active', g.activeTabId === t.id);
    card.style.animationDelay = `${Math.min(i, 14) * 22}ms`;
    $('.ov-title', card).textContent = t.title || (t.url ? displayHost(t.url) : 'Start Page');
    setIcon($('.ov-fav', card), t.url ? t : { url: '', title: 'S' });
    const img = $('.ov-img', card);
    if (t.snapshot) img.src = t.snapshot; else img.removeAttribute('src');
    $('.ov-placeholder', card).textContent = t.url ? monogram(t).letter : '★';
    card.addEventListener('click', (e) => { if (e.target.closest('.ov-close')) return; closeOverview(); activateTab(t.id); });
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') { closeOverview(); activateTab(t.id); } });
    $('.ov-close', card).addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); renderOverview(); });
    grid.appendChild(card);
  });
}
function bindOverview() {
  E.btnOverview.addEventListener('click', toggleOverview);
  E.btnOverviewDone.addEventListener('click', closeOverview);
  E.btnOverviewNew.addEventListener('click', () => { closeOverview(); newTab({ focusAddress: true }); });
  E.overviewSearch.addEventListener('input', debounce(renderOverview, 80));
  E.overviewSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = $('.ov-card', E.overviewGrid); if (first) first.click(); }
  });
  E.overviewGrid.addEventListener('mousedown', (e) => { if (e.target === E.overviewGrid) closeOverview(); });
}

/* ------------------------------------------------------------------ */
/* Find on Page                                                       */
/* ------------------------------------------------------------------ */
const find = { tab: null };
function openFind() {
  const t = curTab();
  if (!t || !t.wv || !t.domReady) return;
  closePopovers(); closeSuggestions();
  find.tab = t;
  E.findbar.classList.add('open');
  E.findInput.focus(); E.findInput.select();
  if (E.findInput.value) runFind(false, true);
}
function closeFind(silent) {
  if (find.tab && find.tab.wv && find.tab.domReady) { try { find.tab.wv.stopFindInPage('clearSelection'); } catch (_) { /* ignore */ } }
  const wasOpen = E.findbar.classList.contains('open');
  find.tab = null;
  E.findbar.classList.remove('open', 'nomatch');
  E.findCount.textContent = '';
  if (wasOpen && !silent) { const t = curTab(); if (t && t.wv) { try { t.wv.focus(); } catch (_) { /* ignore */ } } }
}
function syncFindBar() { if (find.tab && find.tab !== curTab()) closeFind(true); }
function runFind(findNext, forward) {
  const t = find.tab || curTab();
  const text = E.findInput.value;
  if (!t || !t.wv || !t.domReady) return;
  if (!text) { try { t.wv.stopFindInPage('clearSelection'); } catch (_) { /* ignore */ } E.findCount.textContent = ''; E.findbar.classList.remove('nomatch'); return; }
  find.tab = t;
  try { t.wv.findInPage(text, { findNext: !!findNext, forward: forward !== false, matchCase: false }); } catch (_) { /* ignore */ }
}
function onFound(result) {
  if (!result) return;
  if (!result.matches) { E.findCount.textContent = 'No matches'; E.findbar.classList.add('nomatch'); return; }
  E.findbar.classList.remove('nomatch');
  E.findCount.textContent = `${result.activeMatchOrdinal} of ${result.matches}`;
}
function bindFind() {
  E.findInput.addEventListener('input', debounce(() => runFind(false, true), 60));
  E.findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runFind(true, !e.shiftKey); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  E.findNext.addEventListener('click', () => runFind(true, true));
  E.findPrev.addEventListener('click', () => runFind(true, false));
  E.findDone.addEventListener('click', () => closeFind());
}

/* ------------------------------------------------------------------ */
/* Zoom                                                               */
/* ------------------------------------------------------------------ */
let zoomTimer;
function applyZoom(tab) {
  const z = ((settings.zoomLevels || {})[hostOf(tab.url)]) || 1;
  tab.zoom = z;
  if (tab.wv && tab.domReady) { try { tab.wv.setZoomFactor(z); } catch (_) { /* ignore */ } }
}
function changeZoom(dir) {
  const t = curTab();
  if (!t || !t.url) return;
  let z = 1;
  if (dir !== 0) {
    const cur = t.zoom || 1;
    let idx = 0, best = Infinity;
    ZOOM_STEPS.forEach((s, i) => { const d = Math.abs(s - cur); if (d < best) { best = d; idx = i; } });
    z = ZOOM_STEPS[clamp(idx + dir, 0, ZOOM_STEPS.length - 1)];
  }
  const host = hostOf(t.url);
  settings.zoomLevels = settings.zoomLevels || {};
  if (z === 1) delete settings.zoomLevels[host]; else settings.zoomLevels[host] = z;
  saveSettings();
  applyZoom(t);
  E.zoomBadge.textContent = `${Math.round(z * 100)}%`;
  E.zoomBadge.classList.add('show');
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => E.zoomBadge.classList.remove('show'), 1600);
}

/* ------------------------------------------------------------------ */
/* Web Inspector + View Source                                        */
/* ------------------------------------------------------------------ */
function syncDevtoolsDock() {
  const t = curTab();
  for (const tab of tabsById.values()) if (tab.devtoolsWv) tab.devtoolsWv.style.display = tab === t ? '' : 'none';
  E.devtoolsDock.hidden = !(t && t.devtoolsWv);
}
function closeDevtools(t) {
  if (t.wcId) S.devtools.close(t.wcId).catch(() => {});
  if (t.devtoolsWv) { t.devtoolsWv.remove(); t.devtoolsWv = null; }
  t.devtoolsOpen = false;
  syncDevtoolsDock();
}
function toggleDevtools() {
  const t = curTab();
  if (!t || !t.url || !t.wcId || !t.domReady) { toast('Open a web page to use the Web Inspector'); return; }
  closePopovers();
  if (t.devtoolsWv || t.devtoolsOpen) { closeDevtools(t); return; }
  const dt = document.createElement('webview');
  dt.setAttribute('partition', INFO.devtoolsPartition || 'safari-devtools');
  t.devtoolsWv = dt;
  E.devtoolsHost.appendChild(dt);
  syncDevtoolsDock();
  dt.addEventListener('did-attach', async () => {
    try { await S.devtools.openDocked(t.wcId, dt.getWebContentsId()); t.devtoolsOpen = true; }
    catch (_) {
      dt.remove(); t.devtoolsWv = null; syncDevtoolsDock();
      try { t.devtoolsOpen = !!(await S.devtools.toggle(t.wcId, 'detach')); } catch (__) { /* ignore */ }
    }
  }, { once: true });
}
function bindDevtools() {
  S.devtools.onState(({ webContentsId, opened }) => {
    const t = wcToTab.get(webContentsId);
    if (!t) return;
    t.devtoolsOpen = opened;
    if (!opened && t.devtoolsWv) { t.devtoolsWv.remove(); t.devtoolsWv = null; syncDevtoolsDock(); }
  });
  E.devtoolsResizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const shield = h('div', { style: 'position:fixed;inset:0;z-index:999;cursor:ns-resize' });
    document.body.appendChild(shield);
    const startY = e.clientY, startH = E.devtoolsDock.offsetHeight;
    const move = (ev) => { E.devtoolsDock.style.height = `${clamp(startH + (startY - ev.clientY), 140, window.innerHeight - 220)}px`; };
    const up = () => { shield.remove(); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  });
}

let vsSource = '';
let vsRun = 0;
function tokenizeHtml(src) {
  const re = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/?[A-Za-z][\w:-]*|\/?>|"[^"]*"|'[^']*'|([A-Za-z_:@][\w:.-]*)(?==)|[A-Za-z_:@][\w:.-]*|[^<>"'A-Za-z_:@]+|[\s\S]/gi;
  const out = [];
  let inTag = false, m;
  while ((m = re.exec(src))) {
    const s = m[0];
    let c = '';
    if (s.startsWith('<!--')) c = 'tok-com';
    else if (/^<!doctype/i.test(s)) c = 'tok-doctype';
    else if (/^<\/?[A-Za-z]/.test(s)) { c = 'tok-tag'; inTag = true; }
    else if (s === '>' || s === '/>') { if (inTag) { c = 'tok-tag'; inTag = false; } }
    else if (inTag && (s[0] === '"' || s[0] === "'")) c = 'tok-str';
    else if (inTag && m[1]) c = 'tok-attr';
    const last = out[out.length - 1];
    if (last && last.c === c) last.t += s; else out.push({ t: s, c });
  }
  return out;
}
function renderSource(src) {
  const run = ++vsRun;
  const lines = [[]];
  let len = 0;
  for (const tok of tokenizeHtml(src)) {
    const parts = tok.t.split('\n');
    parts.forEach((p, i) => {
      if (i > 0) { lines.push([]); len = 0; }
      if (!p) return;
      if (len > 6000) return;
      const seg = len + p.length > 6000 ? `${p.slice(0, Math.max(0, 6000 - len))}…` : p;
      lines[lines.length - 1].push({ t: seg, c: tok.c });
      len += p.length;
    });
  }
  E.vsCode.textContent = '';
  let i = 0;
  const chunk = () => {
    if (run !== vsRun) return;
    const frag = document.createDocumentFragment();
    for (const end = Math.min(i + 1500, lines.length); i < end; i++) {
      const line = h('span', { class: 'code-line' });
      for (const seg of lines[i]) { if (seg.c) line.appendChild(h('span', { class: seg.c, text: seg.t })); else line.append(document.createTextNode(seg.t)); }
      if (!lines[i].length) line.append(document.createTextNode(' '));
      frag.appendChild(line);
    }
    E.vsCode.appendChild(frag);
    if (i < lines.length) setTimeout(chunk, 0);
  };
  chunk();
}
async function showViewSource(tab) {
  const t = tab || curTab();
  if (!t || !t.wcId || !isHttp(t.url)) { toast('Open a web page first'); return; }
  closePopovers();
  E.vsTitle.textContent = 'Page Source';
  E.vsUrl.textContent = t.url;
  E.vsCode.textContent = 'Loading…';
  E.viewsource.classList.add('open');
  E.viewsource.setAttribute('aria-hidden', 'false');
  const r = await S.page.viewSource(t.wcId).catch(() => null);
  if (!r) { E.vsCode.textContent = 'The page source could not be loaded.'; return; }
  vsSource = r.source;
  E.vsTitle.textContent = r.title || 'Page Source';
  renderSource(r.source);
}
function closeViewSource() { vsRun++; E.viewsource.classList.remove('open'); E.viewsource.setAttribute('aria-hidden', 'true'); E.vsCode.textContent = ''; vsSource = ''; }
function bindViewSource() {
  E.vsClose.addEventListener('click', closeViewSource);
  E.viewsource.addEventListener('mousedown', (e) => { if (e.target === E.viewsource) closeViewSource(); });
  E.vsCopy.addEventListener('click', () => { if (vsSource) { S.clipboard.writeText(vsSource); toast('Source copied'); } });
}

/* ------------------------------------------------------------------ */
/* HTTP authentication sheet                                          */
/* ------------------------------------------------------------------ */
const authQueue = [];
let authCur = null;
function nextAuth() {
  authCur = authQueue.shift() || null;
  if (!authCur) { E.authSheet.classList.remove('open'); E.authSheet.setAttribute('aria-hidden', 'true'); return; }
  E.authTitle.textContent = `Sign in to “${authCur.host}”`;
  E.authSub.textContent = authCur.realm ? `The server says: “${authCur.realm}”. Your login information will be sent ${authCur.scheme === 'basic' ? 'without encryption' : 'securely'}.` : 'Your login information will be sent securely.';
  E.authUser.value = ''; E.authPass.value = '';
  E.authSheet.classList.add('open');
  E.authSheet.setAttribute('aria-hidden', 'false');
  setTimeout(() => E.authUser.focus(), 60);
}
function bindAuth() {
  S.auth.onRequest((req) => { authQueue.push(req); if (!authCur) nextAuth(); });
  const done = (ok) => { if (!authCur) return; if (ok) S.auth.respond(authCur.id, E.authUser.value, E.authPass.value); else S.auth.respond(authCur.id); nextAuth(); };
  E.authOk.addEventListener('click', () => done(true));
  E.authCancel.addEventListener('click', () => done(false));
  E.authSheet.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
}

/* ------------------------------------------------------------------ */
/* Shortcuts & global key handling                                    */
/* ------------------------------------------------------------------ */
function cycleTab(dir) {
  const g = curGroup(), list = orderedTabs(g);
  if (list.length < 2) return;
  const i = list.findIndex((t) => t.id === g.activeTabId);
  activateTab(list[(i + dir + list.length) % list.length].id);
}
function handleShortcut({ action, index }) {
  const t = curTab();
  switch (action) {
    case 'back': goBack(); break;
    case 'forward': goForward(); break;
    case 'reload': if (t && t.loading) stopLoading(t); else reloadTab(t); break;
    case 'hard-reload': reloadTab(t, true); break;
    case 'devtools': toggleDevtools(); break;
    case 'view-source': showViewSource(); break;
    case 'next-tab': cycleTab(1); break;
    case 'prev-tab': cycleTab(-1); break;
    case 'goto-tab': { const list = orderedTabs(curGroup()); if (list[index]) activateTab(list[index].id); break; }
    case 'last-tab': { const list = orderedTabs(curGroup()); if (list.length) activateTab(list[list.length - 1].id); break; }
    case 'tab-overview': toggleOverview(); break;
    case 'zoom-in': changeZoom(1); break;
    case 'zoom-out': changeZoom(-1); break;
    case 'zoom-reset': changeZoom(0); break;
    case 'focus-address': closeOverview(); focusAddressBar(); break;
    case 'toggle-sidebar': toggleSidebar(); break;
    case 'new-tab': closeOverview(); newTab({ focusAddress: true }); break;
    case 'reopen-tab': reopenClosedTab(); break;
    case 'close-tab': if (t) closeTab(t.id); break;
    case 'reader': toggleReader(); break;
    case 'bookmark': openBookmarkPopover(); break;
    case 'find': openFind(); break;
    case 'find-next': if (E.findbar.classList.contains('open')) runFind(true, true); break;
    case 'find-prev': if (E.findbar.classList.contains('open')) runFind(true, false); break;
    case 'history': openSidebar('history'); break;
    case 'downloads': toggleDownloads(); break;
    case 'print': if (t && t.wcId) S.page.print(t.wcId); break;
    case 'save-pdf': if (t && t.wcId) S.page.savePDF(t.wcId, t.title).then((r) => { if (r && r.ok) toast('Saved as PDF'); }).catch(() => {}); break;
    default: break;
  }
}
function handleEscape() {
  if (E.ctxMenu.classList.contains('open')) { hideMenus(); return true; }
  if (E.authSheet.classList.contains('open')) return false;
  if ($$('.popover.open').some((p) => p !== E.popSuggestions)) { closePopovers(); return true; }
  if (E.viewsource.classList.contains('open')) { closeViewSource(); return true; }
  if (E.settings.classList.contains('open')) { closeSettings(); return true; }
  if (E.findbar.classList.contains('open')) { closeFind(); return true; }
  if (overviewIsOpen()) { closeOverview(); return true; }
  if (E.reader.classList.contains('open')) { closeReader(); return true; }
  return false;
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.activeElement !== E.addressInput) { if (handleEscape()) e.preventDefault(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); openSettings(); }
});

/* ------------------------------------------------------------------ */
/* Session restore                                                    */
/* ------------------------------------------------------------------ */
function restoreSession(sess) {
  groups = [];
  const build = (id, name, data) => {
    const g = { id, name, tabs: [], activeTabId: null };
    for (const t of (data && data.tabs) || []) {
      const tab = makeTabObj({ id: t.id, url: isHttp(t.url) ? t.url : '', title: t.title, favicon: t.favicon, pinned: t.pinned, groupId: id });
      g.tabs.push(tab);
    }
    g.tabs.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    g.activeTabId = g.tabs.some((t) => t.id === (data && data.activeTabId)) ? data.activeTabId : (g.tabs[0] && g.tabs[0].id) || null;
    return g;
  };
  groups.push(build(DEFAULT_GROUP, 'Tabs', sess.defaultGroup));
  for (const g of sess.groups || []) groups.push(build(g.id, g.name, g));
  activeGroupId = groups.some((g) => g.id === sess.activeGroupId) ? sess.activeGroupId : DEFAULT_GROUP;
  const g = curGroup();
  if (!g.tabs.length) {
    const home = settings.homepage && settings.homepage !== 'safari://start' ? (resolveInput(settings.homepage) || {}).url || '' : '';
    const tab = makeTabObj({ url: home, groupId: g.id });
    g.tabs.push(tab);
    g.activeTabId = tab.id;
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */
function bindToolbar() {
  E.btnSidebar.addEventListener('click', toggleSidebar);
  E.btnGroups.addEventListener('click', showGroupsMenu);
  E.groupsMenuNew.addEventListener('click', () => { closePopovers(); createGroup(); });
  E.btnReload.addEventListener('click', (e) => { const t = curTab(); if (!t) return; if (t.loading) stopLoading(t); else reloadTab(t, e.shiftKey); });
  E.btnNewtab.addEventListener('click', () => { closeOverview(); newTab({ focusAddress: true }); });
  E.btnTabbarNew.addEventListener('click', () => newTab({ focusAddress: true }));
  E.btnErrorRetry.addEventListener('click', () => reloadTab(curTab()));
  $$('.sb-tab').forEach((b) => b.addEventListener('click', () => { settings.sidebar.section = b.dataset.section; applySidebar(); renderSidebar(); saveSettings(); }));
  E.btnNewGroup.addEventListener('click', () => createGroup());
  E.btnNewFolder.addEventListener('click', newBookmarkFolder);
  $$('button', E.readingFilter).forEach((b) => b.addEventListener('click', () => { readingFilter = b.dataset.filter; renderReading(); }));
  E.readingSearch.addEventListener('input', debounce(renderReading, 100));
}

function bindEvents() {
  S.onShortcut(handleShortcut);
  S.onOpenTab(({ url, background, opener }) => {
    const o = opener ? wcToTab.get(opener) : null;
    newTab({ url, background: !!background, afterId: o ? o.id : null, group: o ? getGroup(o.groupId) : curGroup() });
  });
  S.onViewSourceRequest(({ webContentsId }) => showViewSource(wcToTab.get(webContentsId)));
  S.onTargetUrl(({ webContentsId, url }) => {
    if (wcToTab.get(webContentsId) !== curTab()) return;
    E.linkStatus.textContent = url || '';
    E.linkStatus.classList.toggle('show', !!url);
  });
  S.onHtmlFullscreen(({ active }) => E.app.classList.toggle('html-fullscreen', !!active));
  S.store.onChanged(async ({ name }) => {
    try {
      if (name === 'settings') { settings = await S.store.get('settings'); applySidebar(); renderTabs(); applyTint(curTab()); if (E.settings.classList.contains('open')) syncSettingsUI(); }
      else if (name === 'favorites') { favorites = await S.store.get('favorites'); renderStartPage(); refreshSidebarIf('bookmarks'); }
      else if (name === 'bookmarks') { bookmarks = await S.store.get('bookmarks'); refreshSidebarIf('bookmarks'); }
      else if (name === 'readingList') { readingList = await S.store.get('readingList'); refreshSidebarIf('reading'); renderStartPage(); }
      else if (name === 'history') refreshSidebarIf('history');
    } catch (_) { /* ignore */ }
  });
}

async function init() {
  const [s, favs, bms, rl, sess] = await Promise.all(['settings', 'favorites', 'bookmarks', 'readingList', 'session'].map((n) => S.store.get(n)));
  settings = s; favorites = favs || []; bookmarks = bms || []; readingList = rl || [];
  recentlyClosed = (sess && sess.recentlyClosed) || [];
  restoreSession(sess || {});

  bindWindowControls();
  bindToolbar();
  bindAddressBar();
  bindNavButtons();
  bindHistoryUI();
  bindStartPage();
  bindBookmarkPopover();
  bindShare();
  bindPrivacy();
  bindSettings();
  bindReader();
  bindOverview();
  bindFind();
  bindDevtools();
  bindViewSource();
  bindAuth();
  bindEvents();

  applySidebar();
  if (settings.sidebar.open) renderSidebar();
  applyReaderPrefs();
  const first = curGroup().tabs.find((t) => t.id === curGroup().activeTabId) || curGroup().tabs[0];
  activateTab(first.id, { focusAddress: !first.url, keepFocus: true });
  loadDownloads();
  S.ready();
}

window.addEventListener('beforeunload', () => { S.store.set('session', sessionData()); });
init().catch((err) => { console.error(err); document.body.textContent = `Safari failed to start: ${err && err.message}`; });
})();
