import { useState } from 'react';
import { PROJECT_STATUSES, type Milestone, type Project, type ProjectSummary } from '@fbrx/shared';
import { Button, Card, Empty, Field, Grid, Icons, Input, Meter, Modal, Page, Select, Status, TextArea, Toggle, useAction, useConfirm } from '@fbrx/ui';
import { call } from '../client';
import { useCore } from '../hooks';
import { navigate } from '../app';

const COLORS = ['#f0a530', '#3987e5', '#1baf7a', '#e87ba4', '#9085e9', '#eb6834', '#2cc4c4', '#898781'];

function ProjectEditor({ project, onClose }: { project: Partial<Project>; onClose: () => void }) {
  const [p, setP] = useState<Partial<Project>>({ milestones: [], color: COLORS[0], status: 'active', ...project });
  const [ms, setMs] = useState('');
  const [cascade, setCascade] = useState(false);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const milestones = p.milestones ?? [];
  const save = () =>
    run('save', async () => {
      await call('projects.save', { id: p.id, name: p.name ?? '', description: p.description, status: p.status, color: p.color, due: p.due || null, milestones });
      onClose();
    });
  return (
    <Modal
      title={p.id ? 'Edit project' : 'New project'}
      onClose={onClose}
      wide
      footer={
        <>
          {p.id && (
            <Button
              variant="danger"
              icon="trash"
              onClick={async () => {
                if (
                  await confirm({
                    title: `Delete "${p.name}"?`,
                    danger: true,
                    confirmLabel: 'Delete',
                    body: <Toggle checked={cascade} onChange={setCascade} label="Also delete its tasks, notes and snippets (otherwise they are kept without a project)" />,
                  })
                ) {
                  await call('projects.delete', { id: p.id!, cascade });
                  onClose();
                }
              }}
            >
              Delete
            </Button>
          )}
          <span className="fx-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 'save'} disabled={!p.name?.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="fx-grid">
        <div className="fx-row">
          <Field label="Name">
            <Input autoFocus value={p.name ?? ''} onChange={(e) => setP({ ...p, name: e.target.value })} />
          </Field>
          <Field label="Status">
            <Select value={p.status} onChange={(e) => setP({ ...p, status: e.target.value as Project['status'] })} options={PROJECT_STATUSES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))} />
          </Field>
          <Field label="Due">
            <Input type="date" value={p.due?.slice(0, 10) ?? ''} onChange={(e) => setP({ ...p, due: e.target.value || null })} />
          </Field>
        </div>
        <Field label="Color">
          <div style={{ display: 'flex', gap: 8 }}>
            {COLORS.map((c) => (
              <button key={c} aria-label={`Color ${c}`} onClick={() => setP({ ...p, color: c })} style={{ width: 24, height: 24, borderRadius: 999, border: p.color === c ? '2px solid var(--text-primary)' : '1px solid var(--border)', background: c, cursor: 'pointer' }} />
            ))}
          </div>
        </Field>
        <Field label="Description">
          <TextArea rows={3} value={p.description ?? ''} onChange={(e) => setP({ ...p, description: e.target.value })} />
        </Field>
        <Field label="Milestones">
          <div className="fx-grid" style={{ gap: 6 }}>
            {milestones.map((m, i) => (
              <div key={m.id ?? i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="checkbox" checked={m.done} aria-label={`Done: ${m.title}`} onChange={() => setP({ ...p, milestones: milestones.map((x, j) => (j === i ? { ...x, done: !x.done } : x)) })} />
                <span style={{ flex: 1, textDecoration: m.done ? 'line-through' : undefined }}>{m.title}</span>
                <Button size="sm" variant="ghost" icon="x" aria-label="Remove milestone" onClick={() => setP({ ...p, milestones: milestones.filter((_, j) => j !== i) })} />
              </div>
            ))}
            <Input
              placeholder="Add a milestone and press Enter"
              value={ms}
              onChange={(e) => setMs(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && ms.trim()) {
                  setP({ ...p, milestones: [...milestones, { id: '', title: ms.trim(), done: false } as Milestone] });
                  setMs('');
                }
              }}
            />
          </div>
        </Field>
      </div>
      {dialog}
    </Modal>
  );
}

export function ProjectsPage() {
  const projects = useCore('projects.list', undefined, ['workspace.changed']);
  const [editing, setEditing] = useState<Partial<Project> | null>(null);
  const list = projects.data ?? [];
  const tone = (s: ProjectSummary['status']) => (s === 'active' ? 'good' : s === 'paused' ? 'warning' : 'neutral');
  return (
    <Page
      title="Projects"
      description="Group tasks, notes and snippets, track milestones and see what is overdue."
      actions={
        <Button variant="primary" icon="plus" onClick={() => setEditing({})}>
          New project
        </Button>
      }
    >
      {list.length ? (
        <Grid cols={3}>
          {list.map((p) => {
            const done = p.milestones.filter((m) => m.done).length;
            return (
              <Card
                key={p.id}
                title={
                  <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: p.color || 'var(--accent)' }} />
                    {p.name}
                  </span>
                }
                subtitle={p.due ? `Due ${p.due.slice(0, 10)}` : 'No due date'}
                actions={<Button size="sm" variant="ghost" icon="edit" aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)} />}
              >
                <div className="fx-grid" style={{ gap: 10 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Status tone={tone(p.status)}>{p.status}</Status>
                    {p.overdue > 0 && <Status tone="critical">{p.overdue} overdue</Status>}
                  </div>
                  {p.description && <div className="fx-secondary" style={{ fontSize: 13 }}>{p.description.slice(0, 160)}</div>}
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
                      <span>Tasks</span>
                      <span className="fx-muted">
                        {p.done}/{p.tasks}
                      </span>
                    </div>
                    <Meter value={p.done} max={Math.max(1, p.tasks)} label="Tasks done" />
                  </div>
                  {p.milestones.length > 0 && (
                    <div style={{ fontSize: 12.5 }}>
                      <div className="fx-muted" style={{ marginBottom: 4 }}>
                        Milestones {done}/{p.milestones.length}
                      </div>
                      {p.milestones.slice(0, 4).map((m) => (
                        <div key={m.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          {m.done ? <Icons.checkCircle size={13} style={{ color: 'var(--good)' }} /> : <Icons.clock size={13} className="fx-muted" />}
                          <span style={m.done ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : undefined}>{m.title}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="fx-muted" style={{ fontSize: 12 }}>
                    {p.notes} note(s) · {p.snippets} snippet(s)
                  </div>
                  <div className="fx-actions">
                    <Button size="sm" icon="tasks" onClick={() => navigate('tasks')}>
                      Tasks
                    </Button>
                    <Button size="sm" icon="note" onClick={() => navigate('notes')}>
                      Notes
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </Grid>
      ) : (
        <Empty title="No projects yet" action={<Button variant="primary" icon="plus" onClick={() => setEditing({})}>Create a project</Button>}>
          Projects collect the tasks, notes and snippets for one piece of work.
        </Empty>
      )}
      {editing && <ProjectEditor project={editing} onClose={() => (setEditing(null), projects.reload())} />}
    </Page>
  );
}
