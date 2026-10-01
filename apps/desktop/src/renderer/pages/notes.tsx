import { useEffect, useRef, useState } from 'react';
import type { Note } from '@fbrx/shared';
import { Button, Card, Empty, Icons, Input, Select, Status, TextArea, timeAgo, useAction, useConfirm } from '@fbrx/ui';
import { call } from '../client';
import { useAgentName, useCore } from '../hooks';
import { Markdown } from '../markdown';
import { navigate, routeArg } from '../app';

/** Notes with Markdown preview, tags, pinning and autosave. */
export function NotesPage() {
  const [query, setQuery] = useState('');
  const notes = useCore('notes.list', query ? { query } : undefined, ['workspace.changed']);
  const projects = useCore('projects.list', undefined, ['workspace.changed']);
  const [selected, setSelected] = useState<string | null>(routeArg());
  const [draft, setDraft] = useState<Note | null>(null);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [saved, setSaved] = useState<'saved' | 'saving' | 'dirty'>('saved');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { run } = useAction();
  const { confirm, dialog } = useConfirm();
  const agent = useAgentName();

  useEffect(() => {
    if (!selected) return setDraft(null);
    const n = notes.data?.find((x) => x.id === selected);
    if (n && (!draft || draft.id !== n.id)) {
      setDraft(n);
      setSaved('saved');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, notes.data]);

  const persist = async (n: Note) => {
    setSaved('saving');
    await call('notes.save', { id: n.id, title: n.title.trim() || 'Untitled', content: n.content, tags: n.tags, pinned: n.pinned, projectId: n.projectId });
    setSaved('saved');
  };
  const edit = (patch: Partial<Note>) => {
    if (!draft) return;
    const n = { ...draft, ...patch };
    setDraft(n);
    setSaved('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void persist(n), 700);
  };
  const create = async () => {
    const n = await run('new', () => call('notes.save', { title: 'Untitled note', content: '', projectId: null }));
    if (n) {
      setSelected(n.id);
      setDraft(n);
      setMode('edit');
      navigate(`notes/${n.id}`);
    }
  };

  const list = notes.data ?? [];
  return (
    <div className="split">
      <Card className="split-list" title="Notes" actions={<Button size="sm" icon="plus" aria-label="New note" onClick={() => void create()} />} flush>
        <div style={{ padding: '0 12px 8px' }}>
          <Input placeholder="Search notes" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search notes" />
        </div>
        <div className="split-items">
          {list.map((n) => (
            <button key={n.id} className={`agent-conv${selected === n.id ? ' active' : ''}`} onClick={() => (setSelected(n.id), navigate(`notes/${n.id}`))}>
              <div className="agent-conv-title">
                {n.pinned && <Icons.tag size={11} style={{ marginRight: 4, color: 'var(--accent)' }} />}
                {n.title}
              </div>
              <div className="agent-conv-sub">
                {timeAgo(n.updatedAt)}
                {n.tags.length ? ` · ${n.tags.join(', ')}` : ''}
              </div>
            </button>
          ))}
          {!list.length && <div className="fx-muted" style={{ padding: 12, fontSize: 13 }}>{query ? 'No matches.' : 'No notes yet.'}</div>}
        </div>
      </Card>
      <Card className="split-main" flush>
        {draft ? (
          <div className="note-editor">
            <div className="note-bar">
              <input className="note-title" value={draft.title} onChange={(e) => edit({ title: e.target.value })} aria-label="Title" />
              <Status tone={saved === 'saved' ? 'good' : saved === 'saving' ? 'busy' : 'neutral'}>{saved === 'dirty' ? 'editing' : saved}</Status>
              <div className="seg">
                <button className={mode === 'edit' ? 'on' : ''} onClick={() => setMode('edit')}>
                  <Icons.edit size={13} /> Write
                </button>
                <button className={mode === 'preview' ? 'on' : ''} onClick={() => setMode('preview')}>
                  <Icons.eye size={13} /> Preview
                </button>
              </div>
              <Button size="sm" variant="ghost" icon="tag" title={draft.pinned ? 'Unpin' : 'Pin to top'} aria-label="Pin" onClick={() => edit({ pinned: !draft.pinned })} />
              <Button
                size="sm"
                variant="ghost"
                icon="sparkles"
                title={`Ask ${agent} about this note`}
                aria-label={`Ask ${agent}`}
                onClick={() => {
                  sessionStorage.setItem('fbrx.agentDraft', `About my note "${draft.title}": `);
                  navigate('agent');
                }}
              />
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                aria-label="Delete note"
                onClick={async () => {
                  if (await confirm({ title: `Delete "${draft.title}"?`, danger: true, confirmLabel: 'Delete' })) {
                    await call('notes.delete', { id: draft.id });
                    setSelected(null);
                    navigate('notes');
                  }
                }}
              />
            </div>
            <div className="note-meta">
              <Input placeholder="Tags, separated by commas" value={draft.tags.join(', ')} onChange={(e) => edit({ tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })} aria-label="Tags" />
              <div style={{ width: 220 }}>
                <Select aria-label="Project" value={draft.projectId ?? ''} onChange={(e) => edit({ projectId: e.target.value || null })} options={[{ value: '', label: 'No project' }, ...(projects.data ?? []).map((p) => ({ value: p.id, label: p.name }))]} />
              </div>
            </div>
            {mode === 'edit' ? (
              <TextArea className="note-body" value={draft.content} onChange={(e) => edit({ content: e.target.value })} placeholder="Write in Markdown: # headings, **bold**, - lists, ```code```" aria-label="Note text" />
            ) : (
              <div className="note-preview">{draft.content ? <Markdown text={draft.content} /> : <span className="fx-muted">Nothing written yet.</span>}</div>
            )}
          </div>
        ) : (
          <Empty title="Pick a note or start a new one" action={<Button variant="primary" icon="plus" onClick={() => void create()}>New note</Button>}>
            Notes are stored on this computer, searchable by {agent}, and included in your encrypted backups.
          </Empty>
        )}
      </Card>
      {dialog}
    </div>
  );
}
