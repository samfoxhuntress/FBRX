import { useState } from 'react';
import type { ServerResourceFile } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Grid, Modal, Page, Status, formatBytes, useAction, useToast } from '@fbrx/ui';
import { bridge, call } from '../client';
import { useCore } from '../hooks';
import { Markdown } from '../markdown';

/**
 * FBRX Server, from FBRX Endpoint: the server installer ISO, the bundle for a Debian 13 server you already have, and
 * the guides. They ride along inside FBRX Endpoint for now (scripts/server/endpoint-resources.mjs).
 */
export function ServerPage() {
  const res = useCore('server.resources');
  const toast = useToast();
  const { run, busy } = useAction();
  const [doc, setDoc] = useState<{ title: string; text: string } | null>(null);
  const [verified, setVerified] = useState<Record<string, boolean>>({});
  const r = res.data;
  if (!r) return <Page title="FBRX Server"><Empty title="Loading…" /></Page>;

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
    <Page title="FBRX Server" description="FBRX OS for servers: Debian 13 set up the FBRX way, running the FBRX Virtual hypervisor and, with the ai role, an AI agent on FBRX Mesh. What you need to set one up comes with FBRX for now.">
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
                    <li>Write the ISO to a USB stick with any image writer, or on a Dell PowerEdge mount it through the iDRAC: <em>Virtual Console → Virtual Media → Map CD/DVD</em>.</li>
                    <li>Start the server from it (F11 boot menu) and pick <b>Install FBRX Server</b>. It asks which disk to erase, the time zone and a password.</li>
                    <li>When it restarts, open the address its screen shows (port 9443) and sign in with the setup code.</li>
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
    </Page>
  );
}
