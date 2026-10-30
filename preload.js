'use strict';

/* =====================================================================
 * Safari for Windows — Preload (context-isolated bridge)
 * Exposes `window.safari` to the renderer. No Node APIs leak through.
 * ===================================================================== */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

/** Subscribe to a main→renderer channel. Returns an unsubscribe function. */
const on = (channel, callback) => {
  const handler = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

// Static facts about the environment (platform, partition name, search engines…)
const info = ipcRenderer.sendSync('app:info-sync');

contextBridge.exposeInMainWorld('safari', {
  /** Static environment info: { platform, partition, devtoolsPartition, version, versions, searchEngines, … } */
  info,

  /** Call once the renderer has finished booting so queued "open URL" requests are delivered. */
  ready: () => ipcRenderer.send('app:renderer-ready'),

  window: {
    minimize: () => invoke('window:minimize'),
    toggleMaximize: () => invoke('window:toggle-maximize'),
    toggleFullscreen: () => invoke('window:toggle-fullscreen'),
    close: () => invoke('window:close'),
    newWindow: () => invoke('window:new'),
    getState: () => invoke('window:state'),
    /** cb({ focused, maximized, fullscreen, minimized, platform }) */
    onState: (cb) => on('window:state', cb)
  },

  theme: {
    /** → { dark: boolean, source: 'light' | 'dark' | 'system' } */
    get: () => invoke('theme:get'),
    onChanged: (cb) => on('theme:changed', cb)
  },

  /**
   * Persistent JSON stores.
   * Readable: settings, favorites, bookmarks, readingList, history, session, downloads
   * Writable: settings (object), favorites (array), bookmarks (array), readingList (array), session (object)
   */
  store: {
    get: (name) => invoke('store:get', name),
    set: (name, value) => invoke('store:set', name, value),
    /** cb({ name }) — fired when another window (or main) changed a store. */
    onChanged: (cb) => on('store:changed', cb)
  },

  history: {
    add: (entry) => invoke('history:add', entry),                    // { url, title, favicon }
    update: (entry) => invoke('history:update', entry),              // { url, title?, favicon? }
    search: (query, limit = 50) => invoke('history:search', { query, limit }),
    /** range: 'hour' | 'today' | 'today-yesterday' | 'all' */
    clear: (range, clearWebsiteData = false) => invoke('history:clear', { range, clearWebsiteData }),
    remove: (ids) => invoke('history:remove', ids)
  },

  privacy: {
    /** → { page:{host,count,trackers[]}, week, total, since, sites[], enabled } */
    report: (webContentsId) => invoke('privacy:report', webContentsId),
    reset: () => invoke('privacy:reset'),
    /** kind: 'all' | 'cache' | 'cookies', origin?: string */
    clearData: (kind, origin) => invoke('privacy:clear-data', { kind, origin }),
    /** cb({ webContentsId, host, pageCount, weekCount, total }) — live tracker counter updates. */
    onBlocked: (cb) => on('privacy:blocked', cb)
  },

  downloads: {
    list: () => invoke('downloads:list'),
    pause: (id) => invoke('downloads:pause', id),
    resume: (id) => invoke('downloads:resume', id),
    cancel: (id) => invoke('downloads:cancel', id),
    open: (id) => invoke('downloads:open', id),
    show: (id) => invoke('downloads:show', id),
    remove: (id) => invoke('downloads:remove', id),
    clear: () => invoke('downloads:clear'),
    chooseFolder: () => invoke('dialog:choose-downloads-folder'),
    /**
     * cb(record) — a new download appears with state 'progressing'; later updates reuse the same id.
     * record: { id, filename, url, path, mime, totalBytes, receivedBytes, state, paused, canResume,
     *           startTime, endTime, bytesPerSecond }
     */
    onUpdate: (cb) => on('downloads:update', cb)
  },

  page: {
    /** → { ok, path } | { ok:false, canceled:true } */
    savePDF: (webContentsId, title) => invoke('page:save-pdf', { id: webContentsId, title }),
    print: (webContentsId) => invoke('page:print', webContentsId),
    /** → JPEG data URL | null (null when the guest is hidden/unrendered) */
    capture: (webContentsId, width = 640) => invoke('page:capture', { id: webContentsId, width }),
    /** → { hex, luminance } | null — dominant colour of the top edge of the page. */
    sampleColor: (webContentsId) => invoke('page:sample-color', webContentsId),
    /** → { url, title, source } */
    viewSource: (webContentsId) => invoke('page:view-source', webContentsId)
  },

  devtools: {
    /** mode: 'detach' | 'right' | 'bottom' | 'left' | 'undocked' → resolves to the new open state */
    toggle: (webContentsId, mode = 'detach') => invoke('devtools:toggle', { id: webContentsId, mode }),
    /**
     * Docked inspector: create a fresh `<webview partition="safari-devtools">` WITHOUT a src, wait for its
     * `did-attach` event, then pass its getWebContentsId() as devtoolsId.
     */
    openDocked: (webContentsId, devtoolsId) => invoke('devtools:open-docked', { id: webContentsId, devtoolsId }),
    close: (webContentsId) => invoke('devtools:close', webContentsId),
    isOpen: (webContentsId) => invoke('devtools:is-open', webContentsId),
    /** cb({ webContentsId, opened }) */
    onState: (cb) => on('devtools:state', cb)
  },

  nav: {
    /** → { entries:[{url,title}], index } — the tab's back/forward stack for the long-press popover. */
    stack: (webContentsId) => invoke('nav:stack', webContentsId),
    goToIndex: (webContentsId, index) => invoke('nav:go-to-index', { id: webContentsId, index })
  },

  /** → string[] of live autocomplete suggestions (fetched in main, no CORS issues). */
  suggest: (engine, query) => invoke('suggest:fetch', engine, query),

  clipboard: { writeText: (text) => invoke('clipboard:write', text) },

  shell: {
    openExternal: (url) => invoke('shell:open-external', url),   // http(s) and mailto only
    showItemInFolder: (p) => invoke('shell:show-item', p)
  },

  dialogs: {
    /** → { path, url } | null — copies the chosen image into app storage; use `url` as a CSS background. */
    pickBackground: () => invoke('dialog:pick-background')
  },

  /** HTTP basic-auth prompts: respond with credentials, or call with no username to cancel. */
  auth: {
    onRequest: (cb) => on('auth:request', cb),
    respond: (id, username, password) => ipcRenderer.send('auth:respond', { id, username, password })
  },

  /**
   * Global keyboard shortcuts (captured in main so they also work while a page has focus).
   * cb({ action, index? }) — actions: back, forward, reload, hard-reload, devtools, next-tab, prev-tab,
   * tab-overview, goto-tab(index), last-tab, zoom-in, zoom-out, zoom-reset, focus-address, toggle-sidebar,
   * new-tab, reopen-tab, close-tab, reader, bookmark, find, find-next, find-prev, history, downloads,
   * view-source, print, save-pdf
   */
  onShortcut: (cb) => on('shortcut', cb),

  /** Open-in-tab requests: window.open / target=_blank / context menu / CLI / second instance. */
  onOpenTab: (cb) => on('tab:open', cb),                          // cb({ url, background, opener? })
  onViewSourceRequest: (cb) => on('view-source:request', cb),     // cb({ webContentsId })
  onTargetUrl: (cb) => on('webview:target-url', cb),              // cb({ webContentsId, url }) — hover link preview
  onHtmlFullscreen: (cb) => on('webview:html-fullscreen', cb)     // cb({ webContentsId, active })
});
