'use strict';

/* =====================================================================
 * Safari for Windows — Main Process
 * ===================================================================== */

const {
  app, BrowserWindow, ipcMain, session, dialog, shell, Menu,
  nativeTheme, net, clipboard, webContents, screen
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { pathToFileURL } = require('url');
const { randomUUID } = require('crypto');

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */
const IS_DEV = process.argv.includes('--dev');
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const PARTITION = 'persist:safari';            // every browsing <webview> must use this
const DEVTOOLS_PARTITION = 'safari-devtools';  // docked DevTools front-end <webview>
const DAY_MS = 86400000;
const HISTORY_CAP = 20000;
const DOWNLOADS_CAP = 200;

app.setPath('userData', path.join(app.getPath('appData'), 'SafariForWindows'));

const SEARCH_ENGINES = {
  google:     { name: 'Google',     url: 'https://www.google.com/search?q=%s' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  bing:       { name: 'Bing',       url: 'https://www.bing.com/search?q=%s' },
  ecosia:     { name: 'Ecosia',     url: 'https://www.ecosia.org/search?q=%s' },
  yahoo:      { name: 'Yahoo',      url: 'https://search.yahoo.com/search?p=%s' }
};

const SUGGEST_URLS = {
  google:     (q) => `https://suggestqueries.google.com/complete/search?client=firefox&q=${q}`,
  duckduckgo: (q) => `https://duckduckgo.com/ac/?type=list&q=${q}`,
  bing:       (q) => `https://api.bing.com/osjson.aspx?query=${q}`,
  ecosia:     (q) => `https://ac.ecosia.org/autocomplete?type=list&q=${q}`,
  yahoo:      (q) => `https://api.bing.com/osjson.aspx?query=${q}`
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

function deepMerge(target, src) {
  if (!isPlainObject(src)) return target;
  for (const key of Object.keys(src)) {
    if (isPlainObject(src[key]) && isPlainObject(target[key])) deepMerge(target[key], src[key]);
    else target[key] = src[key];
  }
  return target;
}

function dayKey(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sanitizeFilename(name) {
  return String(name || 'download')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .slice(0, 150) || 'download';
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 1; i < 10000; i++) {
    const candidate = path.join(dir, `${name} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${name}-${Date.now()}${ext}`);
}

function cleanUserAgent() {
  return app.userAgentFallback
    .replace(/\sElectron\/[\d.]+/, '')
    .replace(/\s[^\s/]+\/[\d.]+(?=\s+Chrome\/)/, '');
}

/* ------------------------------------------------------------------ */
/* Persistent JSON storage (atomic, debounced)                        */
/* ------------------------------------------------------------------ */
class JsonStore {
  constructor(dir, name, defaults, merge = false) {
    this.file = path.join(dir, `${name}.json`);
    this.defaults = defaults;
    this.merge = merge;
    this.timer = null;
    this.dirty = false;
    this.writing = Promise.resolve();
    this.data = this._load();
  }
  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return this.merge ? deepMerge(clone(this.defaults), parsed) : parsed;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch (_) { /* ignore */ }
      }
      return clone(this.defaults);
    }
  }
  get() { return this.data; }
  set(value) { this.data = value; this.touch(); }
  touch() {
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }
  flush() {
    clearTimeout(this.timer);
    if (!this.dirty) return this.writing;
    this.dirty = false;
    const json = JSON.stringify(this.data);
    const tmp = `${this.file}.tmp`;
    this.writing = this.writing.then(async () => {
      await fsp.writeFile(tmp, json);
      try { await fsp.rename(tmp, this.file); }
      catch (_) { await fsp.writeFile(this.file, json); }
    }).catch((e) => console.error('[store] write failed', this.file, e));
    return this.writing;
  }
  flushSync() {
    clearTimeout(this.timer);
    if (!this.dirty) return;
    this.dirty = false;
    const json = JSON.stringify(this.data);
    try {
      fs.writeFileSync(`${this.file}.tmp`, json);
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch (_) {
      try { fs.writeFileSync(this.file, json); } catch (e) { console.error('[store] sync write failed', e); }
    }
  }
}

const DEFAULT_SETTINGS = {
  theme: 'system',                 // 'light' | 'dark' | 'system'
  tabLayout: 'separate',           // 'separate' | 'compact'
  colorInCompactTabBar: true,
  searchEngine: 'google',
  homepage: 'safari://start',
  blockTrackers: true,
  privacyExceptions: [],
  sitePermissions: {},
  zoomLevels: {},
  downloadsPath: '',
  nativeMaterial: 'none',          // 'none' | 'mica' | 'acrylic' | 'tabbed'
  sidebar: { open: false, width: 260, section: 'tabgroups', readingFilter: 'all' },
  startPage: {
    showFavorites: true,
    showPrivacyReport: true,
    showReadingList: true,
    showRecentlyClosed: true,
    background: { type: 'preset', value: 'sequoia' }
  },
  reader: { theme: 'white', font: 'system', size: 19 },
  windowBounds: null
};

const DEFAULT_FAVORITES = [
  { id: 'fav-apple',     title: 'Apple',     url: 'https://www.apple.com/' },
  { id: 'fav-icloud',    title: 'iCloud',    url: 'https://www.icloud.com/' },
  { id: 'fav-google',    title: 'Google',    url: 'https://www.google.com/' },
  { id: 'fav-youtube',   title: 'YouTube',   url: 'https://www.youtube.com/' },
  { id: 'fav-wikipedia', title: 'Wikipedia', url: 'https://www.wikipedia.org/' },
  { id: 'fav-github',    title: 'GitHub',    url: 'https://github.com/' },
  { id: 'fav-reddit',    title: 'Reddit',    url: 'https://www.reddit.com/' },
  { id: 'fav-yahoo',     title: 'Yahoo',     url: 'https://www.yahoo.com/' }
];

const DEFAULT_SESSION = {
  version: 1,
  activeGroupId: null,             // null = the ungrouped default tab set
  defaultGroup: { tabs: [], activeTabId: null },
  groups: [],                      // [{ id, name, tabs:[{id,url,title,favicon,pinned}], activeTabId }]
  recentlyClosed: []
};

const stores = {};
let DATA_DIR = '';
let BG_DIR = '';

function initStores() {
  DATA_DIR = path.join(app.getPath('userData'), 'safari-data');
  BG_DIR = path.join(DATA_DIR, 'backgrounds');
  fs.mkdirSync(BG_DIR, { recursive: true });
  stores.settings    = new JsonStore(DATA_DIR, 'settings', DEFAULT_SETTINGS, true);
  stores.favorites   = new JsonStore(DATA_DIR, 'favorites', DEFAULT_FAVORITES);
  stores.bookmarks   = new JsonStore(DATA_DIR, 'bookmarks', []);
  stores.readingList = new JsonStore(DATA_DIR, 'readingList', []);
  stores.history     = new JsonStore(DATA_DIR, 'history', []);
  stores.session     = new JsonStore(DATA_DIR, 'session', DEFAULT_SESSION);
  stores.downloads   = new JsonStore(DATA_DIR, 'downloads', []);
  stores.privacy     = new JsonStore(DATA_DIR, 'privacy', { total: 0, since: Date.now(), daily: {}, sites: {} });
}

const READABLE_STORES = ['settings', 'favorites', 'bookmarks', 'readingList', 'history', 'session', 'downloads'];
const WRITABLE_STORES = { settings: 'object', favorites: 'array', bookmarks: 'array', readingList: 'array', session: 'object' };

/* ------------------------------------------------------------------ */
/* Window management                                                  */
/* ------------------------------------------------------------------ */
const windows = new Set();
const readyWindows = new WeakSet();
const fullscreenOwned = new WeakSet();
let pendingOpen = [];

const bgColor = () => (nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7');

function broadcast(channel, payload, exceptWebContentsId) {
  for (const win of windows) {
    if (win.isDestroyed()) continue;
    const wc = win.webContents;
    if (wc.isDestroyed() || wc.id === exceptWebContentsId) continue;
    wc.send(channel, payload);
  }
}

function windowState(win) {
  return {
    focused: win.isFocused(),
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen(),
    minimized: win.isMinimized(),
    platform: process.platform
  };
}

function applyMaterial(win, material) {
  if (!IS_WIN || typeof win.setBackgroundMaterial !== 'function') return;
  try { win.setBackgroundMaterial(['mica', 'acrylic', 'tabbed'].includes(material) ? material : 'none'); }
  catch (_) { /* unsupported on this Windows build */ }
}

function restoreBounds(saved) {
  const work = screen.getPrimaryDisplay().workArea;
  const b = Object.assign({ width: 1280, height: 820 }, saved || {});
  b.width = Math.min(Math.max(b.width, 640), Math.max(work.width, 640));
  b.height = Math.min(Math.max(b.height, 420), Math.max(work.height, 420));
  const visible = typeof b.x === 'number' && typeof b.y === 'number' && screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return b.x + b.width > w.x + 100 && b.x < w.x + w.width - 100 && b.y >= w.y - 10 && b.y < w.y + w.height - 50;
  });
  if (!visible) { delete b.x; delete b.y; }
  return b;
}

function createWindow(options = {}) {
  const settings = stores.settings.get();
  const b = restoreBounds(settings.windowBounds);
  const focused = BrowserWindow.getFocusedWindow();
  if (options.cascade && focused && !focused.isMaximized() && !focused.isFullScreen()) {
    const fb = focused.getBounds();
    Object.assign(b, { x: fb.x + 30, y: fb.y + 30, width: fb.width, height: fb.height });
  }

  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    minWidth: 640, minHeight: 420,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    title: 'Safari',
    backgroundColor: bgColor(),
    autoHideMenuBar: true,
    fullscreenable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      spellcheck: true
    }
  });

  windows.add(win);
  applyMaterial(win, settings.nativeMaterial);

  win.once('ready-to-show', () => {
    if (!options.cascade && settings.windowBounds && settings.windowBounds.maximized) win.maximize();
    win.show();
  });

  const sendState = () => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('window:state', windowState(win));
  };
  ['focus', 'blur', 'maximize', 'unmaximize', 'minimize', 'restore', 'enter-full-screen', 'leave-full-screen']
    .forEach((ev) => win.on(ev, sendState));

  let boundsTimer;
  const saveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
      stores.settings.get().windowBounds = Object.assign(win.getNormalBounds(), { maximized: win.isMaximized() });
      stores.settings.touch();
    }, 500);
  };
  ['resize', 'move', 'maximize', 'unmaximize'].forEach((ev) => win.on(ev, saveBounds));

  win.on('closed', () => { windows.delete(win); clearTimeout(boundsTimer); });

  // The host UI never navigates away from index.html.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.loadFile(path.join(__dirname, 'index.html'));
  return win;
}

