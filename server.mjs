import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'published');
const HTML_PATH = path.join(DATA_DIR, 'index.html');
const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.json');
const MESSAGES_PATH = path.join(DATA_DIR, 'contact-messages.json');
const PORT = Number(process.env.PORT || 8787);
let OWNER_PASSWORD = process.env.OWNER_PASSWORD || '';
let USER_PASSWORD = process.env.USER_PASSWORD || '';
const MAX_BODY = 12 * 1024 * 1024;
const SESSION_TTL = 8 * 60 * 60 * 1000;
const sessions = new Map();
const activeClients = new Map();
const HEARTBEAT_TTL = 90 * 1000;
const serverStartedAt = Date.now();

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function ensureData() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const sourceHtml = path.join(__dirname, 'index.html');
  if (!existsSync(HTML_PATH)) await fs.copyFile(sourceHtml, HTML_PATH);
  if (!existsSync(MANIFEST_PATH)) {
    await writeManifest('1.2.0', 'إشعارات التحديث ومراقبة الخادم ومعاينة الطباعة وإصلاح عزل الملاحظات', 'الإصدار الذي يحتوي على الميزات الجديدة والإصلاحات المطلوبة');
  }
  if (!existsSync(MESSAGES_PATH)) await fs.writeFile(MESSAGES_PATH, '[]', 'utf8');
  if (!existsSync(MANIFEST_PATH)) return;
  try {
    const currentManifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'));
    const currentHtml = await fs.readFile(HTML_PATH, 'utf8');
    const source = await fs.readFile(sourceHtml, 'utf8');
    if (currentManifest.version !== '1.3.0' && source.includes('id="contact"')) {
      await fs.copyFile(sourceHtml, HTML_PATH);
      await writeManifest('1.3.0', 'صندوق رسائل المالك وإصلاح تفاعل خانات التواصل', 'إضافة التواصل الداخلي مع المالك وإصلاح عمل خانات الإدخال قبل التحديث.');
    }
  } catch (error) {
    console.error('Could not migrate the initial manifest:', error.message);
  }
}

