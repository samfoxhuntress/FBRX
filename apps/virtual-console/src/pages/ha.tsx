import { useState } from 'react';
import { HA_STATE_NAMES, type HaCopyView, type HaEvent, type HaPath, type HaState, type HaStatus } from '@fbrx/shared';
import { Badge, Button, Callout, Card, CopyText, Empty, Field, formatDate, Input, KeyValue, Modal, Page, Status, Table, timeAgo, Toggle, useAction, useConfirm } from '@fbrx/ui';
import { api } from '../api';
import { useApp, usePoll } from '../state';

/**
 * High availability: this server and a partner as one pair. Not paired: make this the primary (pair with a standby)
 * or the standby (make a pairing code). Paired: the pair drawn (who serves, the two paths, the third vote), switching
 * over and handing back, the settings, the third vote, and what happened. And this server as the third vote of
 * another pair.
 */
export function HaPage() {
  const st = usePoll<HaStatus>('/v1/ha', 2000);
  const s = st.data;
  return (
    <Page title="High availability" description="Two FBRX Servers as one: the standby keeps a copy and takes over when the active one stops answering.">
      {!s ? (
        st.error ? <Callout tone="critical" title="High availability does not answer">{st.error}</Callout> : <Empty title="Loading…" />
      ) : (
        <>
          {!s.available && <Callout tone="warning" title="Not on HTTPS">{s.reason}</Callout>}
          {s.partner ? <Pair s={s} reload={st.reload} /> : s.available && <NotPaired s={s} reload={st.reload} />}
          <History events={s.events} />
          <ThirdVoteHost s={s} reload={st.reload} />
        </>
      )}
    </Page>
  );
}

const TONE: Record<HaState, 'good' | 'neutral' | 'warning' | 'critical'> = { single: 'neutral', starting: 'neutral', active: 'good', standby: 'neutral', stopped: 'critical' };

// -------------------------------------------------------------------------------------------- not paired

function NotPaired({ s, reload }: { s: HaStatus; reload: () => Promise<void> }) {
  const app = useApp();
  const [pairing, setPairing] = useState(false);
  const [code, setCode] = useState<{ code: string; expiresAt: string; fingerprint: string } | null>(null);
  const { run, busy } = useAction();
  if (!app.can('admin')) return <Card title="Not paired"><p className="fx-secondary">An administrator can pair this server with another.</p></Card>;
  return (
    <div className="ha-choose">
      <Card title="Make this the primary" subtitle="It serves, and a second FBRX Server keeps a copy, ready to take over.">
        <p className="fx-secondary">On the other server, open High availability and make a pairing code; then pair with it here.</p>
        <div className="fx-actions">
          <Button variant="primary" icon="link" onClick={() => setPairing(true)}>
            Pair with a standby
          </Button>
        </div>
      </Card>
      <Card title="Make this the standby" subtitle="It keeps a copy of another FBRX Server and takes over when that one stops.">
        {code || s.code ? (
          <>
            {code ? (
              <KeyValue
                items={[
                  ['Pairing code', <CopyText value={code.code} />],
                  ['This server’s certificate', <code className="ha-fp">{code.fingerprint}</code>],
                  ['Lasts until', formatDate(code.expiresAt)],
                ]}
              />
            ) : (
              <p className="fx-secondary">A pairing code is open until {formatDate(s.code!.expiresAt)}. Make a new one to see it again.</p>
            )}
            <Callout tone="warning">Once paired, what this server keeps is replaced by the primary’s copy, and it serves only when it takes over.</Callout>
            <div className="fx-actions">
              <Button icon="refresh" loading={busy === 'code'} onClick={() => void run('code', async () => setCode(await api('POST', '/v1/ha/code')))}>
                Make a new code
              </Button>
              <Button variant="ghost" loading={busy === 'cancel'} onClick={() => void run('cancel', () => api('DELETE', '/v1/ha/code').then(() => (setCode(null), reload())), 'Code cancelled')}>
                Cancel the code
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="fx-secondary">Make a pairing code here and give it, with this server’s address, to the primary. It lasts 30 minutes.</p>
            <div className="fx-actions">
              <Button variant="primary" icon="key" loading={busy === 'code'} onClick={() => void run('code', async () => setCode(await api('POST', '/v1/ha/code')))}>
                Make a pairing code
              </Button>
            </div>
          </>
        )}
      </Card>
      {pairing && <PairDialog onClose={() => setPairing(false)} reload={reload} />}
    </div>
  );
}

