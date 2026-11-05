import { deflateSync } from 'node:zlib';

/**
 * A virtual machine's screen for FBRX Time's boot checks: libvirt hands it over as a PPM picture, which browsers do not
 * show, so it is turned into a PNG here (no image library on the server). The colors on it also tell a desktop or a
 * sign-in screen (many colors) from a text screen, which may be a boot error.
 */

export interface Picture {
  width: number;
  height: number;
  /** RGB, 3 bytes a pixel, row by row. */
  rgb: Buffer;
}

/** Reads a binary PPM (P6), as `virsh screenshot` writes it. */
export function readPpm(buf: Buffer): Picture {
  let pos = 0;
  const token = (): string => {
    for (;;) {
      while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]!))) pos++;
      if (buf[pos] === 0x23) {
        while (pos < buf.length && buf[pos] !== 0x0a) pos++;
        continue;
      }
      break;
    }
    const start = pos;
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]!))) pos++;
    return buf.subarray(start, pos).toString('ascii');
  };
  if (token() !== 'P6') throw new Error('Not a PPM screenshot');
  const width = Number(token());
  const height = Number(token());
  const max = Number(token());
  pos++;
  if (!width || !height || max !== 255) throw new Error('Unexpected screenshot format');
  const rgb = buf.subarray(pos, pos + width * height * 3);
  if (rgb.length < width * height * 3) throw new Error('The screenshot is cut short');
  return { width, height, rgb };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A PNG of the picture, scaled down (whole pixels) so its width is at most maxWidth. */
export function toPng(p: Picture, maxWidth = 1024): Buffer {
  const step = Math.max(1, Math.ceil(p.width / maxWidth));
  const w = Math.floor(p.width / step);
  const h = Math.floor(p.height / step);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const src = (y * step * p.width + x * step) * 3;
      p.rgb.copy(raw, row + 1 + x * 3, src, src + 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export interface ScreenLook {
  /** One color all over (a blank screen). */
  blank: boolean;
  /** Distinct colors, rounded to 32 levels a channel. */
  colors: number;
  /** A picture with many colors (a desktop or sign-in screen), not just text on a plain background. */
  graphical: boolean;
}

/** What the screen shows, roughly: blank, text, or a picture. */
export function lookAt(p: Picture): ScreenLook {
  const seen = new Set<number>();
  const pixels = p.width * p.height;
  const stride = Math.max(1, Math.floor(pixels / 40_000));
  for (let i = 0; i < pixels; i += stride) {
    const o = i * 3;
    seen.add(((p.rgb[o]! >> 3) << 10) | ((p.rgb[o + 1]! >> 3) << 5) | (p.rgb[o + 2]! >> 3));
    if (seen.size > 4096) break;
  }
  return { blank: seen.size <= 1, colors: seen.size, graphical: seen.size >= 48 };
}

/** A made-up screen for the simulated driver: a soft two-way gradient with a lighter box, like a sign-in screen. */
export function samplePicture(width = 320, height = 200, hue = 210): Picture {
  const rgb = Buffer.alloc(width * height * 3);
  const blue = hue > 180;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      const box = x > width * 0.35 && x < width * 0.65 && y > height * 0.4 && y < height * 0.62;
      if (box) {
        rgb[o] = 236;
        rgb[o + 1] = 239;
        rgb[o + 2] = 243;
        continue;
      }
      const fx = x / width;
      const fy = y / height;
      rgb[o] = Math.round((blue ? 20 : 60) + fx * 140);
      rgb[o + 1] = Math.round(40 + fy * 150);
      rgb[o + 2] = Math.round((blue ? 120 : 50) + (fx + fy) * 60);
    }
  }
  return { width, height, rgb };
}
