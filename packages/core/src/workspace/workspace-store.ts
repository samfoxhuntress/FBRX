import { z } from 'zod';
import {
  newId,
  PROJECT_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Note,
  type Project,
  type ProjectSummary,
  type Snippet,
  type Task,
} from '@fbrx/shared';
import { CoreError } from '../errors';
import type { EventBus } from '../events';
import type { Db } from '../storage/db';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/, 'Use a date like 2026-10-31');
const tags = z.array(z.string().trim().min(1).max(40)).max(30);
const projectRef = z.string().max(64).nullable();

export const NoteInputSchema = z.object({
  id: z.string().optional(),
  title: z.string().trim().min(1).max(200),
  content: z.string().max(200_000).optional(),
  tags: tags.optional(),
  projectId: projectRef.optional(),
  pinned: z.boolean().optional(),
});
export const TaskInputSchema = z.object({
  id: z.string().optional(),
  title: z.string().trim().min(1).max(300),
  details: z.string().max(20_000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  due: day.nullable().optional(),
  projectId: projectRef.optional(),
});
export const ProjectInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(20_000).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  color: z.string().max(20).optional(),
  due: day.nullable().optional(),
  milestones: z.array(z.object({ id: z.string().max(64).optional(), title: z.string().trim().min(1).max(200), done: z.boolean().optional() })).max(100).optional(),
});
export const SnippetInputSchema = z.object({
  id: z.string().optional(),
  title: z.string().trim().min(1).max(200),
  language: z.string().max(40).optional(),
  content: z.string().max(200_000).optional(),
  tags: tags.optional(),
  projectId: projectRef.optional(),
});

