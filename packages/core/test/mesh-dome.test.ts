import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MeshNetworkComputer, MeshNetworkFinding } from '@fbrx/shared';
import { makeKernel, waitFor, USER } from './helpers';
import type { Kernel } from '../src/kernel';

/**
 * Network protection: a gate's FBRX MiniDome (through the FBRX core on the gate) tells a paired computer what it saw
 * coming from it, and sees how that computer is protected, only when the computer allows it.
 */
let G: Awaited<ReturnType<typeof makeKernel>>;
let L: Awaited<ReturnType<typeof makeKernel>>;
let kg: Kernel;
let kl: Kernel;
let gateOnLaptop = '';

const finding: MeshNetworkFinding = {
  kind: 'bad-domain',
  severity: 'serious',
  title: 'sam-laptop asked for a known-bad name',
  detail: 'cdn.evil.example is on a threat list.',
  subject: 'evil.example',
  evidence: ['12:00:01 A cdn.evil.example'],
  at: new Date().toISOString(),
};

beforeAll(async () => {
  G = await makeKernel();
  L = await makeKernel();
  kg = G.kernel;
  kl = L.kernel;
  kg.settings.update({ mesh: { enabled: true, port: 47851 }, general: { deviceName: 'gate' } });
  kl.settings.update({ mesh: { enabled: true, port: 47852 }, general: { deviceName: 'sam-laptop' } });
  await waitFor(() => kg.mesh.running && kl.mesh.running);
  const pairing = (await kl.call('mesh.startPairing', undefined, USER)) as { code: string };
  const peer = (await kg.call('mesh.pair', { code: pairing.code, host: '127.0.0.1:47852' }, USER)) as { id: string };
  expect(peer.id).toBeTruthy();
  gateOnLaptop = kl.mesh.devices()[0].id;
}, 60_000);

afterAll(async () => {
  await L?.cleanup();
  await G?.cleanup();
});

describe('Network protection over FBRX Mesh', () => {
  it('is off until the computer allows it', async () => {
    expect(kl.mesh.devices()[0].permissions.network).toBe(false);
    expect(await kg.call('mesh.network.notify', { address: '127.0.0.1', finding }, USER)).toEqual({ delivered: null });
    const pcs = (await kg.call('mesh.network.computers', undefined, USER)) as MeshNetworkComputer[];
    expect(pcs).toHaveLength(1);
    expect(pcs[0]).toMatchObject({ name: 'sam-laptop', protection: null });
    expect(pcs[0].addresses).toContain('127.0.0.1');
  });

  it('turns what the gate saw into an alert on the computer', async () => {
    await kl.call('mesh.setPermissions', { id: gateOnLaptop, permissions: { network: true } }, USER);
    expect(await kg.call('mesh.network.notify', { address: '127.0.0.1', finding }, USER)).toEqual({ delivered: 'sam-laptop' });
    await waitFor(() => kl.alerts.inbox({ limit: 10 }).some((a) => a.ruleId === 'network_threat'));
    const alert = kl.alerts.inbox({ limit: 10 }).find((a) => a.ruleId === 'network_threat')!;
    expect(alert).toMatchObject({ severity: 'critical', title: finding.title });
    expect(alert.body).toContain('Seen by FBRX MiniDome on gate');
    // Nobody else's address: nobody is told.
    expect(await kg.call('mesh.network.notify', { address: '10.9.9.9', finding }, USER)).toEqual({ delivered: null });
    await expect(kg.call('mesh.network.notify', { address: 'not-an-address', finding }, USER)).rejects.toThrow();
  });
});