async function sha256File(filePath) {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

async function writeManifest(version, notes, message = '') {
  const manifest = { version, htmlUrl: '/published/index.html', notes: notes || '', message, publishedAt: new Date().toISOString(), sha256: await sha256File(HTML_PATH) };
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

async function readMessages() {
  try {
    const value = JSON.parse(await fs.readFile(MESSAGES_PATH, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function writeMessages(messages) {
  const tempPath = `${MESSAGES_PATH}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(messages, null, 2), 'utf8');
  await fs.rename(tempPath, MESSAGES_PATH);
}

function cleanMessageValue(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, maxLength);
}

function validContactStatus(value) { return ['new', 'read', 'closed'].includes(String(value || '')); }

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('حجم النسخة أكبر من الحد المسموح.')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('بيانات الطلب ليست JSON صالحة.')); }
    });
    req.on('error', reject);
  });
}

function validVersion(version) { return /^\d+\.\d+\.\d+$/.test(String(version || '')); }
function digest(value) { return crypto.createHash('sha256').update(String(value || '')).digest(); }
function safeEqual(a, b) { const da = digest(a); const db = digest(b); return crypto.timingSafeEqual(da, db); }
function passwordIsAcceptable(value) { return typeof value === 'string' && value.length >= 8 && value.length <= 256; }
function invalidateRoleSessions(role = null) {
  for (const [token, session] of sessions.entries()) {
    if (!role || session.role === role) sessions.delete(token);
  }
}
function cleanupActiveClients() {
  const cutoff = Date.now() - HEARTBEAT_TTL;
  for (const [token, client] of activeClients.entries()) {
    if (client.lastSeenAt < cutoff || !sessions.has(token)) activeClients.delete(token);
  }
}
function activeClientSummary() {
  cleanupActiveClients();
  return [...activeClients.values()].map(client => ({ role: client.role, lastSeenAt: new Date(client.lastSeenAt).toISOString() }));
}
function issueToken(role) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { role, expiresAt: Date.now() + SESSION_TTL });
  return token;
}
function sessionFrom(req) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) { if (token) sessions.delete(token); return null; }
  return { token, ...session };
}
function requireOwner(req, res) {
  const session = sessionFrom(req);
  if (!session || session.role !== 'owner') { send(res, 401, { error: 'تسجيل دخول المالك مطلوب.' }); return null; }
  return session;
}

await ensureData();
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); return res.end(); }
    if (req.method === 'POST' && req.url === '/api/login') {
      const body = await readBody(req);
      const role = body.role === 'owner' ? 'owner' : body.role === 'user' ? 'user' : '';
      const password = String(body.password || '');
      if (!role || !password) return send(res, 400, { error: 'اختر نوع الحساب وأدخل كلمة المرور.' });
      const expected = role === 'owner' ? OWNER_PASSWORD : USER_PASSWORD;
      if (!expected) return send(res, 503, { error: `لم يتم إعداد كلمة مرور حساب ${role === 'owner' ? 'المالك' : 'المستخدم'} في الخادم.` });
      if (!safeEqual(password, expected)) return send(res, 401, { error: 'بيانات تسجيل الدخول غير صحيحة.' });
      return send(res, 200, { ok: true, role, token: issueToken(role), expiresIn: SESSION_TTL / 1000 });
    }
    if (req.method === 'POST' && req.url === '/api/heartbeat') {
      const session = sessionFrom(req);
      if (!session) return send(res, 401, { error: 'جلسة تسجيل الدخول غير صالحة.' });
      activeClients.set(session.token, { role: session.role, lastSeenAt: Date.now() });
      return send(res, 200, { ok: true, serverTime: new Date().toISOString(), activeConnections: activeClients.size });
    }
    if (req.method === 'GET' && req.url === '/api/status') {
      const session = sessionFrom(req);
      if (!session || session.role !== 'owner') return send(res, 401, { error: 'تسجيل دخول المالك مطلوب.' });
      const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'));
      const clients = activeClientSummary();
      return send(res, 200, {
        ok: true,
        status: 'online',
        serverTime: new Date().toISOString(),
        uptimeSeconds: Math.floor((Date.now() - serverStartedAt) / 1000),
        activeConnections: clients.length,
        activeClients: clients,
        latestVersion: manifest.version,
        publishedAt: manifest.publishedAt || ''
      });
    }
    if (req.method === 'POST' && req.url === '/api/contact') {
      const body = await readBody(req);
      const type = cleanMessageValue(body.type, 40);
      const subject = cleanMessageValue(body.subject, 160);
      const message = cleanMessageValue(body.message, 5000);
      const name = cleanMessageValue(body.name, 100);
      const replyEmail = cleanMessageValue(body.replyEmail, 160);
      const rating = cleanMessageValue(body.rating, 1);
      if (!type || !subject || !message) return send(res, 400, { error: 'نوع الرسالة والعنوان والنص حقول مطلوبة.' });
      if (replyEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyEmail)) return send(res, 400, { error: 'بريد الرد غير صالح.' });
      if (rating && !/^[1-5]$/.test(rating)) return send(res, 400, { error: 'التقييم يجب أن يكون من 1 إلى 5.' });
      const messages = await readMessages();
      const item = { id: crypto.randomUUID(), type, subject, message, name, replyEmail, rating: rating || null, status: 'new', createdAt: new Date().toISOString() };
      messages.push(item);
      await writeMessages(messages.slice(-1000));
      return send(res, 201, { ok: true, id: item.id, message: 'تم استلام الرسالة.' });
    }
    if (req.method === 'GET' && req.url === '/api/contact/messages') {
      if (!requireOwner(req, res)) return;
      const messages = await readMessages();
      return send(res, 200, { ok: true, messages: messages.slice().reverse() });
    }
    if (req.method === 'POST' && req.url === '/api/contact/messages/status') {
      if (!requireOwner(req, res)) return;
      const body = await readBody(req);
      const id = cleanMessageValue(body.id, 100);
      const status = cleanMessageValue(body.status, 20);
      if (!id || !validContactStatus(status)) return send(res, 400, { error: 'بيانات حالة الرسالة غير صالحة.' });
      const messages = await readMessages();
      const item = messages.find(entry => entry.id === id);
      if (!item) return send(res, 404, { error: 'الرسالة غير موجودة.' });
      item.status = status;
      item.updatedAt = new Date().toISOString();
      await writeMessages(messages);
      return send(res, 200, { ok: true, message: item });
    }
    if (req.method === 'GET' && req.url === '/manifest.json') return send(res, 200, await fs.readFile(MANIFEST_PATH, 'utf8'));
    if (req.method === 'POST' && req.url === '/api/password/change') {
      const session = sessionFrom(req);
      if (!session || session.role !== 'owner') return send(res, 401, { error: 'تسجيل دخول المالك مطلوب.' });
      const body = await readBody(req);
      const targetRole = body.targetRole === 'owner' ? 'owner' : body.targetRole === 'user' ? 'user' : '';
      const currentPassword = String(body.currentPassword || '');
      const newPassword = String(body.newPassword || '');
      const confirmPassword = String(body.confirmPassword || '');
      if (!targetRole || !currentPassword || !newPassword || !confirmPassword) return send(res, 400, { error: 'أكمل جميع حقول تغيير كلمة المرور.' });
      if (!safeEqual(currentPassword, OWNER_PASSWORD)) return send(res, 401, { error: 'كلمة مرور المالك الحالية غير صحيحة.' });
      if (!passwordIsAcceptable(newPassword)) return send(res, 400, { error: 'يجب أن تكون كلمة المرور الجديدة بين 8 و256 حرفًا.' });
      if (newPassword !== confirmPassword) return send(res, 400, { error: 'تأكيد كلمة المرور الجديدة غير مطابق.' });
      if (targetRole === 'owner') {
        OWNER_PASSWORD = newPassword;
        invalidateRoleSessions();
        return send(res, 200, { ok: true, targetRole, ownerPasswordChanged: true, message: 'تم تغيير كلمة مرور المالك. سجّل الدخول من جديد.' });
      }
      USER_PASSWORD = newPassword;
      invalidateRoleSessions('user');
      return send(res, 200, { ok: true, targetRole, ownerPasswordChanged: false, message: 'تم تغيير كلمة مرور المستخدم بنجاح.' });
    }
    if (req.method === 'GET' && req.url === '/published/index.html') return send(res, 200, await fs.readFile(HTML_PATH, 'utf8'), 'text/html; charset=utf-8');
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
    if (req.method === 'POST' && req.url === '/api/publish') {
      requireOwner(req, res) || (() => { throw new Error('__AUTH_RETURN__'); })();
      const body = await readBody(req);
      if (!validVersion(body.version)) return send(res, 400, { error: 'رقم الإصدار يجب أن يكون بصيغة 1.0.1.' });
      if (typeof body.html !== 'string' || !body.html.includes('<html') || !body.html.includes('</html>')) return send(res, 400, { error: 'الكود المرسل ليس HTML صالحًا.' });
      await fs.writeFile(HTML_PATH, body.html, 'utf8');
      const manifest = await writeManifest(body.version, body.notes, `تم نشر الإصدار ${body.version}`);
      return send(res, 200, { ok: true, version: manifest.version, message: `تم نشر الإصدار ${manifest.version} بنجاح.` });
    }
    return send(res, 404, { error: 'المسار غير موجود.' });
  } catch (error) {
    if (error.message === '__AUTH_RETURN__') return;
    console.error(error);
    return send(res, 500, { error: error.message || 'خطأ داخلي في الخادم.' });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Update server listening on port ${PORT}`));
