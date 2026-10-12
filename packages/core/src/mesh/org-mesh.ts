import type { OrgMeshPeer, OrgMeshRoster } from '@fbrx/shared';
import type { Logger } from '../logger';
import { errorMessage } from '../errors';

/** How often the roster is fetched besides FBRX Command's own nudges (a computer joined, settings changed). */
const EVERY_MS = 10 * 60_000;

export interface OrgMeshDeps {
  enrolled: () => boolean;
  roster: () => Promise<OrgMeshRoster>;
  syncPeers: (peers: OrgMeshPeer[]) => { added: number; removed: number };
  meshEnabled: () => boolean;
  /** Turns FBRX Mesh on for the organization (false when a managed setting keeps it off). */
  enableMesh: () => boolean;
  log: Logger;
}

export interface OrgMeshState {
  organization: string;
  enabled: boolean;
  peers: number;
  syncedAt: string;
  error: string | null;
}

/**
 * The organization's FBRX Mesh on this computer: FBRX Command introduces the organization's other computers (and
 * vouches for their keys), so they mesh without pairing codes, with the permissions the organization chose. Leaving
 * the organization, or the organization turning it off, forgets them; computers paired by hand stay.
 */
export class OrgMesh {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private last: OrgMeshState | null = null;

  constructor(private readonly d: OrgMeshDeps) {}

  start(): void {
    this.timer ??= setInterval(() => void this.sync(), EVERY_MS);
    this.timer.unref?.();
    void this.sync();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  state(): OrgMeshState | null {
    return this.last;
  }

  /** Fetches the roster and applies it (one at a time; a second call waits for the first). */
  sync(): Promise<void> {
    this.running ??= this.run().finally(() => (this.running = null));
    return this.running;
  }

  private async run(): Promise<void> {
    if (!this.d.enrolled()) {
      this.d.syncPeers([]);
      this.last = null;
      return;
    }
    try {
      const r = await this.d.roster();
      if (r.enabled && !this.d.meshEnabled() && !this.d.enableMesh()) this.d.log.info('The organization meshes its computers, but a managed setting keeps FBRX Mesh off here');
      const res = this.d.syncPeers(r.enabled ? r.peers : []);
      if (res.added || res.removed) this.d.log.info('Organization mesh updated', { added: res.added, removed: res.removed });
      this.last = { organization: r.tenantName, enabled: r.enabled, peers: r.enabled ? r.peers.length : 0, syncedAt: new Date().toISOString(), error: null };
    } catch (e) {
      // FBRX Command unreachable or older than 1.9.5: keep what is known.
      this.d.log.debug('Organization mesh not updated', { error: errorMessage(e) });
      if (this.last) this.last = { ...this.last, error: errorMessage(e) };
    }
  }
}
