import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * Minimal ZIP reading and writing (stored + deflate, no ZIP64): runtime downloads unpack with no external tools on
 * macOS, Windows or Linux, and Office documents (.docx, .xlsx, .pptx are ZIP archives) are read and written in memory.
 */

interface ZipEntry {
  name: string;
  /** Unix permissions, when the archive keeps them. */
  mode: number;
  data: () => Buffer;
}

/** The entries of a ZIP archive, in order; each entry's data is decompressed when asked for. */
export function zipEntries(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const extAttr = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    entries.push({
      name,
      mode: (extAttr >>> 16) & 0o777,
      data: () => {
        if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('Corrupt zip local header');
        const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.subarray(dataStart, dataStart + compSize);
        if (method === 0) return raw;
        if (method === 8) return inflateRawSync(raw);
        throw new Error(`Unsupported zip compression method ${method}`);
      },
    });
  }
  return entries;
}

/** Extracts an archive to a folder. Rejects entries that would escape it. */
export function unzip(file: string, dest: string): string[] {
  const root = resolve(dest);
  const written: string[] = [];
  for (const e of zipEntries(readFileSync(file))) {
    const target = resolve(root, e.name);
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`Unsafe path in archive: ${e.name}`);
    if (e.name.endsWith('/')) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, e.data());
    if (e.mode && process.platform !== 'win32') chmodSync(target, e.mode);
    written.push(join(dest, e.name));
  }
  return written;
}

/** Builds a ZIP archive in memory from named files (deflated, dated now). */
export function zip(files: Array<{ name: string; data: Buffer | string }>): Buffer {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // names are UTF-8
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(head, name, packed);
    central.push(dir, name);
    offset += head.length + name.length + packed.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}
