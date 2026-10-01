import { useState } from 'react';
import { TASK_PRIORITIES, type Task, type TaskPriority, type TaskStatus } from '@fbrx/shared';
import { Button, Empty, Field, Input, Modal, Page, Select, Status, Tabs, TextArea, useAction, useConfirm } from '@fbrx/ui';
import { call } from '../client';
import { useAgentName, useCore } from '../hooks';

const COLUMNS: Array<{ id: TaskStatus; label: string }> = [
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'In progress' },
  { id: 'done', label: 'Done' },
];
const PRIORITY_TONE: Record<TaskPriority, 'neutral' | 'info' | 'warning' | 'critical'> = { low: 'neutral', medium: 'info', high: 'warning', critical: 'critical' };

const today = () => new Date().toISOString().slice(0, 10);

function TaskEditor({ task, projects, onClose }: { task: Partial<Task>; projects: Array<{ id: string; name: string }>; onClose: () => void }) {
  const [t, setT] = useState<Partial<Task>>(task);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const save = () =>
    run('save', async () => {
      await call('tasks.save', { id: t.id, title: t.title ?? '', details: t.details, status: t.status, priority: t.priority, due: t.due || null, projectId: t.projectId ?? null });
      onClose();
    });
  return (
    <Modal
      title={t.id ? 'Edit task' : 'New task'}
      onClose={onClose}
      footer={
        <>
          {t.id && (
            <Button
              variant="danger"
              icon="trash"
              onClick={async () => {
                if (await confirm({ title: 'Delete this task?', danger: true, confirmLabel: 'Delete' })) {
                  await call('tasks.delete', { id: t.id! });
                  onClose();
                }
              }}
            >
              Delete
            </Button>
          )}
          <span className="fx-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 'save'} disabled={!t.title?.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="fx-grid">
        <Field label="Title">
          <Input autoFocus value={t.title ?? ''} onChange={(e) => setT({ ...t, title: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && t.title?.trim() && void save()} />
        </Field>
        <div className="fx-row">
          <Field label="Status">
            <Select value={t.status ?? 'todo'} onChange={(e) => setT({ ...t, status: e.target.value as TaskStatus })} options={COLUMNS.map((c) => ({ value: c.id, label: c.label }))} />
          </Field>
          <Field label="Priority">
            <Select value={t.priority ?? 'medium'} onChange={(e) => setT({ ...t, priority: e.target.value as TaskPriority })} options={TASK_PRIORITIES.map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) }))} />
          </Field>
          <Field label="Due">
            <Input type="date" value={t.due?.slice(0, 10) ?? ''} onChange={(e) => setT({ ...t, due: e.target.value || null })} />
          </Field>
        </div>
        <Field label="Project">
          <Select value={t.projectId ?? ''} onChange={(e) => setT({ ...t, projectId: e.target.value || null })} options={[{ value: '', label: 'No project' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]} />
        </Field>
        <Field label="Details">
          <TextArea rows={5} value={t.details ?? ''} onChange={(e) => setT({ ...t, details: e.target.value })} />
        </Field>
      </div>
      {dialog}
    </Modal>
  );
}

