import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectionProtocol, ConsoleBookmark, ConsoleSession, RemoteProtocol, ViewOpen } from '@fbrx/shared';
import { Button, Callout, Empty, Field, Icons, Input, Modal, Status, Toggle, timeAgo, useToast, type IconName } from '@fbrx/ui';
import { call } from '../client';
import { ConnectDialog, ConsoleScreen, KIND, KindSwitch, useFillHeight, type ConnectTarget } from '../consoles';
import { useConsoleSessions, useCore } from '../hooks';
import { askAgent } from '../widgets';

/**
 * FBRX View: every way into another machine, in tabs. Remote desktops (RDP) and screen sharing (VNC) are drawn here,
 * in the window, through the app's own proxy (it listens on this computer only and lets nothing through without a
 * ticket); SSH and Telnet open the device consoles. The saved connections are one list, their logins in the vault.
 */

type Tab = { id: string; title: string; kind: 'screen'; open: ViewOpen; remember: boolean; typed: boolean } | { id: string; title: string; kind: 'console'; sessionId: string };

const ICON: Record<ConnectionProtocol, IconName> = { rdp: 'monitor', vnc: 'monitor', ssh: 'terminal', telnet: 'terminal' };

export function ViewPage() {
  const bookmarks = useCore('console.bookmarks', undefined, ['console.changed']);
  const consoles = useConsoleSessions();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [connect, setConnect] = useState<ConnectTarget | null>(null);
  const [filter, setFilter] = useState('');
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  /** A Remote Desktop file (.rdp) or a Remote Desktop Manager export: its connections, never its passwords. */
  const importFile = async (f: File) => {
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const r = await call('view.import', { fileName: f.name, data: btoa(bin) });
      toast.success(
        `${r.added} connection${r.added === 1 ? '' : 's'} added`,
        `${r.skipped ? `${r.skipped} left out (folders, other kinds, or entries without an address). ` : ''}Passwords are never imported: View asks once, then keeps them if you say so.`,
      );
      bookmarks.reload();
    } catch (e) {
      toast.error('Could not import it', (e as Error).message);
    }
  };

  const add = (t: Tab) => {
    setTabs((all) => [...all.filter((x) => x.id !== t.id), t]);
    setActive(t.id);
  };
  const close = (id: string) => {
    const t = tabs.find((x) => x.id === id);
    if (t?.kind === 'console') void call('console.close', { id: t.sessionId }).catch(() => undefined);
    setTabs((all) => all.filter((x) => x.id !== id));
    setActive((a) => (a === id ? null : a));
  };

  const openScreen = async (p: { protocol: RemoteProtocol; host: string; port?: number; username?: string; password?: string; label?: string; remember?: boolean }) => {
    const open = await call('view.open', { protocol: p.protocol, host: p.host, port: p.port, username: p.username, password: p.password, label: p.label });
    add({ id: `scr-${open.token.slice(0, 10)}`, title: open.bookmark.label, kind: 'screen', open, remember: !!p.remember, typed: !!p.password });
    bookmarks.reload();
  };

  const fromBookmark = (b: ConsoleBookmark) => {
    if ((b.protocol === 'rdp' || b.protocol === 'vnc') && b.passwordSaved) {
      void openScreen({ protocol: b.protocol, host: b.host, port: b.port, username: b.username ?? undefined, label: b.label }).catch((e) => toast.error('Could not open it', (e as Error).message));
      return;
    }
    setConnect({ host: b.host, name: b.label, protocol: b.protocol, port: b.port, username: b.username, profileId: b.profileId, auto: b.passwordSaved });
  };

  const list = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (bookmarks.data ?? []).filter((b) => !q || `${b.label} ${b.host} ${b.username ?? ''} ${b.protocol}`.toLowerCase().includes(q));
  }, [bookmarks.data, filter]);

  const current = tabs.find((t) => t.id === active) ?? null;
  return (
    <div className="view-page">
      <aside className="view-list">
        <div className="view-list-head">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a connection" aria-label="Find a connection" />
          <Button variant="primary" icon="plus" onClick={() => setConnect({})} title="New connection">
            New
          </Button>
          <Button variant="ghost" icon="upload" onClick={() => fileRef.current?.click()} title="Import a Remote Desktop file (.rdp) or a Remote Desktop Manager export" aria-label="Import connections" />
          <input
            ref={fileRef}
            type="file"
            accept=".rdp,.rdm,.xml"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void importFile(f);
            }}
          />
        </div>
        {list.length === 0 ? (
          <Empty title={filter ? 'Nothing matches' : 'No connections yet'}>{filter ? 'Try another name or address.' : 'Connect to a computer or a device; it is kept here.'}</Empty>
        ) : (
          <ul className="view-conns">
            {list.map((b) => (
              <li key={b.id}>
                <button type="button" className="view-conn" onClick={() => fromBookmark(b)} title={`${KIND[b.protocol].label} · ${b.username ? `${b.username}@` : ''}${b.host}:${b.port}`}>
                  <span className={`view-conn-icon ${b.protocol}`}>{(() => {
                    const I = Icons[ICON[b.protocol]];
                    return <I size={16} />;
                  })()}</span>
                  <span className="view-conn-text">
                    <b>{b.label}</b>
                    <small>
                      {KIND[b.protocol].label} · {b.host}
                      {b.lastConnectedAt ? ` · ${timeAgo(b.lastConnectedAt)}` : ''}
                    </small>
                  </span>
                  {b.passwordSaved && <Icons.key size={13} aria-label="Login saved" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="view-main">
        <div className="view-tabs" role="tablist">
          <button type="button" role="tab" className={`view-tab${active === null ? ' on' : ''}`} onClick={() => setActive(null)}>
            <Icons.dashboard size={14} /> Start
          </button>
          {tabs.map((t) => {
            const live = t.kind === 'console' ? consoles.data?.find((c) => c.id === t.sessionId)?.state !== 'closed' : true;
            return (
              <span key={t.id} role="tab" className={`view-tab${active === t.id ? ' on' : ''}${live ? '' : ' ended'}`} onClick={() => setActive(t.id)}>
                {t.kind === 'screen' ? <Icons.monitor size={14} /> : <Icons.terminal size={14} />}
                <span className="view-tab-title">{t.title}</span>
                <button
                  type="button"
                  className="view-tab-x"
                  aria-label={`Close ${t.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    close(t.id);
                  }}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
        <div className="view-stage">
          {/* Every tab stays mounted, so switching tabs keeps each session. */}
          {tabs.map((t) => (
            <div key={t.id} className="view-session" hidden={t.id !== active}>
              {t.kind === 'screen' ? (
                <ScreenSession tab={t} onEnd={() => close(t.id)} />
              ) : (
                <ConsoleTab session={consoles.data?.find((c) => c.id === t.sessionId) ?? null} />
              )}
            </div>
          ))}
          {!current && <StartPanel bookmarks={bookmarks.data ?? []} onOpen={fromBookmark} onNew={(protocol) => setConnect({ protocol })} />}
        </div>
      </section>

      {connect && (
        <ConnectDialog
          target={connect}
          onClose={() => setConnect(null)}
          onConnected={(s) => {
            setConnect(null);
            add({ id: `con-${s.id}`, title: s.label, kind: 'console', sessionId: s.id });
            bookmarks.reload();
          }}
          remote={({ protocol, target, onKind, onClose }) => (
            <ScreenLogin
              key={protocol}
              protocol={protocol}
              target={target}
              onKind={onKind}
              onClose={onClose}
              onOpen={async (p) => {
                await openScreen(p);
                setConnect(null);
              }}
            />
          )}
        />
      )}
    </div>
  );
}

function StartPanel({ bookmarks, onOpen, onNew }: { bookmarks: ConsoleBookmark[]; onOpen: (b: ConsoleBookmark) => void; onNew: (p: ConnectionProtocol) => void }) {
  const recent = bookmarks.filter((b) => b.lastConnectedAt).slice(0, 6);
  const kinds: Array<{ p: ConnectionProtocol; what: string }> = [
    { p: 'rdp', what: 'A Windows computer or server, or Linux with XRDP' },
    { p: 'vnc', what: 'A Mac, a Linux desktop, or anything that shares its screen' },
    { p: 'ssh', what: 'A server, a switch, a router or a firewall' },
    { p: 'telnet', what: 'Older network gear' },
  ];
  return (
    <div className="view-start">
      <h2>Connect</h2>
      <div className="view-kinds">
        {kinds.map(({ p, what }) => {
          const I = Icons[ICON[p]];
          return (
            <button key={p} type="button" className="view-kind" onClick={() => onNew(p)}>
              <I size={22} />
              <b>{KIND[p].label}</b>
              <small>{what}</small>
            </button>
          );
        })}
      </div>
      {recent.length > 0 && (
        <>
          <h3>Recently</h3>
          <div className="view-recent">
            {recent.map((b) => (
              <button key={b.id} type="button" className="view-recent-card" onClick={() => onOpen(b)}>
                <b>{b.label}</b>
                <small>
                  {KIND[b.protocol].label} · {timeAgo(b.lastConnectedAt!)}
                </small>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Where to connect, and the login: drawn here in View. */
function ScreenLogin({
  protocol,
  target,
  onKind,
  onClose,
  onOpen,
}: {
  protocol: RemoteProtocol;
  target?: ConnectTarget;
  onKind: (p: ConnectionProtocol) => void;
  onClose: () => void;
  onOpen: (p: { protocol: RemoteProtocol; host: string; port?: number; username?: string; password?: string; label?: string; remember?: boolean }) => Promise<void>;
}) {
  const [host, setHost] = useState(target?.host ?? '');
  const [port, setPort] = useState(target?.port && target.port !== KIND[protocol].port ? String(target.port) : '');
  const [user, setUser] = useState(target?.username ?? '');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await onOpen({ protocol, host: host.trim(), port: Number(port) || undefined, username: user.trim() || undefined, password: password || undefined, label: target?.name ?? undefined, remember });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const ready = !!host.trim() && (protocol === 'vnc' || !!user.trim());
  return (
    <Modal
      title={target?.name ? `Connect to ${target.name}` : protocol === 'rdp' ? 'Remote desktop' : 'Screen sharing'}
      description={protocol === 'rdp' ? 'Another computer’s desktop, here in a tab (RDP).' : 'Another computer’s screen, here in a tab (VNC).'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="monitor" loading={busy} disabled={!ready} onClick={() => void go()}>
            Connect
          </Button>
        </>
      }
    >
      <form
        className="fx-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void go();
        }}
      >
        <Field label="Connect with">
          <KindSwitch value={protocol} onChange={onKind} />
        </Field>
        <div className="fx-row">
          <Field label="Address">
            <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.20" autoFocus={!target?.host} />
          </Field>
          <Field label="Port">
            <Input type="number" value={port} placeholder={String(KIND[protocol].port)} onChange={(e) => setPort(e.target.value)} style={{ width: 90 }} />
          </Field>
        </div>
        <Field label="User name" help={protocol === 'rdp' ? 'name, or DOMAIN\\name' : 'Only if the computer asks for one.'}>
          <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder={protocol === 'rdp' ? 'name' : 'optional'} autoFocus={!!target?.host && !target?.username} />
        </Field>
        <Field label="Password" help={target?.auto ? 'Saved in the vault: leave it empty to use it.' : undefined}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" autoFocus={!!target?.username} />
        </Field>
        <Toggle checked={remember} onChange={setRemember} label="Keep the password in the vault once it works" />
        {protocol === 'rdp' && (
          <Callout tone="info">The other computer must allow remote desktop (on Windows: Settings → System → Remote Desktop). Its certificate is checked like any remote desktop app does, and the login stays on this computer.</Callout>
        )}
        {error && (
          <Callout tone="critical" title="Could not connect">
            {error}
          </Callout>
        )}
      </form>
    </Modal>
  );
}

type ScreenState = { s: 'connecting' } | { s: 'live' } | { s: 'password' } | { s: 'ended'; why: string } | { s: 'failed'; why: string };

/** One remote screen: RDP (IronRDP) or VNC (noVNC), through the app's proxy. */
function ScreenSession({ tab, onEnd }: { tab: Extract<Tab, { kind: 'screen' }>; onEnd: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const height = useFillHeight(box, [], { gap: 12, min: 320 });
  const [state, setState] = useState<ScreenState>({ s: 'connecting' });
  const [fit, setFit] = useState(true);
  const ctl = useRef<{ ctrlAltDel: () => void; meta?: () => void; scale: (fit: boolean) => void; password?: (p: string) => void; stop: () => void } | null>(null);
  const toast = useToast();
  const [retry, setRetry] = useState(0);
  const [askPw, setAskPw] = useState('');
  const o = tab.open;

  const remember = (password: string) => {
    if (!tab.remember || !password || o.saved) return;
    call('view.saveLogin', { protocol: o.protocol, host: o.bookmark.host, port: o.bookmark.port, username: o.domain ? `${o.domain}\\${o.username}` : o.username, password })
      .then(() => toast.success('Login kept in the vault', `${o.bookmark.label} connects without asking next time.`))
      .catch(() => undefined);
  };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let stopped = false;
    setState({ s: 'connecting' });
    const stop = o.protocol === 'rdp' ? startRdp(el, o, setState, ctl, remember, () => stopped) : startVnc(el, o, setState, ctl, remember, () => stopped);
    return () => {
      stopped = true;
      stop();
      ctl.current = null;
    };
    // A new ticket is needed to connect again (they are used once): Reconnect asks for one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.token, retry]);

  const reconnect = async () => {
    try {
      const again = await call('view.open', { protocol: o.protocol, host: o.bookmark.host, port: o.bookmark.port, username: o.domain ? `${o.domain}\\${o.username}` : o.username || undefined, password: o.password || undefined, label: o.bookmark.label });
      Object.assign(o, again);
      setRetry((n) => n + 1);
    } catch (e) {
      setState({ s: 'failed', why: (e as Error).message });
    }
  };

  return (
    <div className="view-screen">
      <div className="view-screen-bar">
        <Status tone={state.s === 'live' ? 'good' : state.s === 'connecting' || state.s === 'password' ? 'neutral' : 'critical'}>
          {state.s === 'live' ? 'Connected' : state.s === 'connecting' ? 'Connecting…' : state.s === 'password' ? 'Password needed' : state.s === 'ended' ? 'Disconnected' : 'Could not connect'}
        </Status>
        <span className="fx-muted">
          {o.protocol === 'rdp' ? 'Remote desktop' : 'Screen sharing'} · {o.username ? `${o.domain ? `${o.domain}\\` : ''}${o.username}@` : ''}
          {o.bookmark.host}
        </span>
        <span className="fx-spacer" />
        <Button size="sm" variant="ghost" disabled={state.s !== 'live'} onClick={() => ctl.current?.ctrlAltDel()} title="Send Ctrl+Alt+Del">
          Ctrl+Alt+Del
        </Button>
        {o.protocol === 'rdp' && (
          <Button size="sm" variant="ghost" disabled={state.s !== 'live'} onClick={() => ctl.current?.meta?.()} title="Send the Windows key">
            Start key
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={state.s !== 'live'}
          onClick={() => {
            setFit(!fit);
            ctl.current?.scale(!fit);
          }}
        >
          {fit ? 'Actual size' : 'Fit'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void box.current?.requestFullscreen?.()}>
          Full screen
        </Button>
        {state.s === 'ended' || state.s === 'failed' ? (
          <Button size="sm" icon="refresh" onClick={() => void reconnect()}>
            Reconnect
          </Button>
        ) : (
          <Button size="sm" variant="danger" icon="x" onClick={() => (ctl.current?.stop(), onEnd())}>
            Disconnect
          </Button>
        )}
      </div>
      <div ref={box} className="view-canvas" style={{ height: height ?? undefined }} />
      {state.s === 'password' && (
        <form
          className="view-overlay"
          onSubmit={(e) => {
            e.preventDefault();
            ctl.current?.password?.(askPw);
            remember(askPw);
            setAskPw('');
            setState({ s: 'connecting' });
          }}
        >
          <b>{o.bookmark.label} asks for its password</b>
          <Input type="password" value={askPw} onChange={(e) => setAskPw(e.target.value)} autoFocus autoComplete="off" />
          <Button type="submit" variant="primary">
            Send
          </Button>
        </form>
      )}
      {(state.s === 'failed' || state.s === 'ended') && (
        <div className="view-overlay">
          <Callout tone={state.s === 'failed' ? 'critical' : 'info'} title={state.s === 'failed' ? 'Could not connect' : 'The session ended'}>
            {state.why}
          </Callout>
          <div className="fx-row">
            <Button icon="refresh" onClick={() => void reconnect()}>
              Reconnect
            </Button>
            {state.s === 'failed' && (
              <Button variant="ghost" icon="sparkles" onClick={() => askAgent(`A ${o.protocol === 'rdp' ? 'remote desktop (RDP)' : 'screen sharing (VNC)'} connection in FBRX View will not open. Help me find out why, step by step.`, { address: `${o.bookmark.host}:${o.bookmark.port}`, error: state.why })}>
                Ask Fabrix
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ RDP (IronRDP)

let rdpReady: Promise<{ Backend: unknown; enableCredssp: (on: boolean) => unknown }> | null = null;

/** IronRDP's client: loaded the first time a remote desktop opens (it is large), then kept. */
function loadRdp() {
  rdpReady ??= (async () => {
    const [rdp] = await Promise.all([import('@devolutions/iron-remote-desktop-rdp'), import('@devolutions/iron-remote-desktop')]);
    await rdp.init('WARN');
    return { Backend: rdp.Backend, enableCredssp: rdp.enableCredssp as (on: boolean) => unknown };
  })();
  return rdpReady;
}

interface IronError {
  kind?: () => number;
  backtrace?: () => string;
  rdcleanpathDetails?: () => { httpStatusCode?: number; wsaErrorCode?: number; tlsAlertCode?: number; errorCode?: number } | undefined;
}

/** What went wrong, in words, from IronRDP's error. */
export function rdpError(err: unknown): string {
  const e = err as IronError;
  const kind = typeof e?.kind === 'function' ? e.kind() : null;
  const d = typeof e?.rdcleanpathDetails === 'function' ? e.rdcleanpathDetails() : undefined;
  if (kind === 1 || kind === 2) return 'The user name or password was not accepted.';
  if (kind === 3) return 'This user may not sign in remotely on that computer (Remote Desktop Users group, or its policy).';
  if (kind === 6) return 'The computer and View could not agree on security. Check that remote desktop is allowed there; an old computer may need Network Level Authentication turned on.';
  if (d?.wsaErrorCode === 10061) return 'Nothing answers on that port: remote desktop is off, or a firewall blocks it.';
  if (d?.wsaErrorCode === 10060 || d?.wsaErrorCode === 10065 || d?.wsaErrorCode === 10051) return 'The computer cannot be reached from here (it is off, asleep, or on a network this computer cannot get to).';
  if (d?.errorCode === 104) return 'That name could not be found. Check the address.';
  if (d?.errorCode === 105) return 'The secure connection to the computer failed.';
  if (d?.errorCode === 2) return 'The computer refused the connection’s security, or only offers old RDP security without encryption.';
  const text = typeof e?.backtrace === 'function' ? e.backtrace() : err instanceof Error ? err.message : String(err);
  return text.split('\n')[0]!.slice(0, 300) || 'The connection failed.';
}

function startRdp(el: HTMLElement, o: ViewOpen, setState: (s: ScreenState) => void, ctl: React.MutableRefObject<unknown>, remember: (pw: string) => void, stopped: () => boolean): () => void {
  let ui: { connect: (c: unknown) => Promise<{ run: () => Promise<{ reason: () => string }> }>; configBuilder: () => Record<string, (...a: unknown[]) => unknown>; setVisibility: (v: boolean) => void; setScale: (s: number) => void; ctrlAltDel: () => void; metaKey: () => void; shutdown: () => void } | null = null;
  let host: HTMLElement | null = null;
  void loadRdp()
    .then(({ Backend }) => {
      if (stopped()) return;
      host = document.createElement('iron-remote-desktop');
      host.setAttribute('scale', 'fit');
      host.setAttribute('flexcenter', 'true');
      (host as unknown as { module: unknown }).module = Backend;
      host.addEventListener('ready', (ev) => {
        ui = (ev as CustomEvent).detail.irgUserInteraction;
        if (!ui || stopped()) return;
        type Builder = { withDestination: (v: string) => Builder; withProxyAddress: (v: string) => Builder; withAuthToken: (v: string) => Builder; withUsername: (v: string) => Builder; withPassword: (v: string) => Builder; withServerDomain: (v: string) => Builder; withDesktopSize: (v: { width: number; height: number }) => Builder; build: () => unknown };
        const b = ui.configBuilder() as unknown as Builder;
        let c = b.withDestination(o.destination).withProxyAddress(o.url).withAuthToken(o.token).withUsername(o.username).withPassword(o.password);
        if (o.domain) c = c.withServerDomain(o.domain);
        const r = el.getBoundingClientRect();
        c = c.withDesktopSize({ width: Math.max(800, Math.round(r.width)) & ~1, height: Math.max(600, Math.round(r.height)) & ~1 });
        ui.connect(c.build())
          .then((info) => {
            if (stopped()) return ui?.shutdown();
            ui?.setVisibility(true);
            setState({ s: 'live' });
            remember(o.password);
            ctl.current = {
              ctrlAltDel: () => ui?.ctrlAltDel(),
              meta: () => ui?.metaKey(),
              scale: (fit: boolean) => ui?.setScale(fit ? 1 : 3),
              stop: () => ui?.shutdown(),
            };
            info
              .run()
              .then((end) => !stopped() && setState({ s: 'ended', why: end.reason() || 'The remote computer ended it.' }))
              .catch((err) => !stopped() && setState({ s: 'ended', why: rdpError(err) }));
          })
          .catch((err) => !stopped() && setState({ s: 'failed', why: rdpError(err) }));
      });
      el.appendChild(host);
    })
    .catch((err) => setState({ s: 'failed', why: `The remote desktop client did not load: ${(err as Error).message}` }));
  return () => {
    try {
      ui?.shutdown();
    } catch {
      /* already gone */
    }
    host?.remove();
  };
}

// --------------------------------------------------------------------------------------------- VNC (noVNC)

function startVnc(el: HTMLElement, o: ViewOpen, setState: (s: ScreenState) => void, ctl: React.MutableRefObject<unknown>, remember: (pw: string) => void, stopped: () => boolean): () => void {
  let rfb: import('@novnc/novnc').default | null = null;
  let live = false;
  void import('@novnc/novnc')
    .then(({ default: RFB }) => {
      if (stopped()) return;
      rfb = new RFB(el, o.url, { wsProtocols: ['binary'], credentials: o.password ? { username: o.username || undefined, password: o.password } : undefined });
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.focusOnClick = true;
      rfb.background = 'transparent';
      rfb.addEventListener('connect', () => {
        live = true;
        setState({ s: 'live' });
        remember(o.password);
      });
      rfb.addEventListener('credentialsrequired', () => setState({ s: 'password' }));
      rfb.addEventListener('securityfailure', (e) => setState({ s: 'failed', why: (e as CustomEvent).detail?.reason || 'The password was not accepted.' }));
      rfb.addEventListener('disconnect', (e) => {
        if (stopped()) return;
        const clean = (e as CustomEvent).detail?.clean;
        setState(live ? { s: 'ended', why: clean ? 'The computer ended it.' : 'The connection was lost.' } : { s: 'failed', why: 'The computer did not answer as a screen sharing (VNC) server, or screen sharing is off there.' });
      });
      ctl.current = {
        ctrlAltDel: () => rfb?.sendCtrlAltDel(),
        scale: (fit: boolean) => rfb && ((rfb.scaleViewport = fit), (rfb.clipViewport = !fit)),
        password: (password: string) => rfb?.sendCredentials({ username: o.username || undefined, password }),
        stop: () => rfb?.disconnect(),
      };
    })
    .catch((err) => setState({ s: 'failed', why: `The screen sharing client did not load: ${(err as Error).message}` }));
  return () => {
    try {
      rfb?.disconnect();
    } catch {
      /* already gone */
    }
    el.replaceChildren();
  };
}

// ------------------------------------------------------------------------------------------------ consoles

function ConsoleTab({ session }: { session: ConsoleSession | null }) {
  if (!session) return <Empty title="This console has closed" />;
  return (
    <div className="view-console">
      <div className="view-screen-bar">
        <Status tone={session.state === 'open' ? 'good' : 'critical'}>{session.state === 'open' ? 'Connected' : 'Closed'}</Status>
        <span className="fx-muted">
          {session.protocol.toUpperCase()} · {session.username ? `${session.username}@` : ''}
          {session.host}
        </span>
        <span className="fx-spacer" />
        {session.state === 'open' && <QuickCommands sessionId={session.id} />}
        <Button size="sm" variant="ghost" icon="sparkles" onClick={() => askAgent('Look at my console session in FBRX View and help me with it.', { console: session.id, host: session.host, protocol: session.protocol })}>
          Ask Fabrix
        </Button>
      </div>
      <ConsoleScreen session={session} />
    </div>
  );
}

/** Saved commands typed into the console with one click, without Enter: you read it, then press Enter. */
function QuickCommands({ sessionId }: { sessionId: string }) {
  const snippets = useCore('view.snippets');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const toast = useToast();
  const type = (text: string) => {
    setOpen(false);
    void call('console.write', { id: sessionId, data: text.replace(/\r?\n$/, '') }).catch((e) => toast.error('Could not type it', (e as Error).message));
  };
  return (
    <span className="view-qc-wrap">
      <Button size="sm" variant="ghost" icon="list" onClick={() => setOpen(!open)} aria-expanded={open}>
        Quick commands
      </Button>
      {open && (
        <div className="view-qc" role="menu">
          {(snippets.data ?? []).length === 0 && <p className="fx-muted">None yet: add the commands you type often.</p>}
          {(snippets.data ?? []).map((q) => (
            <button key={q.id} type="button" role="menuitem" onClick={() => type(q.text)} title={q.text}>
              <b>{q.name}</b>
              <code>{q.text.split('\n')[0]}</code>
            </button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            icon="edit"
            onClick={() => {
              setOpen(false);
              setEditing(true);
            }}
          >
            Edit quick commands
          </Button>
        </div>
      )}
      {editing && <QuickCommandsEditor list={snippets.data ?? []} onChanged={() => snippets.reload()} onClose={() => setEditing(false)} />}
    </span>
  );
}

function QuickCommandsEditor({ list, onChanged, onClose }: { list: Array<{ id: string; name: string; text: string }>; onChanged: () => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setError(null);
    try {
      await call('view.saveSnippet', { name: name.trim(), text });
      setName('');
      setText('');
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title="Quick commands" description="Typed into the console with one click, without Enter, so you can read them first." onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
      <div className="fx-form">
        {list.map((q) => (
          <div key={q.id} className="view-qc-row">
            <span>
              <b>{q.name}</b>
              <code>{q.text}</code>
            </span>
            <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${q.name}`} onClick={() => void call('view.removeSnippet', { id: q.id }).then(onChanged)} />
          </div>
        ))}
        <div className="fx-row">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Show interfaces" />
          </Field>
          <Field label="Command">
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="show ip interface brief" />
          </Field>
        </div>
        <Button icon="plus" disabled={!name.trim() || !text} onClick={() => void add()}>
          Add
        </Button>
        {error && <Callout tone="critical">{error}</Callout>}
      </div>
    </Modal>
  );
}
