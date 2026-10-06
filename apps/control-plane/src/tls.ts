import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { certificateInfo, createSelfSignedCertificate } from '@fbrx/shared/node';
import type { Config } from './config';

export interface TlsMaterial {
  key: string;
  cert: string;
  fingerprint: string;
  /** No public authority vouches for it: computers pin its fingerprint. */
  selfSigned: boolean;
  notAfter: string;
}

/** This computer's names and network addresses, for the certificate (browsers check them; pinning does not). */
export function localNames(): string[] {
  const host = hostname().replace(/\.local$/i, '');
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((n): n is NonNullable<typeof n> => !!n && !n.internal && (n.family === 'IPv4' || (n.family === 'IPv6' && !n.address.startsWith('fe80'))))
    .map((n) => n.address);
  return [host, `${host}.local`, 'localhost', '127.0.0.1', '::1', ...ips];
}

/**
 * The certificate FBRX Command serves HTTPS with. A self-signed one is made once and kept in the data folder
 * (tls/command.crt and .key), so its fingerprint stays the same and computers that trusted it keep working.
 */
export function loadTls(config: Config): TlsMaterial | null {
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
  const certFile = join(dir, 'command.crt');
  const keyFile = join(dir, 'command.key');
  if (existsSync(certFile) && existsSync(keyFile)) {
    const cert = readFileSync(certFile, 'utf8');
    const key = readFileSync(keyFile, 'utf8');
    const info = certificateInfo(cert, key);
    if (info.matchesKey && new Date(info.notAfter).getTime() > Date.now() + 86400_000) return { cert, key, fingerprint: info.fingerprint, selfSigned: true, notAfter: info.notAfter };
  }
  mkdirSync(dir, { recursive: true });
  const names = [...localNames(), ...t.names];
  const made = createSelfSignedCertificate({ commonName: names[0] ?? 'fbrx-command', names: names.slice(1) });
  writeFileSync(keyFile, made.keyPem, { mode: 0o600 });
  try {
    chmodSync(keyFile, 0o600);
  } catch {
    /* Windows */
  }
  writeFileSync(certFile, made.certPem);
  return { cert: made.certPem, key: made.keyPem, fingerprint: made.fingerprint, selfSigned: true, notAfter: made.notAfter };
}