const json = <T>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};
const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Notes, tasks, projects and snippets: the personal workspace, stored locally and carried by snapshots. */
export class WorkspaceStore {
  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
  ) {}

  private changed(kind: 'notes' | 'tasks' | 'projects' | 'snippets') {
    this.events.emit('workspace.changed', { kind });
  }

  private checkProject(id: string | null | undefined) {
    if (id && !this.db.get('SELECT 1 FROM projects WHERE id = ?', id)) throw new CoreError('NOT_FOUND', 'Project not found');
  }

  // ------------------------------------------------------------------------------------------ notes

  listNotes(p: { projectId?: string; query?: string } = {}): Note[] {
    const where: string[] = [];
    const args: string[] = [];
    if (p.projectId) {
      where.push('project_id = ?');
      args.push(p.projectId);
    }
    if (p.query?.trim()) {
      where.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')");
      const l = like(p.query.trim());
      args.push(l, l, l);
    }
    return this.db
      .all<any>(`SELECT * FROM notes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY pinned DESC, updated_at DESC LIMIT 1000`, ...args)
      .map(toNote);
  }

  getNote(id: string): Note {
    const row = this.db.get<any>('SELECT * FROM notes WHERE id = ?', id);
    if (!row) throw new CoreError('NOT_FOUND', 'Note not found');
    return toNote(row);
  }

  saveNote(raw: unknown): Note {
    const i = NoteInputSchema.parse(raw);
    this.checkProject(i.projectId);
    const now = new Date().toISOString();
    if (i.id && this.db.get('SELECT 1 FROM notes WHERE id = ?', i.id)) {
      const cur = this.getNote(i.id);
      this.db.run(
        'UPDATE notes SET title = ?, content = ?, tags = ?, project_id = ?, pinned = ?, updated_at = ? WHERE id = ?',
        i.title,
        i.content ?? cur.content,
        JSON.stringify(i.tags ?? cur.tags),
        i.projectId === undefined ? cur.projectId : i.projectId,
        (i.pinned ?? cur.pinned) ? 1 : 0,
        now,
        i.id,
      );
      this.changed('notes');
      return this.getNote(i.id);
    }
    const id = newId('note');
    this.db.run(
      'INSERT INTO notes (id, title, content, tags, project_id, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      i.title,
      i.content ?? '',
      JSON.stringify(i.tags ?? []),
      i.projectId ?? null,
      i.pinned ? 1 : 0,
      now,
      now,
    );
    this.changed('notes');
    return this.getNote(id);
  }

  deleteNote(id: string): boolean {
    const ok = this.db.run('DELETE FROM notes WHERE id = ?', id).changes > 0;
    if (ok) this.changed('notes');
    return ok;
  }

  // ------------------------------------------------------------------------------------------ tasks

  listTasks(p: { projectId?: string; status?: string } = {}): Task[] {
    const where: string[] = [];
    const args: string[] = [];
    if (p.projectId) {
      where.push('project_id = ?');
      args.push(p.projectId);
    }
    if (p.status) {
      where.push('status = ?');
      args.push(p.status);
    }
    return this.db
      .all<any>(
        `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END,
                  CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                  COALESCE(due, '9999'), updated_at DESC LIMIT 2000`,
        ...args,
      )
      .map(toTask);
  }

  getTask(id: string): Task {
    const row = this.db.get<any>('SELECT * FROM tasks WHERE id = ?', id);
    if (!row) throw new CoreError('NOT_FOUND', 'Task not found');
    return toTask(row);
  }

  saveTask(raw: unknown): Task {
    const i = TaskInputSchema.parse(raw);
    this.checkProject(i.projectId);
    const now = new Date().toISOString();
    if (i.id && this.db.get('SELECT 1 FROM tasks WHERE id = ?', i.id)) {
      const cur = this.getTask(i.id);
      const status = i.status ?? cur.status;
      const completedAt = status === 'done' ? (cur.completedAt ?? now) : null;
      this.db.run(
        'UPDATE tasks SET title = ?, details = ?, status = ?, priority = ?, due = ?, project_id = ?, updated_at = ?, completed_at = ? WHERE id = ?',
        i.title,
        i.details ?? cur.details,
        status,
        i.priority ?? cur.priority,
        i.due === undefined ? cur.due : i.due,
        i.projectId === undefined ? cur.projectId : i.projectId,
        now,
        completedAt,
        i.id,
      );
      this.changed('tasks');
      return this.getTask(i.id);
    }
    const id = newId('task');
    const status = i.status ?? 'todo';
    this.db.run(
      'INSERT INTO tasks (id, title, details, status, priority, due, project_id, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      i.title,
      i.details ?? '',
      status,
      i.priority ?? 'medium',
      i.due ?? null,
      i.projectId ?? null,
      now,
      now,
      status === 'done' ? now : null,
    );
    this.changed('tasks');
    return this.getTask(id);
  }

  deleteTask(id: string): boolean {
    const ok = this.db.run('DELETE FROM tasks WHERE id = ?', id).changes > 0;
    if (ok) this.changed('tasks');
    return ok;
  }

  /** Open tasks whose due date has passed or falls within `withinDays`. */
  dueSoon(withinDays = 0): Task[] {
    const limit = new Date(Date.now() + withinDays * 86400_000).toISOString().slice(0, 10);
    return this.db.all<any>("SELECT * FROM tasks WHERE status != 'done' AND due IS NOT NULL AND substr(due, 1, 10) <= ? ORDER BY due", limit).map(toTask);
  }

  // --------------------------------------------------------------------------------------- projects

  listProjects(): ProjectSummary[] {
    const today = new Date().toISOString().slice(0, 10);
    return this.db
      .all<any>(
        `SELECT p.*,
           (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS n_tasks,
           (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS n_done,
           (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status != 'done' AND t.due IS NOT NULL AND substr(t.due, 1, 10) < ?) AS n_overdue,
           (SELECT COUNT(*) FROM notes n WHERE n.project_id = p.id) AS n_notes,
           (SELECT COUNT(*) FROM snippets s WHERE s.project_id = p.id) AS n_snippets,
           (SELECT COUNT(*) FROM conversations c WHERE c.project_id = p.id) AS n_chats
         FROM projects p ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, p.updated_at DESC`,
        today,
      )
      .map((r) => ({ ...toProject(r), tasks: r.n_tasks, done: r.n_done, overdue: r.n_overdue, notes: r.n_notes, snippets: r.n_snippets, chats: r.n_chats }));
  }

  getProject(id: string): Project {
    const row = this.db.get<any>('SELECT * FROM projects WHERE id = ?', id);
    if (!row) throw new CoreError('NOT_FOUND', 'Project not found');
    return toProject(row);
  }

  saveProject(raw: unknown): Project {
    const i = ProjectInputSchema.parse(raw);
    const now = new Date().toISOString();
    const milestones = i.milestones?.map((m) => ({ id: m.id || newId('ms'), title: m.title, done: !!m.done }));
    if (i.id && this.db.get('SELECT 1 FROM projects WHERE id = ?', i.id)) {
      const cur = this.getProject(i.id);
      this.db.run(
        'UPDATE projects SET name = ?, description = ?, status = ?, color = ?, due = ?, milestones = ?, updated_at = ? WHERE id = ?',
        i.name,
        i.description ?? cur.description,
        i.status ?? cur.status,
        i.color ?? cur.color,
        i.due === undefined ? cur.due : i.due,
        JSON.stringify(milestones ?? cur.milestones),
        now,
        i.id,
      );
      this.changed('projects');
      return this.getProject(i.id);
    }
    const id = newId('proj');
    this.db.run(
      'INSERT INTO projects (id, name, description, status, color, due, milestones, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      i.name,
      i.description ?? '',
      i.status ?? 'active',
      i.color ?? '',
      i.due ?? null,
      JSON.stringify(milestones ?? []),
      now,
      now,
    );
    this.changed('projects');
    return this.getProject(id);
  }

  /** Deletes a project. Its tasks, notes and snippets are deleted too with `cascade`, otherwise kept unassigned. */
  deleteProject(id: string, cascade = false): boolean {
    let ok = false;
    this.db.tx(() => {
      for (const t of ['tasks', 'notes', 'snippets']) {
        if (cascade) this.db.run(`DELETE FROM ${t} WHERE project_id = ?`, id);
        else this.db.run(`UPDATE ${t} SET project_id = NULL WHERE project_id = ?`, id);
      }
      // Chats are never deleted with a project: they go back to the main history.
      this.db.run('UPDATE conversations SET project_id = NULL WHERE project_id = ?', id);
      ok = this.db.run('DELETE FROM projects WHERE id = ?', id).changes > 0;
    });
    if (ok) for (const k of ['projects', 'tasks', 'notes', 'snippets'] as const) this.changed(k);
    return ok;
  }

  // --------------------------------------------------------------------------------------- snippets

  listSnippets(p: { projectId?: string; query?: string } = {}): Snippet[] {
    const where: string[] = [];
    const args: string[] = [];
    if (p.projectId) {
      where.push('project_id = ?');
      args.push(p.projectId);
    }
    if (p.query?.trim()) {
      where.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR language LIKE ? ESCAPE '\\')");
      const l = like(p.query.trim());
      args.push(l, l, l, l);
    }
    return this.db.all<any>(`SELECT * FROM snippets ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT 1000`, ...args).map(toSnippet);
  }

  getSnippet(id: string): Snippet {
    const row = this.db.get<any>('SELECT * FROM snippets WHERE id = ?', id);
    if (!row) throw new CoreError('NOT_FOUND', 'Snippet not found');
    return toSnippet(row);
  }

  saveSnippet(raw: unknown): Snippet {
    const i = SnippetInputSchema.parse(raw);
    this.checkProject(i.projectId);
    const now = new Date().toISOString();
    if (i.id && this.db.get('SELECT 1 FROM snippets WHERE id = ?', i.id)) {
      const cur = this.getSnippet(i.id);
      this.db.run(
        'UPDATE snippets SET title = ?, language = ?, content = ?, tags = ?, project_id = ?, updated_at = ? WHERE id = ?',
        i.title,
        i.language ?? cur.language,
        i.content ?? cur.content,
        JSON.stringify(i.tags ?? cur.tags),
        i.projectId === undefined ? cur.projectId : i.projectId,
        now,
        i.id,
      );
      this.changed('snippets');
      return this.getSnippet(i.id);
    }
    const id = newId('snip');
    this.db.run(
      'INSERT INTO snippets (id, title, language, content, tags, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      i.title,
      i.language ?? '',
      i.content ?? '',
      JSON.stringify(i.tags ?? []),
      i.projectId ?? null,
      now,
      now,
    );
    this.changed('snippets');
    return this.getSnippet(id);
  }

  deleteSnippet(id: string): boolean {
    const ok = this.db.run('DELETE FROM snippets WHERE id = ?', id).changes > 0;
    if (ok) this.changed('snippets');
    return ok;
  }
}

function toNote(r: any): Note {
  return { id: r.id, title: r.title, content: r.content, tags: json(r.tags, []), projectId: r.project_id, pinned: !!r.pinned, createdAt: r.created_at, updatedAt: r.updated_at };
}
function toTask(r: any): Task {
  return {
    id: r.id,
    title: r.title,
    details: r.details,
    status: r.status,
    priority: r.priority,
    due: r.due,
    projectId: r.project_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  };
}
function toProject(r: any): Project {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    status: r.status,
    color: r.color,
    due: r.due,
    milestones: json(r.milestones, []),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function toSnippet(r: any): Snippet {
  return { id: r.id, title: r.title, language: r.language, content: r.content, tags: json(r.tags, []), projectId: r.project_id, createdAt: r.created_at, updatedAt: r.updated_at };
}
