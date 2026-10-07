import { useEffect, useState } from 'react';
import { DOME_TEST_DOMAIN, type DomeDevice, type DomeFinding, type DomeSettings, type DomeSeverity, type DomeState, type DomeStatus } from '@fbrx/dome';
import type { GateState } from '@fbrx/gate';
import { Button, Callout, Card, ChoiceCards, CopyText, Empty, Field, formatNumber, Grid, Page, StatTile, Status, Table, Tabs, TextArea, timeAgo, Toggle, useAction, useToast, type StatusTone } from '@fbrx/ui';
import { api } from '../api';
import { useGate } from '../gate-state';
import { useApp, usePoll, useRoute } from '../state';

const TONE: Record<DomeSeverity, StatusTone> = { info: 'info', warning: 'warning', serious: 'serious', critical: 'critical' };
const SEVERITY_WORDS: Record<DomeSeverity, string> = { info: 'Worth knowing', warning: 'Warning', serious: 'Serious', critical: 'Critical' };
const STATUS_WORDS: Record<DomeStatus, string> = { open: 'Open', acknowledged: 'Looking into it', resolved: 'Resolved', muted: 'Muted' };
const KIND_WORDS: Record<DomeFinding['kind'], string> = {
  'new-device': 'New device',
  'bad-domain': 'Known-bad name',
  dga: 'Made-up names',
  'dns-tunnel': 'Data hidden in names',
  'dns-bypass': 'DNS around the gate',
  'port-scan': 'Scanning',
  beaconing: 'Checking in like clockwork',
  'arp-spoof': 'Address fight',
};
const BLOCKABLE = new Set(['bad-domain', 'dns-tunnel']);
type Tab = 'findings' | 'devices' | 'settings';
type Filter = 'active' | DomeStatus | 'all';

/** FBRX MiniDome: what it saw on the network, the devices on it, and how it watches. */
export function DomePage({ tab }: { tab?: string }) {
  const app = useApp();
  const [, go] = useRoute();
  const state = usePoll<DomeState>(app.has('minidome') ? '/v1/dome' : null, 5000);
  const active: Tab = tab === 'devices' || tab === 'settings' ? tab : 'findings';
  if (!app.has('minidome'))
    return (
      <Page title="MiniDome">
        <Card title="MiniDome is not on this server">
          <p className="fx-secondary">
            FBRX MiniDome watches your network through FBRX Gate: the names devices ask for, the connections they make, and who is on the wire. It spots known-bad sites, malware looking for its servers, data smuggled out through DNS, scans, devices calling home like clockwork, and devices fighting over addresses. Add it to a gate with:
          </p>
          <CopyText value="sudo ./install.sh --roles gate,minidome,ai --gate-wan eno1 --gate-lan eno2" />
        </Card>
      </Page>
    );
  const s = state.data;
  const open = s ? s.open.critical + s.open.serious : 0;
  const lastHour = s ? s.stats.dnsPerMinute.reduce((a, b) => a + b, 0) : 0;
  return (
    <Page title="MiniDome" description="Watches the network through the gate: the names devices ask for, the connections they make, and who is on the wire. What looks wrong shows up here, and FBRX computers hear about what was seen coming from them.">
      {!s ? (
        state.error ? <Callout tone="critical" title="MiniDome does not answer">{state.error}</Callout> : <Empty title="Loading…" />
      ) : (
        <>
          {s.mode === 'simulated' && (
            <Callout tone="info" title="Simulated network">
              A pretend household, with a few of the things MiniDome is there for happening shortly after the start. On a real gate, MiniDome listens to the gate's DNS, its connections and its neighbors.
            </Callout>
          )}
          {!s.settings.enabled && <Callout tone="warning" title="MiniDome is switched off">Nothing is watched until it is switched on again (Settings).</Callout>}
          {s.learningUntil && (
            <Callout tone="info">
              Learning your network until {new Date(s.learningUntil).toLocaleTimeString()}: devices seen until then are taken as yours, so new devices are reported only after that.
            </Callout>
          )}
          {s.stats.sensors.filter((x) => !x.ok).map((x) => (
            <Callout key={x.name} tone="warning" title={x.name}>
              {x.detail}
            </Callout>
          ))}
          <Grid cols={4}>
            <StatTile label="Needs a look" value={formatNumber(open)} foot={`${s.open.warning} warning${s.open.warning === 1 ? '' : 's'} · ${s.open.info} worth knowing`} hero />
            <StatTile label="Names asked, last hour" value={formatNumber(lastHour)} foot={`${formatNumber(s.stats.dnsQueries)} since ${new Date(s.stats.since).toLocaleTimeString()}`} trend={s.stats.dnsPerMinute} />
            <StatTile label="Devices seen" value={formatNumber(s.stats.devices)} foot={`${formatNumber(s.stats.flows)} connections watched`} />
            <StatTile label="Threat list" value={formatNumber(s.stats.feedDomains)} foot={`${s.stats.feedDomains === 1 ? 'domain' : 'domains'}${s.stats.feedUpdatedAt ? ` · updated ${timeAgo(s.stats.feedUpdatedAt)}` : ''}${s.settings.feeds.length ? '' : ' (add lists in Settings)'}`} />
          </Grid>
          <Tabs<Tab>
            active={active}
            onChange={(t) => go('dome', t)}
            tabs={[
              { id: 'findings', label: `Findings${open ? ` · ${open}` : ''}` },
              { id: 'devices', label: 'Devices' },
              { id: 'settings', label: 'Settings' },
            ]}
          />
          {active === 'findings' && <Findings onChanged={() => void state.reload()} />}
          {active === 'devices' && <Devices />}
          {active === 'settings' && <Settings state={s} onSaved={() => void state.reload()} />}
        </>
      )}
    </Page>
  );
}