function openUrls(urls) {
  const win = BrowserWindow.getFocusedWindow() || [...windows][0];
  if (!win) { pendingOpen.push(...urls); createWindow(); return; }
  if (!readyWindows.has(win)) { pendingOpen.push(...urls); return; }
  for (const url of urls) win.webContents.send('tab:open', { url, background: false });
}

const urlsFromArgv = (argv) => argv.slice(1).filter((a) => /^https?:\/\//i.test(a));

/* ------------------------------------------------------------------ */
/* Keyboard shortcuts (captured in main so they work inside webviews) */
/* ------------------------------------------------------------------ */
function matchShortcut(input) {
  if (input.type !== 'keyDown') return null;
  const { key, code, shift, alt } = input;
  const ctrl = input.control || input.meta;
  const k = key.length === 1 ? key.toLowerCase() : key;

  if (alt && !ctrl && !shift) {
    if (key === 'ArrowLeft') return { action: 'back' };
    if (key === 'ArrowRight') return { action: 'forward' };
    return null;
  }
  if (key === 'F5' && !alt) return { action: ctrl && shift ? 'hard-reload' : 'reload' };
  if (key === 'F12' && !ctrl && !alt) return { action: 'devtools' };
  if (!ctrl || alt) return null; // ignore AltGr (Ctrl+Alt) combos

  if (key === 'Tab') return { action: shift ? 'prev-tab' : 'next-tab' };
  if (code === 'Backslash' && shift) return { action: 'tab-overview' };

  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  if (digit && !shift) {
    const n = Number(digit[1]);
    return n === 9 ? { action: 'last-tab' } : { action: 'goto-tab', index: n - 1 };
  }
  if (/^(?:Digit|Numpad)0$/.test(code)) return { action: 'zoom-reset' };
  if (code === 'Equal' || code === 'NumpadAdd') return { action: 'zoom-in' };
  if (code === 'Minus' || code === 'NumpadSubtract') return { action: 'zoom-out' };

  switch (k) {
    case 'l': return { action: shift ? 'toggle-sidebar' : 'focus-address' };
    case 't': return { action: shift ? 'reopen-tab' : 'new-tab' };
    case 'w': return shift ? null : { action: 'close-tab' };
    case 'r': return { action: shift ? 'reader' : 'reload' };
    case 'i': return shift ? { action: 'devtools' } : null;
    case 'd': return shift ? null : { action: 'bookmark' };
    case 'f': return shift ? null : { action: 'find' };
    case 'g': return { action: shift ? 'find-prev' : 'find-next' };
    case 'h': case 'y': return shift ? null : { action: 'history' };
    case 'j': return shift ? null : { action: 'downloads' };
    case 'u': return shift ? null : { action: 'view-source' };
    case 'p': return shift ? null : { action: 'print' };
    case 's': return shift ? null : { action: 'save-pdf' };
    case 'n': return shift ? null : { action: 'new-window' };
    default: return null;
  }
}

/* ------------------------------------------------------------------ */
/* Privacy: ad / tracker blocker                                      */
/* ------------------------------------------------------------------ */
const BLOCKED_DOMAINS = new Set(`
doubleclick.net googlesyndication.com googleadservices.com google-analytics.com googletagmanager.com
googletagservices.com adservice.google.com analytics.google.com ads.google.com 2mdn.net app-measurement.com
ads.youtube.com pixel.facebook.com an.facebook.com analytics.twitter.com ads-api.twitter.com ads-twitter.com
ads.linkedin.com px.ads.linkedin.com snap.licdn.com ads.pinterest.com ct.pinterest.com log.pinterest.com
trk.pinterest.com analytics.tiktok.com business-api.tiktok.com ads.tiktok.com tr.snapchat.com sc-static.net
events.reddit.com alb.reddit.com ads.reddit.com ads.yahoo.com analytics.yahoo.com sp.analytics.yahoo.com
amazon-adsystem.com adsystem.amazon.com bat.bing.com clarity.ms ads.msn.com adnxs.com adnxs-simple.com
taboola.com taboolasyndication.com outbrain.com sphere.com criteo.com criteo.net scorecardresearch.com
quantserve.com quantcount.com chartbeat.com chartbeat.net hotjar.com hotjar.io mouseflow.com fullstory.com
crazyegg.com luckyorange.com segment.io cdn.segment.com mixpanel.com amplitude.com heapanalytics.com
optimizely.com nr-data.net cloudflareinsights.com pubmatic.com rubiconproject.com openx.net casalemedia.com
indexww.com contextweb.com advertising.com adtechus.com adform.net smartadserver.com sharethrough.com teads.tv
triplelift.com 33across.com lijit.com sovrn.com yieldmo.com gumgum.com media.net bidswitch.net adsrvr.org
demdex.net omtrdc.net 2o7.net everesttech.net krxd.net bluekai.com exelator.com agkn.com rlcdn.com mathtag.com
tapad.com turn.com eyeota.net adition.com liadm.com id5-sync.com semasio.net crwdcntrl.net lotame.com
addthis.com sharethis.com buysellads.com carbonads.com carbonads.net comscore.com imrworldwide.com moatads.com
moatpixel.com doubleverify.com adsafeprotected.com iasds01.com serving-sys.com flashtalking.com innovid.com
tubemogul.com mc.yandex.ru mc.yandex.com top-fwz1.mail.ru counter.yadro.ru ad.mail.ru hm.baidu.com cnzz.com
umeng.com 51.la adobedtm.com tiqcdn.com ensighten.com tagcommander.com ml314.com bidr.io bttrack.com adroll.com
perfectaudience.com rtbhouse.com revcontent.com mgid.com zemanta.com content.ad adblade.com popads.net
propellerads.com popcash.net exoclick.com juicyads.com trafficjunky.net clickadu.com adcash.com hilltopads.net
adsterra.com a-ads.com coin-hive.com crypto-loot.com jsecoin.com hs-analytics.net hsadspixel.net hs-banner.com
track.hubspot.com munchkin.marketo.net pi.pardot.com smaato.net inmobi.com mopub.com applovin.com
unityads.unity3d.com vungle.com chartboost.com ironsrc.com supersonicads.com statcounter.com histats.com
yandexadexchange.net adsymptotic.com bing.net.adsrvr.org
`.split(/\s+/).filter(Boolean));

// [host suffix, path prefix] — only evaluated for third-party requests.
const BLOCKED_PATHS = [
  ['google.com', '/pagead/'], ['google.com', '/ads/'], ['google.com', '/doubleclick/'],
  ['youtube.com', '/api/stats/ads'], ['youtube.com', '/pagead/'],
  ['facebook.com', '/tr'], ['connect.facebook.net', '/en_US/fbevents.js'], ['connect.facebook.net', '/signals/'],
  ['linkedin.com', '/px/'], ['linkedin.com', '/li/track'],
  ['twitter.com', '/i/adsct'], ['x.com', '/i/adsct'], ['t.co', '/i/adsct'],
  ['pinterest.com', '/ct.html'], ['tiktok.com', '/i18n/pixel'], ['amazon.com', '/aan/']
];

const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'co.in', 'com.br', 'co.nz',
  'co.za', 'com.cn', 'com.mx', 'com.tr', 'com.sg', 'co.kr', 'com.hk', 'com.tw', 'com.ar', 'co.id', 'com.ua'
]);

