import { networkOf } from '@fbrx/shared';
import type { GateConfig, GatePeer } from '../model';

/**
 * The settings file for a device joining the gate's VPN (WireGuard): shown once as text and a QR code, with the
 * private key the gate made for it. The gate keeps only the device's public key.
 */
export function peerConfig(o: { config: GateConfig; peer: GatePeer; privateKey: string; gatePublicKey: string; endpoint: string; fullTunnel: boolean }): string {
  const c = o.config;
  const dns = c.vpn.address.split('/')[0];
  const allowed = o.fullTunnel ? ['0.0.0.0/0'] : [networkOf(c.vpn.address), ...(c.vpn.access === 'full' ? c.networks.map((n) => networkOf(n.address)) : [])];
  return [
    '[Interface]',
    `# ${o.peer.name}`,
    `PrivateKey = ${o.privateKey}`,
    `Address = ${o.peer.address}/32`,
    `DNS = ${dns}`,
    '',
    '[Peer]',
    `# ${c.hostname} (FBRX Gate)`,
    `PublicKey = ${o.gatePublicKey}`,
    `Endpoint = ${o.endpoint.includes(':') ? o.endpoint : `${o.endpoint}:${c.vpn.port}`}`,
    `AllowedIPs = ${allowed.join(', ')}`,
    `PersistentKeepalive = ${o.peer.keepalive || 25}`,
    '',
  ].join('\n');
}
