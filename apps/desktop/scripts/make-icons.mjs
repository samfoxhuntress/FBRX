// Generates the FBRX OS icon set (a woven "fabric" mark) as PNGs with no image dependencies.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const lerp = (a, b, t) => a + (b - a) * t;
const A = [42, 120, 214];
const B = [74, 58, 167];

/** Sample one point of the mark in unit space: returns [r,g,b,a]. */
function sample(u, v, mono) {
  const r = 0.2;
  const inset = 0.04;
  const x = u - 0.5;
  const y = v - 0.5;
  const h = 0.5 - inset;
  const qx = Math.abs(x) - (h - r);
  const qy = Math.abs(y) - (h - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  if (outside > 0) return [0, 0, 0, 0];
  // Woven threads: three warp (vertical) and three weft (horizontal) bands, alternating over/under.
  const bands = [0.3, 0.5, 0.7];
  const w = 0.085;
  const inBand = (p) => bands.findIndex((c) => Math.abs(p - c) < w / 2);
  const vi = inBand(u);
  const hi = inBand(v);
  let thread = 0;
  if (vi >= 0 && hi >= 0) thread = (vi + hi) % 2 === 0 ? 1 : 0.78;
  else if (vi >= 0 && v > 0.2 && v < 0.8) thread = 0.9;
  else if (hi >= 0 && u > 0.2 && u < 0.8) thread = 0.9;
  if (mono) return thread ? [0, 0, 0, 255] : [0, 0, 0, 0];
  const t = (u + v) / 2;
  const bg = [lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t)];
  if (!thread) return [...bg, 255];
  return [lerp(bg[0], 255, thread), lerp(bg[1], 255, thread), lerp(bg[2], 255, thread), 255];
}

function render(size, mono = false) {
  const buf = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const s = sample((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, mono);
          const a = s[3] / 255;
          acc[0] += s[0] * a;
          acc[1] += s[1] * a;
          acc[2] += s[2] * a;
          acc[3] += a;
        }
      const i = (py * size + px) * 4;
      const a = acc[3] / (ss * ss);
      buf[i] = acc[3] ? acc[0] / acc[3] : 0;
      buf[i + 1] = acc[3] ? acc[1] / acc[3] : 0;
      buf[i + 2] = acc[3] ? acc[2] / acc[3] : 0;
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return png(size, buf);
}

const out = (p, data) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
};
const app = join(here, '..');
out(join(app, 'build', 'icon.png'), render(1024));
out(join(app, 'dist', 'assets', 'icon.png'), render(512));
out(join(app, 'dist', 'assets', 'tray.png'), render(32));
out(join(app, 'dist', 'assets', 'tray@2x.png'), render(64));
out(join(app, 'dist', 'assets', 'trayTemplate.png'), render(22, true));
out(join(app, 'dist', 'assets', 'trayTemplate@2x.png'), render(44, true));
out(join(app, 'src', 'renderer', 'public', 'icon.png'), render(128));
console.log('Icons generated');
