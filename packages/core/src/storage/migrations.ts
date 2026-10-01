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
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