function baseDomain(host) {
  if (!host) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join('.');
  return MULTI_PART_TLDS.has(last2) ? parts.slice(-3).join('.') : last2;
}

function matchBlockedDomain(host) {
  const labels = host.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    if (BLOCKED_DOMAINS.has(candidate)) return candidate;
  }
  return null;
}

function matchBlockedPath(host, pathname) {
  for (const [suffix, prefix] of BLOCKED_PATHS) {
    if ((host === suffix || host.endsWith(`.${suffix}`)) && pathname.startsWith(prefix)) return suffix;
  }
  return null;
}

/** Per-guest page state used for the Privacy Report. */
const pageInfo = new Map();

function makePage(id, url) {
  let host = null;
  try { const u = new URL(url); if (/^https?:$/.test(u.protocol)) host = u.hostname.toLowerCase(); } catch (_) { /* ignore */ }
  const page = { id, url, host, base: baseDomain(host), count: 0, trackers: new Map(), timer: null };
  pageInfo.set(id, page);
  return page;
}

function weekTotal() {
  const daily = stores.privacy.get().daily;
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += daily[dayKey(Date.now() - i * DAY_MS)] || 0;
  return sum;
}

function recordBlock(page, tracker, wc) {
  page.count++;
  page.trackers.set(tracker, (page.trackers.get(tracker) || 0) + 1);

  const priv = stores.privacy.get();
  priv.total++;
  const today = dayKey();
  priv.daily[today] = (priv.daily[today] || 0) + 1;
  if (page.base) {
    let site = priv.sites[page.base];
    if (!site) {
      const keys = Object.keys(priv.sites);
      if (keys.length >= 400) {
        keys.sort((a, b) => (priv.sites[a].last || 0) - (priv.sites[b].last || 0));
        keys.slice(0, 40).forEach((k) => delete priv.sites[k]);
      }
      site = priv.sites[page.base] = { count: 0, trackers: {}, last: 0 };
    }
    site.count++;
    site.last = Date.now();
    site.trackers[tracker] = (site.trackers[tracker] || 0) + 1;
  }
  const keepFrom = dayKey(Date.now() - 60 * DAY_MS);
  if (Math.random() < 0.01) for (const k of Object.keys(priv.daily)) if (k < keepFrom) delete priv.daily[k];
  stores.privacy.touch();

  if (page.timer) return;
  page.timer = setTimeout(() => {
    page.timer = null;
    if (wc.isDestroyed()) return;
    const host = wc.hostWebContents;
    if (!host || host.isDestroyed()) return;
    host.send('privacy:blocked', {
      webContentsId: wc.id, host: page.host, pageCount: page.count,
      weekCount: weekTotal(), total: stores.privacy.get().total
    });
  }, 120);
}

