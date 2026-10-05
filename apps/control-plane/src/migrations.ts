import type { Migration } from '@fbrx/shared/node';

export const CP_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: `
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

      CREATE TABLE tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active',
        contact_email TEXT,
        notes TEXT NOT NULL DEFAULT '',
        default_profile_id TEXT,
        update_channel TEXT NOT NULL DEFAULT 'stable',
        config_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        mfa_secret TEXT,
        mfa_enabled INTEGER NOT NULL DEFAULT 0,
        failed_logins INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        last_login_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ip TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT
      );

      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        last_used_at TEXT,
        revoked_at TEXT
      );

      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        settings TEXT NOT NULL DEFAULT '{}',
        locked TEXT NOT NULL DEFAULT '[]',
        policy TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, name)
      );

      CREATE TABLE groups (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
        update_channel TEXT,
        pinned_version TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, name)
      );

      CREATE TABLE enrollment_tokens (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
        label TEXT NOT NULL,
        prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        max_uses INTEGER,
        uses INTEGER NOT NULL DEFAULT 0,
        template_snapshot_id TEXT,
        expires_at TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        hostname TEXT NOT NULL,
        platform TEXT NOT NULL,
        arch TEXT NOT NULL,
        os_version TEXT NOT NULL,
        app_version TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        token_hash TEXT NOT NULL UNIQUE,
        enrolled_at TEXT NOT NULL,
        enrolled_via TEXT,
        last_seen_at TEXT,
        last_ip TEXT,
        heartbeat TEXT,
        config_version INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        settings_override TEXT NOT NULL DEFAULT '{}',
        locked_override TEXT NOT NULL DEFAULT '[]',
        policy_override TEXT,
        update_channel TEXT,
        pinned_version TEXT,
        audit_head_seq INTEGER,
        audit_head_hash TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX devices_tenant ON devices (tenant_id, status);

      CREATE TABLE device_metrics (
        id INTEGER PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        ts TEXT NOT NULL,
        cpu REAL, mem REAL, disk_free REAL,
        agent_runs INTEGER, tool_calls INTEGER, denials INTEGER, errors INTEGER
      );
      CREATE INDEX device_metrics_dev ON device_metrics (device_id, ts);

      CREATE TABLE device_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        data TEXT,
        acknowledged_at TEXT
      );
      CREATE INDEX device_events_tenant ON device_events (tenant_id, ts);

      CREATE TABLE commands (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        expires_at TEXT,
        result TEXT,
        error TEXT
      );
      CREATE INDEX commands_device ON commands (device_id, created_at);
      CREATE INDEX commands_status ON commands (status);

      CREATE TABLE releases (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL UNIQUE,
        channel TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        published INTEGER NOT NULL DEFAULT 0,
        rollout_pct INTEGER NOT NULL DEFAULT 100,
        created_by TEXT,
        created_at TEXT NOT NULL,
        published_at TEXT
      );
      CREATE TABLE release_files (
        id TEXT PRIMARY KEY,
        release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
        platform TEXT NOT NULL,
        arch TEXT NOT NULL,
        kind TEXT NOT NULL,
        file_name TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha512 TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (release_id, file_name)
      );

      CREATE TABLE licenses (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        customer TEXT NOT NULL,
        edition TEXT NOT NULL,
        seats INTEGER NOT NULL,
        features TEXT NOT NULL DEFAULT '[]',
        issued_at TEXT NOT NULL,
        expires_at TEXT,
        max_major_version INTEGER,
        key_text TEXT NOT NULL,
        created_by TEXT,
        revoked_at TEXT
      );

      CREATE TABLE secrets (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        name TEXT NOT NULL,
        value_enc TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, scope, scope_id, name)
      );

      CREATE TABLE snapshots (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
        device_name TEXT NOT NULL,
        name TEXT NOT NULL,
        label TEXT,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        header TEXT,
        storage_path TEXT NOT NULL,
        is_template INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE packages (
        id TEXT PRIMARY KEY,
        tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
        plugin_id TEXT NOT NULL,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        permissions TEXT NOT NULL DEFAULT '[]',
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE webhooks (
        id TEXT PRIMARY KEY,
        tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        secret_enc TEXT NOT NULL,
        events TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_by TEXT,
        created_at TEXT NOT NULL,
        last_status INTEGER,
        last_delivery_at TEXT,
        last_error TEXT
      );

      CREATE TABLE audit_log (
        seq INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        tenant_id TEXT,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        actor_label TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        ip TEXT,
        details TEXT,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
      );
      CREATE INDEX cp_audit_tenant ON audit_log (tenant_id, seq);
    `,
  },
  {
    version: 2,
    name: 'sso',
    up: `
      CREATE TABLE sso_connections (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        issuer TEXT NOT NULL,
        client_id TEXT NOT NULL,
        client_secret_enc TEXT NOT NULL,
        domains TEXT NOT NULL DEFAULT '[]',
        auto_provision INTEGER NOT NULL DEFAULT 0,
        default_role TEXT NOT NULL DEFAULT 'viewer',
        require_sso INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX cp_sso_tenant ON sso_connections (tenant_id);
      ALTER TABLE users ADD COLUMN sso_connection_id TEXT;
      ALTER TABLE users ADD COLUMN sso_subject TEXT;
    `,
  },
  {
    version: 3,
    name: 'helpdesk',
    up: `
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
        requester_name TEXT NOT NULL,
        subject TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'other',
        priority TEXT NOT NULL DEFAULT 'normal',
        status TEXT NOT NULL DEFAULT 'open',
        assignee_device_id TEXT,
        assignee_name TEXT,
        diagnostics TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE (tenant_id, number)
      );
      CREATE INDEX cp_tickets_tenant ON tickets (tenant_id, status, updated_at);
      CREATE INDEX cp_tickets_device ON tickets (device_id, updated_at);
      CREATE TABLE ticket_messages (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL,
        author_kind TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_device_id TEXT,
        author_user_id TEXT,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX cp_ticket_messages ON ticket_messages (ticket_id, created_at);
      ALTER TABLE devices ADD COLUMN helpdesk_receiver INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tenants ADD COLUMN helpdesk_enabled INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    version: 4,
    name: 'audiences-and-updates',
    up: `
      ALTER TABLE tenants ADD COLUMN vertical TEXT NOT NULL DEFAULT 'business';
      ALTER TABLE tenants ADD COLUMN auto_update TEXT NOT NULL DEFAULT 'notify';
      ALTER TABLE groups ADD COLUMN audience TEXT;
      ALTER TABLE groups ADD COLUMN tier TEXT;
      ALTER TABLE groups ADD COLUMN auto_update TEXT;
      ALTER TABLE enrollment_tokens ADD COLUMN audience TEXT;
      ALTER TABLE devices ADD COLUMN audience TEXT;
      ALTER TABLE licenses ADD COLUMN vertical TEXT;
    `,
  },
];
