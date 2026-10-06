import type { ShieldDetection } from '@fbrx/shared';
import { CoreError } from '../../errors';
import type { ProtectionService } from '../../protection/protection-service';
import type { Shield } from '../../protection/shield';
import type { ToolSpec } from '../types';

/**
 * The agent's view of the antivirus (FBRX Shield page): which antivirus protects the computer and how it is doing,
 * what FBRX Shield found, scanning a file or folder (report only), and quarantining a finding (with approval).
 */
export function shieldTools(protection: ProtectionService, shield: Shield): ToolSpec[] {
  const tool = (t: Omit<ToolSpec, 'source' | 'sourceId'>): ToolSpec => ({ source: 'builtin', sourceId: null, ...t });
  const line = (d: ShieldDetection) => `- [${d.id}] ${d.kind === 'suspicious' ? 'Suspicious' : d.kind === 'test' ? 'Test file' : 'Malware'}: ${d.name} — ${d.path} (${d.reason}) · ${d.action}${d.source === 'download' ? ' · new download' : ''}`;
  return [
    tool({
      name: 'shield.status',
      title: 'Antivirus status',
      description:
        'Which antivirus protects this computer (FBRX Shield, Microsoft Defender, or one installed like Sophos), whether it is on and up to date, problems, the threat database, and what FBRX Shield found recently. Use it for any question about antivirus, malware or whether the computer is protected.',
      risk: 'read',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const s = await protection.status(true);
        const recent = shield.detections(15);
        const lines = [
          `Protected by: ${s.active.name}${s.choice === 'auto' ? ' (chosen automatically)' : ''}${s.managed ? ' (set by the organization)' : ''}`,
          `State: ${s.state}${s.realtime === null ? '' : `, real-time ${s.realtime ? 'on' : 'off'}`}${s.upToDate === null ? '' : `, definitions ${s.upToDate ? 'up to date' : 'out of date'}`}${s.lastScan ? `, last scan ${s.lastScan}` : ''}`,
          `Threats waiting: ${s.threats}`,
          ...(s.problems.length ? ['Problems:', ...s.problems.map((p) => `- ${p}`)] : []),
          ...(s.notes.length ? ['Notes:', ...s.notes.map((p) => `- ${p}`)] : []),
          `Antivirus found on this computer: ${s.products.map((p) => `${p.name}${p.realtime === false ? ' (off)' : ''}`).join(', ') || 'none besides FBRX Shield'}`,
          `FBRX Shield: threat database ${s.shield.signatures} fingerprints${s.shield.signaturesUpdatedAt ? ` (updated ${s.shield.signaturesUpdatedAt})` : ''}, download checks ${s.shield.watching.length ? 'on' : 'off'}, ${s.shield.quarantined} in quarantine`,
          ...(recent.length ? ['Recent FBRX Shield findings:', ...recent.map(line)] : ['FBRX Shield has found nothing.']),
        ];
        return { output: lines.join('\n'), data: { status: s, recent } };
      },
    }),
    tool({
      name: 'shield.scan',
      title: 'Scan with FBRX Shield',
      description: 'Scans a file or folder with FBRX Shield and reports what it finds. It only reports: nothing is moved or deleted (use shield.quarantine for that, with the person’s approval).',
      risk: 'read',
      timeoutMs: 30 * 60_000,
      inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string', description: 'A file or folder' } } },
      // The folder goes through the same file-access policy as reading it.
      resources: (i: { path: string }) => ({ paths: [{ path: i.path, access: 'read' }] }),
      async run(i: { path: string }, ctx) {
        const r = await shield.scan([i.path], { signal: ctx.signal, quarantine: false, onProgress: () => undefined });
        const out = [`Scanned ${r.files} file${r.files === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} could not be read)` : ''} in ${i.path}.`, r.detections.length ? 'Found:' : 'Nothing found.', ...r.detections.map(line)];
        return { output: out.join('\n'), data: r };
      },
    }),
    tool({
      name: 'shield.quarantine',
      title: 'Quarantine a file',
      description: 'Moves a file FBRX Shield found (by its detection id from shield.status or shield.scan) into quarantine, where it cannot run. It can be restored from FBRX Shield.',
      risk: 'write',
      inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      async run(i: { id: string }) {
        const d = shield.detection(i.id);
        if (d.action !== 'open') throw new CoreError('CONFLICT', `That finding is already ${d.action}.`);
        const done = await shield.quarantine(i.id);
        return { output: done.action === 'quarantined' ? `${done.path} is in quarantine.` : `${done.path} is gone already.`, data: done };
      },
    }),
  ];
}
