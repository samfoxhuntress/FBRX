import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { certificateInfo, createSelfSignedCertificate } from '@fbrx/shared/node';
import type { VirtualConfig } from './config';

export interface TlsMaterial {
  key: string;
  cert: string;
  fingerprint: string;
  selfSigned: boolean;
  notAfter: string;
}

function localNames(): string[] {
  const host = hostname().replace(/\.local$/i, '');
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((n): n is NonNullable<typeof n> => !!n && !n.internal && (n.family === 'IPv4' || (n.family === 'IPv6' && !n.address.startsWith('fe80'))))
    .map((n) => n.address);
  return [host, `${host}.local`, 'localhost', '127.0.0.1', '::1', ...ips];
}

/** FBRX Virtual's HTTPS certificate: one you have, or its own (made once, kept in the data folder as tls/virtual.*). */
export function loadTls(config: VirtualConfig): TlsMaterial | null {
  const t = config.tls;
  if (!t) return null;
  if (t.mode === 'files') {
    const cert = readFileSync(t.certFile, 'utf8');
    const key = readFileSync(t.keyFile, 'utf8');
    const info = certificateInfo(cert, key);
    if (!info.matchesKey) throw new Error(`The TLS key ${t.keyFile} does not belong to the certificate ${t.certFile}`);
    return { cert, key, fingerprint: info.fingerprint, selfSigned: info.selfSigned, notAfter: info.notAfter };
  }
  const dir = join(config.dataDir, 'tls');
  const certFile = join(dir, 'virtual.crt');
  const keyFile = join(dir, 'virtual.key');
  if (existsSync(certFile) && existsSync(keyFile)) {
    const cert = readFileSync(certFile, 'utf8');
    const key = readFileSync(keyFile, 'utf8');
    const info = certificateInfo(cert, key);
    if (info.matchesKey && new Date(info.notAfter).getTime() > Date.now() + 86400_000) return { cert, key, fingerprint: info.fingerprint, selfSigned: true, notAfter: info.notAfter };
  }
  mkdirSync(dir, { recursive: true });
  const names = [...localNames(), ...t.names];
  const made = createSelfSignedCertificate({ commonName: names[0] ?? 'fbrx-virtual', names: names.slice(1), organization: 'FBRX Virtual' });
  writeFileSync(keyFile, made.keyPem, { mode: 0o600 });
  try {
    chmodSync(keyFile, 0o600);
  } catch {
    /* windows */
  }
  writeFileSync(certFile, made.certPem);
  return { cert: made.certPem, key: made.keyPem, fingerprint: made.fingerprint, selfSigned: true, notAfter: made.notAfter };
}
