import { useState } from 'react';
import type { DeepPartial, MemoryEntry, Settings } from '@fbrx/shared';
import { MEMORY_CATEGORY_LABEL } from '@fbrx/shared';
import { Badge, Button, Callout, Card, Empty, Field, Grid, Icons, Input, Toggle, timeAgo, useAction, useConfirm } from '@fbrx/ui';
import { call } from '../client';
import { isLocked, useCore } from '../hooks';
import { menuFor } from '../context-menu';

/**
 * Settings → Memory: what the AI remembers about the person, on this computer only. Short-term memory is the last
 * 24 hours of chats; long-term memory is lasting facts (learned from what they say, or kept when asked) and the chat
 * history it can search. Identity and money numbers are never kept, and private details never leave the computer.
 */

const SOURCE: Record<MemoryEntry['source'], string> = { auto: 'Learned', agent: 'Asked to remember', person: 'Added by you' };

const KEEP: Array<{ id: keyof Settings['memory']['keep']; label: string }> = [
  { id: 'address', label: 'Addresses (home, work)' },
  { id: 'location', label: 'The town or city you live in' },
  { id: 'contact', label: 'Your email and phone number' },
  { id: 'birthday', label: 'Your birthday' },
  { id: 'payment', label: 'Payment cards, by their last four digits only' },
];

