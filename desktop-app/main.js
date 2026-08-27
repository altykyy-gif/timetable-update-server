const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');

const APP_DIR = path.join(__dirname, 'app');
const USER_APP_DIR = path.join(app.getPath('userData'), 'published');
const CURRENT_HTML = path.join(USER_APP_DIR, 'index.html');
const BUNDLED_HTML = path.join(APP_DIR, 'index.html');
const INSTALLED_VERSION_PATH = path.join(USER_APP_DIR, 'version.txt');
const CONFIG_PATH = path.join(__dirname, 'update-config.json');

let mainWindow;
let authSession = { role: null, token: null, expiresAt: 0 };
let exeUpdateState = { configured: false, available: false, downloaded: false, version: '', notes: '' };

async function ensureCurrentHtml() {
  await fs.mkdir(USER_APP_DIR, { recursive: true });
  const hasCurrentHtml = existsSync(CURRENT_HTML);
  const hasInstalledVersion = existsSync(INSTALLED_VERSION_PATH);
  let installedVersion = '';
  if (hasInstalledVersion) {
    try { installedVersion = (await fs.readFile(INSTALLED_VERSION_PATH, 'utf8')).trim(); } catch {}
  }
  const packagedVersion = app.getVersion();
  const shouldSyncBundledHtml = !hasCurrentHtml || !hasInstalledVersion || !installedVersion || compareVersions(packagedVersion, installedVersion) > 0;
  if (shouldSyncBundledHtml) await fs.copyFile(BUNDLED_HTML, CURRENT_HTML);
  if (!hasInstalledVersion || !installedVersion || compareVersions(packagedVersion, installedVersion) > 0) {
    await fs.writeFile(INSTALLED_VERSION_PATH, packagedVersion, 'utf8');
  }
}

async function getInstalledVersion() {
  try { return (await fs.readFile(INSTALLED_VERSION_PATH, 'utf8')).trim() || app.getVersion(); }
  catch { return app.getVersion(); }
}

async function readConfig() {
  try { return JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8')); }
  catch { return { manifestUrl: '' }; }
}

function compareVersions(a, b) {
  const pa = String(a || '0.0.0').split('.').map(Number);
  const pb = String(b || '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const av = Number.isFinite(pa[i]) ? pa[i] : 0;
    const bv = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { cache: 'no-store', ...options, signal: controller.signal, headers: { Accept: 'application/json', ...(options.headers || {}) } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('تعذر الاتصال بالخادم خلال 20 ثانية. تحقق من اتصال الإنترنت وحاول مرة أخرى.');
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function requireOwnerSession() {
  if (authSession.role !== 'owner' || !authSession.token || authSession.expiresAt <= Date.now()) {
    throw new Error('يجب تسجيل الدخول بصلاحية المالك أولًا.');
  }
}

async function login(payload) {
  const config = await readConfig();
  if (!config.manifestUrl) throw new Error('رابط خادم التحديث غير مضبوط.');
  const authUrl = config.authUrl || new URL('/api/login', config.manifestUrl).href;
  const result = await fetchJson(authUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  authSession = { role: result.role, token: result.token, expiresAt: Date.now() + (Number(result.expiresIn || 0) * 1000) };
  return { role: result.role, expiresIn: result.expiresIn };
}

async function submitContactMessage(payload) {
  const config = await readConfig();
  if (!config.manifestUrl) throw new Error('رابط خادم التحديث غير مضبوط.');
  const contactUrl = config.contactUrl || new URL('/api/contact', config.manifestUrl).href;
  return fetchJson(contactUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) });
}

async function getContactMessages() {
  requireOwnerSession();
  const config = await readConfig();
  if (!config.manifestUrl) throw new Error('رابط خادم التحديث غير مضبوط.');
  const messagesUrl = config.contactMessagesUrl || new URL('/api/contact/messages', config.manifestUrl).href;
  return fetchJson(messagesUrl, { cache: 'no-store', headers: { Authorization: `Bearer ${authSession.token}` } });
}

async function getContactThread(clientId) {
  const config = await readConfig();
  if (!config.manifestUrl) throw new Error('رابط خادم التحديث غير مضبوط.');
  const url = config.contactThreadUrl || new URL('/api/contact/thread', config.manifestUrl).href;
  return fetchJson(`${url}?clientId=${encodeURIComponent(String(clientId || ''))}`, { cache: 'no-store' });
}

async function replyToContactMessage(payload) {
  requireOwnerSession();
  const config = await readConfig();
  if (!config.manifestUrl) throw new Error('رابط خادم التحديث غير مضبوط.');
  const url = config.contactReplyUrl || new URL('/api/contact/messages/reply', config.manifestUrl).href;
  return fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authSession.token}` }, body: JSON.stringify(payload || {}) });
}

async function updateContactMessage(payload) {
  requireOwnerSession();
  const config = await readConfig();
  if (!config.manifestUrl) throw new Error('رابط خادم التحديث غير مضبوط.');
  const statusUrl = config.contactStatusUrl || new URL('/api/contact/messages/status', config.manifestUrl).href;
  return fetchJson(statusUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authSession.token}` }, body: JSON.stringify(payload || {}) });
}

