import { openSync, readSync, closeSync } from 'node:fs';

export interface GgufInfo {
  version: number;
  /** "qwen3", "llama", "gpt-oss"… */
  architecture: string | null;
  /** Transformer layers (what --n-gpu-layers counts). */
  blockCount: number | null;
  name: string | null;
}

/** How much of the file is read: the metadata that matters comes before the (large) tokenizer lists. */
const HEAD_BYTES = 4 * 1024 * 1024;

/**
 * Reads a GGUF model file's header: its format version, architecture and layer count. Null when the file does not
 * start like a GGUF model at all (an error page saved by mistake, a different format, an empty file).
 */
export function readGgufInfo(path: string): GgufInfo | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return parseGgufHeader(buf.subarray(0, n));
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function parseGgufHeader(buf: Buffer): GgufInfo | null {
  if (buf.length < 24 || buf.toString('latin1', 0, 4) !== 'GGUF') return null;
  const version = buf.readUInt32LE(4);
  if (version < 2 || version > 3) return { version, architecture: null, blockCount: null, name: null };
  const info: GgufInfo = { version, architecture: null, blockCount: null, name: null };
  let off = 8 + 8; // tensor count
  const kvCount = Number(buf.readBigUInt64LE(off));
  off += 8;
  const need = (n: number) => {
    if (off + n > buf.length) throw new RangeError('end of header window');
  };
  const str = () => {
    need(8);
    const len = Number(buf.readBigUInt64LE(off));
    off += 8;
    need(len);
    const s = buf.toString('utf8', off, off + len);
    off += len;
    return s;
  };
  const SIZES: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
  const value = (type: number): unknown => {
    switch (type) {
      case 4:
        need(4);
        return buf.readUInt32LE((off += 4) - 4);
      case 5:
        need(4);
        return buf.readInt32LE((off += 4) - 4);
      case 10:
        need(8);
        return Number(buf.readBigUInt64LE((off += 8) - 8));
      case 8:
        return str();
      case 9: {
        need(12);
        const et = buf.readUInt32LE(off);
        const count = Number(buf.readBigUInt64LE(off + 4));
        off += 12;
        if (et === 8) for (let i = 0; i < count; i++) str();
        else {
          const size = SIZES[et];
          if (size === undefined) throw new RangeError('nested array');
          need(size * count);
          off += size * count;
        }
        return undefined;
      }
      default: {
        const size = SIZES[type];
        if (size === undefined) throw new RangeError(`unknown type ${type}`);
        need(size);
        off += size;
        return undefined;
      }
    }
  };
  try {
    for (let i = 0; i < kvCount; i++) {
      const key = str();
      need(4);
      const type = buf.readUInt32LE(off);
      off += 4;
      const v = value(type);
      if (key === 'general.architecture' && typeof v === 'string') info.architecture = v;
      else if (key === 'general.name' && typeof v === 'string') info.name = v;
      else if (info.architecture && key === `${info.architecture}.block_count` && typeof v === 'number') info.blockCount = v;
      if (info.architecture && info.blockCount !== null && info.name !== null) break;
    }
  } catch {
    /* the rest of the metadata lies past the window (or is malformed): keep what was read */
  }
  return info;
}