function evaluateRequest(details) {
  const settings = stores.settings.get();
  if (!settings.blockTrackers || details.resourceType === 'mainFrame') return null;
  let u;
  try { u = new URL(details.url); } catch (_) { return null; }
  if (!/^(https?|wss?):$/.test(u.protocol)) return null;
  const wc = details.webContents;
  if (!wc || wc.isDestroyed() || wc.getType() !== 'webview') return null;

  const page = pageInfo.get(wc.id) || makePage(wc.id, wc.getURL());
  if (!page.base) return null;
  const host = u.hostname.toLowerCase();
  if (baseDomain(host) === page.base) return null; // first party
  const exceptions = settings.privacyExceptions || [];
  if (exceptions.includes(page.host) || exceptions.includes(page.base)) return null;

  const hit = matchBlockedDomain(host) || matchBlockedPath(host, u.pathname);
  return hit ? { page, tracker: hit, wc } : null;
}

function setupBlocker(ses) {
  ses.webRequest.onBeforeRequest((details, callback) => {
    const r = evaluateRequest(details);
    if (!r) return callback({});
    recordBlock(r.page, r.tracker, r.wc);
    return callback({ cancel: true });
  });
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    if (!stores.settings.get().blockTrackers) return callback({ requestHeaders: details.requestHeaders });
    return callback({ requestHeaders: Object.assign({}, details.requestHeaders, { DNT: '1', 'Sec-GPC': '1' }) });
  });
}

/* ------------------------------------------------------------------ */
/* Downloads                                                          */
/* ------------------------------------------------------------------ */
const activeDownloads = new Map(); // id -> { item, rec, lastBytes, lastTime, lastSent }

const downloadsDir = () => stores.settings.get().downloadsPath || app.getPath('downloads');

function updateTaskbarProgress() {
  let total = 0, received = 0, count = 0;
  for (const { rec } of activeDownloads.values()) {
    if (rec.state !== 'progressing') continue;
    count++;
    if (rec.totalBytes > 0) { total += rec.totalBytes; received += rec.receivedBytes; }
  }
  const p = count === 0 ? -1 : (total > 0 ? received / total : 2);
  for (const w of windows) if (!w.isDestroyed()) w.setProgressBar(p);
}

function setupDownloads(ses) {
  ses.on('will-download', (event, item) => {
    const id = randomUUID();
    let dir = downloadsDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { dir = app.getPath('downloads'); }
    const savePath = uniquePath(path.join(dir, sanitizeFilename(item.getFilename())));
    item.setSavePath(savePath);

    const rec = {
      id, filename: path.basename(savePath), url: item.getURL(), path: savePath,
      mime: item.getMimeType(), totalBytes: item.getTotalBytes(), receivedBytes: 0,
      state: 'progressing', paused: false, canResume: false,
      startTime: Date.now(), endTime: null, bytesPerSecond: 0
    };
    const entry = { item, rec, lastBytes: 0, lastTime: Date.now(), lastSent: 0 };
    activeDownloads.set(id, entry);
    broadcast('downloads:update', rec);
    updateTaskbarProgress();

    item.on('updated', (_e, state) => {
      const now = Date.now();
      rec.receivedBytes = item.getReceivedBytes();
      rec.totalBytes = item.getTotalBytes();
      rec.paused = item.isPaused();
      rec.canResume = item.canResume();
      rec.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      const dt = (now - entry.lastTime) / 1000;
      if (dt >= 0.5) {
        rec.bytesPerSecond = Math.round((rec.receivedBytes - entry.lastBytes) / dt);
        entry.lastBytes = rec.receivedBytes;
        entry.lastTime = now;
      }
      if (now - entry.lastSent > 150 || rec.state === 'interrupted') {
        entry.lastSent = now;
        broadcast('downloads:update', rec);
        updateTaskbarProgress();
      }
    });

    item.once('done', (_e, state) => {
      rec.state = state; // 'completed' | 'cancelled' | 'interrupted'
      rec.receivedBytes = item.getReceivedBytes();
      rec.totalBytes = item.getTotalBytes() || rec.receivedBytes;
      rec.paused = false;
      rec.endTime = Date.now();
      rec.bytesPerSecond = 0;
      activeDownloads.delete(id);
      if (state !== 'cancelled') {
        const list = stores.downloads.get();
        list.unshift(clone(rec));
        if (list.length > DOWNLOADS_CAP) list.length = DOWNLOADS_CAP;
        stores.downloads.touch();
      }
      broadcast('downloads:update', rec);
      updateTaskbarProgress();
    });
  });
}

/* ------------------------------------------------------------------ */
/* Permissions                                                        */
/* ------------------------------------------------------------------ */
function setupPermissions(ses) {
  const AUTO = new Set([
    'fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock', 'sensors',
    'background-sync', 'storage-access', 'top-level-storage-access', 'speaker-selection'
  ]);
  const PROMPT_LABELS = {
    geolocation: 'Use Your Location',
    notifications: 'Show Notifications',
    'clipboard-read': 'Read From Your Clipboard',
    midi: 'Use MIDI Devices',
    midiSysex: 'Use MIDI Devices',
    'idle-detection': 'Know When You Are Idle'
  };
  const pending = new Map();

  const labelFor = (permission, details) => {
    if (permission === 'media') {
      const t = (details && details.mediaTypes) || [];
      if (t.includes('video') && t.includes('audio')) return 'Use Your Camera and Microphone';
      if (t.includes('video')) return 'Use Your Camera';
      return 'Use Your Microphone';
    }
    return PROMPT_LABELS[permission] || null;
  };

  ses.setPermissionCheckHandler((_wc, permission, origin) => {
    if (AUTO.has(permission)) return true;
    const rec = stores.settings.get().sitePermissions || {};
    return rec[`${origin}|${permission}`] === true;
  });

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (AUTO.has(permission)) return callback(true);
    const label = labelFor(permission, details);
    if (!label) return callback(false);

    let origin;
    try { origin = new URL(details.requestingUrl || (wc && wc.getURL())).origin; }
    catch (_) { return callback(false); }

    const settings = stores.settings.get();
    settings.sitePermissions = settings.sitePermissions || {};
    const key = `${origin}|${permission}`;
    if (key in settings.sitePermissions) return callback(settings.sitePermissions[key]);

    let promise = pending.get(key);
    if (!promise) {
      const hostWc = wc && wc.hostWebContents;
      const win = hostWc ? BrowserWindow.fromWebContents(hostWc) : null;
      const opts = {
        type: 'question', title: 'Safari', noLink: true,
        message: `“${new URL(origin).host}” Would Like to ${label}`,
        detail: 'You can change this later in Safari settings.',
        buttons: ['Don’t Allow', 'Allow'], defaultId: 1, cancelId: 0,
        checkboxLabel: 'Remember my decision for this website'
      };
      promise = (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts))
        .finally(() => pending.delete(key));
      pending.set(key, promise);
    }
    return promise.then((r) => {
      const allow = r.response === 1;
      if (r.checkboxChecked) { settings.sitePermissions[key] = allow; stores.settings.touch(); }
      callback(allow);
    }).catch(() => callback(false));
  });
}

