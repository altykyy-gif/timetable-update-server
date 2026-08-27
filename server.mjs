import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'published');
const HTML_PATH = path.join(DATA_DIR, 'index.html');
const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.json');
const MESSAGES_PATH = path.join(DATA_DIR, 'contact-messages.json');
const PORT = Number(process.env.PORT || 8787);
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: /render\.com|amazonaws\.com|neon\.tech|supabase\.co/i.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined, max: 5 }) : null;
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
  await ensureDatabase();
  const sourceHtml = path.join(__dirname, 'index.html');
  if (!existsSync(HTML_PATH)) await fs.copyFile(sourceHtml, HTML_PATH);
  if (!existsSync(MANIFEST_PATH)) {
    await writeManifest('1.4.3', 'إضافة خط سلطان ميديا وتصفية تقارير المعلمين حسب الصف وخيار جميع الصفوف.', 'تحديث آمن للتقارير دون تغيير خوارزمية توليد الجداول أو بيانات المستخدم.');
  }
  if (!existsSync(MESSAGES_PATH)) await fs.writeFile(MESSAGES_PATH, '[]', 'utf8');
  if (!existsSync(MANIFEST_PATH)) return;
  try {
    const currentManifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'));
    const source = await fs.readFile(sourceHtml, 'utf8');
    if (validVersion(currentManifest.version) && compareVersions(currentManifest.version, '1.4.3') < 0 && source.includes('id="printGradeFilter"') && source.includes('Sultan Medium')) {
      await fs.copyFile(sourceHtml, HTML_PATH);
      await writeManifest('1.4.3', 'إضافة خط سلطان ميديا وتصفية تقارير المعلمين حسب الصف وخيار جميع الصفوف.', 'تحديث آمن للتقارير دون تغيير خوارزمية توليد الجداول أو بيانات المستخدم.');
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

function dbMessageFromRow(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    type: row.type,
    subject: row.subject,
    message: row.message,
    name: row.name || '',
    replyEmail: row.reply_email || '',
    rating: row.rating == null ? null : String(row.rating),
    status: row.status || 'new',
    ownerReply: row.owner_reply || '',
    replyAt: row.reply_at ? new Date(row.reply_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

function messageParams(item) {
  return [item.id, item.clientId || '', item.type || '', item.subject || '', item.message || '', item.name || '', item.replyEmail || '', item.rating ? Number(item.rating) : null, item.status || 'new', item.ownerReply || '', item.replyAt || null, item.createdAt || new Date().toISOString(), item.updatedAt || null];
}

async function readJsonMessages() {
  try {
    const value = JSON.parse(await fs.readFile(MESSAGES_PATH, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function readMessages() {
  if (pool) {
    const result = await pool.query('SELECT id, client_id, type, subject, message, name, reply_email, rating, status, owner_reply, reply_at, created_at, updated_at FROM contact_messages ORDER BY created_at DESC LIMIT 1000');
    return result.rows.map(dbMessageFromRow);
  }
  return readJsonMessages();
}

async function writeMessages(messages) {
  if (pool) {
    for (const item of messages.slice(-1000)) {
      await pool.query(`INSERT INTO contact_messages (id, client_id, type, subject, message, name, reply_email, rating, status, owner_reply, reply_at, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (id) DO UPDATE SET client_id=EXCLUDED.client_id, type=EXCLUDED.type, subject=EXCLUDED.subject, message=EXCLUDED.message, name=EXCLUDED.name, reply_email=EXCLUDED.reply_email, rating=EXCLUDED.rating, status=EXCLUDED.status, owner_reply=EXCLUDED.owner_reply, reply_at=EXCLUDED.reply_at, created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at`, messageParams(item));
    }
    return;
  }
  const tempPath = `${MESSAGES_PATH}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(messages, null, 2), 'utf8');
  await fs.rename(tempPath, MESSAGES_PATH);
}

async function ensureDatabase() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS contact_messages (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    type TEXT NOT NULL,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    reply_email TEXT NOT NULL DEFAULT '',
    rating INTEGER NULL,
    status TEXT NOT NULL DEFAULT 'new',
    owner_reply TEXT NOT NULL DEFAULT '',
    reply_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NULL
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS contact_messages_client_idx ON contact_messages (client_id, created_at DESC)');
  const count = await pool.query('SELECT COUNT(*)::int AS count FROM contact_messages');
  if (count.rows[0].count === 0) {
    const legacy = await readJsonMessages();
    if (legacy.length) await writeMessages(legacy.map(item => ({ ...item, clientId: item.clientId || 'legacy-' + item.id })));
  }
}

function cleanMessageValue(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, maxLength);
}

function validContactStatus(value) { return ['new', 'read', 'replied', 'closed'].includes(String(value || '')); }
function validClientId(value) { return /^[A-Za-z0-9._-]{8,100}$/.test(String(value || '')); }

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
      const clientId = cleanMessageValue(body.clientId, 100);
      if (!type || !subject || !message) return send(res, 400, { error: 'نوع الرسالة والعنوان والنص حقول مطلوبة.' });
      if (!validClientId(clientId)) return send(res, 400, { error: 'معرّف المستخدم غير صالح. أعد فتح التبويب وحاول مرة أخرى.' });
      if (replyEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyEmail)) return send(res, 400, { error: 'بريد الرد غير صالح.' });
      if (rating && !/^[1-5]$/.test(rating)) return send(res, 400, { error: 'التقييم يجب أن يكون من 1 إلى 5.' });
      const messages = await readMessages();
      const item = { id: crypto.randomUUID(), clientId, type, subject, message, name, replyEmail, rating: rating || null, status: 'new', ownerReply: '', replyAt: null, createdAt: new Date().toISOString(), updatedAt: null };
      messages.push(item);
      await writeMessages(messages.slice(-1000));
      return send(res, 201, { ok: true, id: item.id, clientId, message: 'تم استلام الرسالة.' });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/contact/thread')) {
      const clientId = cleanMessageValue(new URL(req.url, 'http://localhost').searchParams.get('clientId'), 100);
      if (!validClientId(clientId)) return send(res, 400, { error: 'معرّف المستخدم غير صالح.' });
      const messages = await readMessages();
      return send(res, 200, { ok: true, messages: messages.filter(item => item.clientId === clientId).slice(-50).reverse() });
    }
    if (req.method === 'GET' && req.url === '/api/contact/messages') {
      if (!requireOwner(req, res)) return;
      const messages = await readMessages();
      return send(res, 200, { ok: true, messages: messages.slice().reverse() });
    }
    if (req.method === 'POST' && req.url === '/api/contact/messages/reply') {
      if (!requireOwner(req, res)) return;
      const body = await readBody(req);
      const id = cleanMessageValue(body.id, 100);
      const reply = cleanMessageValue(body.reply, 5000);
      if (!id || !reply) return send(res, 400, { error: 'اكتب الرد وحدد الرسالة.' });
      const messages = await readMessages();
      const item = messages.find(entry => entry.id === id);
      if (!item) return send(res, 404, { error: 'الرسالة غير موجودة.' });
      item.ownerReply = reply;
      item.replyAt = new Date().toISOString();
      item.updatedAt = item.replyAt;
      if (item.status !== 'closed') item.status = 'replied';
      await writeMessages(messages);
      return send(res, 200, { ok: true, message: item });
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
