// ── Desktop app (Electron) ───────────────────────────────────────────────────
// A thin shell around the normal app — no business logic lives here:
//
//   • starts src/server.js (the GUI) and, once setup is done, index.js (the
//     hourly scheduler with Telegram bot + apply worker) as child processes on
//     Electron's bundled Node runtime (ELECTRON_RUN_AS_NODE),
//   • shows the GUI in a window and keeps running in the tray when it's closed,
//   • keeps all user data in the OS's per-user app-data folder (APP_DATA_DIR,
//     see src/paths.js) — the install directory is read-only,
//   • downloads Playwright's Chromium on first start,
//   • updates itself from GitHub Releases (updater.js).
//
// Quitting or updating never kills a job search mid-way without asking: a GUI
// run is stopped through /api/run/stop and the scheduler gets SIGTERM, both of
// which save the work done so far before exiting.

import { app, BrowserWindow, Tray, Menu, Notification, dialog, shell, ipcMain, nativeImage } from 'electron';
import { spawn, execFile } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getUpdateState, onUpdateState, checkForUpdates, startUpdateChecks,
  downloadUpdate, installUpdate,
} from './updater.js';

const DESKTOP_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(DESKTOP_DIR, '..');
// A fixed port keeps the GUI's origin — and with it localStorage (language,
// theme, active client) — stable across launches. Deliberately not 3000, which
// a git/Docker install on the same machine is likely to use.
const PREFERRED_PORT = 3456;

// The data folder is named after the product, not package.json's "name"
// (e.g. ~/Library/Application Support/Job Alert Bot, %APPDATA%\Job Alert Bot,
// ~/.config/Job Alert Bot). `npm run desktop` gets its own folder so trying
// things out never touches the installed app's data. Must run before the
// single-instance lock, which lives in that folder.
app.setName('Job Alert Bot');
app.setPath('userData', path.join(app.getPath('appData'), app.isPackaged ? 'Job Alert Bot' : 'Job Alert Bot (Dev)'));

if (!app.requestSingleInstanceLock()) {
  // A second launch just brings the running instance to the front.
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(start).catch((err) => {
    dialog.showErrorBox('Job Alert Bot', `Start fehlgeschlagen:\n${err.stack || err.message}`);
    app.exit(1);
  });
}

// ── State ────────────────────────────────────────────────────────────────────
let win = null;
let tray = null;
let origin = '';          // http://127.0.0.1:<port>
let childEnv = null;
let logStream = null;
let shuttingDown = false; // children are being / have been stopped on purpose
let readyToQuit = false;  // before-quit may let the app go
let hiddenHintShown = false;
let browserReady = false;
let setupDone = false;

const procs = { server: null, scheduler: null };
const crashes = { server: [], scheduler: [] };

// ── Logging ──────────────────────────────────────────────────────────────────
// Everything the children print goes to <data>/logs/desktop.log (pipeline runs
// additionally write their own per-run log files, as without the desktop app).
function openLog(logsDir) {
  mkdirSync(logsDir, { recursive: true });
  const file = path.join(logsDir, 'desktop.log');
  try {
    if (statSync(file).size > 5_000_000) renameSync(file, `${file}.1`);
  } catch { /* no log yet */ }
  logStream = createWriteStream(file, { flags: 'a' });
}

function log(msg) {
  const line = `[${new Date().toISOString()}] [desktop] ${msg}`;
  console.log(line);
  logStream?.write(line + '\n');
}

function pipeOutput(name, child) {
  const write = (buf) => {
    const text = buf.toString();
    process.stdout.write(text);
    logStream?.write(text.replace(/^(?=.)/gm, `[${name}] `));
  };
  child.stdout?.on('data', write);
  child.stderr?.on('data', write);
}

// ── Startup ──────────────────────────────────────────────────────────────────
async function start() {
  const dataHome = app.getPath('userData');
  mkdirSync(dataHome, { recursive: true });
  openLog(path.join(dataHome, 'logs'));
  log(`Version ${app.getVersion()} — Daten: ${dataHome}`);

  const port = await pickPort(PREFERRED_PORT);
  origin = `http://127.0.0.1:${port}`;
  childEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',   // run our scripts as plain Node, inherited by every run they spawn
    JOB_ALERT_DESKTOP: '1',
    APP_DATA_DIR: dataHome,
    GUI_PORT: String(port),
    GUI_HOST: '127.0.0.1',       // never reachable from the network
  };

  registerIpc();
  createWindow();
  createTray();

  startChild('server');
  await waitForServer();
  log(`GUI bereit → ${origin}`);
  win?.loadURL(origin);

  ensureBrowser();               // first start: download Chromium in the background
  watchSetupThenStartScheduler();
  startUpdateChecks();
}