async function changePassword(payload) {
  requireOwnerSession();
  const config = await readConfig();
  if (!config.manifestUrl) throw new Error('رابط خادم التحديث غير مضبوط.');
  const passwordUrl = config.passwordChangeUrl || new URL('/api/password/change', config.manifestUrl).href;
  const response = await fetch(passwordUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${authSession.token}` },
    body: JSON.stringify(payload || {})
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  if (result.ownerPasswordChanged) authSession = { role: null, token: null, expiresAt: 0 };
  return result;
}

function logout() {
  authSession = { role: null, token: null, expiresAt: 0 };
  return true;
}

function getRole() {
  return authSession.expiresAt > Date.now() ? authSession.role : null;
}

async function sendHeartbeat() {
  if (!getRole() || !authSession.token) return { authenticated: false };
  const config = await readConfig();
  if (!config.manifestUrl) return { authenticated: false, configured: false };
  const heartbeatUrl = config.heartbeatUrl || new URL('/api/heartbeat', config.manifestUrl).href;
  const response = await fetch(heartbeatUrl, { method: 'POST', headers: { Accept: 'application/json', Authorization: `Bearer ${authSession.token}` } });
  if (response.status === 401) { authSession = { role: null, token: null, expiresAt: 0 }; return { authenticated: false }; }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function getServerStatus() {
  requireOwnerSession();
  const config = await readConfig();
  if (!config.manifestUrl) throw new Error('رابط خادم التحديث غير مضبوط.');
  const statusUrl = config.statusUrl || new URL('/api/status', config.manifestUrl).href;
  const response = await fetch(statusUrl, { cache: 'no-store', headers: { Accept: 'application/json', Authorization: `Bearer ${authSession.token}` } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

async function checkForUpdate() {
  const config = await readConfig();
  if (!config.manifestUrl) return { configured: false, currentVersion: await getInstalledVersion(), message: 'لم يتم ضبط رابط خادم التحديث بعد.' };
  const manifest = await fetchJson(config.manifestUrl);
  const currentVersion = await getInstalledVersion();
  return { configured: true, currentVersion, latestVersion: manifest.version, hasUpdate: compareVersions(manifest.version, currentVersion) > 0, notes: manifest.notes || '', publishedAt: manifest.publishedAt || '', manifestUrl: config.manifestUrl };
}

async function readCurrentSource() {
  requireOwnerSession();
  return fs.readFile(CURRENT_HTML, 'utf8');
}

async function publishSource(payload) {
  requireOwnerSession();
  const config = await readConfig();
  if (!config.manifestUrl) throw new Error('رابط خادم التحديث غير مضبوط.');
  const publishUrl = config.publishUrl || new URL('/api/publish', config.manifestUrl).href;
  const response = await fetch(publishUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${authSession.token}` },
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

async function checkExeUpdate() {
  const config = await readConfig();
  if (!app.isPackaged || !config.exeUpdateUrl) return { configured: false, available: false, message: 'تحديث EXE متاح بعد تثبيت نسخة NSIS المنشورة.' };
  try {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.setFeedURL({ provider: 'generic', url: config.exeUpdateUrl });
    const updateCheck = autoUpdater.checkForUpdates();
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('انتهت مهلة فحص تحديث EXE.')), 15000));
    const result = await Promise.race([updateCheck, timeout]);
    const info = result?.updateInfo || {};
    const available = Boolean(info.version && info.version !== app.getVersion() && compareVersions(info.version, app.getVersion()) > 0);
    exeUpdateState = { configured: true, available, downloaded: false, version: info.version || '', notes: info.releaseNotes || '' };
    return { ...exeUpdateState, currentVersion: app.getVersion() };
  } catch (error) {
    return { configured: true, available: false, error: error.message || String(error), currentVersion: app.getVersion() };
  }
}

