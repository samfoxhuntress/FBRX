import type { ConnectionProtocol } from '@fbrx/shared';

/**
 * FBRX View's imports: connections from a Remote Desktop file (.rdp) or a Remote Desktop Manager export (XML, .rdm).
 * Only where to connect and who as: passwords in them (encrypted for the computer that wrote them) are never taken.
 * What is read is checked again when it is saved, as if typed in.
 */
export interface ImportedConnection {
  label: string;
  host: string;
  port: number | null;
  protocol: ConnectionProtocol;
  username: string | null;
  notes: string;
}

const MAX_FILE = 4 * 1024 * 1024;
const MAX_CONNECTIONS = 1000;

/** The file's text: UTF-16 (with its byte order mark, as Windows writes .rdp files) or UTF-8. */
export function importText(buf: Buffer): string {
  if (buf.length > MAX_FILE) throw new Error('That file is too large to be a connection list');
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

/** "host", "host:port", "[v6]:port". */
function hostPort(v: string): { host: string; port: number | null } {
  const s = v.trim();
  const v6 = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(s);
  if (v6) return { host: v6[1]!, port: v6[2] ? Number(v6[2]) : null };
  const m = /^([^:\s]+):(\d{1,5})$/.exec(s);
  return m ? { host: m[1]!, port: Number(m[2]) } : { host: s, port: null };
}

const withDomain = (user: string | undefined, domain: string | undefined) => {
  const u = user?.trim();
  if (!u) return null;
  if (u.includes('\\') || u.includes('@') || !domain?.trim()) return u;
  return `${domain.trim()}\\${u}`;
};

/** A .rdp file: one remote desktop. */
export function parseRdpFile(text: string, fileName = ''): ImportedConnection[] {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-z0-9 :_-]+?):([isb]):(.*)$/i.exec(line.trim());
    if (m) fields.set(m[1]!.toLowerCase(), m[3]!);
  }
  const address = fields.get('full address') ?? fields.get('alternate full address');
  if (!address) throw new Error('This .rdp file has no computer address (full address)');
  const { host, port } = hostPort(address);
  const serverPort = Number(fields.get('server port'));
  const gateway = fields.get('gatewayhostname');
  return [
    {
      label: fileName.replace(/\.rdp$/i, '').trim() || host,
      host,
      port: port ?? (Number.isInteger(serverPort) && serverPort > 0 ? serverPort : null),
      protocol: 'rdp',
      username: withDomain(fields.get('username'), fields.get('domain')),
      notes: ['From a Remote Desktop file', gateway ? `It used the remote desktop gateway ${gateway}, which View does not use yet.` : ''].filter(Boolean).join('. '),
    },
  ];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()]!));

/** The first <tag>value</tag> in xml (any depth), without CDATA or markup. */
function tag(xml: string, ...names: string[]): string | undefined {
  for (const n of names) {
    const m = new RegExp(`<${n}(?:\\s[^>]*)?>([^<]*)</${n}>`, 'i').exec(xml);
    if (m && m[1]!.trim()) return decode(m[1]!.trim());
  }
  return undefined;
}

/** Remote Desktop Manager's connection kinds, as FBRX View connects to them. */
function rdmKind(type: string | undefined): ConnectionProtocol | null {
  const t = (type ?? '').toLowerCase();
  if (t.startsWith('rdp')) return 'rdp';
  if (t.includes('vnc')) return 'vnc';
  if (t.includes('ssh') || t === 'putty' || t.includes('terminal')) return 'ssh';
  if (t.includes('telnet')) return 'telnet';
  return null;
}

/** A Remote Desktop Manager export (XML): its remote desktop, VNC, SSH and Telnet entries; folders and others are left. */
export function parseRdmExport(text: string): { connections: ImportedConnection[]; skipped: number } {
  if (!/<Connection[\s>]/i.test(text)) throw new Error('This is not a Remote Desktop Manager export (no connections in it)');
  const out: ImportedConnection[] = [];
  let skipped = 0;
  for (const m of text.matchAll(/<Connection(?:\s[^>]*)?>([\s\S]*?)<\/Connection>/gi)) {
    if (out.length >= MAX_CONNECTIONS) break;
    const xml = m[1]!;
    const protocol = rdmKind(tag(xml, 'ConnectionType'));
    const name = tag(xml, 'Name');
    // The address: the entry's Url, or the Host of its settings (SSH and VNC keep it there).
    const address = tag(xml, 'Url', 'Host', 'HostName');
    if (!protocol || !address) {
      skipped++;
      continue;
    }
    const { host, port } = hostPort(address);
    const p = Number(tag(xml, 'Port', 'HostPort', 'VNCPort'));
    const group = tag(xml, 'Group');
    out.push({
      label: name ?? host,
      host,
      port: port ?? (Number.isInteger(p) && p > 0 && p < 65536 ? p : null),
      protocol,
      username: withDomain(tag(xml, 'UserName', 'Username', 'User'), tag(xml, 'Domain')),
      notes: `From Remote Desktop Manager${group ? ` (folder ${group})` : ''}`,
    });
  }
  return { connections: out, skipped };
}

/** A file the person chose: which kind it is, by its name and what is in it. */
export function parseConnectionFile(buf: Buffer, fileName: string): { connections: ImportedConnection[]; skipped: number } {
  const text = importText(buf);
  if (/\.rdp$/i.test(fileName) || /^\s*full address:s:/im.test(text)) return { connections: parseRdpFile(text, fileName), skipped: 0 };
  if (/\.(rdm|xml)$/i.test(fileName) || /<Connection[\s>]/i.test(text)) return parseRdmExport(text);
  throw new Error('View imports Remote Desktop files (.rdp) and Remote Desktop Manager exports (.rdm, XML)');
}
