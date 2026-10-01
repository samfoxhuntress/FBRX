// Renders the FBRX OS icon set from the vector mark (packages/ui/src/fbrx-mark.json) with no image dependencies: a
// small anti-aliased scanline rasterizer writes the PNGs and the Windows installer's sidebar bitmaps.
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mark = JSON.parse(readFileSync(join(here, '..', '..', '..', 'packages', 'ui', 'src', 'fbrx-mark.json'), 'utf8'));

// ------------------------------------------------------------------------------------------- geometry (mark units)

/** Points of an SVG elliptical arc (endpoint form, no rotation), excluding the start point. */
function arc(x1, y1, rx, ry, large, sweep, x2, y2) {
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const lambda = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * dy * dy - ry * ry * dx * dx;
  const den = rx * rx * dy * dy + ry * ry * dx * dx;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cx = (k * rx * dy) / ry + (x1 + x2) / 2;
  const cy = (-k * ry * dx) / rx + (y1 + y2) / 2;
  const a1 = Math.atan2((y1 - cy) / ry, (x1 - cx) / rx);
  let da = Math.atan2((y2 - cy) / ry, (x2 - cx) / rx) - a1;
  if (sweep && da < 0) da += 2 * Math.PI;
  if (!sweep && da > 0) da -= 2 * Math.PI;
  const n = Math.max(4, Math.ceil((Math.abs(da) / (Math.PI / 2)) * 24));
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const a = a1 + (da * i) / n;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

/** Polygons of an absolute path made of M, H, V, L, A and Z commands. */
function pathPolygons(d) {
  const tokens = d.match(/[MHVLAZ]|-?\d*\.?\d+/g);
  const polys = [];
  let poly = null;
  let x = 0;
  let y = 0;
  let cmd = '';
  for (let i = 0; i < tokens.length; ) {
    if (/[A-Z]/.test(tokens[i])) cmd = tokens[i++];
    const n = () => Number(tokens[i++]);
    if (cmd === 'M') {
      x = n();
      y = n();
      poly = [[x, y]];
      polys.push(poly);
      cmd = 'L';
    } else if (cmd === 'L') {
      x = n();
      y = n();
      poly.push([x, y]);
    } else if (cmd === 'H') {
      x = n();
      poly.push([x, y]);
    } else if (cmd === 'V') {
      y = n();
      poly.push([x, y]);
    } else if (cmd === 'A') {
      const [rx, ry] = [n(), n()];
      n(); // rotation (always 0 in the mark)
      const [large, sweep, x2, y2] = [n(), n(), n(), n()];
      poly.push(...arc(x, y, rx, ry, large, sweep, x2, y2));
      x = x2;
      y = y2;
    } else if (cmd === 'Z') {
      cmd = '';
    } else throw new Error(`Unexpected path data near "${tokens[i]}"`);
  }
  return polys;
}

function roundedRect(x, y, w, h, r) {
  const pts = [];
  const corner = (cx, cy, from) => {
    for (let i = 0; i <= 24; i++) {
      const a = from + (i / 24) * (Math.PI / 2);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  if (r <= 0) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  corner(x + w - r, y + r, -Math.PI / 2);
  corner(x + w - r, y + h - r, 0);
  corner(x + r, y + h - r, Math.PI / 2);
  corner(x + r, y + r, Math.PI);
  return pts;
}

const { inset, radius, stroke } = mark.frame;
const S = mark.size;
const outer = roundedRect(inset - stroke / 2, inset - stroke / 2, S - 2 * inset + stroke, S - 2 * inset + stroke, radius + stroke / 2);
const inner = roundedRect(inset + stroke / 2, inset + stroke / 2, S - 2 * inset - stroke, S - 2 * inset - stroke, Math.max(0, radius - stroke / 2));
const TILE = [outer];
const INK = [outer, inner, ...pathPolygons(mark.letters)]; // even-odd: the frame ring plus the letters

// ------------------------------------------------------------------------------------------- rasterizer

/** Even-odd coverage (0..1) of polygons drawn into a w x h grid, the mark's box placed at (ox, oy) with side `box`. */
function coverage(polys, w, h, ox, oy, box) {
  const s = box / S;
  const edges = [];
  for (const p of polys) {
    for (let i = 0; i < p.length; i++) {
      const [ax, ay] = p[i];
      const [bx, by] = p[(i + 1) % p.length];
      if (ay !== by) edges.push([ox + ax * s, oy + ay * s, ox + bx * s, oy + by * s]);
    }
  }
  const SUB = 16;
  const acc = new Float32Array(w * h);
  const xs = [];
  for (let row = 0; row < h; row++) {
    for (let k = 0; k < SUB; k++) {
      const y = row + (k + 0.5) / SUB;
      xs.length = 0;
      for (const [x0, y0, x1, y1] of edges) {
        if ((y >= y0 && y < y1) || (y >= y1 && y < y0)) xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const a = Math.max(0, xs[i]);
        const b = Math.min(w, xs[i + 1]);
        if (b <= a) continue;
        const ia = Math.floor(a);
        const ib = Math.floor(b);
        const base = row * w;
        if (ia === ib) acc[base + ia] += b - a;
        else {
          acc[base + ia] += ia + 1 - a;
          for (let j = ia + 1; j < ib; j++) acc[base + j] += 1;
          if (ib < w) acc[base + ib] += b - ib;
        }
      }
    }
  }
  for (let i = 0; i < acc.length; i++) acc[i] = Math.min(1, acc[i] / SUB);
  return acc;
}

// ------------------------------------------------------------------------------------------- encoders

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
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
/** 24-bit bottom-up BMP, as the NSIS installer expects for its sidebar. */
function bmp(w, h, rgb) {
  const stride = Math.ceil((w * 3) / 4) * 4;
  const out = Buffer.alloc(54 + stride * h);
  out.write('BM', 0);
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(w, 18);
  out.writeInt32LE(h, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(stride * h, 34);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const o = 54 + (h - 1 - y) * stride + x * 3;
      out[o] = rgb[i + 2];
      out[o + 1] = rgb[i + 1];
      out[o + 2] = rgb[i];
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------- images

const BLACK = 10; // the tile is near-black, the frame and letters white

/** App icon: the mark on its own black tile, filling the canvas apart from a small margin. */
function icon(size) {
  const box = size * 0.92;
  const o = (size - box) / 2;
  const tile = coverage(TILE, size, size, o, o, box);
  const ink = coverage(INK, size, size, o, o, box);
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const a = tile[i];
    const white = a > 0 ? Math.min(1, ink[i] / a) : 0;
    const v = Math.round(BLACK + (255 - BLACK) * white);
    buf.writeUInt32BE(((v << 24) | (v << 16) | (v << 8) | Math.round(a * 255)) >>> 0, i * 4);
  }
  return png(size, size, buf);
}

/** macOS menu-bar template: the frame and letters as black on transparent; macOS tints it. */
function template(size) {
  const ink = coverage(INK, size, size, 0, 0, size);
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) buf[i * 4 + 3] = Math.round(ink[i] * 255);
  return png(size, size, buf);
}

/** Installer sidebar (164 x 314): the white mark on black. */
function sidebar() {
  const w = 164;
  const h = 314;
  const box = 104;
  const ink = coverage(INK, w, h, (w - box) / 2, 64, box);
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) rgb.fill(Math.round(BLACK + (255 - BLACK) * ink[i]), i * 3, i * 3 + 3);
  return bmp(w, h, rgb);
}

const out = (p, data) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
};
const app = join(here, '..');
out(join(app, 'build', 'icon.png'), icon(1024));
out(join(app, 'build', 'installerSidebar.bmp'), sidebar());
out(join(app, 'dist', 'assets', 'icon.png'), icon(512));
// Windows tray: 16 px at 100 % scaling; Electron picks the @1.5x / @2x files on high-DPI screens.
out(join(app, 'dist', 'assets', 'tray.png'), icon(16));
out(join(app, 'dist', 'assets', 'tray@1.5x.png'), icon(24));
out(join(app, 'dist', 'assets', 'tray@2x.png'), icon(32));
out(join(app, 'dist', 'assets', 'trayTemplate.png'), template(22));
out(join(app, 'dist', 'assets', 'trayTemplate@2x.png'), template(44));
out(join(app, 'src', 'renderer', 'public', 'icon.png'), icon(128));
console.log('Icons generated');