/* ------------------------------------------------------------------ */
/* Guest (<webview>) setup                                            */
/* ------------------------------------------------------------------ */
const navApi = {
  canGoBack: (c) => (c.navigationHistory ? c.navigationHistory.canGoBack() : c.canGoBack()),
  canGoForward: (c) => (c.navigationHistory ? c.navigationHistory.canGoForward() : c.canGoForward()),
  goBack: (c) => (c.navigationHistory ? c.navigationHistory.goBack() : c.goBack()),
  goForward: (c) => (c.navigationHistory ? c.navigationHistory.goForward() : c.goForward())
};

function showContextMenu(contents, params) {
  const host = contents.hostWebContents;
  const win = host && BrowserWindow.fromWebContents(host);
  if (!win || host.isDestroyed()) return;
  const send = (channel, payload) => { if (!host.isDestroyed()) host.send(channel, payload); };
  const tpl = [];
  const sep = () => { if (tpl.length && tpl[tpl.length - 1].type !== 'separator') tpl.push({ type: 'separator' }); };
  const isImage = params.mediaType === 'image' && params.srcURL;
  const engine = SEARCH_ENGINES[stores.settings.get().searchEngine] || SEARCH_ENGINES.google;

  if (params.misspelledWord) {
    const sugg = params.dictionarySuggestions || [];
    sugg.slice(0, 5).forEach((s) => tpl.push({ label: s, click: () => contents.replaceMisspelling(s) }));
    if (!sugg.length) tpl.push({ label: 'No Guesses Found', enabled: false });
    tpl.push({ label: 'Learn Spelling', click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
    sep();
  }
  if (params.linkURL) {
    tpl.push({ label: 'Open Link in New Tab', click: () => send('tab:open', { url: params.linkURL, background: false, opener: contents.id }) });
    tpl.push({ label: 'Open Link in Background Tab', click: () => send('tab:open', { url: params.linkURL, background: true, opener: contents.id }) });
    tpl.push({ label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) });
    sep();
  }
  if (isImage) {
    tpl.push({ label: 'Open Image in New Tab', click: () => send('tab:open', { url: params.srcURL, background: false, opener: contents.id }) });
    tpl.push({ label: 'Save Image As…', click: () => contents.downloadURL(params.srcURL) });
    tpl.push({ label: 'Copy Image', click: () => contents.copyImageAt(params.x, params.y) });
    tpl.push({ label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) });
    sep();
  }
  if (params.isEditable) {
    const f = params.editFlags || {};
    tpl.push({ label: 'Undo', enabled: !!f.canUndo, click: () => contents.undo() });
    tpl.push({ label: 'Redo', enabled: !!f.canRedo, click: () => contents.redo() });
    sep();
    tpl.push({ label: 'Cut', enabled: !!f.canCut, click: () => contents.cut() });
    tpl.push({ label: 'Copy', enabled: !!f.canCopy, click: () => contents.copy() });
    tpl.push({ label: 'Paste', enabled: !!f.canPaste, click: () => contents.paste() });
    tpl.push({ label: 'Select All', enabled: !!f.canSelectAll, click: () => contents.selectAll() });
    sep();
  } else if (params.selectionText) {
    const snippet = params.selectionText.trim().slice(0, 30);
    tpl.push({ label: 'Copy', click: () => contents.copy() });
    tpl.push({
      label: `Search with ${engine.name} for “${snippet}${params.selectionText.trim().length > 30 ? '…' : ''}”`,
      click: () => send('tab:open', {
        url: engine.url.replace('%s', encodeURIComponent(params.selectionText.trim())),
        background: false, opener: contents.id
      })
    });
    sep();
  }
  if (!params.isEditable && !params.selectionText && !params.linkURL && !isImage) {
    tpl.push({ label: 'Back', enabled: navApi.canGoBack(contents), click: () => navApi.goBack(contents) });
    tpl.push({ label: 'Forward', enabled: navApi.canGoForward(contents), click: () => navApi.goForward(contents) });
    tpl.push({ label: 'Reload Page', click: () => contents.reload() });
    sep();
    tpl.push({ label: 'Select All', click: () => contents.selectAll() });
    sep();
  }
  tpl.push({ label: 'View Page Source', click: () => send('view-source:request', { webContentsId: contents.id }) });
  tpl.push({ label: 'Inspect Element', click: () => { contents.inspectElement(params.x, params.y); } });

  Menu.buildFromTemplate(tpl).popup({ window: win });
}

function setupGuest(contents) {
  const host = contents.hostWebContents;
  const sendHost = (channel, payload) => { if (host && !host.isDestroyed()) host.send(channel, payload); };

  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (/^https?:/i.test(url)) {
      sendHost('tab:open', { url, background: disposition === 'background-tab', opener: contents.id });
    }
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (/^(mailto|tel|sms|facetime):/i.test(url)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      const old = pageInfo.get(contents.id);
      if (old && old.timer) clearTimeout(old.timer);
      makePage(contents.id, details.url);
      sendHost('privacy:blocked', { webContentsId: contents.id, host: null, pageCount: 0, weekCount: weekTotal(), total: stores.privacy.get().total });
    }
  });

  contents.on('context-menu', (_e, params) => showContextMenu(contents, params));
  contents.on('update-target-url', (_e, url) => sendHost('webview:target-url', { webContentsId: contents.id, url }));
  contents.on('devtools-opened', () => sendHost('devtools:state', { webContentsId: contents.id, opened: true }));
  contents.on('devtools-closed', () => sendHost('devtools:state', { webContentsId: contents.id, opened: false }));

  contents.on('enter-html-full-screen', () => {
    const win = host && BrowserWindow.fromWebContents(host);
    if (win && !win.isFullScreen()) { fullscreenOwned.add(win); win.setFullScreen(true); }
    sendHost('webview:html-fullscreen', { webContentsId: contents.id, active: true });
  });
  contents.on('leave-html-full-screen', () => {
    const win = host && BrowserWindow.fromWebContents(host);
    if (win && fullscreenOwned.has(win)) { fullscreenOwned.delete(win); win.setFullScreen(false); }
    sendHost('webview:html-fullscreen', { webContentsId: contents.id, active: false });
  });

  contents.once('destroyed', () => {
    const p = pageInfo.get(contents.id);
    if (p && p.timer) clearTimeout(p.timer);
    pageInfo.delete(contents.id);
  });
}

