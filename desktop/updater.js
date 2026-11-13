// ── Self-update from GitHub Releases ─────────────────────────────────────────
// electron-updater reads latest*.yml from the newest GitHub release (written by
// electron-builder, uploaded by .github/workflows/release.yml) and compares it
// with the running version.
//
// The GUI never talks to this module directly: preload.cjs exposes a small API
// (window.jobAlertDesktop.update) and main.js forwards it here. State changes
// are pushed to every window so the dashboard banner and the settings card stay
// in sync.
//
// Installing in place works for the Windows installer (NSIS), the AppImage and
// the .deb. macOS (Squirrel.Mac) refuses updates for apps that aren't signed
// with an Apple Developer ID, so on macOS "Aktualisieren" opens the release
// page and the user drags the new version into Programme. Once the build is
// signed and notarized, set NATIVE_INSTALL to true for darwin too.

import { app, shell } from 'electron';
import updaterPkg from 'electron-updater';

const { autoUpdater } = updaterPkg;

export const RELEASES_URL = 'https://github.com/JulianFriedle/Job-Alert-Bot/releases/latest';
const NATIVE_INSTALL = process.platform !== 'darwin';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

// status: idle | checking | available | not-available | downloading | downloaded | error
// Inactive outside a real installation: in `npm run desktop`, and on Linux when
// started from an unpacked folder instead of the AppImage/.deb.
let state = {
  supported: app.isPackaged && autoUpdater.isUpdaterActive(),
  nativeInstall: NATIVE_INSTALL,
  currentVersion: app.getVersion(),
  status: 'idle',
  version: null,
  releaseDate: null,
  percent: null,
  error: null,
  checkedAt: null,
};

const listeners = new Set();

function setState(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) {
    try { fn(state); } catch { /* window gone */ }
  }
}

export function getUpdateState() { return state; }
export function onUpdateState(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// Never download behind the user's back: "Aktualisieren" starts the download,
// and installing means restarting the app, which must wait for a running job
// search (main.js handles that before calling installUpdate()).
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.logger = {
  info: (m) => console.log(`[updater] ${m}`),
  warn: (m) => console.warn(`[updater] ${m}`),
  error: (m) => console.error(`[updater] ${m}`),
  debug: () => {},
};

autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: null }));
autoUpdater.on('update-available', (info) => setState({
  status: 'available', version: info.version, releaseDate: info.releaseDate || null,
  checkedAt: new Date().toISOString(),
}));
autoUpdater.on('update-not-available', () => setState({
  status: 'not-available', version: null, checkedAt: new Date().toISOString(),
}));
autoUpdater.on('download-progress', (p) => setState({ status: 'downloading', percent: Math.round(p.percent) }));
autoUpdater.on('update-downloaded', (info) => setState({ status: 'downloaded', version: info.version, percent: 100 }));
autoUpdater.on('error', (err) => setState({
  status: 'error', error: String(err?.message || err).split('\n')[0], percent: null,
}));

export async function checkForUpdates() {
  if (!state.supported) return state;
  // Don't reset a finished or running download just because the timer fired.
  if (['downloading', 'downloaded'].includes(state.status)) return state;
  try { await autoUpdater.checkForUpdates(); }
  catch { /* reported through the 'error' event */ }
  return state;
}

export function startUpdateChecks() {
  if (!state.supported) return;
  setTimeout(checkForUpdates, 15_000);
  setInterval(checkForUpdates, CHECK_EVERY_MS).unref?.();
}

// Download the new version (if not done yet). Resolves true once it is ready
// to install, false when the user has to install by hand (macOS) or on error.
export async function downloadUpdate() {
  if (!state.supported) return false;
  if (!NATIVE_INSTALL) {
    await shell.openExternal(RELEASES_URL);
    return false;
  }
  if (state.status === 'downloaded') return true;
  // A failed download keeps the version it was after, so it can be retried
  // directly; anything else needs a fresh check first.
  const retry = state.status === 'error' && state.version;
  if (state.status !== 'available' && !retry) {
    await checkForUpdates();
    if (state.status !== 'available') return false;
  }
  try {
    setState({ status: 'downloading', percent: 0, error: null });
    await autoUpdater.downloadUpdate();
    return state.status === 'downloaded';
  } catch {
    return false;   // 'error' event already set the state
  }
}

// Quit and run the installer. Call only after the app has shut its own
// processes down — the Windows installer starts right away.
export function installUpdate() {
  // isSilent: no installer wizard on Windows (per-user install, nothing to
  // ask); isForceRunAfter: start the new version when it's done.
  autoUpdater.quitAndInstall(true, true);
}
