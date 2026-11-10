import { useEffect, useMemo, useState } from 'react';
import { SOUL_LIMITS, soulCommands } from '@fbrx/shared';
import { Badge, Button, Card, TextArea, timeAgo, useAction, useConfirm } from '@fbrx/ui';
import { call } from '../client';
import { useAgentName, useCore } from '../hooks';

/**
 * Settings → Soul: soul.md, the AI's persona (who it is, how it talks, the options you set, the commands you can type,
 * its toolkits and its notes). You edit it here; the AI changes it only with your yes (soul.update), and every change
 * keeps the version before it, so Undo goes back. FBRX's core principles are shown too, read-only: they are fixed and
 * not part of the file.
 */
export function SoulSettings() {
  const name = useAgentName();
  const soul = useCore('soul.get', undefined, ['soul.changed']);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const [text, setText] = useState<string | null>(null);
  const [earlier, setEarlier] = useState<string | null>(null);
  const saved = soul.data?.text ?? '';
  // What is on screen follows the file until you start editing.
  useEffect(() => {
    if (text === null && soul.data) setText(soul.data.text);
  }, [soul.data, text]);
  const draft = text ?? saved;
  const changed = draft !== saved;
  const commands = useMemo(() => soulCommands(draft), [draft]);
  const groups = [...new Set(commands.map((c) => c.group))];

  const save = () => void run('save', () => call('soul.set', { text: draft }).then((s) => setText(s.text)), 'soul.md saved');
  const undo = () => void run('undo', () => call('soul.undo').then((s) => setText(s.text)), 'Back to the version before');
  const reset = async () => {
    if (await confirm({ title: 'Go back to FBRX’s soul.md?', body: 'Your version is kept: Undo brings it back.', confirmLabel: 'Use FBRX’s', danger: true })) void run('reset', () => call('soul.reset').then((s) => setText(s.text)), 'FBRX’s soul.md is back');
  };

  const s = soul.data;
  const showEarlier = () => void run('earlier', () => call('soul.previous').then((r) => setEarlier(r.text ?? 'The earlier version is no longer kept.')));
  const dismiss = () => void run('dismiss', () => call('soul.dismissNotice').then(() => setEarlier(null)));
  return (
    <>
      {s?.notice && (
        <Card title="soul.md changed with this update" subtitle={`FBRX’s core principles are fixed now and come first in everything ${name} is told, so these left your soul.md: ${s.notice.removed.join('; ')}. Your earlier version is kept.`}>
          {earlier !== null && <TextArea code rows={12} value={earlier} readOnly aria-label="The earlier soul.md" />}
          <div className="fx-actions" style={{ marginTop: 10 }}>
            {earlier === null && (
              <Button loading={busy === 'earlier'} onClick={showEarlier}>
                Show the earlier version
              </Button>
            )}
            <Button variant="ghost" loading={busy === 'dismiss'} onClick={dismiss}>
              Got it
            </Button>
          </div>
        </Card>
      )}
      <Card
        title="Soul"
        subtitle={`Who ${name} is and how it sounds and works on this computer: soul.md, its persona. It follows the options from your next message, and a command when you start a message with one (/help lists them). ${name} changes it only when you say yes.`}
        actions={
          s && <Badge tone={s.isDefault ? undefined : 'accent'}>{s.isDefault ? 'FBRX’s default' : 'Yours'}</Badge>
        }
      >
        <TextArea code rows={22} value={draft} spellCheck={false} maxLength={SOUL_LIMITS.file} aria-label="soul.md" onChange={(e) => setText(e.target.value)} />
        <div className="fx-actions" style={{ marginTop: 10 }}>
          <Button variant="primary" icon="save" disabled={!changed} loading={busy === 'save'} onClick={save}>
            Save
          </Button>
          {changed && (
            <Button variant="ghost" onClick={() => setText(saved)}>
              Discard changes
            </Button>
          )}
          <Button icon="undo" disabled={!s?.history.length || changed} loading={busy === 'undo'} onClick={undo} title="The version before the last change">
            Undo the last change
          </Button>
          <Button variant="ghost" icon="refresh" disabled={!!s?.isDefault} loading={busy === 'reset'} onClick={() => void reset()}>
            Use FBRX’s
          </Button>
        </div>
        {s && (
          <p className="fx-help">
            {draft.length.toLocaleString()} of {SOUL_LIMITS.file.toLocaleString()} characters · {s.path}
            {s.history[0] && ` · last changed ${timeAgo(s.history[0].at)} by ${s.history[0].by === 'Fabrix' ? name : s.history[0].by}`}
          </p>
        )}
      </Card>
      {s && (
        <Card title="FBRX’s core principles" subtitle={`Fixed: they come with FBRX and come first in everything ${name} is told. No persona, soul.md, setting, skill or memory changes them, so soul.md holds no principles and no options about approvals, secrets or safety (Governance sets approvals). Other words in soul.md ${name} reads as its persona, under these.`}>
          <div className="fx-muted" style={{ whiteSpace: 'pre-wrap' }}>
            {s.core}
          </div>
        </Card>
      )}
      <Card title="Commands" subtitle={`Start a message with one and ${name} does it. Add, change or remove them in the Commands section above.`}>
        {groups.map((g) => (
          <div key={g} className="soul-group">
            <h4>{g}</h4>
            <ul>
              {commands
                .filter((c) => c.group === g)
                .map((c) => (
                  <li key={c.name}>
                    <code>
                      /{c.name}
                      {c.hint ? ` ${c.hint}` : ''}
                    </code>{' '}
                    <span className="fx-muted">{c.does.split(/[:.](\s|$)/)[0]}</span>
                  </li>
                ))}
            </ul>
          </div>
        ))}
        {!commands.length && <p className="fx-muted">No commands: add a Commands section with lines like “- `/name what` — what it does”.</p>}
      </Card>
      {dialog}
    </>
  );
}
