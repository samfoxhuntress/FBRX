import { describe, expect, it } from 'vitest';
import { OrgMesh } from '../src/mesh/org-mesh';

describe('the organization mesh', () => {
  it('does nothing once stopped, so a roster pushed while FBRX shuts down never reads the closed database', async () => {
    let asked = 0;
    const log = { debug() {}, info() {}, warn() {}, error() {} } as never;
    const mesh = new OrgMesh({
      enrolled: () => {
        asked++;
        return false;
      },
      roster: async () => ({ tenantName: 'Org', enabled: false, peers: [] }) as never,
      syncPeers: () => ({ added: 0, removed: 0 }),
      meshEnabled: () => true,
      enableMesh: () => true,
      log,
    });
    await mesh.sync();
    expect(asked).toBe(1);
    mesh.stop();
    await mesh.sync();
    expect(asked).toBe(1);
  });
});
