import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

/**
 * Minimal ZIP extractor (stored + deflate, no ZIP64) so runtime downloads need no external tools on
 * macOS, Windows or Linux. Rejects entries that would escape the destination.
 */
export function unzip(file: string, dest: string): string[] {
  const buf = readFileSync(file);
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
  const root = resolve(dest);
  const written: string[] = [];
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
    const target = resolve(root, name);
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`Unsafe path in archive: ${name}`);
    if (name.endsWith('/')) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('Corrupt zip local header');
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    if (!data) throw new Error(`Unsupported zip compression method ${method}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    const mode = (extAttr >>> 16) & 0o777;
    if (mode && process.platform !== 'win32') chmodSync(target, mode);
    written.push(join(dest, name));
  }
  return written;
}