function PairDialog({ onClose, reload }: { onClose: () => void; reload: () => Promise<void> }) {
  const [address, setAddress] = useState('');
  const [cert, setCert] = useState<{ fingerprint: string; subject: string } | null>(null);
  const [code, setCode] = useState('');
  const [link, setLink] = useState('');
  const { run, busy } = useAction();
  return (
    <Modal
      title="Pair with a standby"
      description="The two talk only over HTTPS that both check, trusted by the certificate you confirm here."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {cert ? (
            <Button variant="primary" loading={busy === 'pair'} disabled={code.replace(/[^a-z0-9]/gi, '').length < 10} onClick={() => void run('pair', () => api('POST', '/v1/ha/pair', { address, fingerprint: cert.fingerprint, code, linkAddress: link.trim() || null }).then(() => (onClose(), reload())), 'Paired: the standby is catching up')}>
              Pair
            </Button>
          ) : (
            <Button variant="primary" loading={busy === 'check'} disabled={!address.trim()} onClick={() => void run('check', async () => setCert(await api('POST', '/v1/ha/check', { address })))}>
              Next
            </Button>
          )}
        </>
      }
    >
      <div className="fx-form">
        <Field label="The standby’s address" help="Its name or IP address, with :port if its console is not on 9443.">
          <Input value={address} autoFocus disabled={!!cert} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.1.21" />
        </Field>
        {cert && (
          <>
            <Field label="Its certificate" help="The standby shows the same next to its pairing code. If it does not match, stop: something is in between.">
              <code className="ha-fp">{cert.fingerprint}</code>
            </Field>
            <Field label="Pairing code">
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCDE-FGHJK" autoComplete="off" />
            </Field>
            <Field label="This server on a dedicated link (optional)" help="When a cable joins the two servers directly: this server’s address on it. The heartbeat goes both ways then, so one broken path is not a takeover.">
              <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="10.99.0.1" />
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------- paired

function Pair({ s, reload }: { s: HaStatus; reload: () => Promise<void> }) {
  const app = useApp();
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const p = s.partner!;
  const me = s.me;
  const meActive = me.state === 'active';
  const partnerActive = p.heard && p.state === 'active';
  const active = meActive ? me.name : partnerActive ? p.name : null;
  const standbyReady = (meActive && p.heard && p.state === 'standby') || (partnerActive && me.state === 'standby');
  // Handing back: the work is on the server the pair prefers as the standby.
  const handBack = standbyReady && ((meActive && me.preference === 'standby') || (partnerActive && p.preference === 'standby'));
  const target = meActive ? p.name : me.name;
  return (
    <>
      {me.state === 'standby' && partnerActive && (
        <Callout tone="info" title={`This is the standby: ${p.name} serves`} actions={<Button size="sm" icon="external" onClick={() => window.open(p.url, '_blank', 'noopener')}>Open {p.name}</Button>}>
          It keeps a copy and takes over if {p.name} stops answering. Make changes on {p.name}.
        </Callout>
      )}
      {s.warnings.map((w) => (
        <Callout key={w} tone="warning">
          {w}
        </Callout>
      ))}
      <Card
        title="The pair"
        subtitle={active ? `${active} serves.` : 'Nobody serves right now.'}
        actions={
          app.can('admin') && (
            <div className="fx-actions">
              {handBack ? (
                <Button
                  variant="primary"
                  icon="undo"
                  loading={busy === 'handback'}
                  onClick={async () => {
                    if (await confirm({ title: `Hand the work back to ${target}?`, body: `${target} takes over in about a second; ${active} becomes the standby again.`, confirmLabel: 'Hand back' }))
                      void run('handback', () => api('POST', '/v1/ha/handback').then(reload), `Handed back to ${target}`);
                  }}
                >
                  Hand back to {target}
                </Button>
              ) : (
                <Button
                  icon="repeat"
                  disabled={!standbyReady}
                  title={standbyReady ? undefined : 'The standby has to be heard and ready'}
                  loading={busy === 'switch'}
                  onClick={async () => {
                    if (await confirm({ title: `Switch over to ${target}?`, body: `A drill, or before an update: ${target} takes over in about a second and ${active} becomes the standby. Hand back afterwards from here.`, confirmLabel: 'Switch over' }))
                      void run('switch', () => api('POST', '/v1/ha/switchover').then(reload), `Switched over to ${target}`);
                  }}
                >
                  Switch over
                </Button>
              )}
            </div>
          )
        }
      >
        <div className="ha-diagram">
          <ServerBox name={me.name} here state={me.state} preference={me.preference} />
          <div className="ha-paths">
            {s.paths.map((path) => (
              <PathLine key={path.name} path={path} />
            ))}
          </div>
          <ServerBox name={p.name} state={p.heard ? p.state : null} preference={p.preference} lastHeardAt={p.lastHeardAt} url={p.url} />
        </div>
        <div className="ha-vote">
          {s.witness ? (
            <>
              <Status tone={s.witness.ok ? 'good' : me.state === 'active' ? 'warning' : 'neutral'}>Third vote</Status>
              <span className="fx-secondary">
                {s.witness.url} · {s.witness.ok ? (s.witness.holder === 'me' ? `${me.name} holds the pair` : s.witness.holder === 'partner' ? `${p.name} holds the pair` : 'answers') : me.state === 'active' ? `does not answer: ${s.witness.error}` : 'asked by the active server'}
              </span>
            </>
          ) : (
            <>
              <Status tone="warning">No third vote</Status>
              <span className="fx-secondary">Add one below so the two can never both serve.</span>
            </>
          )}
        </div>
      </Card>
      {s.copy.length > 0 && <Copy s={s} />}
      {s.gate && <GateCard s={s} reload={reload} />}
      <Settings s={s} reload={reload} />
      <ThirdVote s={s} reload={reload} />
      {app.can('admin') && (
        <Card title="Leave the pair">
          <p className="fx-secondary">Both servers go back to being on their own. The active one keeps serving; the standby keeps its copy and serves it as a server of its own.</p>
          <div className="fx-actions">
            <Button
              variant="danger"
              icon="x"
              loading={busy === 'unpair'}
              onClick={async () => {
                if (await confirm({ title: 'End the pair?', body: `${me.name} and ${p.name} stop watching each other: nothing takes over any more.`, confirmLabel: 'End the pair', danger: true }))
                  void run('unpair', () => api('DELETE', '/v1/ha').then(reload), 'The pair has ended');
              }}
            >
              End the pair
            </Button>
          </div>
        </Card>
      )}
      {dialog}
    </>
  );
}

function ServerBox({ name, here, state, preference, lastHeardAt, url }: { name: string; here?: boolean; state: HaState | null; preference: 'primary' | 'standby' | null; lastHeardAt?: string | null; url?: string }) {
  return (
    <div className={`ha-server ${state === 'active' ? 'is-active' : ''} ${state === null ? 'is-gone' : ''}`}>
      <div className="ha-server-name">
        <b>{name}</b>
        {here ? <Badge>This server</Badge> : url && <a href={url} target="_blank" rel="noopener noreferrer" className="fx-muted">{url.replace(/^https:\/\//, '')}</a>}
      </div>
      <Status tone={state ? TONE[state] : 'critical'}>{state ? HA_STATE_NAMES[state] : 'Not answering'}</Status>
      <small className="fx-muted" title={preference === 'primary' ? 'The pair prefers it to serve' : 'It serves when the primary cannot'}>
        {preference === 'primary' ? 'Primary' : 'Backup'}
        {state === null && lastHeardAt ? ` · last heard ${timeAgo(lastHeardAt)}` : ''}
      </small>
    </div>
  );
}

function PathLine({ path }: { path: HaPath }) {
  return (
    <div className={`ha-path ${path.up ? 'is-up' : 'is-down'}`} title={`${path.address}${path.lastHeardAt ? ` · last heard ${timeAgo(path.lastHeardAt)}` : ''}`}>
      <span className="ha-path-line" />
      <small>
        {path.name === 'link' ? 'Dedicated link' : 'Network'} · {path.up ? 'heard' : 'silent'}
      </small>
    </div>
  );
}

const secs = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : `${Math.round(ms / 60_000)} min`);

/** Role by role: on the active server how far behind the standby is; on the standby how current its copy is. */
function Copy({ s }: { s: HaStatus }) {
  const active = s.me.state === 'active';
  const words = (c: HaCopyView): [string, 'good' | 'neutral' | 'warning'] => {
    if (!active) return c.currentAt ? [`Current as of ${timeAgo(c.currentAt)}`, 'good'] : ['No copy yet', 'warning'];
    if (c.state === 'caught-up') return ['Up to date', 'good'];
    if (c.state === 'full-copy') return [`Copying everything${c.behindMs ? ` (${secs(c.behindMs)})` : ''}`, 'neutral'];
    if (c.state === 'waiting') return [`Waiting for ${s.partner!.name}`, 'neutral'];
    return [`${c.behind} change${c.behind === 1 ? '' : 's'} on the way${c.behindMs ? ` (${secs(c.behindMs)})` : ''}`, (c.behindMs ?? 0) > 60_000 ? 'warning' : 'neutral'];
  };
  return (
    <Card title={active ? `What ${s.partner!.name} has` : 'This server’s copy'} subtitle={active ? 'Each change is copied to the standby as it is made, role by role.' : `Copied from ${s.partner!.name} as it changes. Virtual machines and the files in shares are not copied yet.`} flush>
      <Table<HaCopyView>
        rows={s.copy}
        rowKey={(c) => c.name}
        columns={[
          { key: 'l', header: 'Role', render: (c) => <b>{c.label}</b> },
          {
            key: 's',
            header: '',
            render: (c) => {
              const [text, tone] = words(c);
              return <Status tone={tone}>{text}</Status>;
            },
          },
        ]}
      />
    </Card>
  );
}

/** FBRX Gate in the pair: this server's own address in each network (the gateway address moves between the two). */
function GateCard({ s, reload }: { s: HaStatus; reload: () => Promise<void> }) {
  const app = useApp();
  const g = s.gate!;
  const [own, setOwn] = useState<Record<string, string>>(() => Object.fromEntries(g.networks.map((n) => [n.name, n.own ?? ''])));
  const { run, busy } = useAction();
  const changed = g.networks.some((n) => (own[n.name] ?? '') !== (n.own ?? ''));
  return (
    <Card title="FBRX Gate in the pair" subtitle="Each network’s gateway address moves to the server that serves. Each server also keeps an address of its own in each network; set this server’s here, and the other server’s on its own page.">
      {g.problem ? <Callout tone="warning" title="The gate does not move in a second yet">{g.problem}. Until it has one, the server that takes over applies the gate’s whole configuration (several seconds), and the standby leaves the gate alone.</Callout> : <Callout tone="good">The gate moves in about a second{g.sync ? `, with its open connections (kept in step over ${g.sync})` : ''}.</Callout>}
      <div className="fx-form">
        {g.networks.map((n) => (
          <Field key={n.name} label={`${n.name}: this server’s own address`} help={`The gateway address ${n.gateway.split('/')[0]} moves between the two; give this server another one in ${n.gateway.replace(/\.\d+\//, '.0/')}, with its size.`}>
            <Input value={own[n.name] ?? ''} placeholder={n.gateway.replace(/\.\d+\//, '.2/')} style={{ maxWidth: 220 }} disabled={!app.can('admin')} onChange={(e) => setOwn({ ...own, [n.name]: e.target.value })} />
          </Field>
        ))}
        {app.can('admin') && (
          <div className="fx-actions">
            <Button size="sm" variant="primary" disabled={!changed} loading={busy === 'gate'} onClick={() => void run('gate', () => api('PUT', '/v1/ha/gate', { own }).then(reload), 'Saved: the gate applies it')}>
              Save
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function Settings({ s, reload }: { s: HaStatus; reload: () => Promise<void> }) {
  const app = useApp();
  const [takeover, setTakeover] = useState(String(s.settings.takeoverMs / 1000));
  const [link, setLink] = useState(s.settings.linkAddress ?? '');
  const { run, busy } = useAction();
  const secs = Number(takeover);
  const bad = !Number.isFinite(secs) || secs < 0.6 || secs > 30;
  const save = (patch: Record<string, unknown>, done: string) => void run('save', () => api('PUT', '/v1/ha/settings', patch).then(reload), done);
  return (
    <Card title="Settings" subtitle="Both servers use the same, apart from each one’s dedicated link address.">
      <div className="fx-form">
        <Field label="Take over after" help="How long without a word from the active server before the standby takes over, in seconds (0.6 to 30). Shorter is quicker; longer rides out a busy network." error={bad ? 'Between 0.6 and 30 seconds' : undefined}>
          <div className="fx-actions">
            <Input value={takeover} inputMode="decimal" style={{ width: 100 }} disabled={!app.can('admin')} onChange={(e) => setTakeover(e.target.value)} />
            {app.can('admin') && (
              <Button size="sm" disabled={bad || Math.round(secs * 1000) === s.settings.takeoverMs} loading={busy === 'save'} onClick={() => save({ takeoverMs: Math.round(secs * 1000) }, 'Saved on both servers')}>
                Save
              </Button>
            )}
          </div>
        </Field>
        <Toggle
          checked={s.settings.autoHandBack}
          disabled={!app.can('admin')}
          onChange={(on) => save({ autoHandBack: on }, on ? 'The work goes back to the primary by itself' : 'Handing back is up to you')}
          label="Hand the work back to the primary by itself, once it is back and has been ready for a minute"
        />
        <Field label="This server on a dedicated link" help="Its address on a cable straight to the other server, when there is one; empty when there is none.">
          <div className="fx-actions">
            <Input value={link} placeholder="10.99.0.1" style={{ width: 180 }} disabled={!app.can('admin')} onChange={(e) => setLink(e.target.value)} />
            {app.can('admin') && (
              <Button size="sm" disabled={(link.trim() || null) === s.settings.linkAddress} loading={busy === 'save'} onClick={() => save({ linkAddress: link.trim() || null }, 'Saved: the heartbeat goes on the link too')}>
                Save
              </Button>
            )}
          </div>
        </Field>
      </div>
    </Card>
  );
}

function ThirdVote({ s, reload }: { s: HaStatus; reload: () => Promise<void> }) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const w = s.witness;
  return (
    <Card
      title="Third vote"
      subtitle="FBRX Command, or a third FBRX Server, that decides which of the two serves when they cannot hear each other. With it the two never both serve."
      actions={
        app.can('admin') &&
        s.me.state === 'active' && (
          <div className="fx-actions">
            <Button size="sm" icon={w ? 'edit' : 'plus'} onClick={() => setOpen(true)}>
              {w ? 'Change' : 'Add a third vote'}
            </Button>
            {w && (
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                loading={busy === 'remove'}
                onClick={async () => {
                  if (await confirm({ title: 'Remove the third vote?', body: 'Without it, a break in the network between the two can make both serve.', confirmLabel: 'Remove', danger: true }))
                    void run('remove', () => api('DELETE', '/v1/ha/witness').then(reload), 'The pair has no third vote now');
                }}
              />
            )}
          </div>
        )
      }
    >
      {w ? (
        <KeyValue
          items={[
            ['Address', w.url],
            ['Certificate', w.fingerprint ? <code className="ha-fp">{w.fingerprint}</code> : 'Vouched for by a certificate authority'],
            ['Last answer', w.lastAt ? timeAgo(w.lastAt) : s.me.state === 'active' ? 'Not yet' : 'The active server asks it'],
          ]}
        />
      ) : (
        <p className="fx-secondary">{s.me.state === 'active' ? 'On FBRX Command (Settings → High availability) or another FBRX Server (High availability → Be a third vote), make a third-vote key, then add it here.' : 'Add it on the active server.'}</p>
      )}
      {open && <ThirdVoteDialog onClose={() => setOpen(false)} reload={reload} />}
      {dialog}
    </Card>
  );
}

function ThirdVoteDialog({ onClose, reload }: { onClose: () => void; reload: () => Promise<void> }) {
  const [url, setUrl] = useState('');
  const [cert, setCert] = useState<{ fingerprint: string; trusted: boolean } | null>(null);
  const [key, setKey] = useState('');
  const { run, busy } = useAction();
  return (
    <Modal
      title="Third vote"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {cert ? (
            <Button variant="primary" loading={busy === 'save'} disabled={!key.trim().startsWith('fbrxw1.')} onClick={() => void run('save', () => api('PUT', '/v1/ha/witness', { url, fingerprint: cert.trusted ? null : cert.fingerprint, key }).then(() => (onClose(), reload())), 'The pair has a third vote')}>
              Save
            </Button>
          ) : (
            <Button variant="primary" loading={busy === 'check'} disabled={!url.trim()} onClick={() => void run('check', async () => setCert(await api('POST', '/v1/ha/check', { address: url })))}>
              Next
            </Button>
          )}
        </>
      }
    >
      <div className="fx-form">
        <Field label="Its address" help="FBRX Command’s address, or another FBRX Server’s (https://…:9443).">
          <Input value={url} autoFocus disabled={!!cert} onChange={(e) => setUrl(e.target.value)} placeholder="https://command.example.org" />
        </Field>
        {cert && (
          <>
            <Field label="Its certificate" help={cert.trusted ? 'A certificate authority vouches for it.' : 'Check it against the one the third vote shows next to its key.'}>
              <code className="ha-fp">{cert.fingerprint}</code>
            </Field>
            <Field label="Third-vote key">
              <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="fbrxw1.…" autoComplete="off" />
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------- history

const KIND_WORDS: Record<HaEvent['kind'], string> = {
  paired: 'Paired',
  unpaired: 'Pair ended',
  takeover: 'Takeover',
  switchover: 'Switchover',
  handback: 'Hand-back',
  stopped: 'Stopped',
  resumed: 'Serving again',
  'partner-lost': 'Partner silent',
  'partner-back': 'Partner back',
  'both-active': 'Both served',
  'third-vote': 'Third vote',
};
const KIND_TONE: Partial<Record<HaEvent['kind'], 'good' | 'warning' | 'critical' | 'neutral'>> = { takeover: 'critical', stopped: 'critical', 'both-active': 'warning', 'partner-lost': 'warning', 'partner-back': 'good', resumed: 'good', handback: 'good' };

function History({ events }: { events: HaEvent[] }) {
  const [open, setOpen] = useState<HaEvent | null>(null);
  if (!events.length) return null;
  return (
    <Card title="What happened" flush>
      <Table<HaEvent>
        rows={events}
        rowKey={(e) => String(e.id)}
        onRowClick={(e) => e.steps.length && setOpen(e)}
        columns={[
          { key: 'at', header: 'When', width: 170, render: (e) => <span title={formatDate(e.at)}>{timeAgo(e.at)}</span> },
          { key: 'k', header: '', width: 140, render: (e) => <Status tone={KIND_TONE[e.kind] ?? 'neutral'}>{KIND_WORDS[e.kind]}</Status> },
          { key: 't', header: 'What', render: (e) => <>{e.text}{e.steps.length > 0 && <small className="fx-muted"> · {e.steps.length} steps</small>}</> },
        ]}
      />
      {open && (
        <Modal title={open.text} description={formatDate(open.at)} onClose={() => setOpen(null)}>
          <ol className="ha-steps">
            {open.steps.map((s, i) => (
              <li key={i}>
                <span className="ha-steps-at">{new Date(s.at).toLocaleTimeString()}</span>
                <span>{s.text}</span>
              </li>
            ))}
          </ol>
        </Modal>
      )}
    </Card>
  );
}

// -------------------------------------------------------------------------------------------- a third vote for others

function ThirdVoteHost({ s, reload }: { s: HaStatus; reload: () => Promise<void> }) {
  const app = useApp();
  const [made, setMade] = useState<{ key: string; fingerprint: string | null } | null>(null);
  const [label, setLabel] = useState('');
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  if (!app.can('admin') || !s.available) return null;
  return (
    <Card title="Be a third vote" subtitle="This server can be the third vote of another pair of FBRX Servers: make a key for that pair and add it on its active server." flush>
      <Table
        rows={s.witnessKeys}
        rowKey={(k) => k.id}
        columns={[
          { key: 'l', header: 'Pair', render: (k) => <b>{k.label}</b> },
          { key: 'c', header: 'Made', render: (k) => formatDate(k.createdAt) },
          { key: 'u', header: 'Last asked', render: (k) => (k.lastUsedAt ? timeAgo(k.lastUsedAt) : <span className="fx-muted">Not yet</span>) },
          {
            key: 'a',
            header: '',
            width: 56,
            render: (k) => (
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                aria-label={`Remove the key of ${k.label}`}
                loading={busy === `d:${k.id}`}
                onClick={async () => {
                  if (await confirm({ title: `Remove the key of ${k.label}?`, body: 'That pair loses its third vote: its active server keeps serving while it hears its partner.', confirmLabel: 'Remove', danger: true }))
                    void run(`d:${k.id}`, () => api('DELETE', `/v1/ha/witness/keys/${k.id}`).then(reload), 'Removed');
                }}
              />
            ),
          },
        ]}
        empty={<Empty title="No pair uses this server as its third vote" />}
      />
      <div className="ha-host-add">
        <Input value={label} placeholder="Which pair (Office servers)" maxLength={80} onChange={(e) => setLabel(e.target.value)} style={{ maxWidth: 280 }} />
        <Button icon="key" loading={busy === 'make'} onClick={() => void run('make', async () => (setMade(await api('POST', '/v1/ha/witness/keys', { label })), setLabel(''), await reload()))}>
          Make a third-vote key
        </Button>
      </div>
      {made && (
        <Modal title="Third-vote key" description="Shown this once. Add it on the pair’s active server (High availability → Third vote)." onClose={() => setMade(null)} footer={<Button variant="primary" onClick={() => setMade(null)}>Done</Button>}>
          <KeyValue
            items={[
              ['Address', <CopyText value={location.origin} />],
              ['Certificate', made.fingerprint ? <code className="ha-fp">{made.fingerprint}</code> : '—'],
              ['Key', <CopyText value={made.key} secret />],
            ]}
          />
        </Modal>
      )}
      {dialog}
    </Card>
  );
}