async function downloadExeUpdate() {
  if (!exeUpdateState.configured || !exeUpdateState.available) await checkExeUpdate();
  if (!exeUpdateState.available) return { downloaded: false, available: false, version: exeUpdateState.version };
  await autoUpdater.downloadUpdate();
  exeUpdateState.downloaded = true;
  return { downloaded: true, version: exeUpdateState.version };
}

function installExeUpdate() {
  if (!exeUpdateState.downloaded) throw new Error('يجب تنزيل تحديث EXE أولًا.');
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { installing: true, version: exeUpdateState.version };
}

async function applyUpdate() {
  const config = await readConfig();
  if (!config.manifestUrl) throw new Error('رابط خادم التحديث غير مضبوط.');
  const manifest = await fetchJson(config.manifestUrl);
  const installedVersion = await getInstalledVersion();
  if (compareVersions(manifest.version, installedVersion) <= 0) return { updated: false, latestVersion: manifest.version };
  const htmlUrl = new URL(manifest.htmlUrl || 'index.html', config.manifestUrl).href;
  const response = await fetch(htmlUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`تعذر تنزيل النسخة الجديدة: HTTP ${response.status}`);
  const html = await response.text();
  if (!html.includes('<html') || !html.includes('</html>')) throw new Error('الملف المنشور ليس صفحة HTML صالحة.');
  const tmpPath = `${CURRENT_HTML}.tmp`;
  await fs.writeFile(tmpPath, html, 'utf8');
  await fs.rename(tmpPath, CURRENT_HTML);
  await fs.writeFile(INSTALLED_VERSION_PATH, manifest.version, 'utf8');
  return { updated: true, version: manifest.version, notes: manifest.notes || '' };
}

function createWindow() {
  mainWindow = new BrowserWindow({ width: 1440, height: 920, minWidth: 1024, minHeight: 700, backgroundColor: '#f4f2ed', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  mainWindow.removeMenu();
  mainWindow.loadFile(CURRENT_HTML);
}

app.whenReady().then(async () => {
  await ensureCurrentHtml();
  ipcMain.handle('auth:login', (_event, payload) => login(payload));
  ipcMain.handle('auth:logout', () => logout());
  ipcMain.handle('auth:role', () => getRole());
  ipcMain.handle('auth:change-password', (_event, payload) => changePassword(payload));
  ipcMain.handle('contact:send', (_event, payload) => submitContactMessage(payload));
  ipcMain.handle('contact:list', () => getContactMessages());
  ipcMain.handle('contact:thread', (_event, clientId) => getContactThread(clientId));
  ipcMain.handle('contact:reply', (_event, payload) => replyToContactMessage(payload));
  ipcMain.handle('contact:update-status', (_event, payload) => updateContactMessage(payload));
  ipcMain.handle('auth:heartbeat', () => sendHeartbeat());
  ipcMain.handle('server:status', () => getServerStatus());
  ipcMain.handle('updates:check', () => checkForUpdate());
  ipcMain.handle('updates:apply', () => applyUpdate());
  ipcMain.handle('updates:exe-check', () => checkExeUpdate());
  ipcMain.handle('updates:exe-download', () => downloadExeUpdate());
  ipcMain.handle('updates:exe-install', () => installExeUpdate());
  ipcMain.handle('source:read', () => readCurrentSource());
  ipcMain.handle('source:publish', (_event, payload) => publishSource(payload));
  ipcMain.handle('app:reload-updated', async () => { await mainWindow.loadFile(CURRENT_HTML); return true; });
  ipcMain.handle('app:open-external', (_event, url) => { if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url); return false; });
  ipcMain.handle('app:show-error', (_event, message) => dialog.showErrorBox('خطأ', String(message || 'حدث خطأ غير معروف')));
  createWindow();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