export function MemorySettings() {
  const eff = useCore('settings.get', undefined, ['settings.changed']);
  const st = useCore('memory.status', undefined, ['memory.changed', 'settings.changed']);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const [adding, setAdding] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const s = eff.data?.settings;
  if (!s) return null;
  const m = s.memory;
  const agent = s.ai.agentName;
  const L = (p: string) => isLocked(eff.data?.locked ?? [], `memory.${p}`);
  const patch = (p: DeepPartial<Settings['memory']>) => run('patch', () => call('settings.update', { patch: { memory: p } }));
  const entries = st.data?.entries ?? [];
  const recent = st.data?.recent ?? [];
  const add = () => run('add', () => call('memory.add', { content: adding.trim() }), 'Remembered').then(() => setAdding(''));
  const save = () => editing && run(editing.id, () => call('memory.update', { id: editing.id, content: editing.text.trim() }), 'Updated').then(() => setEditing(null));
  const forget = (e: MemoryEntry) => run(e.id, () => call('memory.forget', { id: e.id }), 'Forgotten');
  const forgetAll = async () => {
    const ok = await confirm({
      title: 'Forget everything?',
      body: `${agent} forgets every fact it keeps about you. Your chats stay where they are (delete them in the chat history).`,
      confirmLabel: 'Forget everything',
      danger: true,
    });
    if (ok) await run('all', () => call('memory.forgetAll'), 'Forgotten');
  };

  return (
    <Grid cols={2}>
      {dialog}
      <div style={{ gridColumn: '1 / -1' }}>
        <Callout tone="info" title="It all stays on this computer">
          {agent}’s memory is kept here and nowhere else, so it knows you whichever AI model you pick. It never goes onto the internet, private details never go to a cloud AI, and some things are never kept at all.
        </Callout>
      </div>
      <Card title="Memory" subtitle={`What ${agent} keeps in mind between chats`}>
        <div className="fx-form">
          <Toggle checked={m.enabled} disabled={L('enabled')} onChange={(v) => void patch({ enabled: v })} label={`Let ${agent} remember things about me`} />
          <Toggle
            checked={m.longTerm}
            disabled={!m.enabled || L('longTerm')}
            onChange={(v) => void patch({ longTerm: v })}
            label="Long-term memory"
            info="Lasting facts about you (your name, where you work, what you prefer), in every chat. It can also look through your past chats when you ask about them."
          />
          <Toggle
            checked={m.shortTerm}
            disabled={!m.enabled || L('shortTerm')}
            onChange={(v) => void patch({ shortTerm: v })}
            label="Short-term memory (the last 24 hours)"
            info="What you talked about today, so you can pick up where you left off in a new chat. It ages out by itself after a day, and only a local AI sees it."
          />
          <Toggle
            checked={m.learn}
            disabled={!m.enabled || !m.longTerm || L('learn')}
            onChange={(v) => void patch({ learn: v })}
            label="Learn from what I say"
            info={`When you say “I live in…” or “my email is…”, ${agent} keeps it. With this off, it keeps only what you or it chose to remember.`}
          />
          <Field label="With a cloud AI" help="A cloud AI gets the general facts with your message, or nothing at all. Private details and the last 24 hours never go to one.">
            <div className="seg" role="group" aria-label="Memory with a cloud AI">
              {(['general', 'none'] as const).map((c) => (
                <button key={c} className={m.cloud === c ? 'on' : ''} disabled={!m.enabled || L('cloud')} onClick={() => void patch({ cloud: c })}>
                  {c === 'general' ? 'General facts only' : 'Nothing'}
                </button>
              ))}
            </div>
          </Field>
        </div>
      </Card>
      <Card title="Private details it may keep" subtitle="Only with a local AI, never online">
        <div className="fx-form">
          {KEEP.map((k) => (
            <Toggle key={k.id} checked={m.keep[k.id]} disabled={!m.enabled || L(`keep.${k.id}`)} onChange={(v) => void patch({ keep: { [k.id]: v } })} label={k.label} />
          ))}
          <p className="fx-muted" style={{ fontSize: 12.5, margin: 0 }}>
            A full card number is never kept: with cards on, {agent} keeps “card ending 1234” and nothing more.
          </p>
        </div>
      </Card>

      <div style={{ gridColumn: '1 / -1' }}>
        <Card
          title="What it remembers"
          subtitle={entries.length ? `${entries.length} ${entries.length === 1 ? 'fact' : 'facts'}, newest first. Right-click one to change or forget it.` : undefined}
          actions={
            entries.length > 0 && (
              <Button size="sm" variant="ghost" icon="trash" loading={busy === 'all'} onClick={() => void forgetAll()}>
                Forget everything
              </Button>
            )
          }
        >
          <form
            className="memory-add"
            onSubmit={(e) => {
              e.preventDefault();
              if (adding.trim()) void add();
            }}
          >
            <Input value={adding} maxLength={500} disabled={!m.enabled} placeholder={`Tell ${agent} something to remember (“I prefer short answers”)`} onChange={(e) => setAdding(e.target.value)} />
            <Button type="submit" icon="plus" disabled={!m.enabled || !adding.trim()} loading={busy === 'add'}>
              Remember
            </Button>
          </form>
          {entries.length ? (
            <div className="fx-list memory-list">
              {entries.map((e) => (
                <div
                  key={e.id}
                  className="fx-list-item"
                  onContextMenu={menuFor([
                    { label: 'Change', icon: 'edit', onSelect: () => setEditing({ id: e.id, text: e.content }) },
                    { label: 'Forget', icon: 'trash', danger: true, onSelect: () => void forget(e) },
                  ])}
                >
                  {editing?.id === e.id ? (
                    <form
                      className="memory-add"
                      style={{ flex: 1 }}
                      onSubmit={(ev) => {
                        ev.preventDefault();
                        if (editing.text.trim()) void save();
                      }}
                    >
                      <Input autoFocus value={editing.text} maxLength={500} onChange={(ev) => setEditing({ id: e.id, text: ev.target.value })} />
                      <Button type="submit" size="sm" variant="primary" loading={busy === e.id}>
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="fx-cell-title">{e.content}</div>
                        <div className="fx-cell-sub">
                          {SOURCE[e.source]} · {timeAgo(e.updatedAt ?? e.createdAt)}
                        </div>
                      </div>
                      <Badge>
                        {e.private && <Icons.lock size={11} />} {MEMORY_CATEGORY_LABEL[e.category]}
                      </Badge>
                      <Button size="sm" variant="ghost" icon="trash" aria-label={`Forget “${e.content}”`} loading={busy === e.id} onClick={() => void forget(e)} />
                    </>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <Empty title="Nothing yet">{m.enabled ? `As you chat, ${agent} keeps what matters here. You can add, change or forget anything.` : 'Memory is off.'}</Empty>
          )}
        </Card>
      </div>

      <Card title="The last 24 hours" subtitle="Short-term memory: it ages out by itself">
        {!m.enabled || !m.shortTerm ? (
          <p className="fx-muted" style={{ margin: 0 }}>
            Short-term memory is off.
          </p>
        ) : recent.length ? (
          <div className="fx-list">
            {recent.map((r) => (
              <div key={r.conversationId} className="fx-list-item">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="fx-cell-title">{r.title}</div>
                  <div className="fx-cell-sub memory-gist">{r.gist}</div>
                </div>
                <span className="fx-muted" style={{ fontSize: 12 }}>
                  {timeAgo(r.at)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="fx-muted" style={{ margin: 0 }}>
            No chats today.
          </p>
        )}
      </Card>
      <Card title="Never kept" subtitle="Taken out before anything is saved, and blocked from going online">
        <ul className="memory-never">
          {(st.data?.neverKept ?? []).map((k) => (
            <li key={k.id}>
              <Icons.lock size={13} /> {k.label}
            </li>
          ))}
        </ul>
        <p className="fx-muted" style={{ fontSize: 12.5, margin: 0 }}>
          If {agent} is about to put one of these into a web search or any other online tool, FBRX stops it. Other private details (an address, a phone number) need your approval first.
        </p>
      </Card>
    </Grid>
  );
}
