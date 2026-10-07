import type { Migration } from './db';

/**
 * Schema history. Never edit a shipped migration — append a new one. Snapshots record the schema version
 * so an older snapshot restored onto a newer build is migrated forward on first boot.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: `
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

      CREATE TABLE settings_layers (
        layer TEXT PRIMARY KEY CHECK (layer IN ('local','managed')),
        data TEXT NOT NULL,
        locked TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE vault_keys (
        id TEXT PRIMARY KEY CHECK (id = 'primary'),
        dek_keychain TEXT,
        keychain_kind TEXT,
        dek_recovery TEXT,
        recovery_salt TEXT,
        recovery_params TEXT,
        key_check TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE secrets (
        name TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        managed INTEGER NOT NULL DEFAULT 0,
        internal INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        value_enc TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed_at TEXT
      );

      CREATE TABLE audit_log (
        seq INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        target TEXT,
        outcome TEXT NOT NULL,
        details TEXT,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
      );
      CREATE INDEX audit_ts ON audit_log (ts);
      CREATE INDEX audit_category ON audit_log (category, ts);

      CREATE TABLE policy_layers (
        layer TEXT PRIMARY KEY CHECK (layer IN ('local','managed')),
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE remembered_rules (id TEXT PRIMARY KEY, rule TEXT NOT NULL, created_at TEXT NOT NULL);

      CREATE TABLE tool_state (name TEXT PRIMARY KEY, enabled INTEGER NOT NULL);

      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        provider_id TEXT,
        model TEXT,
        origin TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        tool_call_id TEXT,
        tool_name TEXT,
        provider_id TEXT,
        model TEXT,
        provider_data TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX messages_conv ON messages (conversation_id, seq);

      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE memories_fts USING fts5(content, tags, content='memories', content_rowid='rowid');
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
      END;
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
      END;

      CREATE TABLE plugins (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        dir TEXT NOT NULL,
        manifest TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE plugin_storage (
        plugin_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (plugin_id, key)
      );

      CREATE TABLE connectors (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config TEXT NOT NULL,
        managed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE models (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        file TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT,
        source TEXT NOT NULL,
        installed_at TEXT NOT NULL
      );

      CREATE TABLE fleet_commands (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        received_at TEXT NOT NULL,
        completed_at TEXT
      );
    `,
  },
  {
    version: 2,
    name: 'command-center',
    up: `
      ALTER TABLE conversations ADD COLUMN offline INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        color TEXT NOT NULL DEFAULT '',
        due TEXT,
        milestones TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        project_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX notes_updated ON notes (updated_at);
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo',
        priority TEXT NOT NULL DEFAULT 'medium',
        due TEXT,
        project_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX tasks_status ON tasks (status, due);
      CREATE TABLE snippets (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        project_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE alerts (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        read INTEGER NOT NULL DEFAULT 0,
        deliveries TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX alerts_created ON alerts (created_at);

      CREATE TABLE net_scans (
        id TEXT PRIMARY KEY,
        subnet TEXT NOT NULL,
        label TEXT NOT NULL,
        scanned_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        devices TEXT NOT NULL
      );
      CREATE TABLE speed_tests (
        at TEXT PRIMARY KEY,
        download REAL NOT NULL,
        upload REAL NOT NULL,
        latency REAL,
        jitter REAL,
        server TEXT
      );

      CREATE TABLE mesh_devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT '',
        version TEXT NOT NULL DEFAULT '',
        public_key TEXT NOT NULL,
        addr TEXT,
        port INTEGER,
        last_seen TEXT,
        paired_at TEXT NOT NULL,
        permissions TEXT NOT NULL
      );
      CREATE TABLE mesh_messages (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        from_name TEXT NOT NULL,
        text TEXT NOT NULL,
        at TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: 'message-thinking',
    up: `ALTER TABLE messages ADD COLUMN thinking TEXT;`,
  },
  {
    version: 4,
    name: 'vault-password-on-start',
    up: `ALTER TABLE vault_keys ADD COLUMN password_on_start INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    version: 5,
    name: 'conversation-projects',
    up: `ALTER TABLE conversations ADD COLUMN project_id TEXT;
      CREATE INDEX conversations_project ON conversations (project_id);`,
  },
  {
    version: 6,
    name: 'calendar',
    up: `
      CREATE TABLE calendar_accounts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        address TEXT,
        color TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        can_write INTEGER NOT NULL DEFAULT 0,
        calendars TEXT NOT NULL DEFAULT '[]',
        config TEXT NOT NULL DEFAULT '{}',
        last_sync_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE calendar_events (
        account_id TEXT NOT NULL,
        calendar_id TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        start TEXT NOT NULL,
        end TEXT NOT NULL,
        all_day INTEGER NOT NULL DEFAULT 0,
        location TEXT,
        organizer TEXT,
        join_url TEXT,
        web_link TEXT,
        show_as TEXT NOT NULL DEFAULT 'busy',
        cancelled INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, id)
      );
      CREATE INDEX calendar_events_start ON calendar_events (start);
    `,
  },
  {
    version: 7,
    name: 'shield',
    up: `
      CREATE TABLE shield_signatures (
        sha256 TEXT PRIMARY KEY,
        name TEXT,
        source TEXT NOT NULL,
        added_at TEXT NOT NULL
      );
      CREATE TABLE shield_allow (
        sha256 TEXT PRIMARY KEY,
        path TEXT,
        at TEXT NOT NULL
      );
      CREATE TABLE shield_detections (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        sha256 TEXT,
        size INTEGER,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        engine TEXT NOT NULL,
        reason TEXT NOT NULL,
        source TEXT NOT NULL,
        at TEXT NOT NULL,
        action TEXT NOT NULL,
        action_at TEXT,
        qfile TEXT,
        qkey TEXT,
        mode INTEGER
      );
      CREATE INDEX shield_detections_at ON shield_detections (at);
    `,
  },
  {
    version: 8,
    name: 'mesh-addresses-roles',
    up: `
      ALTER TABLE mesh_devices ADD COLUMN addrs TEXT;
      ALTER TABLE mesh_devices ADD COLUMN roles TEXT;
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
