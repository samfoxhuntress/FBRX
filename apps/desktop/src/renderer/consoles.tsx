import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { DEVICE_PROFILES, commandSearchUrl, deviceProfile, matchDeviceProfile, type ConsoleBookmark, type ConsoleProtocol, type ConsoleSession, type DeviceProfile } from '@fbrx/shared';
import { Button, Callout, Empty, Field, Icons, InfoTip, Input, Modal, Select, Status, TextArea, Toggle, timeAgo, useConfirm, useToast } from '@fbrx/ui';
import { bridge, call, onEvent } from './client';
import { useAgentName, useConsoleSessions, useCore } from './hooks';
import { askAgent } from './widgets';

// ------------------------------------------------------------------------------------ session output

/** Raw output of each console, kept so a console shows its history when you come back to it. */
const raw = new Map<string, string>();
const RAW_MAX = 400_000;
const listeners = new Set<(id: string, data: string) => void>();
onEvent('console.data', (e) => {
  raw.set(e.id, ((raw.get(e.id) ?? '') + e.data).slice(-RAW_MAX));
  for (const l of listeners) l(e.id, e.data);
});


const webUrl = (host: string, port: number) => `${[80, 8080, 5000, 8000].includes(port) ? 'http' : 'https'}://${host}${port === 80 || port === 443 ? '' : `:${port}`}`;

// ---------------------------------------------------------------------------------- connect dialog

export interface ConnectTarget {
  host?: string;
  name?: string | null;
  vendor?: string | null;
  model?: string | null;
  ports?: number[];
  protocol?: ConsoleProtocol;
  /** From Saved connections: its port, user, guide and name. */
  port?: number;
  username?: string | null;
  profileId?: string | null;
  /** Connect straight away (a saved connection with its password saved). */
  auto?: boolean;
}

