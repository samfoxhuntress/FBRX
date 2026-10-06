import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationSummary, ProjectSummary } from '@fbrx/shared';
import { Button, Callout, Field, Icons, Input, Modal, Select, Toggle, timeAgo, useAction } from '@fbrx/ui';
import { call } from './client';
import { useCore } from './hooks';

/** Which chats the list shows: all, those in no project, or one project's. */
export type ChatFilter = 'all' | 'none' | string;

/**
 * The chat history next to the conversation: filter by project, a menu on each chat (rename, add to a project,
 * delete), select several to move or delete together, and clean up old chats.
 */
export function ChatHistory({
  chats,
  reload,
  selected,
  busyId,
  learner,
  filter,
  setFilter,
  onOpen,
}: {
  chats: ConversationSummary[];
  reload: () => void;
  selected: string | null;
  /** The chat the agent is answering in (not deletable right now). */
  busyId: string | null;
  learner: boolean;
  filter: ChatFilter;
  setFilter: (f: ChatFilter) => void;
  onOpen: (id: string | null) => void;
}) {
  const projects = useCore('projects.list', undefined, ['workspace.changed']);
  const list = learner ? [] : (projects.data ?? []);
  const byId = useMemo(() => new Map(list.map((p) => [p.id, p])), [list]);
  const [menu, setMenu] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState<string[] | null>(null);
  const [renaming, setRenaming] = useState<ConversationSummary | null>(null);
  const [deleting, setDeleting] = useState<string[] | null>(null);
  const [cleaning, setCleaning] = useState(false);

  const shown = chats.filter((c) => (filter === 'all' ? true : filter === 'none' ? !c.projectId : c.projectId === filter));
  // A filter for a project that was deleted falls back to everything.
  useEffect(() => {
    if (filter !== 'all' && filter !== 'none' && projects.data && !byId.has(filter)) setFilter('all');
  }, [filter, byId, projects.data, setFilter]);

  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const done = () => {
    setSelecting(false);
    setPicked(new Set());
  };
  const changed = (removed: string[] = []) => {
    if (selected && removed.includes(selected)) onOpen(null);
    reload();
    projects.reload();
  };

  return (
    <>
      {(list.length > 0 || filter !== 'all') && (
        <div className="chat-filter">
          <Select
            aria-label="Show chats"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            options={[{ value: 'all', label: 'All chats' }, { value: 'none', label: 'Not in a project' }, ...list.map((p) => ({ value: p.id, label: `${p.name} (${p.chats})` }))]}
          />
        </div>
      )}
      <div className="agent-list-items private">
        {shown.map((c) => {
          const project = c.projectId ? byId.get(c.projectId) : undefined;
          return (
            <div key={c.id} className={`agent-conv-row${selected === c.id ? ' active' : ''}${picked.has(c.id) ? ' picked' : ''}`}>
              {selecting && <input type="checkbox" className="chat-pick" aria-label={`Select ${c.title}`} checked={picked.has(c.id)} disabled={c.id === busyId} onChange={() => toggle(c.id)} />}
              <button className={`agent-conv${selected === c.id ? ' active' : ''}`} onClick={() => (selecting ? c.id !== busyId && toggle(c.id) : onOpen(c.id))}>
                <div className="agent-conv-title">{c.title}</div>
                <div className="agent-conv-sub">
                  {project && (
                    <span className="chat-project" title={`In ${project.name}`}>
                      <span className="chat-project-dot" style={{ background: project.color || 'var(--accent)' }} />
                      {project.name} ·{' '}
                    </span>
                  )}
                  {timeAgo(c.updatedAt)} · {c.messageCount} messages{c.origin === 'remote' ? ' · remote' : ''}
                </div>
              </button>
              {!selecting && (
                <button className="chat-more" aria-label={`More for ${c.title}`} aria-expanded={menu === c.id} onClick={() => setMenu(menu === c.id ? null : c.id)}>
                  <Icons.more size={15} />
                </button>
              )}
              {menu === c.id && (
                <ChatMenu
                  onClose={() => setMenu(null)}
                  items={[
                    { icon: 'edit', label: 'Rename', run: () => setRenaming(c) },
                    ...(learner ? [] : [{ icon: 'layers' as const, label: c.projectId ? 'Move to another project' : 'Add to a project', run: () => setMoving([c.id]) }]),
                    ...(c.projectId && !learner
                      ? [{ icon: 'x' as const, label: `Take out of ${project?.name ?? 'the project'}`, run: () => void call('ai.conversations.setProject', { id: c.id, projectId: null }).then(() => changed()) }]
                      : []),
                    { icon: 'trash', label: 'Delete', danger: true, disabled: c.id === busyId, run: () => setDeleting([c.id]) },
                  ]}
                />
              )}
            </div>
          );
        })}
        {!shown.length && <div className="fx-muted" style={{ padding: 12, fontSize: 13 }}>{chats.length ? 'No chats here yet.' : 'No conversations yet.'}</div>}
      </div>
      {selecting ? (
        <div className="chat-select-bar">
          <span className="fx-secondary">{picked.size} selected</span>
          <span className="fx-spacer" />
          {!learner && (
            <Button size="sm" icon="layers" disabled={!picked.size} onClick={() => setMoving([...picked])}>
              Project
            </Button>
          )}
          <Button size="sm" variant="danger" icon="trash" disabled={!picked.size} onClick={() => setDeleting([...picked])}>
            Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={done}>
            Done
          </Button>
        </div>
      ) : (
        chats.length > 0 && (
          <div className="chat-tools">
            <Button size="sm" variant="ghost" icon="check" onClick={() => setSelecting(true)}>
              Select
            </Button>
            <Button size="sm" variant="ghost" icon="trash" onClick={() => setCleaning(true)}>
              Clean up
            </Button>
          </div>
        )
      )}
      {moving && <MoveToProject ids={moving} projects={list} onClose={() => setMoving(null)} onMoved={() => (setMoving(null), done(), changed())} />}
      {renaming && <RenameChat chat={renaming} onClose={() => setRenaming(null)} onDone={() => (setRenaming(null), reload())} />}
      {deleting && <DeleteChats ids={deleting} chats={chats} onClose={() => setDeleting(null)} onDone={(ids) => (setDeleting(null), done(), changed(ids))} />}
      {cleaning && <CleanUp hasProjects={chats.some((c) => c.projectId)} onClose={() => setCleaning(false)} onDone={() => (setCleaning(false), changed(selected ? [selected] : []))} />}
    </>
  );
}

