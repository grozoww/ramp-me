// Ramp Me: one-click speed ramps for DaVinci Resolve Studio.
// Electron main process, started by Resolve from Workspace > Workflow Integrations.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const WI = require('./WorkflowIntegration.node');
const { Bridge } = require('./lib/bridge');
const store = require('./lib/store');

const PLUGIN_ID = 'com.grozoww.rampme';
const ICON = path.join(__dirname, 'img', 'icon.png');
const POLL_MS = 250;

// Errors that would otherwise close the window silently go to
// ~/Library/Application Support/RampMe/plugin.log.
function logError(what, err) {
  try {
    fs.mkdirSync(store.DIR, { recursive: true });
    fs.appendFileSync(path.join(store.DIR, 'plugin.log'), `${new Date().toISOString()} ${what}: ${(err && err.stack) || err}\n`);
  } catch {
    // Nowhere left to report to.
  }
}
process.on('uncaughtException', (e) => logError('uncaught', e));
process.on('unhandledRejection', (e) => logError('unhandled', e));

const bridge = new Bridge(WI, PLUGIN_ID);
let win = null;
let lastSent = '';

function publish(ctx) {
  const json = JSON.stringify(ctx);
  if (json === lastSent || !win) return;
  lastSent = json;
  win.webContents.send('rampme:context', ctx);
}

// One job per kind at a time. A newer request replaces one that is still
// waiting, so dragging a curve only ever sends the latest shape to Resolve.
const slots = {};
function latest(kind, fn) {
  const slot = slots[kind] || (slots[kind] = { running: false, pending: null });
  return new Promise((resolve) => {
    if (slot.pending) slot.pending.resolve({ ok: true, skipped: true });
    slot.pending = { fn, resolve };
    pump(slot);
  });
}
async function pump(slot) {
  if (slot.running || !slot.pending) return;
  const { fn, resolve } = slot.pending;
  slot.pending = null;
  slot.running = true;
  try {
    resolve({ ok: true, result: await bridge.exec(fn) });
  } catch (e) {
    resolve({ ok: false, error: e.message || String(e) });
  } finally {
    slot.running = false;
    pump(slot);
  }
}

async function poll() {
  if (!win) return;
  try {
    const ctx = await bridge.exec(() => bridge.context());
    publish(ctx);
    // The adjustment clip moved or changed length: re-fit its effects.
    const r = ctx.range;
    if (r && r.stale && r.fx) latest(`fx:${r.id}`, () => bridge.applyFx({ rangeId: r.id, settings: r.fx }));
  } catch (e) {
    publish({ status: 'error', message: e.message || String(e) });
  }
  setTimeout(poll, POLL_MS);
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, arg) => {
    try {
      return { ok: true, result: await fn(arg) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
}

// "floating" keeps the window above other apps' windows (Resolve), not only
// above this plugin's own.
function setPinned(on) {
  if (win) win.setAlwaysOnTop(on, 'floating');
}

handle('rampme:getContext', () => bridge.exec(() => bridge.context()));
handle('rampme:setPinned', (on) => setPinned(Boolean(on)));
handle('rampme:getPrefs', () => store.load());
handle('rampme:setPrefs', (prefs) => store.save(prefs));
// Queues are per clip, so a newer edit only replaces an older one for the same clip.
ipcMain.handle('rampme:applyRamp', (_e, p) => latest(`ramp:${p.mediaId}`, () => bridge.applyRamp(p)));
ipcMain.handle('rampme:clearRamp', (_e, p) => latest(`ramp:${p.mediaId}`, () => bridge.clearRamp(p)));
ipcMain.handle('rampme:applyFx', (_e, p) => latest(`fx:${p.rangeId}`, () => bridge.applyFx(p)));
ipcMain.handle('rampme:clearFx', (_e, p) => latest(`fx:${p.rangeId}`, () => bridge.clearFx(p)));

function createWindow() {
  win = new BrowserWindow({
    width: 1060,
    height: 780,
    minWidth: 920,
    minHeight: 660,
    title: 'Ramp Me',
    icon: ICON,
    backgroundColor: '#101113',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  setPinned(store.load().pinned);
  win.on('closed', () => {
    win = null;
  });
}

// Developer hook, only when a ".dev" file sits next to this script: runs JS
// dropped into .devcmd/cmd.js and reloads the window when ui/ changes.
function startDevHooks() {
  const dir = path.join(__dirname, '.devcmd');
  fs.mkdirSync(dir, { recursive: true });
  // Only the owner may drop scripts here: they run inside the plugin.
  fs.chmodSync(dir, 0o700);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let busy = false;
  setInterval(async () => {
    const cmd = path.join(dir, 'cmd.js');
    if (busy || !fs.existsSync(cmd)) return;
    busy = true;
    const code = fs.readFileSync(cmd, 'utf8');
    fs.unlinkSync(cmd);
    let out;
    try {
      out = { ok: true, res: await new AsyncFunction('ctx', code)({ bridge, win, app, fs, path, require }) };
    } catch (e) {
      out = { ok: false, err: String((e && e.stack) || e) };
    }
    fs.writeFileSync(path.join(dir, 'out.json.tmp'), JSON.stringify(out, null, 1));
    fs.renameSync(path.join(dir, 'out.json.tmp'), path.join(dir, 'out.json'));
    busy = false;
  }, 200);
  let timer = null;
  fs.watch(path.join(__dirname, 'ui'), () => {
    clearTimeout(timer);
    timer = setTimeout(() => win && win.webContents.reloadIgnoringCache(), 150);
  });
}

app.whenReady().then(async () => {
  // Resolve runs plugins in a shared Electron app, so the Dock would show
  // Electron's icon. The window icon above only matters on Windows.
  if (app.dock) app.dock.setIcon(ICON);
  try {
    await bridge.connect();
    WI.RegisterCallback('ResolveQuit', () => app.quit());
  } catch (e) {
    // The window shows the error from the first poll.
  }
  createWindow();
  if (fs.existsSync(path.join(__dirname, '.dev'))) startDevHooks();
  poll();
});

app.on('window-all-closed', () => {
  bridge.cleanup();
  app.quit();
});