export function TasksPage() {
  const tasks = useCore('tasks.list', undefined, ['workspace.changed']);
  const projects = useCore('projects.list', undefined, ['workspace.changed']);
  const [view, setView] = useState<'board' | 'list'>('board');
  const [project, setProject] = useState('');
  const [editing, setEditing] = useState<Partial<Task> | null>(null);
  const [quick, setQuick] = useState('');
  const [drag, setDrag] = useState<string | null>(null);
  const { run } = useAction();
  const agent = useAgentName();
  const all = (tasks.data ?? []).filter((t) => !project || t.projectId === project);
  const projName = (id: string | null) => projects.data?.find((p) => p.id === id)?.name;

  const move = (t: Task, status: TaskStatus) => run(t.id, () => call('tasks.save', { id: t.id, title: t.title, status }));
  const addQuick = async () => {
    const title = quick.trim();
    if (!title) return;
    setQuick('');
    await run('quick', () => call('tasks.save', { title, projectId: project || null }));
  };

  const card = (t: Task) => {
    const overdue = t.status !== 'done' && t.due && t.due.slice(0, 10) < today();
    return (
      <div key={t.id} className={`kcard${drag === t.id ? ' dragging' : ''}`} draggable onDragStart={() => setDrag(t.id)} onDragEnd={() => setDrag(null)} onClick={() => setEditing(t)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setEditing(t)}>
        <div className="kcard-title" style={t.status === 'done' ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : undefined}>
          {t.title}
        </div>
        <div className="kcard-meta">
          <Status tone={PRIORITY_TONE[t.priority]}>{t.priority}</Status>
          {t.due && <span className={overdue ? 'kcard-overdue' : 'fx-muted'}>{overdue ? 'Overdue · ' : ''}{t.due.slice(0, 10)}</span>}
          {projName(t.projectId) && <span className="fx-muted">· {projName(t.projectId)}</span>}
        </div>
      </div>
    );
  };

  return (
    <Page
      title="Tasks"
      description={`Your to-do list. ${agent} can read and update it too (ask “what's on my plate?”).`}
      actions={
        <>
          <div style={{ width: 200 }}>
            <Select aria-label="Project" value={project} onChange={(e) => setProject(e.target.value)} options={[{ value: '', label: 'All projects' }, ...(projects.data ?? []).map((p) => ({ value: p.id, label: p.name }))]} />
          </div>
          <Button variant="primary" icon="plus" onClick={() => setEditing({ status: 'todo', priority: 'medium', projectId: project || null })}>
            New task
          </Button>
        </>
      }
    >
      <div className="fx-actions">
        <Tabs tabs={[{ id: 'board', label: 'Board' }, { id: 'list', label: 'List' }]} active={view} onChange={setView} />
        <span className="fx-spacer" />
        <div style={{ width: 360 }}>
          <Input placeholder="Quick add: type a task and press Enter" value={quick} onChange={(e) => setQuick(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void addQuick()} aria-label="Quick add task" />
        </div>
      </div>
      {view === 'board' ? (
        <div className="kanban">
          {COLUMNS.map((col) => {
            const items = all.filter((t) => t.status === col.id);
            return (
              <div
                key={col.id}
                className="kcol"
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  const t = all.find((x) => x.id === drag);
                  if (t && t.status !== col.id) void move(t, col.id);
                  setDrag(null);
                }}
              >
                <div className="kcol-head">
                  <span>{col.label}</span>
                  <span className="fx-muted">{items.length}</span>
                </div>
                <div className="kcol-body">
                  {items.map(card)}
                  {!items.length && <div className="fx-muted" style={{ fontSize: 12.5, padding: 8 }}>{col.id === 'done' ? 'Finished tasks land here.' : 'Drop tasks here.'}</div>}
                </div>
              </div>
            );
          })}
        </div>
      ) : all.length ? (
        <div className="fx-card">
          <div className="fx-list">
            {all.map((t) => (
              <div key={t.id} className="fx-list-item">
                <input type="checkbox" checked={t.status === 'done'} aria-label={`Done: ${t.title}`} onChange={() => void move(t, t.status === 'done' ? 'todo' : 'done')} />
                <button className="linklike" style={{ flex: 1, textAlign: 'left' }} onClick={() => setEditing(t)}>
                  <span style={t.status === 'done' ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : undefined}>{t.title}</span>
                </button>
                {projName(t.projectId) && <span className="fx-muted" style={{ fontSize: 12 }}>{projName(t.projectId)}</span>}
                {t.due && <span className="fx-muted" style={{ fontSize: 12 }}>{t.due.slice(0, 10)}</span>}
                <Status tone={PRIORITY_TONE[t.priority]}>{t.priority}</Status>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <Empty title="No tasks yet">Add one above, or ask {agent} to add tasks for you.</Empty>
      )}
      {editing && <TaskEditor task={editing} projects={projects.data ?? []} onClose={() => (setEditing(null), tasks.reload())} />}
    </Page>
  );
}

