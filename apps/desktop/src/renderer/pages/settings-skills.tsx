import { useState } from 'react';
import { SKILL_LIMITS, type Skill } from '@fbrx/shared';
import { Badge, Button, Card, Empty, Field, Input, Modal, TextArea, Toggle, timeAgo, useAction, useConfirm } from '@fbrx/ui';
import { call } from '../client';
import { useAgentName, useCore } from '../hooks';

/**
 * Settings → Skills: the jobs the AI knows how to do step by step. Starter skills come with FBRX; learned ones are the
 * ones it offered to keep after a job (each kept only when you approved it); yours are the ones you write. The ones
 * that fit a request go with it, so even a small model follows steps that worked before.
 */

const SOURCE: Record<Skill['source'], string> = { starter: 'Starter', learned: 'Learned', yours: 'Yours' };

type Draft = { id?: string; name: string; when: string; steps: string };

export function SkillsSettings() {
  const name = useAgentName();
  const skills = useCore('skills.list', undefined, ['skills.changed']);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const save = async () => {
    if (!draft) return;
    const steps = draft.steps.split('\n').map((s) => s.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
    const r = await run('save', () => call('skills.save', { ...(draft.id ? { id: draft.id } : {}), name: draft.name, when: draft.when, steps }), 'Skill saved');
    if (r) setDraft(null);
  };
  const remove = async (s: Skill) => {
    if (await confirm({ title: `Delete "${s.name}"?`, body: `${name} no longer follows these steps.`, confirmLabel: 'Delete', danger: true })) await run(`rm:${s.id}`, () => call('skills.remove', { id: s.id }));
  };

  return (
    <Card
      title="Skills"
      subtitle={`Jobs ${name} knows how to do step by step. The ones that fit what you ask go with your message.`}
      actions={
        <Button size="sm" icon="plus" onClick={() => setDraft({ name: '', when: '', steps: '' })}>
          Add a skill
        </Button>
      }
    >
      {!skills.data?.length ? (
        <Empty title="No skills yet" />
      ) : (
        <div className="fx-list">
          {skills.data.map((s) => (
            <div key={s.id} className="fx-list-item" style={{ alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="fx-cell-title">
                  {s.name} <Badge>{SOURCE[s.source]}</Badge>
                </div>
                <div className="fx-cell-sub">
                  {s.when}
                  {s.uses ? ` · used ${s.uses} time${s.uses === 1 ? '' : 's'}${s.lastUsedAt ? `, last ${timeAgo(s.lastUsedAt)}` : ''}` : ''}
                </div>
                {open === s.id && (
                  <ol className="skill-steps">
                    {s.steps.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ol>
                )}
              </div>
              <Button size="sm" variant="ghost" onClick={() => setOpen(open === s.id ? null : s.id)}>
                {open === s.id ? 'Hide steps' : 'Steps'}
              </Button>
              {s.source !== 'starter' && (
                <>
                  <Button size="sm" variant="ghost" icon="edit" aria-label="Edit" onClick={() => setDraft({ id: s.id, name: s.name, when: s.when, steps: s.steps.join('\n') })} />
                  <Button size="sm" variant="ghost" icon="trash" aria-label="Delete" loading={busy === `rm:${s.id}`} onClick={() => void remove(s)} />
                </>
              )}
              <Toggle checked={s.enabled} title={s.enabled ? 'On: goes with requests it fits' : 'Off'} onChange={(on) => void run(`on:${s.id}`, () => call('skills.setEnabled', { id: s.id, enabled: on }))} />
            </div>
          ))}
        </div>
      )}
      {draft && (
        <Modal
          title={draft.id ? 'Edit the skill' : 'Add a skill'}
          description={`${name} follows these steps when a request fits the name or the "when".`}
          onClose={() => setDraft(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button variant="primary" loading={busy === 'save'} disabled={!draft.name.trim() || !draft.steps.trim()} onClick={() => void save()}>
                Save
              </Button>
            </>
          }
        >
          <Field label="Name">
            <Input value={draft.name} maxLength={SKILL_LIMITS.name} placeholder="Set up the office printer" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label="When to use it">
            <Input value={draft.when} maxLength={SKILL_LIMITS.when} placeholder="Adding the office printer to a computer" onChange={(e) => setDraft({ ...draft, when: e.target.value })} />
          </Field>
          <Field label="Steps" help="One per line, in order. Name the tools when you know them (net.scan_lan, pc.storage_report…).">
            <TextArea rows={7} value={draft.steps} onChange={(e) => setDraft({ ...draft, steps: e.target.value })} />
          </Field>
        </Modal>
      )}
      {dialog}
    </Card>
  );
}
