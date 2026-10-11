import { useEffect, useRef, useState } from 'react';
import { SERVER_BROWSER_PARTITION, type SavedServer, type ServerCheck, type ServerResourceFile, type ServerSuggestion } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, Grid, Icons, InfoTip, Input, Modal, Page, Spinner, Status, TextArea, formatBytes, timeAgo, useAction, useConfirm, useToast } from '@fbrx/ui';
import { bridge, call } from '../client';
import { navigate, routeArg } from '../app';
import { useCore } from '../hooks';
import { Markdown } from '../markdown';

/** Electron's <webview> (allowed only for server consoles, see main/server-browser.ts). */
type WebviewElement = HTMLElement & {
  src: string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  getURL(): string;
};

/**
 * FBRX Server, from FBRX Endpoint: your servers' web consoles, opened right here, and what you need to set up a new
 * server (the installer ISO, the bundle for a Debian 13 server you already have, the guides; they ride along inside
 * FBRX Endpoint for now, scripts/server/endpoint-resources.mjs).
 */
export function ServerPage() {
  // The page stays mounted while only the part after "server/" changes, so follow the address here.
  const [arg, setArg] = useState(() => routeArg() ?? '');
  useEffect(() => {
    const on = () => setArg(routeArg() ?? '');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const saved = useCore('server.saved');
  const openId = arg.startsWith('open/') ? decodeURIComponent(arg.slice(5)) : null;
  const open = openId ? saved.data?.servers.find((s) => s.id === openId) : null;
  if (openId) {
    if (!saved.data) return <Page title="FBRX Server"><Empty title="Loading…" /></Page>;
    if (!open) return <Page title="FBRX Server"><Empty title="That server is not saved any more"><Button onClick={() => navigate('server')}>Back to your servers</Button></Empty></Page>;
    return <ServerConsole key={open.id} server={open} onChanged={() => void saved.reload()} />;
  }
  return (
    <Page title="FBRX Server" description="FBRX OS for servers: any 64-bit PC or server with Debian 13 underneath, running FBRX Virtual and the roles you pick (AI, gate, MiniDome). Open your servers' consoles here, or set up a new one.">
      <YourServers servers={saved.data?.servers ?? null} suggestions={saved.data?.suggestions ?? []} reload={() => void saved.reload()} />
      <SetUp />
    </Page>
  );
}

// ------------------------------------------------------------------------------------------ your servers

function YourServers({ servers, suggestions, reload }: { servers: SavedServer[] | null; suggestions: ServerSuggestion[]; reload: () => void }) {
  const [editing, setEditing] = useState<SavedServer | 'new' | ServerSuggestion | null>(null);
  const { confirm, dialog } = useConfirm();
  const toast = useToast();
  const remove = async (s: SavedServer) => {
    if (!(await confirm({ title: `Remove ${s.name}?`, body: 'It leaves Your servers, with the certificate you trusted for it. The server itself is not touched.', confirmLabel: 'Remove', danger: true }))) return;
    await call('server.remove', { id: s.id });
    toast.success(`${s.name} removed`);
    reload();
  };
  return (
    <Card
      title={
        <span className="fx-row" style={{ gap: 6 }}>
          Your servers
          <InfoTip>
            Their web consoles open inside FBRX, in a browser of its own: its sign-ins and cookies stay apart from everything else, and the page cannot reach FBRX. FBRX Server makes its own certificate, so the first time you compare its fingerprint with the one the server shows, and from then on only that exact certificate is accepted.
          </InfoTip>
        </span>
      }
      subtitle="FBRX Server's console (port 9443), or any other server or device with a web page: a NAS, a hypervisor, a management controller."
      actions={
        <Button size="sm" icon="plus" onClick={() => setEditing('new')}>
          Add a server
        </Button>
      }
    >
      {servers === null ? (
        <Spinner />
      ) : (
        <div className="fx-grid">
          {servers.length > 0 ? (
            <div className="saved-grid">
              {servers.map((s) => (
                <div key={s.id} className="saved-card srv-card">
                  <div className="saved-card-head">
                    <b>{s.name}</b>
                    {s.fingerprint && (
                      <span className="saved-key" title={`Trusted certificate ${s.fingerprint}`}>
                        <Icons.lock size={12} /> trusted
                      </span>
                    )}
                    {s.scheme === 'http' && <Status tone="warning">not encrypted</Status>}
                  </div>
                  <div className="mono fx-muted" style={{ fontSize: 12 }}>
                    {s.url}
                  </div>
                  <div className="fx-muted" style={{ fontSize: 12 }}>
                    {s.lastOpenedAt ? `Opened ${timeAgo(s.lastOpenedAt)}` : 'Not opened yet'}
                  </div>
                  {s.notes && <div className="saved-notes">{s.notes}</div>}
                  <div className="fx-actions">
                    <Button size="sm" variant="primary" icon="globe" onClick={() => navigate(`server/open/${encodeURIComponent(s.id)}`)}>
                      Open
                    </Button>
                    <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditing(s)}>
                      Edit
                    </Button>
                    <span className="fx-spacer" />
                    <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${s.name}`} onClick={() => void remove(s)} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            !suggestions.length && <Empty title="No servers yet">Add your FBRX Server by its address (shown on its screen, port 9443), or any other server's web page.</Empty>
          )}
          {suggestions.length > 0 && (
            <div className="srv-suggest">
              <span className="fx-muted" style={{ fontSize: 12.5 }}>
                <Icons.orbit size={13} /> On your FBRX Mesh:
              </span>
              {suggestions.map((g) => (
                <button key={g.host} className="chip" onClick={() => setEditing(g)} title={`Roles: ${g.roles.join(', ')}`}>
                  <Icons.server size={13} /> {g.name} <span className="fx-muted mono">{g.host}</span> <Icons.plus size={12} />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {editing && (
        <ServerEditor
          server={editing === 'new' || !('id' in editing) ? null : editing}
          suggestion={editing !== 'new' && !('id' in editing) ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {dialog}
    </Card>
  );
}

function ServerEditor({ server, suggestion, onClose, onSaved }: { server: SavedServer | null; suggestion: ServerSuggestion | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(server?.name ?? suggestion?.name ?? '');
  const [address, setAddress] = useState(server ? `${server.scheme}://${server.host.includes(':') ? `[${server.host}]` : server.host}` : (suggestion?.host ?? ''));
  const [port, setPort] = useState(server ? String(server.port) : suggestion ? String(suggestion.port) : '');
  const [notes, setNotes] = useState(server?.notes ?? (suggestion ? `FBRX Server on the mesh (${suggestion.roles.join(', ')})` : ''));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await call('server.save', { id: server?.id, name, address, port: Number(port) || undefined, notes });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={server ? `Edit ${server.name}` : 'Add a server'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!address.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Rack server" autoFocus />
        </Field>
        <div className="fx-row" style={{ alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <Field label="Address" help="An IP address or name, or a whole address like https://nas.local:5001.">
              <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.1.20" />
            </Field>
          </div>
          <div style={{ width: 110 }}>
            <Field label="Port" help="FBRX Server: 9443">
              <Input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} placeholder="9443" inputMode="numeric" />
            </Field>
          </div>
        </div>
        <Field label="Notes">
          <TextArea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Where it is, what runs on it, who to call" />
        </Field>
        {server?.fingerprint && <div className="fx-muted" style={{ fontSize: 12 }}>A new address or port is checked again: its certificate has to be trusted once more.</div>}
        {error && <Callout tone="critical">{error}</Callout>}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------- the built-in browser

/** Popups reach main/server-browser.ts, which opens the console's own pages in place (an attribute, present or not). */
const WEBVIEW_POPUPS = { allowpopups: 'true' } as object;
/** Chromium's certificate errors are -200 to -299. */
const certError = (code: number) => code <= -200 && code > -300;

function ServerConsole({ server, onChanged }: { server: SavedServer; onChanged: () => void }) {
  const [check, setCheck] = useState<ServerCheck | null>(null);
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(true);
  const run = async () => {
    setChecking(true);
    setOpen(false);
    try {
      const c = (await call('server.check', { id: server.id })) as ServerCheck;
      setCheck(c);
      if (c.ok) {
        setOpen(true);
        void call('server.opened', { id: server.id });
      }
    } catch (e) {
      setCheck({ url: server.url, reachable: false, certificate: null, ok: false, changed: false, error: (e as Error).message });
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);
  const back = (
    <Button variant="ghost" icon="chevronLeft" onClick={() => navigate('server')}>
      Your servers
    </Button>
  );
  if (open) return <ServerBrowser server={server} onCertificateRefused={() => void run()} />;
  return (
    <Page title={server.name} description={server.url} actions={back}>
      {checking || !check ? (
        <Card>
          <div className="fx-row" style={{ gap: 10 }}>
            <Spinner /> Checking {server.host}:{server.port}…
          </div>
        </Card>
      ) : !check.reachable ? (
        <Card title="The server does not answer">
          <div className="fx-grid">
            <Callout tone="warning">{check.error ?? `No answer from ${server.host}:${server.port}.`}</Callout>
            <div className="fx-actions">
              <Button variant="primary" icon="refresh" onClick={() => void run()}>
                Try again
              </Button>
              {bridge.openExternal && (
                <Button variant="ghost" icon="external" onClick={() => void bridge.openExternal!(server.url)}>
                  Open in your browser
                </Button>
              )}
            </div>
          </div>
        </Card>
      ) : check.certificate ? (
        <TrustCertificate server={server} check={check} onTrusted={() => (onChanged(), void run())} />
      ) : null}
    </Page>
  );
}

function TrustCertificate({ server, check, onTrusted }: { server: SavedServer; check: ServerCheck; onTrusted: () => void }) {
  const c = check.certificate!;
  const { run, busy } = useAction();
  const lines = c.fingerprint.split(':').reduce<string[][]>((rows, b, i) => (i % 8 ? rows[rows.length - 1].push(b) : rows.push([b]), rows), []);
  return (
    <Card title={check.changed ? 'This is not the certificate you trusted' : 'First time: check that this is your server'}>
      <div className="fx-grid">
        {check.changed ? (
          <Callout tone="critical" title="Stop and check">
            {server.name} used to present another certificate. That happens when the server was reinstalled or its certificate renewed, but it is also what someone pretending to be your server would look like. Trust the new one only after comparing it on the server itself.
          </Callout>
        ) : (
          <div className="fx-secondary">
            {server.host} made its own certificate, so no authority vouches for it: you do, once. On the server, its screen shows the fingerprint, or run <code>fbrx-server fingerprint</code> (another kind of server shows it in its own certificate settings). If it matches, FBRX trusts this certificate for {server.host}:{server.port} only.
          </div>
        )}
        <div className="srv-fp" aria-label="Certificate fingerprint">
          {lines.map((l, i) => (
            <div key={i}>{l.join(':')}</div>
          ))}
        </div>
        <div className="fx-muted" style={{ fontSize: 12 }}>
          Issued to <b>{c.subject}</b> by <b>{c.issuer}</b>
          {c.validTo ? `, valid until ${new Date(c.validTo).toLocaleDateString()}` : ''}. SHA-256.
        </div>
        <div className="fx-actions">
          <Button variant={check.changed ? 'danger' : 'primary'} icon="check" loading={busy === 'trust'} onClick={() => void run('trust', () => call('server.trust', { id: server.id, fingerprint: c.fingerprint })).then((r) => r && onTrusted())}>
            {check.changed ? 'I checked: trust the new one' : 'It matches: trust it and open'}
          </Button>
          <Button variant="ghost" onClick={() => navigate('server')}>
            Not now
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ServerBrowser({ server, onCertificateRefused }: { server: SavedServer; onCertificateRefused: () => void }) {
  const view = useRef<WebviewElement | null>(null);
  const [url, setUrl] = useState(server.url);
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [nav, setNav] = useState({ back: false, forward: false });
  const [failed, setFailed] = useState<string | null>(null);
  const refused = useRef(onCertificateRefused);
  refused.current = onCertificateRefused;
  useEffect(() => {
    const w = view.current;
    if (!w) return;
    const sync = () => {
      try {
        setUrl(w.getURL());
        setNav({ back: w.canGoBack(), forward: w.canGoForward() });
      } catch {
        // Not attached yet.
      }
    };
    const on: Array<[string, (e: Event) => void]> = [
      ['did-start-loading', () => (setLoading(true), setFailed(null))],
      ['did-stop-loading', () => (setLoading(false), sync())],
      ['did-navigate', sync],
      ['did-navigate-in-page', sync],
      ['page-title-updated', (e) => setTitle((e as Event & { title: string }).title)],
      [
        'did-fail-load',
        (e) => {
          const f = e as Event & { errorCode: number; errorDescription: string; isMainFrame: boolean };
          if (!f.isMainFrame || f.errorCode === -3) return;
          if (certError(f.errorCode)) refused.current();
          else setFailed(f.errorDescription || `Error ${f.errorCode}`);
        },
      ],
    ];
    for (const [n, h] of on) w.addEventListener(n, h);
    return () => {
      for (const [n, h] of on) w.removeEventListener(n, h);
    };
  }, []);
  const secure = url.startsWith('https://');
  return (
    <div className="srv-browser">
      <div className="srv-bar">
        <Button size="sm" variant="ghost" icon="chevronLeft" onClick={() => navigate('server')}>
          Your servers
        </Button>
        <span className="srv-bar-sep" />
        <Button size="sm" variant="ghost" icon="chevronLeft" aria-label="Back" disabled={!nav.back} onClick={() => view.current?.goBack()} />
        <Button size="sm" variant="ghost" icon="chevronRight" aria-label="Forward" disabled={!nav.forward} onClick={() => view.current?.goForward()} />
        <Button size="sm" variant="ghost" icon={loading ? 'x' : 'refresh'} aria-label={loading ? 'Stop' : 'Reload'} onClick={() => (loading ? view.current?.stop() : view.current?.reload())} />
        <div className={`srv-address${secure ? '' : ' insecure'}`} title={secure ? (server.fingerprint ? `Trusted certificate ${server.fingerprint}` : 'Certificate vouched for by an authority') : 'Not encrypted'}>
          {secure ? <Icons.lock size={12} /> : <Icons.alert size={12} />}
          <span className="srv-address-name">{server.name}</span>
          <span className="mono">{url}</span>
        </div>
        {loading && <Spinner />}
        {bridge.openExternal && <Button size="sm" variant="ghost" icon="external" aria-label="Open in your browser" title="Open in your browser" onClick={() => void bridge.openExternal!(url)} />}
      </div>
      {failed && (
        <Callout tone="warning" title={`${server.name} could not be loaded`}>
          {failed}{' '}
          <Button size="sm" variant="ghost" icon="refresh" onClick={() => view.current?.reload()}>
            Try again
          </Button>
        </Callout>
      )}
      <webview ref={(el) => void (view.current = el as WebviewElement | null)} className="srv-webview" src={server.url} partition={SERVER_BROWSER_PARTITION} title={title || server.name} {...WEBVIEW_POPUPS} />
    </div>
  );
}

// ------------------------------------------------------------------------------------- a new server

function SetUp() {
  const res = useCore('server.resources');
  const toast = useToast();
  const { run, busy } = useAction();
  const [doc, setDoc] = useState<{ title: string; text: string } | null>(null);
  const [verified, setVerified] = useState<Record<string, boolean>>({});
  const r = res.data;
  if (!r) return null;

  const iso = r.files.find((f) => f.kind === 'iso');
  const bundle = r.files.find((f) => f.kind === 'bundle');
  const docs = r.files.filter((f) => f.kind === 'doc');
  const copy = (f: ServerResourceFile) =>
    void run(`copy${f.name}`, () => call('server.copy', { name: f.name })).then((out) => {
      if (!out) return;
      toast.success('Copied to Downloads', out.path);
      if (bridge.reveal) void bridge.reveal(out.path);
    });
  const verify = (f: ServerResourceFile) =>
    void run(`verify${f.name}`, () => call('server.verify', { name: f.name })).then((out) => {
      if (!out) return;
      setVerified((v) => ({ ...v, [f.name]: out.ok }));
      if (out.ok) toast.success(`${f.title} is intact`, `SHA-256 ${out.sha256.slice(0, 16)}…`);
      else toast.error(`${f.title} does not match`, 'It changed since the installer was made. Reinstall FBRX, or get the file again.');
    });
  const actions = (f: ServerResourceFile) => (
    <span className="fx-row" style={{ gap: 6 }}>
      {verified[f.name] !== undefined && <Status tone={verified[f.name] ? 'good' : 'critical'}>{verified[f.name] ? 'intact' : 'damaged'}</Status>}
      <Button size="sm" icon="check" loading={busy === `verify${f.name}`} onClick={() => verify(f)}>
        Check it
      </Button>
      {bridge.reveal && <Button size="sm" variant="ghost" icon="folder" aria-label="Show in folder" title="Show in folder" onClick={() => void bridge.reveal!(f.path)} />}
      <Button size="sm" variant="primary" icon="download" loading={busy === `copy${f.name}`} onClick={() => copy(f)}>
        Copy to Downloads
      </Button>
    </span>
  );

  return (
    <>
      <h3 className="srv-section">Set up a server</h3>
      {!r.available ? (
        <Card title="Not included in this copy">
          <p className="fx-secondary">
            This FBRX was built without the FBRX Server resources. Get the installer ISO from the <b>FBRX Server ISO</b> workflow in GitHub Actions, or install FBRX again with that download in your Downloads folder and it comes along.
          </p>
        </Card>
      ) : (
        <>
          <Grid cols={2}>
            <Card title="A new server" subtitle={iso ? `${iso.name} · ${formatBytes(iso.size)}` : 'The installer ISO'}>
              {iso ? (
                <div className="fx-grid">
                  <ol className="srv-steps">
                    <li>Write the ISO to a USB stick with any image writer, or attach it as virtual media through the server's management controller (its remote console).</li>
                    <li>Start the server from it (its one-time boot menu, often F11 or F12) and pick <b>Install FBRX Server</b>. It asks which disk to erase, the time zone and a password.</li>
                    <li>When it restarts, its screen shows the console's address (port 9443) and the setup code. Add it under Your servers above and sign in.</li>
                  </ol>
                  <Callout tone="warning">The installer erases the disk you choose. It needs internet access while it installs.</Callout>
                  {actions(iso)}
                </div>
              ) : (
                <p className="fx-secondary">This copy carries no ISO. Put the <b>fbrx-server-iso</b> download from GitHub Actions in Downloads and install FBRX again, and it comes along.</p>
              )}
            </Card>
            <Card title="A Debian 13 server you already have" subtitle={bundle ? `${bundle.name} · ${formatBytes(bundle.size)}` : undefined}>
              {bundle ? (
                <div className="fx-grid">
                  <p className="fx-secondary">Copy it to the server, then:</p>
                  <pre className="srv-cmd">{`tar -xzf ${bundle.name}\nsudo bash ${bundle.name.replace(/\.tar\.gz$/, '')}/install.sh`}</pre>
                  <p className="fx-muted" style={{ fontSize: 12 }}>
                    It installs FBRX Virtual and the AI role (add <span className="mono">--roles virtual</span> for the hypervisor alone). Node.js is in the bundle, so the server does not need to download it.
                  </p>
                  {actions(bundle)}
                </div>
              ) : (
                <p className="fx-secondary">Not included in this copy.</p>
              )}
            </Card>
          </Grid>
          <Card title="Before you install: the server's own settings">
            <ul className="srv-steps">
              <li>
                <b>Firmware (BIOS/UEFI):</b> turn on hardware virtualization and the IOMMU (for giving devices to virtual machines), boot in UEFI mode, and pick a performance power profile if there is one. With a management controller connected, FBRX Virtual's <i>Server &amp; BIOS</i> page sets these for you.
              </li>
              <li>
                <b>Management controller</b> (if the server has one): give it an address on your network, change its default password, and make a separate administrator account for FBRX Virtual.
              </li>
              <li>
                <b>Disks:</b> a RAID controller can offer the disks as one volume (pick it in the installer) or pass them through as they are (HBA or non-RAID mode).
              </li>
            </ul>
          </Card>
          {docs.length > 0 && (
            <Card title="Guides">
              {docs.map((d) => (
                <div key={d.name} className="fx-list-item">
                  <span style={{ flex: 1 }}>
                    <strong>{d.title}</strong> <span className="fx-muted mono">{d.name.replace(/^docs\//, '')}</span>
                  </span>
                  <Button size="sm" icon="book" loading={busy === `doc${d.name}`} onClick={() => void run(`doc${d.name}`, () => call('server.readDoc', { name: d.name })).then((o) => o && setDoc({ title: d.title, text: o.text }))}>
                    Read
                  </Button>
                  <Button size="sm" variant="ghost" icon="download" aria-label="Copy to Downloads" title="Copy to Downloads" onClick={() => copy(d)} />
                </div>
              ))}
            </Card>
          )}
          <div className="fx-muted" style={{ fontSize: 12 }}>
            FBRX Server {r.version}
            {r.builtAt ? ` · packed ${new Date(r.builtAt).toLocaleDateString()}` : ''} · these files live in the FBRX installation and are updated with it.
          </div>
        </>
      )}
      {doc && (
        <Modal title={doc.title} wide onClose={() => setDoc(null)}>
          <div className="srv-doc">
            <Markdown text={doc.text} />
          </div>
        </Modal>
      )}
    </>
  );
}