function ChatMenu({ items, onClose }: { items: Array<{ icon: 'edit' | 'layers' | 'x' | 'trash'; label: string; run: () => void; danger?: boolean; disabled?: boolean }>; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    setTimeout(() => document.addEventListener('mousedown', away), 0);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  return (
    <div className="chat-menu" role="menu" ref={ref}>
      {items.map((i) => {
        const I = Icons[i.icon];
        return (
          <button
            key={i.label}
            role="menuitem"
            className={i.danger ? 'danger' : undefined}
            disabled={i.disabled}
            title={i.disabled ? 'The agent is still answering in this chat' : undefined}
            onClick={() => {
              onClose();
              i.run();
            }}
          >
            <I size={14} /> {i.label}
          </button>
        );
      })}
    </div>
  );
}

function MoveToProject({ ids, projects, onClose, onMoved }: { ids: string[]; projects: ProjectSummary[]; onClose: () => void; onMoved: () => void }) {
  const [target, setTarget] = useState(projects[0]?.id ?? 'new');
  const [name, setName] = useState('');
  const { run, busy } = useAction();
  const save = () =>
    run(
      'move',
      async () => {
        const projectId = target === 'new' ? ((await call('projects.save', { name: name.trim() })) as { id: string }).id : target;
        for (const id of ids) await call('ai.conversations.setProject', { id, projectId });
        onMoved();
      },
      ids.length === 1 ? 'Added to the project' : `${ids.length} chats added to the project`,
    );
  return (
    <Modal
      title={ids.length === 1 ? 'Add this chat to a project' : `Add ${ids.length} chats to a project`}
      description="The chat stays in your history and also shows on the project."
      onClose={onClose}
      footer={
        <>
          <span className="fx-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="layers" loading={busy === 'move'} disabled={target === 'new' && !name.trim()} onClick={() => void save()}>
            Add
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Project">
          <Select value={target} onChange={(e) => setTarget(e.target.value)} options={[...projects.map((p) => ({ value: p.id, label: p.name })), { value: 'new', label: 'New project…' }]} />
        </Field>
        {target === 'new' && (
          <Field label="New project's name">
            <Input value={name} autoFocus maxLength={120} placeholder="Kitchen remodel" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && void save()} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

function RenameChat({ chat, onClose, onDone }: { chat: ConversationSummary; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState(chat.title);
  const { run, busy } = useAction();
  const save = () => run('rename', () => call('ai.conversations.rename', { id: chat.id, title: title.trim() }).then(onDone));
  return (
    <Modal
      title="Rename chat"
      onClose={onClose}
      footer={
        <>
          <span className="fx-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 'rename'} disabled={!title.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <Input value={title} autoFocus maxLength={120} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && title.trim() && void save()} />
    </Modal>
  );
}

function DeleteChats({ ids, chats, onClose, onDone }: { ids: string[]; chats: ConversationSummary[]; onClose: () => void; onDone: (ids: string[]) => void }) {
  const { run, busy } = useAction();
  const one = ids.length === 1 ? chats.find((c) => c.id === ids[0]) : null;
  const remove = () =>
    run(
      'delete',
      async () => {
        const r = ids.length === 1 ? { deleted: (await call('ai.conversations.delete', { id: ids[0]! })).deleted ? 1 : 0 } : await call('ai.conversations.deleteMany', { ids });
        onDone(ids);
        return r;
      },
      ids.length === 1 ? 'Chat deleted' : `${ids.length} chats deleted`,
    );
  return (
    <Modal
      title={one ? `Delete "${one.title}"?` : `Delete ${ids.length} chats?`}
      description="Deleted chats cannot be brought back (backups made before now still have them)."
      onClose={onClose}
      footer={
        <>
          <span className="fx-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger-solid" icon="trash" loading={busy === 'delete'} onClick={() => void remove()}>
            Delete
          </Button>
        </>
      }
    >
      <span />
    </Modal>
  );
}

const AGES = [
  { value: '7', label: 'Older than a week' },
  { value: '30', label: 'Older than a month' },
  { value: '90', label: 'Older than 3 months' },
  { value: '365', label: 'Older than a year' },
  { value: '0', label: 'All chats' },
];

function CleanUp({ hasProjects, onClose, onDone }: { hasProjects: boolean; onClose: () => void; onDone: () => void }) {
  const [age, setAge] = useState('30');
  const [includeProjects, setIncludeProjects] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const { run, busy } = useAction();
  useEffect(() => {
    let live = true;
    setCount(null);
    void call('ai.conversations.cleanup', { olderThanDays: Number(age), includeProjects, dryRun: true }).then((r) => live && setCount(r.deleted));
    return () => {
      live = false;
    };
  }, [age, includeProjects]);
  const clean = () => run('clean', () => call('ai.conversations.cleanup', { olderThanDays: Number(age), includeProjects }).then(onDone), count === 1 ? '1 chat deleted' : `${count} chats deleted`);
  return (
    <Modal
      title="Clean up chat history"
      description="Deletes chats you have not touched for a while. Chats you keep in projects stay unless you include them."
      onClose={onClose}
      footer={
        <>
          <span className="fx-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger-solid" icon="trash" loading={busy === 'clean'} disabled={!count} onClick={() => void clean()}>
            {count === null ? 'Delete' : count === 0 ? 'Nothing to delete' : `Delete ${count} chat${count === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Which chats">
          <Select value={age} onChange={(e) => setAge(e.target.value)} options={AGES} />
        </Field>
        {hasProjects && <Toggle checked={includeProjects} onChange={setIncludeProjects} label="Also delete chats that are in projects" />}
        {age === '0' && <Callout tone="warning">This deletes every chat{includeProjects ? '' : ' that is not in a project'}. A chat the agent is answering in right now is kept.</Callout>}
      </div>
    </Modal>
  );
}
