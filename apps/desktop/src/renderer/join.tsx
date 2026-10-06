import { useState, type ReactNode } from 'react';
import type { FleetProbe } from '@fbrx/shared';
import { Button, Callout, Field, Input, Toggle, useAction } from '@fbrx/ui';
import { call } from './client';

/**
 * Joining FBRX Command (Organization page and first-run setup). An https:// address whose certificate no authority
 * vouches for (FBRX Command on a home or school network, with its own certificate) is joined only after the person
 * checks its fingerprint against the one FBRX Command shows under Deploy & enroll; from then on this computer trusts
 * that certificate and no other.
 */
export function JoinForm({ onJoined, extraActions, showDeviceName = true, studentNote }: { onJoined?: () => void; extraActions?: ReactNode; showDeviceName?: boolean; studentNote?: string }) {
  const [form, setForm] = useState({ serverUrl: '', token: '', deviceName: '', student: false });
  const [check, setCheck] = useState<FleetProbe | null>(null);
  const { run, busy } = useAction();

  const enroll = (fingerprint?: string) =>
    run(
      'join',
      () =>
        call('fleet.enroll', {
          serverUrl: check?.serverUrl ?? form.serverUrl,
          token: form.token,
          deviceName: form.deviceName || undefined,
          ...(form.student ? { audience: 'student' as const } : {}),
          ...(fingerprint ? { fingerprint } : {}),
        }).then((s) => {
          setCheck(null);
          onJoined?.();
          return s;
        }),
      'Connected to FBRX Command',
    );
  const connect = async () => {
    const probe = await run('join', () => call('fleet.probe', { serverUrl: form.serverUrl }));
    if (!probe) return;
    if (probe.certificate && !probe.certificate.trusted) setCheck(probe);
    else await enroll();
  };
  const edit = (patch: Partial<typeof form>) => {
    setForm({ ...form, ...patch });
    if (patch.serverUrl !== undefined) setCheck(null);
  };

  return (
    <div className="fx-form">
      <Field label="FBRX Command address" help="From whoever runs FBRX Command for you (IT, the school office or a parent): FBRX Command → Deploy & enroll shows it.">
        <Input value={form.serverUrl} onChange={(e) => edit({ serverUrl: e.target.value })} placeholder="https://192.168.1.20:8787" />
      </Field>
      <Field label="Enrollment token">
        <Input value={form.token} onChange={(e) => edit({ token: e.target.value.trim() })} placeholder="fbrx_enr_…" />
      </Field>
      {showDeviceName && (
        <Field label="Device name (optional)">
          <Input value={form.deviceName} onChange={(e) => edit({ deviceName: e.target.value })} />
        </Field>
      )}
      <Toggle checked={form.student} onChange={(v) => edit({ student: v })} label="This computer is for a student or a child" />
      {form.student && <p className="fx-muted" style={{ margin: 0, fontSize: 12.5 }}>{studentNote ?? 'It becomes FBRX OS Education (at a school) or FBRX OS Home (in a family): a simpler set of tools and a safe learning helper. Only FBRX Command can turn it back.'}</p>}
      {check?.certificate && (
        <Callout tone="warning" title="Check FBRX Command's certificate">
          <p style={{ margin: '4px 0 8px' }}>
            {check.serverUrl} uses its own certificate (normal for FBRX Command on a home or school network). Make sure this fingerprint is the same as the one in FBRX Command → Deploy & enroll before you trust it:
          </p>
          <code className="join-fp">{check.certificate.fingerprint}</code>
          <div className="fx-actions" style={{ marginTop: 10 }}>
            <Button variant="primary" icon="shield" loading={busy === 'join'} onClick={() => void enroll(check.certificate!.fingerprint)}>
              It matches: trust and connect
            </Button>
            <Button onClick={() => setCheck(null)}>Cancel</Button>
          </div>
        </Callout>
      )}
      {!check && (
        <div className="fx-actions" style={{ justifyContent: extraActions ? 'flex-end' : undefined }}>
          {extraActions}
          <Button variant="primary" icon="globe" loading={busy === 'join'} disabled={!form.serverUrl.trim() || !form.token} onClick={() => void connect()}>
            Connect
          </Button>
        </div>
      )}
    </div>
  );
}
