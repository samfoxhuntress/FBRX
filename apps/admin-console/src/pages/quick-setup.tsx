import { useState } from 'react';
import { AUDIENCE_NAMES, KIND_GROUPS, VERTICAL_INFO, type Audience, type Vertical } from '@fbrx/shared';
import { Button, Callout, CopyText, Field, useAction } from '@fbrx/ui';
import { api, saveBlob } from '../api';

interface Made {
  group: { id: string; name: string };
  audience: Audience;
  token: string;
  provisioning: Record<string, unknown>;
}

export const QUICK_SETUP_TITLE: Record<Vertical, string> = { business: 'Set up for work', education: 'Set up for a school', home: 'Set up for a family' };

/** True when the tenant already has every group its kind's quick setup would make. */
export function quickSetupDone(vertical: Vertical, groupNames: string[]): boolean {
  return KIND_GROUPS[vertical].every((g) => groupNames.includes(g.name));
}

/**
 * One click for the tenant's kind: Staff and IT (Work), Teachers, IT and Students (School), Parents and Children
 * (Home), each group with its own enrollment token. Tokens are shown once.
 */
export function QuickSetup({ tenantId, vertical, onDone }: { tenantId: string; vertical: Vertical; onDone?: () => void }) {
  const { run, busy } = useAction();
  const [made, setMade] = useState<Made[] | null>(null);
  const plan = KIND_GROUPS[vertical];
  const setUp = () =>
    run(
      'quick',
      async () => {
        const r = await api<{ groups: Made[] }>('POST', `/v1/admin/tenants/${tenantId}/quick-setup`, {});
        setMade(r.groups);
        onDone?.();
      },
      'Groups and tokens ready',
    );
  if (made) {
    return (
      <div className="fx-form">
        <Callout tone="good" title="Copy these tokens now">
          They are shown once. Install FBRX on each computer with its group's token: paste it on FBRX's Organization page, or put the downloaded file next to the installer. Deploy & enroll makes more tokens and device-manager files.
        </Callout>
        {made.map((m) => (
          <Field key={m.group.id} label={m.group.name} help={`For ${AUDIENCE_NAMES[m.audience].toLowerCase()} computers${m.audience === 'student' ? ': FBRX OS Education' : m.audience === 'child' ? ': FBRX OS Home' : ''}`}>
            <div className="fx-actions" style={{ flexWrap: 'nowrap' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <CopyText value={m.token} />
              </div>
              <Button size="sm" icon="download" onClick={() => saveBlob(new Blob([JSON.stringify(m.provisioning, null, 2)], { type: 'application/json' }), `fbrx-provision-${m.group.name.toLowerCase()}.json`)}>
                File
              </Button>
            </div>
          </Field>
        ))}
      </div>
    );
  }
  return (
    <div className="fx-form">
      <ul className="fx-quick-plan">
        {plan.map((g) => (
          <li key={g.name}>
            <b>{g.name}</b> <span className="fx-secondary">{g.description}</span>
          </li>
        ))}
      </ul>
      <div className="fx-actions">
        <Button variant="primary" icon="plus" loading={busy === 'quick'} onClick={() => void setUp()}>
          Create {plan.map((g) => g.name).join(', ').replace(/, ([^,]*)$/, ' and $1')} groups
        </Button>
        <span className="fx-secondary" style={{ fontSize: 12 }}>
          Each gets an enrollment token. Help desk requests go to {VERTICAL_INFO[vertical].helpers}.
        </span>
      </div>
    </div>
  );
}
