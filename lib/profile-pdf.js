'use strict';
/**
 * Company-profile PDF generator (zero dependencies).
 * Builds the PDF from the live website content, so every admin edit is reflected.
 */
const fs = require('fs');
const zlib = require('zlib');
const WIDTHS = require('./helv-widths.json');          // Helvetica metrics (F1 regular, F2 bold, F3 oblique)

const PW = 595.28, PH = 841.89, M = 46, TOP = 44, BOTTOM = 62;
const C = { ink: '#0c2d5e', blue: '#1b63c6', green: '#2e8b2e', gold: '#f59e0b', text: '#334155', mut: '#64748b', line: '#e2e8f0', tint: '#eef5fc', tintG: '#eef7ec' };

/* ---------- text helpers (WinAnsi / cp1252) ---------- */
const SPECIAL = { 0x2013: 0x96, 0x2014: 0x97, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x20ac: 0x80, 0x2026: 0x85, 0x2122: 0x99, 0x00a0: 0x20 };
function enc(str) {
  const out = [];
  for (const ch of String(str == null ? '' : str)) {
    const c = ch.codePointAt(0);
    if (c === 10) out.push(10); else if (c < 32) out.push(32);
    else if (c < 256 && !(c >= 0x80 && c < 0xa0)) out.push(c);
    else if (SPECIAL[c]) out.push(SPECIAL[c]); else out.push(63);
  }
  return out;
}
function tw(str, font, size) { let w = 0; for (const b of enc(str)) w += (WIDTHS[font][b] || 0); return w * size / 1000; }
function wrap(str, font, size, maxW) {
  const lines = [];
  String(str == null ? '' : str).split(/\r?\n/).forEach(par => {
    const words = par.split(/\s+/).filter(Boolean); let cur = '';
    if (!words.length) { lines.push(''); return; }
    words.forEach(w => {
      while (tw(w, font, size) > maxW) {                       // very long word: hard-break
        let k = w.length; while (k > 1 && tw(w.slice(0, k), font, size) > maxW) k--;
        if (cur) { lines.push(cur); cur = ''; }
        lines.push(w.slice(0, k)); w = w.slice(k);
      }
      const test = cur ? cur + ' ' + w : w;
      if (tw(test, font, size) <= maxW) cur = test; else { if (cur) lines.push(cur); cur = w; }
    });
    if (cur) lines.push(cur);
  });
  return lines;
}
const hex = s => Buffer.from(enc(s)).toString('hex');
function rgb(c) { const n = parseInt(c.slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(v => v.toFixed(3)).join(' '); }
const f2 = n => (Math.round(n * 100) / 100).toString();

/* ---------- JPEG reader ---------- */
function readJpeg(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xff) { i += (m === 0xff ? 1 : 2); continue; }
      const len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        const h = buf.readUInt16BE(i + 5), w = buf.readUInt16BE(i + 7), comps = buf[i + 9];
        if (comps === 4 || !w || !h) return null;                // CMYK not supported
        return { data: buf, w, h, cs: comps === 1 ? '/DeviceGray' : '/DeviceRGB' };
      }
      i += 2 + len;
    }
  } catch (e) { /* ignore */ }
  return null;
}

