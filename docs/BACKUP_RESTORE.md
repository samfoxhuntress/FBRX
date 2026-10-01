# Backup, restore and machine moves

FBRX OS is built so a workstation can be lost, replaced or duplicated without losing anything: settings, policy,
vault secrets, conversations, agent memory, plugins and their data, connectors, the workspace and (optionally)
downloaded models all live under one data folder and travel together in one encrypted snapshot.

## Snapshots

A snapshot is a single `.fbrxsnap` file:

```
"FBRXSNAP" | u32 header length | header JSON | AES-256-GCM( tar.gz ) | 16-byte GCM tag
```

* The key is derived from your **snapshot passphrase** with scrypt; the header (app version, schema version,
  hostname, creation time, KDF parameters) is authenticated as GCM additional data, so it cannot be altered.
* Inside: a consistent copy of the database (`VACUUM INTO`, safe while running), `plugins/`, `plugin-data/`,
  `workspace/`, optionally `models/`, and a manifest with the SHA-256 of every file (checked on restore).
* The manifest also carries the vault's data key, so the restored machine can read every secret even though its OS
  keychain is different. That is why the passphrase matters: **anyone with the file and the passphrase has your
  secrets.** Use a long passphrase and keep it in your password manager.
* Machine-bound items are never captured: logs, the downloaded runtime, temp files, the local keychain fallback.

### Creating snapshots

| How | Where |
| --- | --- |
| On demand | Desktop: **Backup → Create snapshot**. Headless: `fbrx-headless backup "<passphrase>" --label before-upgrade` |
| On a schedule | **Backup → Schedule**: interval, retention, folder (point it at a synced or network folder for off-machine copies), include models |
| Remotely | Admin console: device → **Back up now** (or the `backup.create` command, also in bulk). The snapshot is uploaded to the control plane, which keeps the latest N per device |

Scheduled and remote backups run unattended, so they take the passphrase from the vault secret named in
`backup.passphraseSecret` (default `FBRX_BACKUP_PASSPHRASE`). Set it on the workstation, or — better for fleets —
create it once as a **tenant secret** in the admin console so every device gets it and you can restore any of them.

## Restoring

Restores are staged: the snapshot is decrypted and verified into `.restore-staging/`, the vault key is re-bound to
this machine's keychain, and the app restarts. On the next boot the staged data is swapped in *before* anything is
opened. The data it replaced is kept in `.pre-restore/<timestamp>/` (the three most recent are retained), so a
mistaken restore can be undone by hand.

Snapshots from older versions restore into newer ones (the database migrates forward on boot). A snapshot from a
newer version is refused until the target is updated.

### Migrate — "as if nothing happened"

Use **migrate** when the new machine *replaces* the old one (hardware refresh, lost laptop, reinstall):

* Everything comes back, including the fleet identity: same device record in the console, same group, managed
  configuration, license and secrets. The device simply reconnects from new hardware.
* The audit log continues on the same hash chain and records the restore.
* Retire or wipe the old machine afterwards — two machines with one identity will fight over the same device record.

Desktop: **Backup → Restore from file → Migrate**. Headless: `fbrx-headless restore snapshot.fbrxsnap "<passphrase>"`.

### Clone — a new machine from a template

Use **clone** to stand up *additional* machines that start from the same state (a golden image):

* Keeps settings, local policy, the user's own vault secrets, plugins, connectors, workspace and memory.
* Drops the fleet identity, the managed layers (settings, policy, secrets, license) and queued commands, so the copy
  enrolls as a new device and receives its own managed configuration.
* Drops the mesh identity and paired devices, so each copy pairs its own phone and computers.

Desktop: **Restore from file → Clone**. Headless: `fbrx-headless restore snapshot.fbrxsnap "<passphrase>" --clone`.
Fleet: pick the snapshot as the **template** on an enrollment token — every machine provisioned with that token
restores it as a clone before enrolling (see [DEPLOYMENT.md](DEPLOYMENT.md#4-rolling-out-to-workstations)).

### Moving to a new computer, step by step

1. Old machine: **Backup → Create snapshot** (tick *include models* to avoid re-downloading them), or take one
   remotely from the console.
2. Copy the `.fbrxsnap` file over (USB, network share), or download it from the console (**Backups**).
3. New machine: install FBRX OS (same or newer version). On the first screen choose **Restore from a backup**
   (or later: **Backup → Restore from file**), pick the file, enter the passphrase, choose **Migrate**.
4. The app restarts on the restored state. Re-download the local runtime if it isn't bundled (Local AI page).

## If the OS keychain is lost

Normally the vault's data key is protected by the macOS Keychain or Windows DPAPI, which is tied to the user
account. If the account is rebuilt or the keychain reset, FBRX OS starts with the vault **locked**. Unlock it
with the **recovery passphrase** (set it in **Vault → Recovery**; strongly recommended) — or restore a snapshot,
which carries the key itself.

## The control plane

Everything the control plane knows is in its data directory (`/data` in Docker):

| Item | Notes |
| --- | --- |
| `control-plane.db` (+ `-wal`, `-shm`) | Tenants, users, devices, configuration, secrets (sealed), licenses, audit |
| `keys/` | `jwt.key`, `master.key` (seals secrets), `license-signing.pem`. Unless supplied via environment variables, **losing these is unrecoverable**: sealed secrets become unreadable and licenses can no longer be issued under the same key |
| `releases/`, `snapshots/`, `packages/` | Uploaded files |

Back it up with the volume stopped, or take a consistent online copy of the database:

```bash
docker compose -f deploy/control-plane/docker-compose.yml exec control-plane \
  node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('/data/control-plane.db').exec(\"VACUUM INTO '/data/backup.db'\")"
```

…then copy `backup.db`, `keys/` and the file folders off the host. To move the control plane, restore the data
directory on the new host (rename `backup.db` to `control-plane.db`) and point DNS at it; devices reconnect on
their own because they address it by URL.