/** Log in to a device over SSH or Telnet, confirming its identity (host key) the first time. */
export function ConnectDialog({ target, onClose, onConnected }: { target?: ConnectTarget; onClose: () => void; onConnected: (s: ConsoleSession) => void }) {
  const matched = target ? matchDeviceProfile({ vendor: target.vendor, name: target.name, model: target.model, ports: target.ports }) : null;
  const logins = useCore('console.logins');
  const [host, setHost] = useState(target?.host ?? '');
  const [protocol, setProtocol] = useState<ConsoleProtocol>(target?.protocol ?? (target?.ports && !target.ports.includes(22) && target.ports.includes(23) ? 'telnet' : 'ssh'));
  const [profileId, setProfileId] = useState(target?.profileId ?? matched?.id ?? '');
  const profile = deviceProfile(profileId);
  const defaultPort = protocol === 'telnet' ? 23 : (profile?.sshPort ?? 22);
  const [port, setPort] = useState(target?.port && target.port !== (protocol === 'telnet' ? 23 : 22) ? String(target.port) : '');
  const saved = (logins.data ?? []).filter((l) => l.host === host.trim() && l.protocol === protocol);
  const [username, setUsername] = useState<string | null>(target?.username ?? null);
  const [keep, setKeep] = useState(true);
  const user = username ?? saved[0]?.username ?? profile?.defaultUser ?? '';
  const hasSaved = saved.some((l) => l.username === user && l.port === (Number(port) || defaultPort));
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [legacy, setLegacy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hostKey, setHostKey] = useState<{ fingerprint: string; keyType: string; status: 'new' | 'changed'; previous: string | null } | null>(null);

  const connect = async (trust?: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await call('console.connect', {
        host: host.trim(),
        port: Number(port) || defaultPort,
        protocol,
        username: user || undefined,
        password: password || undefined,
        useSaved: !password && hasSaved,
        remember: remember && !!password,
        legacy: legacy || undefined,
        trustFingerprint: trust,
        profileId: profileId || undefined,
        vendor: target?.vendor ?? undefined,
        label: target?.name ? (target.username !== undefined ? target.name : `${target.name} (${host.trim()})`) : undefined,
        save: keep,
        cols: 120,
        rows: 32,
      });
      if ('hostKey' in r) setHostKey(r.hostKey);
      else onConnected(r.session);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // A saved connection whose password is saved goes straight in (the dialog stays for a key question or an error).
  const autoTried = useRef(false);
  useEffect(() => {
    if (!target?.auto || autoTried.current || !logins.data) return;
    autoTried.current = true;
    if (hasSaved || protocol === 'telnet') void connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logins.data]);

  const title = target?.name || target?.vendor ? `Connect to ${target.name ?? target.vendor}` : 'Connect to a device';
  return (
    <Modal
      title={title}
      description={profile ? `${profile.name} · ${profile.kind}` : 'Open a command line on a switch, firewall, access point, NAS or server.'}
      onClose={onClose}
      footer={
        hostKey ? (
          <>
            <Button variant="ghost" onClick={() => setHostKey(null)}>
              Back
            </Button>
            <Button variant={hostKey.status === 'changed' ? 'danger-solid' : 'primary'} loading={busy} onClick={() => void connect(hostKey.fingerprint)}>
              {hostKey.status === 'changed' ? 'Trust the new key and connect' : 'Trust and connect'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" icon="terminal" loading={busy} disabled={!host.trim() || (protocol === 'ssh' && !user)} onClick={() => void connect()}>
              Connect
            </Button>
          </>
        )
      }
    >
      {hostKey ? (
        hostKey.status === 'changed' ? (
          <Callout tone="critical" title="This device's identity changed">
            The key {host} uses to prove who it is is different from the one saved the last time ({hostKey.previous}). That is expected after a factory reset, a firmware reinstall or a replacement device, but it can also mean someone is intercepting the connection. Only continue if you know why it changed.
            <div className="mono" style={{ marginTop: 8, fontSize: 12 }}>
              New: {hostKey.keyType} {hostKey.fingerprint}
            </div>
          </Callout>
        ) : (
          <Callout tone="info" title={`First connection to ${host}`}>
            FBRX saves the device's key so it can warn you if it ever changes. To be thorough, compare the fingerprint with the one the device shows on its console or web admin page.
            <div className="mono" style={{ marginTop: 8, fontSize: 12 }}>
              {hostKey.keyType} {hostKey.fingerprint}
            </div>
          </Callout>
        )
      ) : (
        <div className="fx-form">
          <div className="fx-row">
            <Field label="Address">
              <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.1" autoFocus={!target?.host} />
            </Field>
            <Field label="Connect with">
              <div className="seg" role="group">
                {(['ssh', 'telnet'] as const).map((p) => (
                  <button key={p} className={protocol === p ? 'on' : ''} onClick={() => setProtocol(p)}>
                    {p === 'ssh' ? 'SSH' : 'Telnet'}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Port">
              <Input type="number" value={port} placeholder={String(defaultPort)} onChange={(e) => setPort(e.target.value)} style={{ width: 90 }} />
            </Field>
          </div>
          {protocol === 'telnet' && (
            <Callout tone="warning" title="Telnet is not encrypted">
              Your password and everything you type cross the network in plain text. Use it only on a network you trust, ideally to turn on SSH.
            </Callout>
          )}
          <div className="fx-row">
            <Field label="User name" help={profile?.defaultUser && !saved.length ? `Usually "${profile.defaultUser}" on ${profile.name.split(' ')[0]} gear` : undefined}>
              <Input value={user} onChange={(e) => setUsername(e.target.value)} placeholder={protocol === 'telnet' ? 'Optional' : 'admin'} autoFocus={!!target?.host} list="console-users" />
              <datalist id="console-users">
                {saved.map((l) => (
                  <option key={l.username} value={l.username} />
                ))}
              </datalist>
            </Field>
            <Field label="Password" help={hasSaved && !password ? 'Leave empty to use the saved password' : 'Leave empty to use your SSH key (~/.ssh)'}>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={hasSaved ? '•••••••• (saved)' : ''} onKeyDown={(e) => e.key === 'Enter' && host.trim() && void connect()} />
            </Field>
          </div>
          <div className="fx-row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Toggle checked={remember} onChange={setRemember} disabled={!password} label="Remember the password on this computer (encrypted)" />
            <Toggle checked={keep} onChange={setKeep} label="Keep in Saved connections" info="The device, its user and its guide go in Saved connections for one-click connecting next time. The password is kept only if you choose to remember it." />
          </div>
          <Field label="Device guide" help="Commands and documentation shown next to the console">
            <Select value={profileId} onChange={(e) => setProfileId(e.target.value)} options={[{ value: '', label: matched ? `Automatic (${matched.name})` : 'None' }, ...DEVICE_PROFILES.map((p) => ({ value: p.id, label: p.name }))]} />
          </Field>
          {protocol === 'ssh' && <Toggle checked={legacy} onChange={setLegacy} label="Allow older encryption (old switch or firewall firmware; FBRX also tries this by itself)" />}
          {error && <Callout tone="critical" title="Could not connect">{error}</Callout>}
          {hasSaved && (
            <div className="fx-muted" style={{ fontSize: 12.5 }}>
              A password is saved for {user}@{host.trim()}.{' '}
              <button
                className="linklike"
                onClick={() =>
                  void call('console.forgetLogin', { host: host.trim(), port: Number(port) || defaultPort, username: user }).then(() => {
                    logins.reload();
                  })
                }
              >
                Forget it
              </button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ----------------------------------------------------------------------------------- console view

function cssVar(name: string, fallback: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** The terminal screen of one session (xterm.js), sized to its box. */
function Screen({ session }: { session: ConsoleSession }) {
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const closed = session.state === 'closed';
  const closedRef = useRef(closed);
  closedRef.current = closed;
  useEffect(() => {
    const t = new Terminal({
      fontFamily: 'Cascadia Mono, Consolas, "JetBrains Mono", Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: false,
      theme: { background: '#0c0e11', foreground: '#e3e6ea', cursor: cssVar('--accent', '#f4b942'), selectionBackground: 'rgba(244,185,66,0.35)' },
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(box.current!);
    term.current = t;
    t.write(raw.get(session.id) ?? '');
    const onData = (id: string, data: string) => id === session.id && t.write(data);
    listeners.add(onData);
    const input = t.onData((data) => {
      if (!closedRef.current) void call('console.write', { id: session.id, data }).catch(() => undefined);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* not visible */
      }
      clearTimeout(timer);
      timer = setTimeout(() => void call('console.resize', { id: session.id, cols: t.cols, rows: t.rows }).catch(() => undefined), 150);
    });
    ro.observe(box.current!);
    t.focus();
    return () => {
      ro.disconnect();
      clearTimeout(timer);
      listeners.delete(onData);
      input.dispose();
      t.dispose();
      term.current = null;
    };
  }, [session.id]);
  useEffect(() => {
    if (closed) term.current?.write(`\r\n\x1b[33m[${session.reason ?? 'Disconnected'}]\x1b[0m\r\n`);
  }, [closed, session.reason]);
  return <div className="console-screen" ref={box} onClick={() => term.current?.focus()} />;
}

function Guide({ session, profile }: { session: ConsoleSession; profile: DeviceProfile | null }) {
  const agent = useAgentName();
  const { confirm, dialog } = useConfirm();
  const open = session.state === 'open';
  const type = async (cmd: string, run: boolean, danger?: boolean) => {
    if (run && danger && !(await confirm({ title: 'Send this command?', body: `"${cmd}" changes or restarts the device.`, confirmLabel: 'Send', danger: true }))) return;
    for (const line of run ? cmd.split('\n') : [cmd]) await call('console.write', { id: session.id, data: run ? `${line}\r` : line });
  };
  const ask = async (prompt: string) => {
    const { text } = await call('console.transcript', { id: session.id }).catch(() => ({ text: '' }));
    askAgent(prompt, text.split('\n').slice(-80).join('\n'));
  };
  const device = `${profile?.name ?? session.vendor ?? 'a network device'} at ${session.host}`;
  return (
    <div className="console-guide">
      <div className="console-guide-ai">
        <Button
          size="sm"
          variant="primary"
          icon="sparkles"
          onClick={() =>
            void ask(
              `I'm connected to ${device} over ${session.protocol.toUpperCase()} in the FBRX device console (session ${session.id}). Help me with it. You can read the console with device_console.read and type commands with device_console.send; I approve each command. Start by telling me what is on the screen and what I can do next.`,
            )
          }
        >
          Get help from {agent}
        </Button>
        <Button size="sm" className="ask-btn" icon="sparkles" onClick={() => void ask(`Explain what this ${device} console is showing, in plain language, and what I should do next. The last lines of the console are below.`)}>
          Explain the screen
        </Button>
      </div>
      {profile ? (
        <>
          <div className="console-guide-head">
            <strong>{profile.name}</strong>
            <span className="fx-muted">{profile.kind}</span>
          </div>
          <ul className="console-tips">
            {profile.login.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          {profile.noPaging && (
            <Button size="sm" variant="ghost" icon="layers" disabled={!open} onClick={() => void type(profile.noPaging!, true)} title={profile.noPaging}>
              Show long output without --More--
            </Button>
          )}
          {profile.commands.map((g) => (
            <div key={g.group} className="console-cmds">
              <div className="console-cmds-title">{g.group}</div>
              {g.items.map((c) => (
                <div key={c.cmd} className={`console-cmd${c.danger ? ' danger' : ''}`}>
                  <button className="console-cmd-text" disabled={!open} onClick={() => void type(c.cmd, false)} title="Type it (press Enter in the console to run)">
                    <code>{c.cmd}</code>
                    <span>{c.what}</span>
                  </button>
                  <Button size="sm" variant="ghost" icon="play" aria-label={`Run ${c.cmd}`} title={c.danger ? 'Run (asks first)' : 'Run'} disabled={!open} onClick={() => void type(c.cmd, true, c.danger)} />
                </div>
              ))}
            </div>
          ))}
          <div className="console-cmds-title">Documentation</div>
          <div className="console-docs">
            {profile.docs.map((d) => (
              <button key={d.url} className="linklike" onClick={() => bridge.openExternal?.(d.url)}>
                {d.label} ↗
              </button>
            ))}
            <button className="linklike" onClick={() => bridge.openExternal?.(commandSearchUrl(profile.name, session.vendor))}>
              Search for more commands ↗
            </button>
          </div>
        </>
      ) : (
        <div className="fx-muted" style={{ fontSize: 12.5 }}>
          No guide for this device yet.{' '}
          <button className="linklike" onClick={() => bridge.openExternal?.(commandSearchUrl(session.vendor ?? session.host))}>
            Search its commands ↗
          </button>
        </div>
      )}
      {dialog}
    </div>
  );
}

/** The device consoles tab of the Terminal page: open sessions on the left, the selected one with its guide. */
export function DeviceConsolesPanel({ selected, onSelect }: { selected: string | null; onSelect: (id: string | null) => void }) {
  const sessions = useConsoleSessions();
  const bookmarks = useCore('console.bookmarks');
  const [connect, setConnect] = useState<ConnectTarget | null>(null);
  const [editing, setEditing] = useState<ConsoleBookmark | 'new' | null>(null);
  const [showSaved, setShowSaved] = useState(false);
  const fromBookmark = (b: ConsoleBookmark): ConnectTarget => ({ host: b.host, port: b.port, protocol: b.protocol, username: b.username, profileId: b.profileId, name: b.label, vendor: b.vendor, auto: true });
  const [showGuide, setShowGuide] = useState(true);
  const toast = useToast();
  const list = sessions.data ?? [];
  const current = list.find((s) => s.id === selected) ?? list[0] ?? null;
  const profile = useMemo(() => deviceProfile(current?.profileId), [current?.profileId]);
  useEffect(() => {
    if (current && current.id !== selected) onSelect(current.id);
  }, [current, selected, onSelect]);
  return (
    <div className="consoles">
      <div className="consoles-list">
        <Button size="sm" variant="primary" icon="plus" onClick={() => setConnect({})}>
          New connection
        </Button>
        {list.map((s) => (
          <button key={s.id} className={`agent-conv${current?.id === s.id && !showSaved ? ' active' : ''}`} onClick={() => (setShowSaved(false), onSelect(s.id))}>
            <div className="agent-conv-title">
              <span className={`dot ${s.state === 'open' ? 'ok' : s.state === 'connecting' ? 'busy' : 'bad'}`} aria-hidden /> {s.label}
            </div>
            <div className="agent-conv-sub">
              {s.protocol.toUpperCase()} · {s.host}:{s.port}
            </div>
          </button>
        ))}
        <div className="consoles-saved-head">
          <button type="button" className={`linklike${showSaved ? ' on' : ''}`} onClick={() => setShowSaved((v) => !v)}>
            Saved connections{bookmarks.data?.length ? ` (${bookmarks.data.length})` : ''}
          </button>
          <InfoTip>Devices you connected to before, with their user and guide. A key means the password is saved (encrypted in your vault): one click connects.</InfoTip>
        </div>
        {(bookmarks.data ?? []).slice(0, 8).map((b) => (
          <button key={b.id} className="agent-conv saved" onClick={() => setConnect(fromBookmark(b))} title={`Connect to ${b.label}`}>
            <div className="agent-conv-title">
              {b.passwordSaved ? <Icons.key size={11} /> : <Icons.terminal size={11} />} {b.label}
            </div>
            <div className="agent-conv-sub">
              {b.protocol.toUpperCase()} · {b.host}
              {b.port !== (b.protocol === 'telnet' ? 23 : 22) ? `:${b.port}` : ''}
            </div>
          </button>
        ))}
      </div>
      {showSaved || (!current && (bookmarks.data?.length ?? 0) > 0) ? (
        <SavedConnections
          list={bookmarks.data ?? []}
          onConnect={(b) => setConnect(fromBookmark(b))}
          onEdit={(b) => setEditing(b)}
          onAdd={() => setEditing('new')}
          onChanged={() => bookmarks.reload()}
        />
      ) : current ? (
        <div className="console-main">
          <div className="console-head">
            <div style={{ minWidth: 0 }}>
              <div className="console-title">{current.label}</div>
              <div className="fx-muted mono" style={{ fontSize: 12 }}>
                {current.protocol.toUpperCase()} {current.host}:{current.port}
                {current.fingerprint ? ` · ${current.fingerprint.slice(0, 26)}…` : ''}
              </div>
            </div>
            <span className="fx-spacer" />
            <Status tone={current.state === 'open' ? 'good' : current.state === 'connecting' ? 'busy' : 'neutral'}>{current.state === 'open' ? 'Connected' : current.state === 'connecting' ? 'Connecting' : 'Closed'}</Status>
            {profile?.webPorts?.length ? (
              <Button size="sm" icon="external" onClick={() => bridge.openExternal?.(webUrl(current.host, profile.webPorts![0]))}>
                Web admin
              </Button>
            ) : null}
            {bridge.platform === 'win32' && current.protocol === 'ssh' && (
              <Button size="sm" variant="ghost" icon="terminal" title="Open the same login in Windows Terminal" onClick={() => void call('net.ssh', { host: current.host, user: current.username ?? undefined, port: current.port })}>
                Windows Terminal
              </Button>
            )}
            <Button size="sm" variant="ghost" icon="book" onClick={() => setShowGuide((v) => !v)}>
              {showGuide ? 'Hide guide' : 'Guide'}
            </Button>
            {current.state === 'closed' ? (
              <Button size="sm" icon="refresh" onClick={() => setConnect({ host: current.host, protocol: current.protocol, name: current.label, vendor: current.vendor })}>
                Reconnect
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              icon="x"
              onClick={() =>
                void call('console.close', { id: current.id }).then(() => {
                  onSelect(null);
                  sessions.reload();
                })
              }
            >
              {current.state === 'closed' ? 'Remove' : 'Disconnect'}
            </Button>
          </div>
          <div className={`console-body${showGuide ? ' with-guide' : ''}`}>
            <Screen key={current.id} session={current} />
            {showGuide && <Guide session={current} profile={profile} />}
          </div>
        </div>
      ) : (
        <Empty title="No device consoles open" action={<Button variant="primary" icon="plus" onClick={() => setConnect({})}>New connection</Button>}>
          Connect to a switch, firewall, access point, NAS or server over SSH (or Telnet for old gear). From Network Center → Devices, a found device opens with its maker's guide.
        </Empty>
      )}
      {connect && (
        <ConnectDialog
          target={connect}
          onClose={() => setConnect(null)}
          onConnected={(s) => {
            setConnect(null);
            setShowSaved(false);
            sessions.reload();
            bookmarks.reload();
            onSelect(s.id);
            toast.success(`Connected to ${s.host}`);
          }}
        />
      )}
      {editing && <BookmarkEditor bookmark={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), bookmarks.reload())} />}
    </div>
  );
}

/** Saved connections: every device you connect to, with its user, guide and (if you chose) its password. */
function SavedConnections({ list, onConnect, onEdit, onAdd, onChanged }: { list: ConsoleBookmark[]; onConnect: (b: ConsoleBookmark) => void; onEdit: (b: ConsoleBookmark) => void; onAdd: () => void; onChanged: () => void }) {
  const [q, setQ] = useState('');
  const { confirm, dialog } = useConfirm();
  const forgetRef = useRef(true);
  const s = q.trim().toLowerCase();
  const shown = s ? list.filter((b) => `${b.label} ${b.host} ${b.username ?? ''} ${b.notes} ${deviceProfile(b.profileId)?.name ?? ''}`.toLowerCase().includes(s)) : list;
  return (
    <div className="console-main saved-connections">
      <div className="console-head">
        <div>
          <div className="console-title">Saved connections</div>
          <div className="fx-muted" style={{ fontSize: 12.5 }}>
            Your switches, firewalls, access points and servers. Passwords you chose to remember stay encrypted in your vault (Credentials).
          </div>
        </div>
        <span className="fx-spacer" />
        <div style={{ width: 220 }}>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search saved connections" aria-label="Search saved connections" />
        </div>
        <Button size="sm" icon="plus" onClick={onAdd}>
          Add
        </Button>
      </div>
      {list.length === 0 ? (
        <Empty title="Nothing saved yet">Connect to a device and it is kept here, or add one by hand.</Empty>
      ) : (
        <div className="saved-grid">
          {shown.map((b) => {
            // No guide picked: the one Connect would pick from its name.
            const guide = deviceProfile(b.profileId) ?? matchDeviceProfile({ vendor: b.vendor, name: b.label });
            return (
              <div key={b.id} className="saved-card">
                <div className="saved-card-head">
                  <b>{b.label}</b>
                  {b.passwordSaved && (
                    <span className="saved-key" title="Password saved (encrypted)">
                      <Icons.key size={12} /> saved
                    </span>
                  )}
                </div>
                <div className="mono fx-muted" style={{ fontSize: 12 }}>
                  {b.protocol.toUpperCase()} {b.username ? `${b.username}@` : ''}
                  {b.host}:{b.port}
                </div>
                <div className="fx-muted" style={{ fontSize: 12 }}>
                  {guide ? guide.name : 'No guide'} · {b.lastConnectedAt ? `used ${timeAgo(b.lastConnectedAt)}` : 'not used yet'}
                </div>
                {b.notes && <div className="saved-notes">{b.notes}</div>}
                <div className="fx-actions">
                  <Button size="sm" variant="primary" icon="terminal" onClick={() => onConnect(b)}>
                    Connect
                  </Button>
                  <Button size="sm" variant="ghost" icon="edit" onClick={() => onEdit(b)}>
                    Edit
                  </Button>
                  <span className="fx-spacer" />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    aria-label={`Remove ${b.label}`}
                    onClick={async () => {
                      forgetRef.current = true;
                      if (
                        await confirm({
                          title: `Remove ${b.label}?`,
                          body: b.passwordSaved ? (
                            <ForgetToggle value={forgetRef} />
                          ) : (
                            'It leaves Saved connections. You can connect to it again any time.'
                          ),
                          confirmLabel: 'Remove',
                          danger: true,
                        })
                      )
                        await call('console.removeBookmark', { id: b.id, forgetPassword: b.passwordSaved && forgetRef.current }).then(onChanged);
                    }}
                  />
                </div>
              </div>
            );
          })}
          {!shown.length && <div className="fx-muted">Nothing matches “{q}”.</div>}
        </div>
      )}
      {dialog}
    </div>
  );
}

/** Lives inside the confirmation, so it keeps its own state and reports it through the ref. */
function ForgetToggle({ value }: { value: { current: boolean } }) {
  const [on, setOn] = useState(value.current);
  return <Toggle checked={on} onChange={(v) => ((value.current = v), setOn(v))} label="Also forget its saved password" />;
}

function BookmarkEditor({ bookmark, onClose, onSaved }: { bookmark: ConsoleBookmark | null; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState(bookmark?.label ?? '');
  const [host, setHost] = useState(bookmark?.host ?? '');
  const [protocol, setProtocol] = useState<ConsoleProtocol>(bookmark?.protocol ?? 'ssh');
  const [port, setPort] = useState(bookmark ? String(bookmark.port) : '');
  const [username, setUsername] = useState(bookmark?.username ?? '');
  const [profileId, setProfileId] = useState(bookmark?.profileId ?? '');
  const [notes, setNotes] = useState(bookmark?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await call('console.saveBookmark', { id: bookmark?.id, label, host, protocol, port: Number(port) || undefined, username: username || null, profileId: profileId || null, notes });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={bookmark ? `Edit ${bookmark.label}` : 'Add a saved connection'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!host.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Name">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Core switch" autoFocus />
        </Field>
        <div className="fx-row">
          <Field label="Address">
            <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.2" disabled={!!bookmark} />
          </Field>
          <Field label="Connect with">
            <div className="seg" role="group">
              {(['ssh', 'telnet'] as const).map((p) => (
                <button key={p} className={protocol === p ? 'on' : ''} disabled={!!bookmark} onClick={() => setProtocol(p)}>
                  {p === 'ssh' ? 'SSH' : 'Telnet'}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Port">
            <Input type="number" value={port} placeholder={protocol === 'telnet' ? '23' : '22'} onChange={(e) => setPort(e.target.value)} disabled={!!bookmark} style={{ width: 90 }} />
          </Field>
        </div>
        <div className="fx-row">
          <Field label="User name">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" disabled={!!bookmark} />
          </Field>
          <Field label="Device guide">
            <Select value={profileId} onChange={(e) => setProfileId(e.target.value)} options={[{ value: '', label: 'None' }, ...DEVICE_PROFILES.map((p) => ({ value: p.id, label: p.name }))]} />
          </Field>
        </div>
        <Field label="Notes" help="Where it is, what it does, who to call">
          <TextArea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {bookmark && <div className="fx-muted" style={{ fontSize: 12 }}>The address, protocol and user identify the connection (and its saved password); to change them, add a new one.</div>}
        {error && <Callout tone="critical">{error}</Callout>}
      </div>
    </Modal>
  );
}
