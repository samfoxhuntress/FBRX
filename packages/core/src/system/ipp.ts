import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { cleanName, type PrinterSupply } from '@fbrx/shared';

/**
 * Ink and toner levels over IPP (the printing protocol every network printer and CUPS speaks): one
 * Get-Printer-Attributes request for the marker-* attributes. Read-only, and only to this computer's own print service
 * or a printer on the local network.
 */

const TAG = { operation: 0x01, end: 0x03, printer: 0x04, integer: 0x21, boolean: 0x22, enum: 0x23, keyword: 0x44, uri: 0x45, charset: 0x47, language: 0x48 } as const;
const WANTED = ['marker-names', 'marker-levels', 'marker-colors', 'marker-types', 'marker-low-levels', 'printer-state-reasons'];

function attr(tag: number, name: string, value: string | Buffer): Buffer {
  const n = Buffer.from(name, 'utf8');
  const v = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const b = Buffer.alloc(1 + 2 + n.length + 2 + v.length);
  b.writeUInt8(tag, 0);
  b.writeUInt16BE(n.length, 1);
  n.copy(b, 3);
  b.writeUInt16BE(v.length, 3 + n.length);
  v.copy(b, 5 + n.length);
  return b;
}

/** A Get-Printer-Attributes request (IPP/2.0) for the supplies. */
export function suppliesRequest(printerUri: string, requestId = 1): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt8(2, 0);
  head.writeUInt8(0, 1);
  head.writeUInt16BE(0x000b, 2);
  head.writeUInt32BE(requestId, 4);
  return Buffer.concat([
    head,
    Buffer.from([TAG.operation]),
    attr(TAG.charset, 'attributes-charset', 'utf-8'),
    attr(TAG.language, 'attributes-natural-language', 'en'),
    attr(TAG.uri, 'printer-uri', printerUri),
    ...WANTED.map((w, i) => attr(TAG.keyword, i === 0 ? 'requested-attributes' : '', w)),
    Buffer.from([TAG.end]),
  ]);
}

/** The attributes in an IPP response, each a list of values (strings, or numbers for integers and enums). */
export function parseIpp(buf: Buffer): { status: number; attributes: Record<string, Array<string | number | boolean>> } {
  if (buf.length < 9) throw new Error('Not an IPP response');
  const status = buf.readUInt16BE(2);
  const attributes: Record<string, Array<string | number | boolean>> = {};
  let i = 8;
  let last = '';
  while (i < buf.length) {
    const tag = buf.readUInt8(i++);
    if (tag === TAG.end) break;
    if (tag < 0x10) continue; // a group starts
    if (i + 2 > buf.length) break;
    const nlen = buf.readUInt16BE(i);
    i += 2;
    const name = buf.toString('utf8', i, i + nlen);
    i += nlen;
    if (i + 2 > buf.length) break;
    const vlen = buf.readUInt16BE(i);
    i += 2;
    const raw = buf.subarray(i, i + vlen);
    i += vlen;
    const key = nlen ? name : last;
    if (nlen) last = name;
    const value = tag === TAG.integer || tag === TAG.enum ? (raw.length === 4 ? raw.readInt32BE(0) : 0) : tag === TAG.boolean ? raw[0] === 1 : raw.toString('utf8');
    (attributes[key] ??= []).push(value);
  }
  return { status, attributes };
}

const KIND: Record<string, PrinterSupply['kind']> = { toner: 'toner', 'toner-cartridge': 'toner', 'ink-cartridge': 'ink', ink: 'ink', 'inkjet-ink': 'ink', 'waste-toner': 'waste', 'waste-ink': 'waste', 'opc': 'drum', 'drum': 'drum', 'fuser': 'other' };

/** The supplies in a parsed response: levels 0-100, or null where the printer only says "some left" or nothing. */
export function suppliesOf(attributes: Record<string, Array<string | number | boolean>>): PrinterSupply[] {
  const names = attributes['marker-names'] ?? [];
  const levels = attributes['marker-levels'] ?? [];
  const colors = attributes['marker-colors'] ?? [];
  const types = attributes['marker-types'] ?? [];
  const lows = attributes['marker-low-levels'] ?? [];
  return names.slice(0, 16).map((n, i) => {
    const level = typeof levels[i] === 'number' ? (levels[i] as number) : -2;
    const low = typeof lows[i] === 'number' && (lows[i] as number) > 0 ? (lows[i] as number) : 10;
    const color = String(colors[i] ?? '').match(/#[0-9a-f]{6}/i)?.[0] ?? null;
    return {
      name: cleanName(String(n)).slice(0, 60) || `Supply ${i + 1}`,
      kind: KIND[String(types[i] ?? '').toLowerCase()] ?? 'other',
      color,
      level: level >= 0 && level <= 100 ? level : null,
      low: level >= 0 && level <= low,
    };
  });
}

/** Only this computer's print service, or a printer on the local network (private addresses and .local names). */
export function localPrinterHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.local')) return true;
  if (isIP(h) === 4) return /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  if (isIP(h) === 6) return h === '::1' || /^(fe80|fc|fd)/.test(h);
  return false;
}

/** The supplies of a printer at an ipp://, ipps://, http:// or https:// address; null when it does not answer. */
export async function printerSupplies(uri: string, timeoutMs = 4000): Promise<PrinterSupply[] | null> {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (!/^(ipps?|https?):$/.test(u.protocol) || !localPrinterHost(u.hostname)) return null;
  const secure = u.protocol === 'ipps:' || u.protocol === 'https:';
  const port = Number(u.port) || (u.protocol === 'http:' ? 80 : u.protocol === 'https:' ? 443 : 631);
  const body = suppliesRequest(`${u.protocol === 'ipps:' ? 'ipps' : 'ipp'}://${u.host}${u.pathname}`);
  const reply = await new Promise<Buffer | null>((resolve) => {
    const req = (secure ? https : http).request(
      {
        host: u.hostname.replace(/^\[|\]$/g, ''),
        port,
        path: u.pathname || '/ipp/print',
        method: 'POST',
        headers: { 'content-type': 'application/ipp', 'content-length': body.length },
        timeout: timeoutMs,
        // A printer's certificate is its own, made by itself: nothing secret goes there, only this read.
        ...(secure ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 256 * 1024) req.destroy();
          else chunks.push(c);
        });
        res.on('end', () => resolve(res.statusCode === 200 ? Buffer.concat(chunks) : null));
        res.on('error', () => resolve(null));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(body);
  });
  if (!reply) return null;
  try {
    const { status, attributes } = parseIpp(reply);
    return status < 0x0100 ? suppliesOf(attributes) : null;
  } catch {
    return null;
  }
}
