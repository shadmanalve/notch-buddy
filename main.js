const {
  app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeImage,
  clipboard, globalShortcut, Notification, dialog, shell
} = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const hooks = require('./scripts/install-hooks');
const { Asker } = require('./ask');
let asker = null;

const PORT = 47321;
let WIN_W = 196;   // window hugs the island; renderer asks for resizes
let WIN_H = 40;

let win = null;
let tray = null;
let mediaProc = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/* ---------------- persistent store ---------------- */
const storeFile = path.join(app.getPath('userData'), 'island.json');
// One-time move from the app's old name: copy settings, launchers and notes over.
try {
  const legacy = path.join(app.getPath('appData'), 'Claude Island', 'island.json');
  if (!fs.existsSync(storeFile) && fs.existsSync(legacy)) {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.copyFileSync(legacy, storeFile);
  }
} catch {}
const store = Object.assign({
  pinned: false,
  launchAtLogin: false,
  followCursor: true,
  expandOnAttention: true,
  focusMinutes: 25,
  contextWindow: 200000,
  notes: '',
  jobs: {},
  focusDone: {},
  hooksAutoInstalled: false,
  theme: 'midnight',
  eyes: 'classic',
  position: 'center',
  hoverDelay: 450,
  ghost: true,
  askModel: 'default',
  font: 'claude',
  launchers: []
}, readJSON(storeFile));

