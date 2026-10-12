import type { Migration } from '@fbrx/shared/node';

export const VIRTUAL_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'users, sessions, audit, settings',
    up: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_login_at TEXT
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        ip TEXT
      );
      CREATE INDEX sessions_user ON sessions(user_id);
      CREATE TABLE audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        outcome TEXT NOT NULL,
        details TEXT
      );
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'FBRX Time: backup jobs, images, tasks',
    up: `
      CREATE TABLE time_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        vm_id TEXT NOT NULL,
        vm_name TEXT NOT NULL,
        schedule TEXT NOT NULL,
        time TEXT NOT NULL,
        day INTEGER NOT NULL,
        verify INTEGER NOT NULL,
        keep INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        last_run_at TEXT,
        last_ok INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE time_images (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        subject TEXT NOT NULL,
        job_id TEXT,
        created_at TEXT NOT NULL,
        dir TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        disks TEXT NOT NULL,
        os TEXT NOT NULL,
        firmware TEXT NOT NULL,
        consistency TEXT NOT NULL,
        check_json TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        facts TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX time_images_subject ON time_images(subject, created_at);
      CREATE TABLE time_tasks (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        state TEXT NOT NULL,
        queued_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        progress REAL,
        detail TEXT NOT NULL DEFAULT '',
        image_id TEXT
      );
    `,
  },
];
