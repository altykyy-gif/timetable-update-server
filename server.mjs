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
const PORT = Number(process.env.PORT || 8787);
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || '';
const USER_PASSWORD = process.env.USER_PASSWORD || '';
const MAX_BODY = 12 * 1024 * 1024;
const SESSION_TTL = 8 * 60 * 60 * 1000;
const sessions = new Map();

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
  if (!existsSync(HTML_PATH)) await fs.copyFile(path.join(__dirname, 'index.html'), HTML_PATH);
  if (!existsSync(MANIFEST_PATH)) await writeManifest('1.0.0', 'الإصدار الأساسي', 'نسخة البداية');
}

async function sha256File(filePath) {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

async function writeManifest(version, notes, message = '') {
  const manifest = { version, htmlUrl: '/published/index.html', notes: notes || '', message, publishedAt: new Date().toISOString(), sha256: await sha256File(HTML_PATH) };
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

function readBody(req) {
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
    if (req.method === 'GET' && req.url === '/manifest.json') return send(res, 200, await fs.readFile(MANIFEST_PATH, 'utf8'));
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