function readJSON(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; }
}
let saveTimer = null;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(storeFile, JSON.stringify(store, null, 2)); } catch {}
  }, 300);
}
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* ---------------- debug log ---------------- */
const logFile = path.join(app.getPath('userData'), 'debug.log');
try { if (fs.existsSync(logFile) && fs.statSync(logFile).size > 512 * 1024) fs.unlinkSync(logFile); } catch {}
function dlog(...a) {
  try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}\n`); } catch {}
}

function send(ch, data) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data);
}

/* ---------------- window ---------------- */
function placeWindow() {
  if (!win) return;
  const b = screen.getPrimaryDisplay().bounds;
  const frac = store.position === 'left' ? 0.22 : store.position === 'right' ? 0.78 : 0.5;
  let x = Math.round(b.x + b.width * frac - WIN_W / 2);
  x = Math.max(b.x, Math.min(b.x + b.width - WIN_W, x));
  const bounds = { x, y: b.y, width: WIN_W, height: WIN_H };
  win.setResizable(true);
  win.setBounds(bounds);
  win.setResizable(false);
}

function createWindow() {
  win = new BrowserWindow({
    width: WIN_W, height: WIN_H,
    frame: false, transparent: true, resizable: false, movable: false, thickFrame: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  placeWindow();
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // closed notch lets clicks through to whatever is underneath (e.g. browser tabs)
  win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.on('console-message', (_e, level, message, line, source) => dlog('console', level, message, `${path.basename(source || '')}:${line}`));
  win.webContents.on('preload-error', (_e, p, err) => dlog('preload-error', String(err && err.stack || err)));
  win.webContents.on('render-process-gone', (_e, d) => dlog('renderer-gone', d));
  win.webContents.on('did-fail-load', (_e, c, d) => dlog('did-fail-load', c, d));
  win.webContents.on('did-finish-load', () => dlog('did-finish-load'));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
  // Keep it above other always-on-top windows (e.g. after fullscreen apps).
  setInterval(() => { if (win && !win.isDestroyed()) win.moveTop(); }, 15000);
}

/* ---------------- Claude Code (hooks) ---------------- */
const sessions = new Map();
let activeId = null;
const log = [];

const trunc = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const base = p => (p ? path.basename(String(p)) : '');
const fmtDur = ms => { const s = Math.round(ms / 1000); const m = Math.floor(s / 60); return m ? `${m}m ${s % 60}s` : `${s}s`; };

function describeTool(name = '', input = {}) {
  switch (name) {
    case 'Read': return { status: 'Reading', detail: base(input.file_path) };
    case 'Glob': return { status: 'Searching', detail: trunc(input.pattern, 40) };
    case 'Grep': return { status: 'Searching', detail: trunc(input.pattern, 40) };
    case 'Edit': case 'MultiEdit': return { status: 'Editing', detail: base(input.file_path) };
    case 'Write': return { status: 'Writing', detail: base(input.file_path) };
    case 'NotebookEdit': return { status: 'Editing', detail: base(input.notebook_path) };
    case 'Bash': return { status: 'Running', detail: trunc(input.description || input.command, 48) };
    case 'WebFetch': { let h = ''; try { h = new URL(input.url).hostname; } catch {} return { status: 'Browsing', detail: h }; }
    case 'WebSearch': return { status: 'Searching web', detail: trunc(input.query, 40) };
    case 'Task': case 'Agent': return { status: 'Delegating', detail: trunc(input.description, 40) };
    case 'TodoWrite': return { status: 'Planning', detail: '' };
    default:
      if (name.startsWith('mcp__')) { const parts = name.split('__'); return { status: 'Using tool', detail: parts.slice(1).join(' · ') }; }
      return { status: name || 'Working', detail: '' };
  }
}

function addLog(s, kind, text) {
  log.unshift({ t: Date.now(), kind, text, project: s.project });
  if (log.length > 60) log.length = 60;
}

function readContextPct(file) {
  try {
    const st = fs.statSync(file);
    const size = Math.min(st.size, 768 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim();
      if (!l.startsWith('{')) continue;
      let o; try { o = JSON.parse(l); } catch { continue; }
      if (o.type !== 'assistant' || o.isSidechain) continue;
      const u = o.message && o.message.usage;
      if (!u) continue;
      const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
      return Math.max(0, Math.min(100, Math.round(used / (store.contextWindow || 200000) * 100)));
    }
  } catch {}
  return null;
}

function pickActive() {
  let best = null;
  for (const s of sessions.values()) if (!best || s.updatedAt > best.updatedAt) best = s;
  return best ? best.id : null;
}

function claudeSnapshot() {
  const s = activeId ? sessions.get(activeId) : null;
  return {
    connected: sessions.size > 0,
    active: s ? { ...s, transcript: undefined } : null,
    sessions: [...sessions.values()].map(x => ({ id: x.id, project: x.project, status: x.status, working: x.working, attention: x.attention })),
    jobsToday: store.jobs[today()] || 0,
    log: log.slice(0, 40)
  };
}
const pushClaude = () => send('claude', claudeSnapshot());

function handleHook(ev) {
  const name = ev.hook_event_name;
  if (!name) return;
  const id = ev.session_id || 'default';
  if (asker && asker.isOwnSession(id)) return;   // our own Ask runs are not Claude Code jobs
  let s = sessions.get(id);
  if (!s) {
    s = { id, project: 'Claude', working: false, attention: false, status: 'Ready', tool: '', startedAt: 0, lastDuration: 0, contextPct: null, doneAt: 0, updatedAt: 0, transcript: null };
    sessions.set(id, s);
  }
  if (ev.cwd) s.project = base(ev.cwd) || s.project;
  if (ev.transcript_path) s.transcript = ev.transcript_path;
  s.updatedAt = Date.now();

  switch (name) {
    case 'SessionStart':
      s.status = 'Ready';
      addLog(s, 'start', 'Session started');
      break;
    case 'UserPromptSubmit':
      if (!s.working) s.startedAt = Date.now();
      s.working = true; s.attention = false; s.status = 'Thinking'; s.tool = '';
      addLog(s, 'prompt', trunc(ev.prompt || 'New prompt', 90));
      break;
    case 'PreToolUse': {
      if (!s.working) { s.working = true; s.startedAt = Date.now(); }
      s.attention = false;
      const d = describeTool(ev.tool_name, ev.tool_input || {});
      s.status = d.status; s.tool = d.detail;
      addLog(s, 'tool', d.detail ? `${d.status} · ${d.detail}` : d.status);
      break;
    }
    case 'PostToolUse':
      s.status = 'Thinking'; s.attention = false;
      break;
    case 'Notification': {
      s.attention = true;
      s.status = s.working ? 'Needs you' : 'Waiting for you';
      const msg = trunc(ev.message || 'Claude needs your input', 90);
      addLog(s, 'attention', msg);
      if (Notification.isSupported()) new Notification({ title: `Claude Code · ${s.project}`, body: msg, silent: false }).show();
      send('attention', { project: s.project, message: msg });
      break;
    }
    case 'Stop':
      if (s.working) {
        s.lastDuration = Date.now() - s.startedAt;
        store.jobs[today()] = (store.jobs[today()] || 0) + 1;
        saveStore();
        addLog(s, 'done', `Finished in ${fmtDur(s.lastDuration)}`);
      }
      s.working = false; s.attention = false; s.status = 'Done'; s.tool = ''; s.doneAt = Date.now();
      break;
    case 'SessionEnd':
      addLog(s, 'end', 'Session ended');
      sessions.delete(id);
      break;
  }

  activeId = sessions.has(id) ? id : pickActive();
  if (s.transcript && ['UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionStart'].includes(name)) {
    const p = readContextPct(s.transcript);
    if (p != null) s.contextPct = p;
  }
  pushClaude();
}

// Esc-interrupted turns never send Stop; quietly settle sessions that went silent.
setInterval(() => {
  let changed = false;
  for (const s of sessions.values()) {
    if (s.working && Date.now() - s.updatedAt > 10 * 60 * 1000) {
      s.working = false; s.status = 'Idle'; s.tool = ''; changed = true;
    }
  }
  if (changed) pushClaude();
}, 30000);

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/hook')) {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
      req.on('end', () => {
        res.statusCode = 204; res.end();   // empty: hook output would otherwise be shown to Claude
        try { const ev = JSON.parse(body); dlog('hook', ev.hook_event_name, ev.tool_name || '', (ev.session_id || '').slice(0, 8)); handleHook(ev); }
        catch (e) { dlog('hook parse error', e.message, body.slice(0, 120)); }
      });
    } else if (req.url === '/ping') {
      res.end('notch-buddy');
    } else {
      res.statusCode = 404; res.end();
    }
  });
  server.on('error', e => console.error('Hook server error:', e.message));
  server.listen(PORT, '127.0.0.1');
}

/* ---------------- media (Windows SMTC via PowerShell) ---------------- */
/* Demo mode (only when ISLAND_DEMO is set): fake a playing track for recordings. */
function startDemoMedia() {
  let art = null;
  try { if (process.env.ISLAND_DEMO_ART) art = nativeImage.createFromPath(process.env.ISLAND_DEMO_ART).toDataURL(); } catch {}
  const d = { ok: true, has: true, key: 'demo', title: 'Golden Hour', artist: 'Nova Lane', album: 'Low Tide', app: 'Spotify.exe', status: 'Playing', pos: 42, dur: 214 };
  let first = true, t = Date.now();
  ipcMain.on('media-cmd', (_e, cmd) => { if (cmd === 'toggle') d.status = d.status === 'Playing' ? 'Paused' : 'Playing'; if (cmd === 'next') { d.title = 'Paper Lanterns'; d.key = 'demo2'; d.pos = 0; first = true; } });
  setInterval(() => {
    if (d.status === 'Playing') d.pos = Math.min(d.dur, d.pos + (Date.now() - t) / 1000);
    t = Date.now();
    send('media', first ? { ...d, art, artChanged: true } : d);
    first = false;
  }, 1000);
}

function startMedia() {
  if (process.env.ISLAND_DEMO) return startDemoMedia();
  if (process.platform !== 'win32' || quitting) return;
  const script = path.join(__dirname, 'scripts', 'media.ps1').replace('app.asar', 'app.asar.unpacked');
  mediaProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
  let buf = '';
  mediaProc.stdout.setEncoding('utf8');
  mediaProc.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith('{')) { try { send('media', JSON.parse(line)); } catch {} }
    }
  });
  mediaProc.stderr.on('data', () => {});
  mediaProc.on('exit', () => { mediaProc = null; if (!quitting) setTimeout(startMedia, 5000); });
}

/* ---------------- clipboard history ---------------- */
let clips = [];
let lastClip = '';
function pollClipboard() {
  let t = '';
  try { t = clipboard.readText(); } catch {}
  if (t && t !== lastClip) {
    lastClip = t;
    if (t.trim()) {
      clips = [t, ...clips.filter(c => c !== t)].slice(0, 30);
      send('clipboard', clips);
    }
  }
}

/* ---------------- login item ---------------- */
function applyLoginItem() {
  const opts = { openAtLogin: !!store.launchAtLogin };
  if (!app.isPackaged) { opts.path = process.execPath; opts.args = [app.getAppPath()]; }
  try { app.setLoginItemSettings(opts); } catch {}
}

/* ---------------- tray ---------------- */
function buildTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('Notch Buddy');
  refreshTray();
  tray.on('click', () => send('toggle'));
}
function refreshTray() {
  if (!tray) return;
  const installed = hooks.status();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open island  (Ctrl+Alt+Space)', click: () => send('toggle') },
    { type: 'separator' },
    { label: 'Keep open', type: 'checkbox', checked: !!store.pinned, click: m => setStore({ pinned: m.checked }) },
    { label: 'Launch at login', type: 'checkbox', checked: !!store.launchAtLogin, click: m => setStore({ launchAtLogin: m.checked }) },
    { label: installed ? 'Claude Code hooks: installed ✓' : 'Install Claude Code hooks', enabled: !installed, click: () => { try { hooks.install(); } catch {} refreshTray(); send('store', storeSnapshot()); } },
    { type: 'separator' },
    { label: 'Open debug log', click: () => { require('electron').shell.openPath(logFile); } },
    { label: 'Reload', click: () => win && win.reload() },
    { label: 'Quit', click: () => app.quit() }
  ]));
}

const storeSnapshot = () => ({ ...store, hooksInstalled: hooks.status(), platform: process.platform });
function setStore(patch) {
  Object.assign(store, patch);
  if ('launchAtLogin' in patch) applyLoginItem();
  if ('position' in patch) placeWindow();
  saveStore();
  refreshTray();
  send('store', storeSnapshot());
  return storeSnapshot();
}

/* ---------------- IPC ---------------- */
/* The window is resized to fit the island, so it is never click-through and
   hover is ordinary DOM mouseenter/mouseleave. We still stream the cursor for the eyes. */
ipcMain.on('set-size', (_e, sz) => {
  if (!sz) return;
  const w = Math.max(40, Math.round(sz.w)), h = Math.max(20, Math.round(sz.h));
  if (w === WIN_W && h === WIN_H) return;
  WIN_W = w; WIN_H = h;
  placeWindow();
  dlog('resize', { w, h }, win.getBounds());
});
ipcMain.on('interactive', (_e, on) => { if (win) win.setIgnoreMouseEvents(!on, { forward: true }); });
ipcMain.on('hit-rect', () => {});
let lastCursor = '';
let mainOver = null;
let lastNearLog = 0;
function pollCursor() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  let p = screen.getCursorScreenPoint();
  if (process.env.ISLAND_TEST_XCURSOR) {   // test harness only (Linux/X11 can't see the cursor through a click-through window)
    try { const o = require('child_process').execSync('xdotool getmouselocation', { encoding: 'utf8' }); const m = o.match(/x:(\d+) y:(\d+)/); if (m) p = { x: +m[1], y: +m[2] }; } catch {}
  }
  const b = win.getBounds();
  const x = p.x - b.x, y = p.y - b.y;
  // hover check done entirely in screen space against the real window bounds
  const over = x >= -2 && y >= -2 && x <= b.width + 2 && y <= b.height + 2;
  if (over !== mainOver) {
    mainOver = over;
    dlog('main-hover', over, { cursor: p, bounds: b });
    send('hover', over);
  }
  if (y < b.height + 120 && Math.abs(x - b.width / 2) < 400 && Date.now() - lastNearLog > 3000) {
    lastNearLog = Date.now();
    dlog('cursor-near', { cursor: p, bounds: b, local: { x, y } });
  }
  const key = x + ',' + y;
  if (key !== lastCursor && y < b.height + 250) { lastCursor = key; send('cursor', { x, y }); }
}
ipcMain.on('log', (_e, ...a) => dlog('renderer', ...a));
ipcMain.on('focus-window', () => { if (win) win.focus(); });
ipcMain.on('media-cmd', (_e, cmd) => {
  if (mediaProc && ['toggle', 'next', 'prev'].includes(cmd)) mediaProc.stdin.write(cmd + '\n');
});
ipcMain.on('copy', (_e, t) => { lastClip = t; clipboard.writeText(String(t)); });
ipcMain.on('clip-clear', () => { clips = []; send('clipboard', clips); });
ipcMain.on('notify', (_e, { title, body }) => {
  if (Notification.isSupported()) new Notification({ title, body }).show();
});
ipcMain.on('focus-complete', () => {
  store.focusDone[today()] = (store.focusDone[today()] || 0) + 1;
  saveStore();
  send('store', storeSnapshot());
});
ipcMain.on('quit', () => app.quit());
ipcMain.on('ask', (_e, { reqId, prompt }) => { if (asker) asker.ask(reqId, String(prompt || ''), { model: store.askModel }); });
ipcMain.on('ask-cancel', () => asker && asker.cancel());
ipcMain.on('ask-reset', () => asker && asker.reset());

/* ---------------- launchers ---------------- */
async function withDialog(fn) {
  // lower the island so the system dialog isn't hidden behind it
  win.setAlwaysOnTop(false);
  try { return await fn(); }
  finally { win.setAlwaysOnTop(true, 'screen-saver'); win.moveTop(); }
}
const prettyName = p => path.basename(p).replace(/\.(lnk|exe|url|appref-ms)$/i, '');
async function iconFor(p) {
  try {
    let target = p;
    if (process.platform === 'win32' && /\.lnk$/i.test(p)) {
      try { const l = shell.readShortcutLink(p); if (l.icon) target = l.icon; else if (l.target) target = l.target; } catch {}
    }
    const img = await app.getFileIcon(target, { size: 'large' });
    if (!img.isEmpty()) return img.toDataURL();
  } catch {}
  return null;
}
async function describe(p, type = 'app') {
  return { type, path: p, name: prettyName(p), icon: await iconFor(p) };
}
const startMenu = process.platform === 'win32'
  ? path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  : app.getPath('home');
ipcMain.handle('pick-apps', () => withDialog(async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose apps, shortcuts or files to open',
    defaultPath: fs.existsSync('C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs') ? 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs' : startMenu,
    properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
    filters: [{ name: 'Apps & shortcuts', extensions: ['exe', 'lnk', 'url', 'bat', 'cmd', 'appref-ms'] }, { name: 'All files', extensions: ['*'] }]
  });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map(p => describe(p, 'app')));
}));
ipcMain.handle('pick-folder', () => withDialog(async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder to open', properties: ['openDirectory', 'multiSelections'] });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map(p => describe(p, 'folder')));
}));
ipcMain.handle('pick-icon', () => withDialog(async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose an icon image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'ico', 'webp', 'gif', 'bmp', 'svg'] }]
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const f = r.filePaths[0];
  try {
    const img = nativeImage.createFromPath(f);
    if (!img.isEmpty()) {
      const sz = img.getSize();
      return (sz.width > 160 || sz.height > 160 ? img.resize(sz.width >= sz.height ? { width: 160 } : { height: 160 }) : img).toDataURL();
    }
  } catch {}
  try {
    const buf = fs.readFileSync(f);
    if (buf.length > 1.5e6) return null;
    const ext = path.extname(f).slice(1).toLowerCase();
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return null; }
}));
ipcMain.handle('launch', async (_e, items) => {
  const errors = [];
  for (const it of items || []) {
    try {
      if (it.type === 'url') await shell.openExternal(it.path);
      else { const err = await shell.openPath(it.path); if (err) errors.push(`${it.name}: ${err}`); }
    } catch (e) { errors.push(`${it.name}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 120));
  }
  dlog('launch', (items || []).map(i => i.path), errors);
  return errors;
});
ipcMain.handle('store-get', () => storeSnapshot());
ipcMain.handle('store-set', (_e, patch) => setStore(patch || {}));
ipcMain.handle('claude-get', () => claudeSnapshot());
ipcMain.handle('clips-get', () => clips);
ipcMain.handle('clipboard-read', () => { try { return clipboard.readText(); } catch { return ''; } });
ipcMain.handle('install-hooks', () => {
  try { hooks.install(); refreshTray(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

/* ---------------- lifecycle ---------------- */
app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('Notch Buddy');
  dlog('---- start', app.getVersion(), process.platform, require('os').release());
  dlog('displays', screen.getAllDisplays().map(d => ({ id: d.id, bounds: d.bounds, scale: d.scaleFactor, primary: d.id === screen.getPrimaryDisplay().id })));
  createWindow();
  win.once('show', () => dlog('window shown', win.getBounds()));
  buildTray();
  startServer();
  startMedia();
  applyLoginItem();
  // First launch: connect Claude Code automatically (settings.json is backed up first).
  try {
    if (hooks.outdated()) { hooks.install(); dlog('hooks upgraded to', hooks.COMMAND); }
    dlog('hooks status', hooks.status(), hooks.settingsPath());
  } catch (e) { dlog('hooks check failed', e.message); }
  if (!store.hooksAutoInstalled) {
    try { if (!hooks.status()) hooks.install(); } catch {}
    store.hooksAutoInstalled = true; saveStore(); refreshTray();
  }
  try { lastClip = clipboard.readText(); } catch {}
  setInterval(pollClipboard, 800);
  setInterval(pollCursor, 40);
  globalShortcut.register('Control+Alt+Space', () => send('toggle'));
  globalShortcut.register('Control+Alt+A', () => send('ask-open'));
  asker = new Asker({ workDir: path.join(app.getPath('userData'), 'ask'), onUpdate: u => send('ask-update', u), log: dlog });
  screen.on('display-metrics-changed', placeWindow);
  screen.on('display-added', placeWindow);
  screen.on('display-removed', placeWindow);
});

app.on('second-instance', () => send('toggle'));
app.on('before-quit', () => {
  quitting = true;
  globalShortcut.unregisterAll();
  if (mediaProc) { try { mediaProc.kill(); } catch {} }
  try { fs.writeFileSync(storeFile, JSON.stringify(store, null, 2)); } catch {}
});
app.on('window-all-closed', () => app.quit());