/* ---------- tiny PDF writer ---------- */
class Page {
  constructor() { this.ops = []; this.images = []; }
  rect(x, y, w, h, color) { this.ops.push(`${rgb(color)} rg ${f2(x)} ${f2(PH - y - h)} ${f2(w)} ${f2(h)} re f`); }
  line(x1, y1, x2, y2, color, lw) { this.ops.push(`${rgb(color)} RG ${f2(lw || 0.7)} w ${f2(x1)} ${f2(PH - y1)} m ${f2(x2)} ${f2(PH - y2)} l S`); }
  text(x, y, str, font, size, color) { if (!str) return; this.ops.push(`BT /${font} ${f2(size)} Tf ${rgb(color)} rg ${f2(x)} ${f2(PH - y)} Td <${hex(str)}> Tj ET`); }
  image(idx, x, y, w, h) { if (!this.images.includes(idx)) this.images.push(idx); this.ops.push(`q ${f2(w)} 0 0 ${f2(h)} ${f2(x)} ${f2(PH - y - h)} cm /Im${idx} Do Q`); }
}
function serialize(pages, images) {
  const parts = []; const offsets = []; let pos = 0;
  const push = b => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'); parts.push(buf); pos += buf.length; };
  const obj = (id, body) => { offsets[id] = pos; push(`${id} 0 obj\n`); push(body); push('\nendobj\n'); };
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const nImg = images.length, nPages = pages.length;
  const idCat = 1, idPages = 2, idF = [3, 4, 5], idImg0 = 6, idPage0 = idImg0 + nImg;   // page i: content=idPage0+2i, page=idPage0+2i+1
  obj(idCat, `<< /Type /Catalog /Pages ${idPages} 0 R >>`);
  const kids = pages.map((_, i) => `${idPage0 + 2 * i + 1} 0 R`).join(' ');
  obj(idPages, `<< /Type /Pages /Kids [${kids}] /Count ${nPages} >>`);
  ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique'].forEach((n, i) => obj(idF[i], `<< /Type /Font /Subtype /Type1 /BaseFont /${n} /Encoding /WinAnsiEncoding >>`));
  images.forEach((im, i) => { offsets[idImg0 + i] = pos; push(`${idImg0 + i} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace ${im.cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.data.length} >>\nstream\n`); push(im.data); push('\nendstream\nendobj\n'); });
  pages.forEach((p, i) => {
    const stream = zlib.deflateSync(Buffer.from(p.ops.join('\n'), 'latin1'));
    offsets[idPage0 + 2 * i] = pos; push(`${idPage0 + 2 * i} 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`); push(stream); push('\nendstream\nendobj\n');
    const xo = p.images.map(k => `/Im${k} ${idImg0 + k - 1} 0 R`).join(' ');
    obj(idPage0 + 2 * i + 1, `<< /Type /Page /Parent ${idPages} 0 R /MediaBox [0 0 ${PW} ${PH}] /Contents ${idPage0 + 2 * i} 0 R /Resources << /Font << /F1 ${idF[0]} 0 R /F2 ${idF[1]} 0 R /F3 ${idF[2]} 0 R >> /XObject << ${xo} >> >> >>`);
  });
  const total = idPage0 + 2 * nPages; const xref = pos;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let id = 1; id < total; id++) push(String(offsets[id]).padStart(10, '0') + ' 00000 n \n');
  push(`trailer\n<< /Size ${total} /Root ${idCat} 0 R /Info << /Title (Company Profile) /Producer (Sky Protein Oil) >> >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

/* ---------- document layout ---------- */
function build(v, opts) {
  const resolve = opts.resolve, fallbackLogo = opts.fallbackLogo;
  const images = [];
  function loadImage(url) {
    if (!url) return 0; const p = resolve(url); if (!p) return 0;
    const j = readJpeg(p); if (!j) return 0; images.push(j); return images.length;
  }
  const pages = []; let pg, y;
  function newPage() { pg = new Page(); pages.push(pg); y = TOP; }
  function need(h) { if (y + h > PH - BOTTOM) newPage(); }
  const CW = PW - 2 * M;

  newPage();
  /* header */
  const bar = (p) => { p.rect(0, 0, PW * 0.6, 7, C.blue); p.rect(PW * 0.6, 0, PW * 0.25, 7, C.green); p.rect(PW * 0.85, 0, PW * 0.15, 7, C.gold); };
  bar(pg);
  let logoIdx = loadImage(v['brand.logo']);
  if (!logoIdx) { const j = readJpeg(fallbackLogo); if (j) { images.push(j); logoIdx = images.length; } }
  if (logoIdx) { const im = images[logoIdx - 1], h = 78, w = h * im.w / im.h; pg.image(logoIdx, M, 26, w, h); }
  const rx = PW - M; let ry = 40;
  const right = (s, font, size, color) => { if (!s) return; const w = tw(s, font, size); pg.text(rx - w, ry, s, font, size, color); ry += size + 4; };
  right(v['brand.descriptor'], 'F2', 8.5, C.blue); ry += 3;
  wrap(v['contact.address'], 'F1', 8.5, 230).forEach(l => right(l, 'F1', 8.5, C.text));
  [v['contact.phone'], v['contact.phone2']].filter(Boolean).length && right([v['contact.phone'], v['contact.phone2']].filter(Boolean).join('  |  '), 'F1', 8.5, C.text);
  right(v['contact.email'], 'F1', 8.5, C.text);
  if (v['contact.gstin']) right((v['contact.gstin_label'] || 'GSTIN') + ': ' + v['contact.gstin'], 'F2', 8.5, C.text);
  y = 124; pg.line(M, y, PW - M, y, C.line, 1); y += 40;
  pg.text(M, y, v['profile.doc_title'] || 'Company Profile', 'F2', 28, C.ink); y += 22;
  pg.text(M, y, v['brand.name'] || '', 'F2', 12.5, C.green); y += 12;
  pg.rect(M, y, 54, 3.5, C.gold); y += 30;

  /* building blocks */
  function section(title) { need(120); y += 12; pg.text(M, y + 12, title, 'F2', 15, C.blue); y += 20; pg.rect(M, y, 34, 2.6, C.green); y += 16; }
  function para(str, o) {
    o = o || {}; const size = o.size || 10, font = o.font || 'F1', lh = size * 1.5, x = o.x || M, w = o.w || CW;
    wrap(str, font, size, w).forEach(l => { need(lh); pg.text(x, y + size, l, font, size, o.color || C.text); y += lh; });
    y += (o.gap == null ? 6 : o.gap);
  }
  function bullets(items) {
    items.filter(Boolean).forEach(it => {
      const lines = wrap(it, 'F1', 10, CW - 16); need(lines.length * 15 + 4);
      pg.rect(M + 2, y + 5.2, 4, 4, C.green);
      lines.forEach(l => { pg.text(M + 16, y + 10, l, 'F1', 10, C.text); y += 15; }); y += 4;
    });
  }

  /* about */
  section(v['about.eyebrow'] || 'About Us');
  pg.text(M, y + 12, v['about.title'] || '', 'F2', 13, C.ink); y += 18;
  para(v['about.subtitle'], { font: 'F2', color: C.green, size: 10.5, gap: 8 });
  [v['about.p1'], v['about.p2'], v['about.p3']].forEach(t => para(t, { gap: 6 }));

  /* featured machine */
  if (v['mobirender.name']) {
    section(v['mobirender.badge'] || 'Featured Machine');
    const im = loadImage(v['mobirender.image']); const imgW = im ? 210 : 0, gap = im ? 20 : 0, tx = M + imgW + gap, tW = CW - imgW - gap;
    const specs = [1, 2, 3, 4].filter(i => v['mobirender.spec' + i + '_value']).map(i => (v['mobirender.spec' + i + '_label'] || '') + ': ' + v['mobirender.spec' + i + '_value']);
    const nameL = wrap(v['mobirender.name'], 'F2', 18, tW), subL = wrap(v['mobirender.subtitle'], 'F2', 11, tW);
    const chips = [v['mobirender.chip_1'], v['mobirender.chip_2'], v['mobirender.chip_3']].filter(Boolean).join('  \u2022  ');
    const chipL = wrap(chips, 'F2', 9.5, tW), txtL = wrap(v['mobirender.text'], 'F1', 10, tW), tagL = wrap(v['mobirender.tagline'], 'F2', 10.5, tW);
    let spL = []; specs.forEach(s => { spL = spL.concat(wrap(s, 'F1', 9.5, tW)); });
    const th = nameL.length * 23 + subL.length * 15 + 8 + chipL.length * 14 + 8 + txtL.length * 15 + 8 + tagL.length * 15 + (spL.length ? spL.length * 13 + 14 : 0) + (v['mobirender.by'] ? 22 : 0);
    const ih = im ? imgW * images[im - 1].h / images[im - 1].w : 0, bh = Math.max(th, ih) + 24;
    need(bh); pg.rect(M, y, CW, bh, C.tint);
    if (im) pg.image(im, M + 10, y + 12 + Math.max(0, (bh - 24 - ih) / 2), imgW - 20, (imgW - 20) * images[im - 1].h / images[im - 1].w);
    let ty = y + 14;
    nameL.forEach(l => { pg.text(tx, ty + 15, l, 'F2', 18, C.ink); ty += 23; });
    subL.forEach(l => { pg.text(tx, ty + 10, l, 'F2', 11, C.green); ty += 15; }); ty += 8;
    chipL.forEach(l => { pg.text(tx, ty + 9, l, 'F2', 9.5, C.blue); ty += 14; }); ty += 8;
    txtL.forEach(l => { pg.text(tx, ty + 10, l, 'F1', 10, C.text); ty += 15; }); ty += 8;
    tagL.forEach(l => { pg.text(tx, ty + 10, l, 'F2', 10.5, C.ink); ty += 15; });
    if (spL.length) { ty += 8; spL.forEach(l => { pg.text(tx, ty + 9, l, 'F1', 9.5, C.text); ty += 13; }); ty += 6; }
    if (v['mobirender.by']) pg.text(tx, ty + 12, v['mobirender.by'], 'F3', 9.5, C.mut);
    y += bh + 8;
  }

  /* how it works */
  section(v['process.title'] || 'How It Works');
  para(v['process.text'], { gap: 8 });
  for (let i = 1; i <= 4; i++) {
    if (!v['process.s' + i + '_title']) continue;
    const tl = wrap(v['process.s' + i + '_text'], 'F1', 9.5, CW - 40); need(tl.length * 14 + 26);
    pg.rect(M, y + 1, 22, 22, C.blue); pg.text(M + 11 - tw(String(i), 'F2', 11) / 2, y + 16.5, String(i), 'F2', 11, '#ffffff');
    pg.text(M + 32, y + 12, v['process.s' + i + '_title'], 'F2', 10.5, C.ink); let yy = y + 26;
    tl.forEach(l => { pg.text(M + 32, yy, l, 'F1', 9.5, C.text); yy += 14; }); y = yy + 6;
  }
  para(v['process.note'], { font: 'F3', size: 9.5, color: C.mut });

  /* products */
  section(v['products.eyebrow'] || 'Products & Machinery');
  para(v['products.text'], { gap: 8 });
  for (let i = 1; i <= 9; i++) {
    const title = v['products.p' + i + '_title']; if (!title) continue;
    const im = loadImage(v['products.p' + i + '_image']), tw0 = im ? 92 : 0, tx = M + 30 + (im ? tw0 + 12 : 0), w = CW - 30 - (im ? tw0 + 12 : 0);
    const tl = wrap(v['products.p' + i + '_text'], 'F1', 9.5, w), titL = wrap(title, 'F2', 11, w);
    const ih = im ? tw0 * images[im - 1].h / images[im - 1].w : 0, bh = Math.max(titL.length * 15 + tl.length * 14 + 6, ih) + 8;
    need(bh);
    pg.text(M, y + 12, String(i).padStart(2, '0'), 'F2', 11, C.gold);
    if (im) pg.image(im, M + 30, y, tw0, ih);
    let yy = y + 11; titL.forEach(l => { pg.text(tx, yy, l, 'F2', 11, C.ink); yy += 15; }); yy -= 1;
    tl.forEach(l => { pg.text(tx, yy + 2, l, 'F1', 9.5, C.text); yy += 14; });
    y += bh; pg.line(M, y - 3, PW - M, y - 3, C.line, 0.6); y += 8;
  }

  /* services table */
  section(v['services.title'] || 'Services');
  para(v['services.text'], { gap: 8 });
  need(34); pg.rect(M, y, CW, 24, C.tint);
  pg.text(M + 12, y + 16, String(v['services.col_1'] || 'Division').toUpperCase(), 'F2', 9, C.ink); pg.text(M + 190, y + 16, String(v['services.col_2'] || 'Details').toUpperCase(), 'F2', 9, C.ink); y += 24;
  for (let i = 1; i <= 6; i++) {
    const n = v['services.r' + i + '_name']; if (!n) continue;
    const dl = wrap(v['services.r' + i + '_details'], 'F1', 10, CW - 190 - 10), nl = wrap(n, 'F2', 10.5, 165), rh = Math.max(dl.length, nl.length) * 15 + 14;
    need(rh); let yy = y + 20; nl.forEach(l => { pg.text(M + 12, yy - 6, l, 'F2', 10.5, C.ink); yy += 15; });
    yy = y + 20; dl.forEach(l => { pg.text(M + 190, yy - 6, l, 'F1', 10, C.text); yy += 15; });
    y += rh; pg.line(M, y, PW - M, y, C.line, 0.7);
  }
  y += 10;

  /* vision & mission */
  function box(title, text, color, tint) {
    const lines = wrap(text, 'F1', 10, CW - 36), h = lines.length * 15 + 46; need(h);
    pg.rect(M, y, 4, h, color); pg.rect(M + 4, y, CW - 4, h, tint);
    pg.text(M + 20, y + 24, title, 'F2', 13, color); let yy = y + 42; lines.forEach(l => { pg.text(M + 20, yy, l, 'F1', 10, C.text); yy += 15; }); y += h + 12;
  }
  y += 4; box(v['vision.vision_title'] || 'Our Vision', v['vision.vision_text'], C.blue, C.tint);
  box(v['vision.mission_title'] || 'Our Mission', v['vision.mission_text'], C.green, C.tintG);

  /* why us + commitment */
  section(v['why.title'] || 'Why Choose Us');
  bullets([1, 2, 3, 4, 5, 6].map(i => v['why.w' + i]));
  section(v['commitment.title'] || 'Our Commitment');
  para(v['commitment.text'], { gap: 8 });
  para(v['commitment.tagline'], { font: 'F2', size: 11, color: C.green });

  /* contact box */
  const rows = [[v['contact.address_label'] || 'Address', v['contact.address']], [v['contact.phone_label'] || 'Phone', [v['contact.phone'], v['contact.phone2']].filter(Boolean).join('   |   ')], [v['contact.email_label'] || 'Email', v['contact.email']], [v['contact.gstin_label'] || 'GSTIN', v['contact.gstin']]].filter(r => r[1]);
  if (rows.length) {
    section(v['contact.eyebrow'] || 'Contact Us');
    const built = rows.map(r => ({ l: r[0], lines: wrap(r[1], 'F1', 10.5, CW - 130) })); const h = built.reduce((a, r) => a + r.lines.length * 16 + 8, 0) + 52;
    need(h); pg.rect(M, y, CW, h, C.ink); pg.rect(M, y, CW, 4, C.gold);
    pg.text(M + 20, y + 28, v['brand.name'] || '', 'F2', 12.5, '#ffffff'); let yy = y + 50;
    built.forEach(r => { pg.text(M + 20, yy, r.l.toUpperCase(), 'F2', 8.5, '#fbd26b'); r.lines.forEach(l => { pg.text(M + 110, yy, l, 'F1', 10.5, '#ffffff'); yy += 16; }); yy += 8; });
    y += h;
  }

  /* footers */
  pages.forEach((p, i) => {
    p.line(M, PH - 44, PW - M, PH - 44, C.line, 0.7);
    p.text(M, PH - 28, v['profile.footer_note'] || '', 'F1', 8, C.mut);
    const s = 'Page ' + (i + 1) + ' of ' + pages.length; p.text(PW - M - tw(s, 'F1', 8), PH - 28, s, 'F1', 8, C.mut);
    p.rect(0, PH - 5, PW * 0.6, 5, C.blue); p.rect(PW * 0.6, PH - 5, PW * 0.25, 5, C.green); p.rect(PW * 0.85, PH - 5, PW * 0.15, 5, C.gold);
  });
  return serialize(pages, images);
}
module.exports = { build };
