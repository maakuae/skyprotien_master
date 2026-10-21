'use strict';
/**
 * Sky Protein Oil - website + admin backend (zero dependencies, Node 18+)
 *   node server.js
 * Site:  http://localhost:3000/        Admin: http://localhost:3000/admin
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const profilePdf = require('./lib/profile-pdf');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const UPLOADS = path.join(ROOT, 'uploads');
const DATA = path.join(ROOT, 'data');
const F_SCHEMA = path.join(DATA, 'schema.json');
const F_CONTENT = path.join(DATA, 'content.json');
const F_INQ = path.join(DATA, 'inquiries.json');
const F_AUTH = path.join(DATA, 'auth.json');
const DEFAULT_PASSWORD = 'admin123';
const ENV_PASSWORD = process.env.ADMIN_PASSWORD || DEFAULT_PASSWORD;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });

/* ---------------- storage helpers ---------------- */
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(file, obj) {            // atomic write
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
const schema = readJSON(F_SCHEMA, null);
if (!schema) { console.error('data/schema.json is missing'); process.exit(1); }
const FIELDS = new Map(schema.fields.map(f => [f.key, f]));
let overrides = readJSON(F_CONTENT, {});      // only values that differ from defaults
let inquiries = readJSON(F_INQ, []);

function currentValues() {
  const out = {};
  for (const [k, f] of FIELDS) out[k] = Object.prototype.hasOwnProperty.call(overrides, k) ? overrides[k] : f.default;
  return out;
}

/* ---------------- validation ---------------- */
function validateValue(field, v) {
  if (typeof v !== 'string') return 'must be text';
  if (field.type === 'image') {
    if (v.length > 500) return 'image path too long';
    if (!(/^\/(img|uploads)\/[A-Za-z0-9._-]+$/.test(v) || /^https?:\/\/[^\s"'<>]+$/i.test(v))) return 'image must be an uploaded file or an http(s) URL';
    return null;
  }
  const max = field.type === 'textarea' ? 3000 : 300;
  if (v.length > max) return 'too long (max ' + max + ' characters)';
  return null;
}

/* ---------------- auth ---------------- */
const sessions = new Map();                      // token -> expiry
const loginFails = new Map();                    // ip -> {n, until}
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
function usingDefaultPassword() { return !fs.existsSync(F_AUTH) && ENV_PASSWORD === DEFAULT_PASSWORD; }
function checkPassword(pw) {
  const auth = readJSON(F_AUTH, null);
  if (auth && auth.salt && auth.hash) {
    const h = crypto.scryptSync(String(pw), Buffer.from(auth.salt, 'hex'), 32);
    return crypto.timingSafeEqual(h, Buffer.from(auth.hash, 'hex'));
  }
  return crypto.timingSafeEqual(sha(pw), sha(ENV_PASSWORD));
}
function setPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 32);
  writeJSON(F_AUTH, { salt: salt.toString('hex'), hash: hash.toString('hex') });
}
function authed(req) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const exp = sessions.get(m[1]);
  if (!exp || exp < Date.now()) { sessions.delete(m[1]); return false; }
  return true;
}
function clientIp(req) { return (req.socket.remoteAddress || '') ; }
const buckets = new Map();                       // simple rate limiter
function rateLimit(key, max, windowMs) {
  const now = Date.now(); let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++; return b.n <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); for (const [k, e] of sessions) if (e < now) sessions.delete(k); }, 600000).unref();