app.on('web-contents-created', (_event, contents) => {
  // Lock down every <webview> the host UI attempts to attach.
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    if (params.partition !== DEVTOOLS_PARTITION) params.partition = PARTITION;
    const src = params.src || '';
    if (src && !/^(https?:|about:blank)/i.test(src)) event.preventDefault();
  });

  // Global shortcuts: forward to the host UI even when a page owns the keyboard.
  contents.on('before-input-event', (event, input) => {
    let host = null;
    const type = contents.getType();
    if (type === 'webview' && contents.session === session.fromPartition(PARTITION)) host = contents.hostWebContents;
    else if (type === 'window' && BrowserWindow.fromWebContents(contents)) host = contents;
    if (!host || host.isDestroyed()) return;

    if (IS_DEV && input.type === 'keyDown' && input.control && input.shift && input.alt && input.key.toLowerCase() === 'i') {
      event.preventDefault();
      host.openDevTools({ mode: 'detach' });
      return;
    }
    const sc = matchShortcut(input);
    if (!sc) return;
    event.preventDefault();
    if (sc.action === 'new-window') { createWindow({ cascade: true }); return; }
    host.send('shortcut', sc);
  });

  if (contents.getType() === 'webview' && contents.session === session.fromPartition(PARTITION)) {
    setupGuest(contents);
  }
});

/* HTTP authentication → renderer sheet */
const pendingAuth = new Map();
app.on('login', (event, wc, details, authInfo, callback) => {
  const host = wc && wc.hostWebContents;
  if (!host || host.isDestroyed()) return;
  event.preventDefault();
  const id = randomUUID();
  pendingAuth.set(id, callback);
  host.send('auth:request', {
    id, url: details.url, host: authInfo.host, port: authInfo.port,
    realm: authInfo.realm, scheme: authInfo.scheme, isProxy: authInfo.isProxy
  });
});

/* ------------------------------------------------------------------ */
/* IPC                                                                */
/* ------------------------------------------------------------------ */
function trusted(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  const url = event.senderFrame && event.senderFrame.url;
  return !!win && windows.has(win) && typeof url === 'string' && url.startsWith('file://');
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) throw new Error(`Untrusted sender for ${channel}`);
    return fn(event, ...args);
  });
}

const winFrom = (event) => BrowserWindow.fromWebContents(event.sender);

function guestFor(event, id) {
  const c = webContents.fromId(Number(id));
  if (!c || c.isDestroyed() || c.getType() !== 'webview' || !c.hostWebContents || c.hostWebContents.id !== event.sender.id) {
    throw new Error('Invalid webview');
  }
  return c;
}

function applySettingsSideEffects(next, prev) {
  if (!prev || prev.theme !== next.theme) {
    nativeTheme.themeSource = ['light', 'dark', 'system'].includes(next.theme) ? next.theme : 'system';
  }
  if (!prev || prev.nativeMaterial !== next.nativeMaterial) {
    for (const w of windows) if (!w.isDestroyed()) applyMaterial(w, next.nativeMaterial);
  }
}