function pickPort(preferred) {
  const tryPort = (p) => new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(null));
    srv.listen(p, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
  return tryPort(preferred).then((p) => p ?? tryPort(0));
}

async function waitForServer(timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${origin}/api/auth/status`);
      if (res.ok) return;
    } catch { /* not listening yet */ }
    await sleep(300);
  }
  throw new Error(`Der GUI-Server hat nicht innerhalb von ${timeoutMs / 1000}s geantwortet. Details in logs/desktop.log.`);
}

// ── Child processes ──────────────────────────────────────────────────────────
const SCRIPTS = {
  server: path.join(APP_ROOT, 'src', 'server.js'),
  scheduler: path.join(APP_ROOT, 'index.js'),
};

function startChild(name) {
  const child = spawn(process.execPath, [SCRIPTS[name]], {
    cwd: APP_ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  procs[name] = child;
  pipeOutput(name, child);
  log(`${name} gestartet (PID ${child.pid})`);

  child.on('exit', (code, signal) => {
    if (procs[name] === child) procs[name] = null;
    if (shuttingDown) return;
    // The GUI's "Neu starten" button makes the server exit 0 and expects us to
    // bring it back (IS_DESKTOP in server.js) — no crash.
    if (name === 'server' && code === 0) {
      log('server beendet sich zum Neustart.');
      startChild('server');
      return;
    }
    log(`${name} unerwartet beendet (${signal || `exit code ${code}`}).`);
    const now = Date.now();
    crashes[name] = crashes[name].filter((t) => now - t < 60_000).concat(now);
    if (crashes[name].length > 3) {
      dialog.showErrorBox('Job Alert Bot',
        `Der Prozess „${name}“ stürzt wiederholt ab und wird nicht mehr neu gestartet.\n` +
        `Details stehen in ${path.join(app.getPath('userData'), 'logs', 'desktop.log')}.`);
      return;
    }
    setTimeout(() => { if (!shuttingDown) startChild(name); }, 2000);
  });
}

// SIGTERM lets index.js / a run wind down and save (installAbortSignals). On
// Windows there are no signals, so take the whole process tree down instead —
// otherwise Playwright's Chromium processes would be left behind.
function stopChild(name, graceMs) {
  const child = procs[name];
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      log(`${name} reagiert nicht — wird hart beendet.`);
      killTree(child, true);
    }, graceMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    killTree(child, false);
  });
}

function killTree(child, force) {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  } else {
    try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already gone */ }
  }
}

// ── First start: Chromium for Playwright ─────────────────────────────────────
// `playwright install chromium` is a quick no-op when the browser is already in
// Playwright's per-user cache, so it simply runs on every start (and repairs a
// half-finished download).
function ensureBrowser() {
  const cli = path.join(APP_ROOT, 'node_modules', 'playwright', 'cli.js');
  log('Prüfe Browser-Komponente (Chromium) …');
  const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
    cwd: APP_ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  pipeOutput('playwright', child);
  child.on('exit', (code) => {
    if (code === 0) {
      browserReady = true;
      log('Browser-Komponente bereit.');
      maybeStartScheduler();
    } else {
      log(`Browser-Komponente konnte nicht installiert werden (exit code ${code}).`);
      dialog.showMessageBox({
        type: 'warning',
        message: 'Die Browser-Komponente (Chromium) konnte nicht heruntergeladen werden.',
        detail: 'Ohne sie können keine Jobs gesucht werden. Bitte Internetverbindung prüfen und die App neu starten.',
      });
    }
  });
}

// ── Scheduler: only once the setup wizard is done ────────────────────────────
// index.js starts a job search right away and then hourly. Before the API key
// and profile exist that run could only fail, so wait for the wizard.
async function watchSetupThenStartScheduler() {
  while (!setupDone && !shuttingDown) {
    try {
      const res = await appFetch('/api/setup/status');
      if (res.ok && (await res.json()).needed === false) {
        setupDone = true;
        maybeStartScheduler();
        return;
      }
    } catch { /* server restarting */ }
    await sleep(20_000);
  }
}

function maybeStartScheduler() {
  if (setupDone && browserReady && !procs.scheduler && !shuttingDown) startChild('scheduler');
}

// Requests from the main process carry the window's cookies, so they also work
// when someone has turned on AUTH_ENABLED.
function appFetch(urlPath, init) {
  const ses = win?.webContents.session;
  return ses ? ses.fetch(origin + urlPath, init) : fetch(origin + urlPath, init);
}

// ── Window + tray ────────────────────────────────────────────────────────────
function iconPath() {
  return path.join(DESKTOP_DIR, 'icon.png');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Job Alert Bot',
    icon: iconPath(),
    show: false,
    webPreferences: {
      preload: path.join(DESKTOP_DIR, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(DESKTOP_DIR, 'splash.html'));
  win.once('ready-to-show', () => win.show());

  // Job ads, LinkedIn etc. belong in the user's real browser; only our own
  // pages (e.g. a CV preview) open inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(origin)) return { action: 'allow' };
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin) && !url.startsWith('file:')) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  // Closing the window keeps the app (and the hourly job search) running.
  win.on('close', (e) => {
    if (readyToQuit) return;
    e.preventDefault();
    win.hide();
    if (!hiddenHintShown && tray && Notification.isSupported()) {
      hiddenHintShown = true;
      new Notification({
        title: 'Job Alert Bot läuft weiter',
        body: 'Die stündliche Jobsuche läuft im Hintergrund. Beenden über das Symbol in der Menüleiste/Taskleiste.',
        icon: iconPath(),
      }).show();
    }
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(iconPath()).resize({ width: 18, height: 18 });
    tray = new Tray(img);
  } catch (err) {
    log(`Kein Tray-Symbol verfügbar: ${err.message}`);
    tray = null;
    return;
  }
  tray.setToolTip('Job Alert Bot');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Öffnen', click: showWindow },
    { label: 'Datenordner öffnen', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: 'Beenden', click: () => app.quit() },
  ]));
  tray.on('click', showWindow);
}

app.on('activate', showWindow);           // macOS: click on the Dock icon
app.on('window-all-closed', () => { /* keep running in the tray */ });

// ── Quit / update: stop everything cleanly first ─────────────────────────────
app.on('before-quit', (e) => {
  if (readyToQuit) return;
  e.preventDefault();
  stopEverything('quit').then((ok) => { if (ok) app.quit(); });
});

let stopping = null;
function stopEverything(reason) {
  if (!stopping) stopping = doStop(reason).finally(() => { stopping = null; });
  return stopping;
}

async function doStop(reason) {
  const status = await guiRunStatus();
  if (status?.active) {
    showWindow();
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: [reason === 'update' ? 'Suche abbrechen und aktualisieren' : 'Suche abbrechen und beenden', 'Zurück'],
      defaultId: 1,
      cancelId: 1,
      message: 'Gerade läuft eine Jobsuche.',
      detail: 'Sie wird sauber abgebrochen — alles, was bis dahin gefunden und bewertet wurde, bleibt gespeichert.',
    });
    if (response !== 0) return false;
    try { await appFetch('/api/run/stop', { method: 'POST' }); } catch { /* already over */ }
    const until = Date.now() + 60_000;
    while (Date.now() < until && (await guiRunStatus())?.active) await sleep(1000);
  }

  shuttingDown = true;
  log(reason === 'update' ? 'Beende für das Update …' : 'Beende …');
  // The scheduler may be in the middle of its hourly run: give it time to save.
  await stopChild('scheduler', 60_000);
  await stopChild('server', 10_000);
  readyToQuit = true;
  logStream?.end();
  return true;
}

async function guiRunStatus() {
  try {
    const res = await appFetch('/api/run/status');
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

// ── IPC for the GUI (see preload.cjs) ────────────────────────────────────────
function registerIpc() {
  // Only our own GUI may drive the updater.
  const fromApp = (e) => !!origin && (e.senderFrame?.url || '').startsWith(origin);

  ipcMain.handle('update:get-state', (e) => (fromApp(e) ? getUpdateState() : null));
  ipcMain.handle('update:check', (e) => (fromApp(e) ? checkForUpdates() : null));
  ipcMain.handle('update:install', async (e) => {
    if (!fromApp(e)) return null;
    const ready = await downloadUpdate();       // macOS: opens the release page instead
    if (!ready) return getUpdateState();
    if (!(await stopEverything('update'))) return getUpdateState();   // user chose "Zurück"
    installUpdate();
    return getUpdateState();
  });
  ipcMain.handle('app:open-data-folder', (e) => (fromApp(e) ? shell.openPath(app.getPath('userData')) : null));

  onUpdateState((state) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('update:state', state);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