/* ---------------- http helpers ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };
function baseHeaders(extra) {
  return Object.assign({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' }, extra || {});
}
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, baseHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) }));
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Payload too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}
function serveFile(req, res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, baseHeaders({ 'Content-Type': 'text/plain' })); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    const h = baseHeaders({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache });
    if (ext === '.svg') h['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    res.writeHead(200, h);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}
function safeJoin(root, rel) {
  const p = path.resolve(root, '.' + path.sep + rel);
  return (p === root || p.startsWith(root + path.sep)) ? p : null;
}

/* ---------------- page rendering ---------------- */
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function renderIndex() {
  let html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const vals = currentValues();
  const json = JSON.stringify(vals).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  html = html.replace(/<title>[\s\S]*?<\/title>/, () => '<title>' + escHtml(vals['seo.title']) + '</title>');
  html = html.replace(/(<meta name="description" content=")[^"]*(")/, (m, a, b) => a + escHtml(vals['seo.description']) + b);
  html = html.replace(/(<link rel="icon" href=")[^"]*(")/, (m, a, b) => a + escHtml(vals['brand.favicon']) + b);
  return html.replace('</head>', () => '<script>window.__CMS__=' + json + ';</script>\n</head>');
}

/* ---------------- uploads ---------------- */
function detectImage(buf) {
  if (buf.length > 12 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 6 && buf.slice(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}
function listUploads() {
  return fs.readdirSync(UPLOADS).filter(f => /^[A-Za-z0-9._-]+\.(png|jpg|gif|webp)$/.test(f)).map(f => {
    const st = fs.statSync(path.join(UPLOADS, f)); return { name: f, url: '/uploads/' + f, size: st.size, mtime: st.mtimeMs };
  }).sort((a, b) => b.mtime - a.mtime);
}
function isInUse(url) { return Object.values(currentValues()).some(v => v === url); }

/* ---------------- API ---------------- */
async function handleApi(req, res, pathname) {
  const method = req.method;

  if (pathname === '/api/content' && method === 'GET') return sendJSON(res, 200, currentValues());

  if (pathname === '/api/inquiry' && method === 'POST') {
    if (!rateLimit('inq:' + clientIp(req), 6, 3600000)) return sendJSON(res, 429, { error: 'Too many enquiries. Please try again later.' });
    const b = await readBody(req, 50 * 1024);
    if (b.website) return sendJSON(res, 200, { ok: true });                 // honeypot
    const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
    const e = { name: clean(b.name, 100), company: clean(b.company, 120), phone: clean(b.phone, 40), email: clean(b.email, 120), interest: clean(b.interest, 120), message: clean(b.message, 3000) };
    if (!e.name || (!e.phone && !e.email)) return sendJSON(res, 400, { error: 'Name and a phone number or email are required.' });
    if (e.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.email)) return sendJSON(res, 400, { error: 'Please enter a valid email address.' });
    e.id = crypto.randomBytes(6).toString('hex'); e.createdAt = new Date().toISOString(); e.status = 'new';
    inquiries.unshift(e); if (inquiries.length > 5000) inquiries.length = 5000;
    writeJSON(F_INQ, inquiries);
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/login' && method === 'POST') {
    const ip = clientIp(req), f = loginFails.get(ip);
    if (f && f.until > Date.now() && f.n >= 8) return sendJSON(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const b = await readBody(req, 4096);
    if (typeof b.password === 'string' && checkPassword(b.password)) {
      loginFails.delete(ip);
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + 12 * 3600 * 1000);
      return sendJSON(res, 200, { token });
    }
    const n = (f && f.until > Date.now() ? f.n : 0) + 1; loginFails.set(ip, { n, until: Date.now() + 15 * 60000 });
    return sendJSON(res, 401, { error: 'Incorrect password.' });
  }

  /* ---- everything below needs a valid session ---- */
  if (!pathname.startsWith('/api/admin/')) return sendJSON(res, 404, { error: 'Not found' });
  if (!authed(req)) return sendJSON(res, 401, { error: 'Please sign in.' });

  if (pathname === '/api/admin/logout' && method === 'POST') { sessions.delete(req.headers.authorization.slice(7)); return sendJSON(res, 200, { ok: true }); }

  if (pathname === '/api/admin/content' && method === 'GET') {
    const vals = currentValues();
    return sendJSON(res, 200, { groups: schema.groups, defaultPassword: usingDefaultPassword(),
      fields: schema.fields.map(f => Object.assign({}, f, { value: vals[f.key], custom: Object.prototype.hasOwnProperty.call(overrides, f.key) })) });
  }

  if (pathname === '/api/admin/content' && method === 'PUT') {
    const b = await readBody(req, 600 * 1024);
    if (!b.values || typeof b.values !== 'object') return sendJSON(res, 400, { error: 'values missing' });
    const next = Object.assign({}, overrides), errors = {};
    for (const [k, v] of Object.entries(b.values)) {
      const f = FIELDS.get(k);
      if (!f) { errors[k] = 'unknown field'; continue; }
      if (v === null) { delete next[k]; continue; }                 // reset to default
      const err = validateValue(f, v);
      if (err) { errors[k] = err; continue; }
      if (v === f.default) delete next[k]; else next[k] = v;
    }
    if (Object.keys(errors).length) return sendJSON(res, 400, { error: 'Some fields are invalid', errors });
    overrides = next; writeJSON(F_CONTENT, overrides);
    return sendJSON(res, 200, { ok: true, saved: Object.keys(b.values).length });
  }

  if (pathname === '/api/admin/upload' && method === 'POST') {
    const b = await readBody(req, 12 * 1024 * 1024);
    let data = String(b.data || ''); const m = /^data:[^;,]+;base64,/.exec(data); if (m) data = data.slice(m[0].length);
    const buf = Buffer.from(data, 'base64');
    if (!buf.length) return sendJSON(res, 400, { error: 'No image data received.' });
    if (buf.length > MAX_IMAGE_BYTES) return sendJSON(res, 413, { error: 'Image is larger than 8 MB.' });
    const ext = detectImage(buf);
    if (!ext) return sendJSON(res, 400, { error: 'Only PNG, JPG, WebP and GIF images are allowed.' });
    const slug = String(b.name || 'image').replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'image';
    const name = slug + '-' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(UPLOADS, name), buf);
    return sendJSON(res, 200, { url: '/uploads/' + name, name, size: buf.length });
  }

  if (pathname === '/api/admin/uploads' && method === 'GET') return sendJSON(res, 200, { files: listUploads() });

  let m = /^\/api\/admin\/uploads\/([A-Za-z0-9._-]+)$/.exec(pathname);
  if (m && method === 'DELETE') {
    const url = '/uploads/' + m[1];
    if (isInUse(url)) return sendJSON(res, 409, { error: 'This image is currently used on the website.' });
    const p = safeJoin(UPLOADS, m[1]); if (!p || !fs.existsSync(p)) return sendJSON(res, 404, { error: 'Not found' });
    fs.unlinkSync(p); return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/admin/password' && method === 'POST') {
    const b = await readBody(req, 4096);
    if (!checkPassword(String(b.current || ''))) return sendJSON(res, 403, { error: 'Current password is incorrect.' });
    if (typeof b.next !== 'string' || b.next.length < 8) return sendJSON(res, 400, { error: 'New password must be at least 8 characters.' });
    setPassword(b.next); return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/admin/inquiries' && method === 'GET') return sendJSON(res, 200, { items: inquiries });
  m = /^\/api\/admin\/inquiries\/([a-f0-9]{12})$/.exec(pathname);
  if (m && method === 'PATCH') {
    const b = await readBody(req, 2048), it = inquiries.find(i => i.id === m[1]);
    if (!it) return sendJSON(res, 404, { error: 'Not found' });
    if (b.status === 'new' || b.status === 'read') it.status = b.status;
    writeJSON(F_INQ, inquiries); return sendJSON(res, 200, { ok: true });
  }
  if (m && method === 'DELETE') {
    const n = inquiries.length; inquiries = inquiries.filter(i => i.id !== m[1]);
    if (inquiries.length === n) return sendJSON(res, 404, { error: 'Not found' });
    writeJSON(F_INQ, inquiries); return sendJSON(res, 200, { ok: true });
  }
  return sendJSON(res, 404, { error: 'Not found' });
}

/* ---------------- server ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    let pathname; try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); return res.end('Bad request'); }
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('Method not allowed'); }

    if (pathname === '/' || pathname === '/index.html') {
      const body = renderIndex();
      res.writeHead(200, baseHeaders({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Length': Buffer.byteLength(body) }));
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    if (pathname === '/company-profile.pdf') {
      const vals = currentValues();
      const resolve = url => {
        let m = /^\/(img|uploads)\/([A-Za-z0-9._-]+)$/.exec(url || '');
        if (!m) return null;
        const p = safeJoin(m[1] === 'img' ? path.join(PUBLIC, 'img') : UPLOADS, m[2]);
        return p && fs.existsSync(p) ? p : null;
      };
      const pdf = profilePdf.build(vals, { resolve, fallbackLogo: path.join(PUBLIC, 'img', 'logo-pdf.jpg') });
      res.writeHead(200, baseHeaders({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="Sky-Protein-Oil-Company-Profile.pdf"', 'Cache-Control': 'no-cache', 'Content-Length': pdf.length }));
      return res.end(req.method === 'HEAD' ? undefined : pdf);
    }
    if (pathname === '/admin' || pathname === '/admin/') {
      const p = path.join(PUBLIC, 'admin', 'index.html');
      return fs.readFile(p, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('Admin not found'); }
        res.writeHead(200, baseHeaders({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
          'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" }));
        res.end(buf);
      });
    }
    if (pathname.startsWith('/uploads/')) {
      const p = safeJoin(UPLOADS, pathname.slice(9)); if (!p) { res.writeHead(403); return res.end('Forbidden'); }
      return serveFile(req, res, p, 'public, max-age=31536000, immutable');
    }
    if (pathname.startsWith('/img/')) {
      const p = safeJoin(path.join(PUBLIC, 'img'), pathname.slice(5)); if (!p) { res.writeHead(403); return res.end('Forbidden'); }
      return serveFile(req, res, p, 'public, max-age=86400');
    }
    res.writeHead(404, baseHeaders({ 'Content-Type': 'text/plain' })); res.end('Not found');
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJSON(res, status, { error: status === 500 ? 'Server error' : err.message }); else res.end();
  }
});
server.listen(PORT, HOST, () => {
  console.log('Sky Protein Oil site running  ->  http://localhost:' + PORT);
  console.log('Admin panel                   ->  http://localhost:' + PORT + '/admin');
  if (usingDefaultPassword()) console.log('\n!! Default admin password "' + DEFAULT_PASSWORD + '" is active. Change it in the admin panel (Settings) or start with ADMIN_PASSWORD=yourpassword\n');
});