function registerIpc() {
  /* ---- app info (sync, used once by preload) ---- */
  ipcMain.on('app:info-sync', (event) => {
    event.returnValue = trusted(event) ? {
      platform: process.platform,
      partition: PARTITION,
      devtoolsPartition: DEVTOOLS_PARTITION,
      version: app.getVersion(),
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
      searchEngines: SEARCH_ENGINES,
      userDataPath: app.getPath('userData'),
      downloadsDir: downloadsDir(),
      isDev: IS_DEV,
      locale: app.getLocale()
    } : null;
  });

  ipcMain.on('app:renderer-ready', (event) => {
    if (!trusted(event)) return;
    const win = winFrom(event);
    readyWindows.add(win);
    const urls = pendingOpen;
    pendingOpen = [];
    for (const url of urls) win.webContents.send('tab:open', { url, background: false });
  });

  ipcMain.on('auth:respond', (event, { id, username, password } = {}) => {
    if (!trusted(event)) return;
    const cb = pendingAuth.get(id);
    if (!cb) return;
    pendingAuth.delete(id);
    if (typeof username === 'string') cb(username, String(password || '')); else cb();
  });

  /* ---- window ---- */
  handle('window:minimize', (e) => { winFrom(e).minimize(); });
  handle('window:toggle-maximize', (e) => {
    const w = winFrom(e);
    if (w.isFullScreen()) w.setFullScreen(false);
    else if (w.isMaximized()) w.unmaximize(); else w.maximize();
  });
  handle('window:toggle-fullscreen', (e) => { const w = winFrom(e); w.setFullScreen(!w.isFullScreen()); });
  handle('window:close', (e) => { winFrom(e).close(); });
  handle('window:new', () => { createWindow({ cascade: true }); });
  handle('window:state', (e) => windowState(winFrom(e)));

  /* ---- theme ---- */
  handle('theme:get', () => ({ dark: nativeTheme.shouldUseDarkColors, source: nativeTheme.themeSource }));
  nativeTheme.on('updated', () => {
    for (const w of windows) if (!w.isDestroyed()) w.setBackgroundColor(bgColor());
    broadcast('theme:changed', { dark: nativeTheme.shouldUseDarkColors, source: nativeTheme.themeSource });
  });

  /* ---- stores ---- */
  handle('store:get', (_e, name) => {
    if (!READABLE_STORES.includes(name)) throw new Error('Unknown store');
    return stores[name].get();
  });
  handle('store:set', (e, name, value) => {
    const kind = WRITABLE_STORES[name];
    if (!kind) throw new Error('Store is not writable');
    if (kind === 'array' ? !Array.isArray(value) : !isPlainObject(value)) throw new Error('Invalid value');
    const prev = name === 'settings' ? clone(stores.settings.get()) : null;
    if (name === 'settings') value = deepMerge(clone(DEFAULT_SETTINGS), value);
    stores[name].set(value);
    if (name === 'settings') applySettingsSideEffects(value, prev);
    broadcast('store:changed', { name }, e.sender.id);
    return true;
  });

  /* ---- history ---- */
  handle('history:add', (e, entry) => {
    const url = String((entry && entry.url) || '');
    if (!/^https?:/i.test(url)) return null;
    const list = stores.history.get();
    const now = Date.now();
    const top = list[0];
    let rec;
    if (top && top.url === url && now - top.visitTime < 30 * 60 * 1000) {
      top.visitTime = now;
      if (entry.title) top.title = entry.title;
      if (entry.favicon) top.favicon = entry.favicon;
      rec = top;
    } else {
      rec = { id: randomUUID(), url, title: entry.title || url, favicon: entry.favicon || null, visitTime: now };
      list.unshift(rec);
      if (list.length > HISTORY_CAP) list.length = HISTORY_CAP;
    }
    stores.history.touch();
    broadcast('store:changed', { name: 'history' }, e.sender.id);
    return rec;
  });
  handle('history:update', (e, { url, title, favicon } = {}) => {
    const rec = stores.history.get().slice(0, 50).find((h) => h.url === url);
    if (!rec) return false;
    if (title) rec.title = title;
    if (favicon) rec.favicon = favicon;
    stores.history.touch();
    broadcast('store:changed', { name: 'history' }, e.sender.id);
    return true;
  });
  handle('history:search', (_e, { query = '', limit = 50 } = {}) => {
    const tokens = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const h of stores.history.get()) {
      if (seen.has(h.url)) continue;
      const hay = `${h.title || ''} ${h.url}`.toLowerCase();
      if (tokens.every((t) => hay.includes(t))) {
        seen.add(h.url);
        out.push(h);
        if (out.length >= limit) break;
      }
    }
    return out;
  });
  handle('history:clear', async (e, { range = 'all', clearWebsiteData = false } = {}) => {
    const now = Date.now();
    const sod = new Date(); sod.setHours(0, 0, 0, 0);
    const startOfToday = sod.getTime();
    let cutoff = 0;
    if (range === 'hour') cutoff = now - 3600000;
    else if (range === 'today') cutoff = startOfToday;
    else if (range === 'today-yesterday') cutoff = startOfToday - DAY_MS;
    stores.history.set(stores.history.get().filter((h) => h.visitTime < cutoff));
    if (clearWebsiteData && range === 'all') {
      const ses = session.fromPartition(PARTITION);
      await ses.clearCache();
      await ses.clearStorageData();
    }
    broadcast('store:changed', { name: 'history' }, e.sender.id);
    return true;
  });
  handle('history:remove', (e, ids) => {
    const set = new Set(Array.isArray(ids) ? ids : [ids]);
    stores.history.set(stores.history.get().filter((h) => !set.has(h.id)));
    broadcast('store:changed', { name: 'history' }, e.sender.id);
    return true;
  });

  /* ---- privacy ---- */
  handle('privacy:report', (_e, id) => {
    const priv = stores.privacy.get();
    const page = pageInfo.get(Number(id));
    return {
      page: page ? {
        host: page.host, count: page.count,
        trackers: [...page.trackers.entries()].map(([domain, count]) => ({ domain, count })).sort((a, b) => b.count - a.count)
      } : { host: null, count: 0, trackers: [] },
      week: weekTotal(),
      total: priv.total,
      since: priv.since,
      sites: Object.entries(priv.sites).map(([host, s]) => ({ host, count: s.count })).sort((a, b) => b.count - a.count).slice(0, 10),
      enabled: !!stores.settings.get().blockTrackers
    };
  });
  handle('privacy:reset', () => {
    stores.privacy.set({ total: 0, since: Date.now(), daily: {}, sites: {} });
    return true;
  });
  handle('privacy:clear-data', async (_e, { kind = 'all', origin } = {}) => {
    const ses = session.fromPartition(PARTITION);
    const opts = origin ? { origin } : {};
    if (kind === 'cache' || kind === 'all') await ses.clearCache();
    if (kind === 'cookies') await ses.clearStorageData(Object.assign({ storages: ['cookies'] }, opts));
    if (kind === 'all') await ses.clearStorageData(opts);
    return true;
  });

  /* ---- downloads ---- */
  handle('downloads:list', () => {
    const active = [...activeDownloads.values()].map((d) => d.rec);
    const done = stores.downloads.get().map((r) => Object.assign({}, r, { missing: !fs.existsSync(r.path) }));
    return [...active, ...done];
  });
  handle('downloads:pause', (_e, id) => {
    const d = activeDownloads.get(id);
    if (!d) return false;
    d.item.pause(); d.rec.paused = true;
    broadcast('downloads:update', d.rec);
    return true;
  });
  handle('downloads:resume', (_e, id) => {
    const d = activeDownloads.get(id);
    if (!d || !d.item.canResume()) return false;
    d.item.resume(); d.rec.paused = false; d.rec.state = 'progressing';
    broadcast('downloads:update', d.rec);
    return true;
  });
  handle('downloads:cancel', (_e, id) => {
    const d = activeDownloads.get(id);
    if (!d) return false;
    d.item.cancel();
    return true;
  });
  handle('downloads:open', async (_e, id) => {
    const rec = stores.downloads.get().find((r) => r.id === id);
    if (!rec || !fs.existsSync(rec.path)) return { ok: false, error: 'missing' };
    const err = await shell.openPath(rec.path);
    return { ok: !err, error: err || null };
  });
  handle('downloads:show', (_e, id) => {
    const rec = stores.downloads.get().find((r) => r.id === id);
    if (!rec) return false;
    if (fs.existsSync(rec.path)) shell.showItemInFolder(rec.path); else shell.openPath(path.dirname(rec.path));
    return true;
  });
  handle('downloads:remove', (e, id) => {
    stores.downloads.set(stores.downloads.get().filter((r) => r.id !== id));
    broadcast('store:changed', { name: 'downloads' }, e.sender.id);
    return true;
  });
  handle('downloads:clear', (e) => {
    stores.downloads.set([]);
    broadcast('store:changed', { name: 'downloads' }, e.sender.id);
    return true;
  });

  /* ---- page utilities ---- */
  handle('page:save-pdf', async (e, { id, title } = {}) => {
    const c = guestFor(e, id);
    const name = `${sanitizeFilename(title || c.getTitle() || 'Untitled')}.pdf`;
    const { canceled, filePath } = await dialog.showSaveDialog(winFrom(e), {
      title: 'Save Page as PDF',
      defaultPath: path.join(downloadsDir(), name),
      filters: [{ name: 'PDF Document', extensions: ['pdf'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    const buf = await c.printToPDF({ printBackground: true, preferCSSPageSize: true, pageSize: 'A4', generateTaggedPDF: true });
    await fsp.writeFile(filePath, buf);
    return { ok: true, path: filePath };
  });
  handle('page:print', (e, id) => {
    const c = guestFor(e, id);
    return new Promise((resolve) => c.print({ silent: false, printBackground: true }, (ok, reason) => resolve({ ok, reason })));
  });
  handle('page:capture', async (e, { id, width = 640 } = {}) => {
    const c = guestFor(e, id);
    const img = await c.capturePage();
    if (img.isEmpty()) return null;
    const out = img.getSize().width > width ? img.resize({ width, quality: 'good' }) : img;
    return `data:image/jpeg;base64,${out.toJPEG(72).toString('base64')}`;
  });
  handle('page:sample-color', async (e, id) => {
    const c = guestFor(e, id);
    const img = await c.capturePage();
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    const strip = img.crop({ x: 0, y: 0, width, height: Math.min(6, height) });
    const bmp = strip.toBitmap(); // BGRA
    const pixels = Math.floor(bmp.length / 4);
    const step = Math.max(1, Math.floor(pixels / 400));
    const buckets = new Map();
    for (let p = 0; p < pixels; p += step) {
      const i = p * 4;
      if (bmp[i + 3] < 250) continue;
      const bl = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (bl >> 4);
      const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      b.n++; b.r += r; b.g += g; b.b += bl;
      buckets.set(key, b);
    }
    let best = null;
    for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
    if (!best) return null;
    const r = Math.round(best.r / best.n), g = Math.round(best.g / best.n), bl = Math.round(best.b / best.n);
    const hex = `#${[r, g, bl].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    return { hex, luminance: (0.2126 * r + 0.7152 * g + 0.0722 * bl) / 255 };
  });
  handle('page:view-source', async (e, id) => {
    const c = guestFor(e, id);
    const url = c.getURL();
    let source = '';
    if (/^https?:/i.test(url)) {
      try {
        const res = await c.session.fetch(url, { credentials: 'include' });
        source = await res.text();
      } catch (_) { /* fall back below */ }
    }
    if (!source) source = await c.executeJavaScript('document.documentElement.outerHTML');
    if (source.length > 4000000) source = `${source.slice(0, 4000000)}\n<!-- truncated -->`;
    return { url, title: c.getTitle(), source };
  });

  /* ---- DevTools ---- */
  handle('devtools:toggle', (e, { id, mode = 'detach' } = {}) => {
    const c = guestFor(e, id);
    if (c.isDevToolsOpened()) { c.closeDevTools(); return false; }
    c.openDevTools({ mode: ['left', 'right', 'bottom', 'undocked', 'detach'].includes(mode) ? mode : 'detach' });
    return true;
  });
  handle('devtools:open-docked', (e, { id, devtoolsId } = {}) => {
    // `devtoolsId` is a fresh, never-navigated <webview partition="safari-devtools"> in the host UI.
    const c = guestFor(e, id);
    const dt = guestFor(e, devtoolsId);
    c.setDevToolsWebContents(dt);
    c.openDevTools({ mode: 'detach' });
    return true;
  });
  handle('devtools:close', (e, id) => { const c = guestFor(e, id); if (c.isDevToolsOpened()) c.closeDevTools(); return true; });
  handle('devtools:is-open', (e, id) => guestFor(e, id).isDevToolsOpened());

  /* ---- per-tab navigation stack (back/forward long-press popover) ---- */
  handle('nav:stack', (e, id) => {
    const c = guestFor(e, id);
    if (!c.navigationHistory) return { entries: [], index: -1 };
    return {
      entries: c.navigationHistory.getAllEntries().map((en) => ({ url: en.url, title: en.title })),
      index: c.navigationHistory.getActiveIndex()
    };
  });
  handle('nav:go-to-index', (e, { id, index } = {}) => {
    const c = guestFor(e, id);
    if (c.navigationHistory) c.navigationHistory.goToIndex(Number(index)); else c.goToIndex(Number(index));
    return true;
  });

  /* ---- search suggestions (avoids CORS in the renderer) ---- */
  handle('suggest:fetch', async (_e, engine, query) => {
    const q = String(query || '').trim().slice(0, 200);
    if (!q) return [];
    const build = SUGGEST_URLS[engine] || SUGGEST_URLS.google;
    try {
      const res = await net.fetch(build(encodeURIComponent(q)), { signal: AbortSignal.timeout(2500), headers: { Accept: 'application/json' } });
      if (!res.ok) return [];
      const json = JSON.parse(await res.text());
      const list = Array.isArray(json) && Array.isArray(json[1]) ? json[1] : [];
      return list.filter((s) => typeof s === 'string').slice(0, 8);
    } catch (_) { return []; }
  });

  /* ---- clipboard / shell / dialogs ---- */
  handle('clipboard:write', (_e, text) => { clipboard.writeText(String(text || '')); return true; });
  handle('shell:open-external', async (_e, url) => {
    if (!/^(https?:|mailto:)/i.test(String(url))) return false;
    await shell.openExternal(url);
    return true;
  });
  handle('shell:show-item', (_e, p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); return true; });

  handle('dialog:pick-background', async (e) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(winFrom(e), {
      title: 'Choose Background Image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'] }]
    });
    if (canceled || !filePaths.length) return null;
    const dest = path.join(BG_DIR, `${randomUUID()}${path.extname(filePaths[0]).toLowerCase()}`);
    await fsp.copyFile(filePaths[0], dest);
    return { path: dest, url: pathToFileURL(dest).href };
  });
  handle('dialog:choose-downloads-folder', async (e) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(winFrom(e), {
      title: 'Choose Downloads Folder',
      defaultPath: downloadsDir(),
      properties: ['openDirectory', 'createDirectory']
    });
    if (canceled || !filePaths.length) return null;
    stores.settings.get().downloadsPath = filePaths[0];
    stores.settings.touch();
    broadcast('store:changed', { name: 'settings' });
    return filePaths[0];
  });
}

/* ------------------------------------------------------------------ */
/* App menu & lifecycle                                               */
/* ------------------------------------------------------------------ */
function buildMenu() {
  if (!IS_MAC) { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  pendingOpen = urlsFromArgv(process.argv);

  app.on('second-instance', (_e, argv) => {
    const win = [...windows][0];
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); } else createWindow();
    const urls = urlsFromArgv(argv);
    if (urls.length) openUrls(urls);
  });

  app.on('open-url', (event, url) => { event.preventDefault(); openUrls([url]); });

  app.whenReady().then(() => {
    initStores();
    const ua = cleanUserAgent();
    app.userAgentFallback = ua;
    nativeTheme.themeSource = ['light', 'dark', 'system'].includes(stores.settings.get().theme)
      ? stores.settings.get().theme : 'system';

    const ses = session.fromPartition(PARTITION);
    ses.setUserAgent(ua);
    setupBlocker(ses);
    setupDownloads(ses);
    setupPermissions(ses);

    buildMenu();
    registerIpc();
    createWindow();

    app.on('activate', () => { if (!windows.size) createWindow(); });
  });

  app.on('window-all-closed', () => { if (!IS_MAC) app.quit(); });

  app.on('before-quit', () => {
    for (const s of Object.values(stores)) s.flushSync();
  });
}