function Findings({ onChanged }: { onChanged: () => void }) {
  const [filter, setFilter] = useState<Filter>('active');
  const list = usePoll<{ findings: DomeFinding[] }>(`/v1/dome/findings${filter === 'all' ? '' : `?status=${filter}`}`, 5000);
  const [open, setOpen] = useState<number | null>(null);
  const rows = list.data?.findings ?? [];
  return (
    <>
      <div className="vt-chips">
        {(['active', 'open', 'acknowledged', 'resolved', 'muted', 'all'] as Filter[]).map((f) => (
          <button key={f} type="button" className={`vt-chip${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>
            {f === 'active' ? 'Needs attention' : f === 'all' ? 'Everything' : STATUS_WORDS[f]}
          </button>
        ))}
      </div>
      <Card flush>
        {!rows.length ? (
          <Empty title={list.data ? (filter === 'active' ? 'Nothing needs a look' : 'Nothing here') : 'Loading…'}>
            {list.data && filter === 'active' && (
              <>
                To try MiniDome, ask the gate for <span className="mono">{DOME_TEST_DOMAIN}</span> from any device (<span className="mono">nslookup {DOME_TEST_DOMAIN}</span>): it is always on the threat list.
              </>
            )}
          </Empty>
        ) : (
          <div className="dm-list">
            {rows.map((f) => (
              <div key={f.id} className={`dm-item ${f.severity}${open === f.id ? ' open' : ''}`}>
                <button type="button" className="dm-head" onClick={() => setOpen(open === f.id ? null : f.id)} aria-expanded={open === f.id}>
                  <Status tone={f.status === 'open' ? TONE[f.severity] : 'neutral'}>{SEVERITY_WORDS[f.severity]}</Status>
                  <span className="dm-title">
                    <b>{f.title}</b>
                    <span className="fx-cell-sub">
                      {KIND_WORDS[f.kind]}
                      {f.device.ip ? ` · ${f.device.ip}` : ''}
                      {f.device.network ? ` · ${f.device.network}` : ''}
                      {f.count > 1 ? ` · ${f.count} times` : ''}
                      {f.status !== 'open' ? ` · ${STATUS_WORDS[f.status].toLowerCase()}` : ''}
                    </span>
                  </span>
                  <span className="fx-muted dm-when">{timeAgo(f.lastAt)}</span>
                </button>
                {open === f.id && (
                  <FindingDetail
                    f={f}
                    onChanged={() => {
                      void list.reload();
                      onChanged();
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

function FindingDetail({ f, onChanged }: { f: DomeFinding; onChanged: () => void }) {
  const app = useApp();
  const gate = useGate();
  const [, go] = useRoute();
  const toast = useToast();
  const { busy, run } = useAction();
  const [answer, setAnswer] = useState<string | null>(null);
  const set = (status: DomeStatus, done: string) =>
    run(status, async () => {
      await api('POST', `/v1/dome/findings/${f.id}`, { status });
      onChanged();
    }, done);
  return (
    <div className="dm-body">
      <p style={{ margin: 0 }}>{f.detail}</p>
      {f.evidence.length > 0 && <pre className="gt-pre dm-evidence">{f.evidence.join('\n')}</pre>}
      <div className="fx-secondary dm-meta">
        First seen {new Date(f.firstAt).toLocaleString()} · last {new Date(f.lastAt).toLocaleString()}
        {f.device.mac ? ` · ${f.device.mac}` : ''}
        {f.notified ? ` · ${f.notified} was told through FBRX Mesh` : ''}
      </div>
      {answer && (
        <div className="vt-assist-answer">
          <b>This server's AI: </b>
          {answer}
        </div>
      )}
      {app.can('operator') && (
        <div className="fx-row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {f.status !== 'acknowledged' && f.status !== 'muted' && (
            <Button size="sm" icon="eye" loading={busy === 'acknowledged'} onClick={() => void set('acknowledged', 'Marked as being looked into')}>
              Looking into it
            </Button>
          )}
          {f.status !== 'resolved' && (
            <Button size="sm" icon="check" loading={busy === 'resolved'} onClick={() => void set('resolved', 'Resolved: it opens again if it happens again')}>
              Resolve
            </Button>
          )}
          {f.status !== 'muted' ? (
            <Button size="sm" variant="ghost" icon="bell" loading={busy === 'muted'} onClick={() => void set('muted', 'Muted: still counted, never raised')} title="Still counted, never raised again">
              Mute
            </Button>
          ) : (
            <Button size="sm" variant="ghost" icon="refresh" loading={busy === 'open'} onClick={() => void set('open', 'Open again')}>
              Unmute
            </Button>
          )}
          {app.has('ai') && (
            <Button
              size="sm"
              icon="sparkles"
              loading={busy === 'explain'}
              onClick={() =>
                void run('explain', async () => {
                  const r = await api<{ answer: string }>('POST', `/v1/dome/findings/${f.id}/explain`);
                  setAnswer(r.answer);
                })
              }
            >
              Explain with AI
            </Button>
          )}
          {app.can('admin') && app.has('gate') && BLOCKABLE.has(f.kind) && f.subject && (
            <Button
              size="sm"
              variant="danger"
              icon="shield"
              loading={busy === 'block'}
              onClick={() =>
                void run('block', async () => {
                  const r = await api<{ domain: string; state: GateState }>('POST', `/v1/dome/findings/${f.id}/block`);
                  gate.setState(r.state);
                  toast.success(`${r.domain} will be blocked`, 'Added to what is being edited on the gate: commit it to put it in place.', { label: 'Review & commit', onClick: () => go('gate-changes') });
                })
              }
            >
              Block {f.subject} on the gate
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Devices() {
  const list = usePoll<{ devices: DomeDevice[] }>('/v1/dome/devices', 15000);
  return (
    <Card title="Devices on your networks" subtitle="Everyone MiniDome has seen through the gate. FBRX computers that allow Network protection on FBRX Mesh show how they are protected." flush>
      <Table<DomeDevice>
        rows={list.data?.devices ?? []}
        rowKey={(d) => d.mac}
        empty={<Empty title={list.data ? 'No devices yet' : 'Loading…'} />}
        columns={[
          { key: 'n', header: 'Device', render: (d) => <div><div className="fx-cell-title">{d.fbrx?.name ?? d.name ?? 'Unnamed'}</div><div className="fx-cell-sub mono">{d.mac}</div></div> },
          { key: 'a', header: 'Address', render: (d) => <div><div className="mono">{d.ip ?? '—'}</div><div className="fx-cell-sub">{d.network ?? ''}</div></div> },
          {
            key: 'p',
            header: 'Protection',
            render: (d) =>
              d.fbrx ? (
                d.fbrx.protection ? (
                  <div>
                    <Status tone={d.fbrx.protection.state === 'protected' ? 'good' : d.fbrx.protection.threats ? 'critical' : 'warning'}>{d.fbrx.protection.name}</Status>
                    <div className="fx-cell-sub">{d.fbrx.protection.threats ? `${d.fbrx.protection.threats} threat${d.fbrx.protection.threats === 1 ? '' : 's'}` : d.fbrx.protection.state}</div>
                  </div>
                ) : (
                  <span className="fx-muted" title="On the computer: Mesh → this server → Network protection">FBRX computer (protection not shared)</span>
                )
              ) : (
                <span className="fx-muted">—</span>
              ),
          },
          { key: 'f', header: 'First seen', render: (d) => new Date(d.firstSeen).toLocaleDateString() },
          { key: 'l', header: 'Last seen', render: (d) => timeAgo(d.lastSeen) },
        ]}
      />
    </Card>
  );
}

function Settings({ state, onSaved }: { state: DomeState; onSaved: () => void }) {
  const app = useApp();
  const admin = app.can('admin');
  const { busy, run } = useAction();
  const [s, setS] = useState<DomeSettings>(state.settings);
  const [feeds, setFeeds] = useState(state.settings.feeds.join('\n'));
  const [allow, setAllow] = useState(state.settings.allow.join('\n'));
  const key = JSON.stringify(state.settings);
  useEffect(() => {
    setS(state.settings);
    setFeeds(state.settings.feeds.join('\n'));
    setAllow(state.settings.allow.join('\n'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const lines = (t: string) => t.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  const draft: DomeSettings = { ...s, feeds: lines(feeds), allow: lines(allow) };
  const dirty = JSON.stringify(draft) !== key;
  return (
    <>
      <Grid cols={2}>
        <Card title="Watching">
          <fieldset className="vt-fieldset" disabled={!admin}>
            <Toggle checked={s.enabled} onChange={(enabled) => setS({ ...s, enabled })} label="MiniDome on" />
            <ChoiceCards
              label="Speaks up"
              value={s.sensitivity}
              onChange={(sensitivity) => setS({ ...s, sensitivity })}
              options={[
                { value: 'low', title: 'Only when sure', description: 'Fewer findings; a busy network stays quiet.' },
                { value: 'normal', title: 'Balanced', description: 'Recommended.' },
                { value: 'high', title: 'Readily', description: 'Earlier warnings, more false alarms.' },
              ]}
            />
            <Toggle checked={s.newDevices} onChange={(newDevices) => setS({ ...s, newDevices })} label="Report devices the gate has not seen before" />
            <Toggle checked={s.notifyComputers} onChange={(notifyComputers) => setS({ ...s, notifyComputers })} label="Tell FBRX computers what was seen coming from them" />
            <p className="fx-secondary gt-hint">
              Through FBRX Mesh and this server's FBRX core (ai role). Each computer decides: on it, Mesh → this server → Network protection. It then gets an alert, and this page shows how it is protected.
            </p>
          </fieldset>
        </Card>
        <Card title="Threat lists">
          <fieldset className="vt-fieldset" disabled={!admin}>
            <Field label="Lists" help="Web addresses of threat lists you trust (hosts files or one domain per line), one per line. Fetched twice a day.">
              <TextArea code rows={4} value={feeds} onChange={(e) => setFeeds(e.target.value)} placeholder="https://example.org/threats.txt" />
            </Field>
            <Field label="Never report" help="Domains you know are fine (their subdomains too), one per line.">
              <TextArea code rows={3} value={allow} onChange={(e) => setAllow(e.target.value)} placeholder="example.com" />
            </Field>
            {state.stats.feedErrors.map((e) => (
              <Callout key={e} tone="warning">
                {e}
              </Callout>
            ))}
            <div className="fx-row" style={{ gap: 8 }}>
              <Button
                size="sm"
                icon="refresh"
                loading={busy === 'feeds'}
                onClick={() =>
                  void run('feeds', async () => {
                    const r = await api<{ domains: number; errors: string[] }>('POST', '/v1/dome/feeds/refresh');
                    onSaved();
                    return r;
                  }, 'Threat lists fetched')
                }
              >
                Fetch the lists now
              </Button>
              <span className="fx-secondary">
                {formatNumber(state.stats.feedDomains)} domain{state.stats.feedDomains === 1 ? '' : 's'}{state.stats.feedUpdatedAt ? `, ${timeAgo(state.stats.feedUpdatedAt)}` : ''}
              </span>
            </div>
          </fieldset>
        </Card>
      </Grid>
      <Card title="What MiniDome listens to">
        <Table
          rows={state.stats.sensors}
          rowKey={(x) => x.name}
          empty={<Empty title="Not listening (switched off)" />}
          columns={[
            { key: 'n', header: 'Source', render: (x) => x.name },
            { key: 's', header: '', render: (x) => <Status tone={x.ok ? 'good' : 'warning'}>{x.ok ? 'Working' : 'Needs a look'}</Status> },
            { key: 'd', header: '', render: (x) => <span className="fx-secondary">{x.detail}</span> },
          ]}
        />
      </Card>
      {admin && dirty && (
        <div className="vt-savebar">
          <span>MiniDome settings changed</span>
          <span className="fx-spacer" />
          <Button
            onClick={() => {
              setS(state.settings);
              setFeeds(state.settings.feeds.join('\n'));
              setAllow(state.settings.allow.join('\n'));
            }}
          >
            Undo
          </Button>
          <Button
            variant="primary"
            loading={busy === 'save'}
            onClick={() =>
              void run('save', async () => {
                await api('PUT', '/v1/dome/settings', { settings: draft });
                onSaved();
              }, 'MiniDome settings saved')
            }
          >
            Save
          </Button>
        </div>
      )}
    </>
  );
}
