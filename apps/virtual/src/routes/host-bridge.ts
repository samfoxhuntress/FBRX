import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HostBridgeStatus } from '@fbrx/shared';
import { audited, need, type VirtualContext } from '../context';
import { badRequest, conflict } from '../errors';
import { BRIDGE, bridgeInterfaces, hostPorts, outerHypervisor, portSetting } from '../host-bridge';
import { readEnv } from './roles';

/**
 * Networks → Bridge a port: the console makes bridge br0 on one of the server's ports (in /etc/network/interfaces), so
 * virtual machines sit straight on that network, and restarts the server for it to take over. Administrators only.
 */
export async function hostBridgeRoutes(app: FastifyInstance, ctx: VirtualContext) {
  const root = ctx.config.sysRoot;
  const file = join(root, 'etc/network/interfaces');
  const pendingFile = join(ctx.config.server.stateDir, 'bridge.env');
  const live = () => existsSync(join(root, 'sys/class/net', BRIDGE));
  const elsewhere = () => {
    const dir = join(root, 'etc/network/interfaces.d');
    try {
      return readdirSync(dir)
        .map((f) => readFileSync(join(dir, f), 'utf8'))
        .join('\n');
    } catch {
      return '';
    }
  };
  const pending = () => {
    const v = readEnv(pendingFile);
    if (!v.PORT) return null;
    // It took over at the last restart.
    if (live()) {
      rmSync(pendingFile, { force: true });
      return null;
    }
    return { port: v.PORT, at: v.AT ?? '' };
  };
  const gatePorts = ctx.config.roles.includes('gate') ? [ctx.config.gate.wan, ctx.config.gate.lan] : [];

  const status = (): HostBridgeStatus => {
    const text = existsSync(file) ? readFileSync(file, 'utf8') : null;
    const waiting = pending();
    const why = !text
      ? 'This server does not keep its network settings in /etc/network/interfaces: add the bridge in its own network settings'
      : waiting
        ? `The bridge on ${waiting.port} is saved: restart the server for it to take over`
        : live() || new RegExp(`^\\s*iface\\s+${BRIDGE}\\b`, 'm').test(text + elsewhere())
          ? `${BRIDGE} is already set up on this server`
          : null;
    const ports = hostPorts(root).map((p) => {
      const mode = text ? portSetting(text, p.name).mode : 'none';
      const note = gatePorts.includes(p.name) ? 'One of FBRX Gate’s ports' : p.bridge ? `Already in ${p.bridge}` : mode === 'other' ? 'Set up in a way FBRX Server does not change by itself' : null;
      return { name: p.name, mac: p.mac, addresses: p.addresses, up: p.up, mode, usable: !why && !note, note };
    });
    return { canMake: !why && ports.some((p) => p.usable), why: why ?? (ports.some((p) => p.usable) ? null : 'No network port here can be bridged'), ports, outer: outerHypervisor(root), pending: waiting, canRestart: existsSync(ctx.config.server.command) };
  };

  app.get('/v1/networks/host-bridge', async (req) => {
    need(req, 'admin');
    return status();
  });

  app.post('/v1/networks/host-bridge', async (req) => {
    need(req, 'admin');
    const { port } = z.object({ port: z.string().regex(/^[A-Za-z0-9._-]{1,15}$/, 'That is not a network port') }).parse(req.body);
    const st = status();
    if (st.why) throw conflict(st.why);
    const p = st.ports.find((x) => x.name === port);
    if (!p) throw badRequest(`This server has no network port ${port}`);
    if (!p.usable) throw conflict(p.note ?? `${port} cannot be bridged`);
    return audited(
      ctx,
      req,
      'network.bridge',
      port,
      () => {
        const before = readFileSync(file, 'utf8');
        let next: string;
        try {
          next = bridgeInterfaces(before, port, elsewhere());
        } catch (e) {
          throw badRequest((e as Error).message);
        }
        // The file as it was is kept once (the first time), and the new one goes in whole.
        if (!existsSync(`${file}.fbrx-backup`)) copyFileSync(file, `${file}.fbrx-backup`);
        writeFileSync(`${file}.fbrx-new`, next);
        renameSync(`${file}.fbrx-new`, file);
        mkdirSync(ctx.config.server.stateDir, { recursive: true });
        writeFileSync(pendingFile, `PORT=${port}\nAT=${new Date().toISOString()}\n`);
        return status();
      },
      { port, mode: p.mode },
    );
  });

  // Restarting the server (after a bridge, or whenever an administrator asks): FBRX Server only.
  app.post('/v1/server/restart', async (req) => {
    need(req, 'admin');
    if (!existsSync(ctx.config.server.command)) throw conflict('The server can be restarted from here on FBRX Server only');
    return audited(ctx, req, 'server.restart', null, () => {
      // A moment for the answer (and the audit line) to get out first.
      setTimeout(() => spawn('systemctl', ['reboot'], { detached: true, stdio: 'ignore' }).unref(), 1500).unref?.();
      return { restarting: true };
    });
  });
}
