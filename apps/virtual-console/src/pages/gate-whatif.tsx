import { useEffect, useState } from 'react';
import type { Verdict, WhatIfReport } from '@fbrx/gate';
import { Button, Callout, Card, Status, Table, timeAgo, useAction, type StatusTone } from '@fbrx/ui';
import { api } from '../api';
import { useApp } from '../state';

const TONE: Record<Verdict['verdict'], StatusTone> = { allowed: 'good', blocked: 'critical', absent: 'neutral' };
const WORD: Record<Verdict['verdict'], string> = { allowed: 'Allowed', blocked: 'Blocked', absent: 'Not there' };
const ZONE = (z: string) => (z === 'wan' ? 'the internet' : z === 'vpn' ? 'VPN devices' : z);

function V({ v }: { v: Verdict }) {
  return (
    <span title={v.because}>
      <Status tone={TONE[v.verdict]}>{WORD[v.verdict]}</Status>
      <span className="fx-cell-sub gt-because">{v.because}</span>
    </span>
  );
}

const moved = (a: Verdict, b: Verdict) => (a.verdict === 'allowed') !== (b.verdict === 'allowed');

/**
 * What If, on Changes: what committing would do to traffic, worked out from the firewall itself (nothing is tried on
 * the network). Who gains and loses what, whether you keep this console, and the connections the gate saw in the last
 * hour that the change turns around. This server's AI can explain it.
 */
export function WhatIfCard({ stamp, onReport }: { stamp: string; onReport: (r: WhatIfReport | null) => void }) {
  const app = useApp();
  const { busy, run } = useAction();
  const [r, setR] = useState<WhatIfReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let off = false;
    setAnswer(null);
    api<WhatIfReport>('GET', '/v1/gate/whatif')
      .then((x) => {
        if (off) return;
        setR(x);
        setError(null);
        onReport(x);
      })
      .catch((e: Error) => !off && setError(e.message));
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);
  if (error) return <Callout tone="warning" title="What If could not work this out">{error}</Callout>;
  if (!r) return null;
  // Cut off first, then newly opened, then the rest (a new network's connections, say).
  const rank = (m: WhatIfReport['matrix'][number]) => (m.before.verdict === 'allowed' && m.after.verdict !== 'allowed' ? 0 : m.before.verdict !== 'allowed' && m.after.verdict === 'allowed' ? 1 : 2);
  const rows = (all ? r.matrix : r.matrix.filter((m) => moved(m.before, m.after) || m.before.verdict !== m.after.verdict)).slice().sort((a, b) => rank(a) - rank(b));
  const same = r.matrix.length - r.matrix.filter((m) => moved(m.before, m.after) || m.before.verdict !== m.after.verdict).length;
  const s = r.summary;
  return (
    <Card
      title="What if you commit this?"
      subtitle="Worked out from the firewall itself, before anything changes on the network."
      actions={
        app.has('ai') &&
        app.can('operator') && (
          <Button size="sm" icon="sparkles" loading={busy === 'explain'} onClick={() => void run('explain', async () => setAnswer((await api<{ answer: string }>('POST', '/v1/gate/whatif/explain')).answer))}>
            Ask the AI
          </Button>
        )
      }
    >
      {r.you &&
        (s.youCutOff ? (
          <Callout tone="critical" title="This change cuts you off from this console">
            You are at {r.you.address} ({ZONE(r.you.from)}): {r.you.after.because}. Commit it on trial (it comes back by itself), or let {ZONE(r.you.fromAfter)} manage the gate first.
          </Callout>
        ) : (
          <p className="fx-secondary gt-whatif-you">
            <Status tone={r.you.after.verdict === 'allowed' ? 'good' : 'warning'}>{r.you.after.verdict === 'allowed' ? 'You keep this console' : 'This console is not reachable from where you are'}</Status> {r.you.address} on {ZONE(r.you.fromAfter)}
          </p>
        ))}
      <div className="gt-whatif-sum">
        <span>
          <b>{s.cutOff}</b> kind{s.cutOff === 1 ? '' : 's'} of connection cut off
        </span>
        <span>
          <b>{s.opened}</b> opened
        </span>
        <span>
          {r.flowsChecked ? (
            <>
              <b>{s.flowsCutOff}</b> of {r.flowsChecked} recent connection{r.flowsChecked === 1 ? '' : 's'} would be cut off, <b>{s.flowsOpened}</b> newly allowed
            </>
          ) : (
            'No recent connections to replay (FBRX MiniDome records them)'
          )}
        </span>
      </div>
      {answer && (
        <div className="vt-assist-answer">
          <b>This server's AI: </b>
          {answer}
        </div>
      )}
      <Table
        rows={rows}
        rowKey={(m) => `${m.from}>${m.to}>${m.what}`}
        empty={<p className="fx-secondary gt-pad">Nothing changes for any kind of connection between your networks, the gate and the internet.</p>}
        columns={[
          { key: 'f', header: 'From', render: (m) => ZONE(m.from) },
          { key: 'w', header: 'To', render: (m) => m.what },
          { key: 'b', header: 'Now', render: (m) => <V v={m.before} /> },
          { key: 'a', header: 'After the change', render: (m) => <V v={m.after} /> },
        ]}
      />
      {same > 0 && (
        <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>
          {all ? 'Show only what changes' : `Show the ${same} that stay the same too`}
        </Button>
      )}
      {r.flows.length > 0 && (
        <>
          <h4 className="gt-whatif-h">Connections from the last hour the change turns around</h4>
          <Table
            rows={r.flows.slice(0, 25)}
            rowKey={(f) => `${f.proto}${f.src}${f.dst}${f.port}`}
            columns={[
              { key: 's', header: 'From', render: (f) => <span className="mono">{f.src}</span> },
              { key: 'd', header: 'To', render: (f) => <span className="mono">{`${f.dst}:${f.port}/${f.proto}`}</span> },
              { key: 'n', header: 'Times', className: 'num', render: (f) => <span title={`Last ${timeAgo(f.lastAt)}`}>{f.count}</span> },
              { key: 'a', header: 'After the change', render: (f) => <V v={f.after} /> },
            ]}
          />
        </>
      )}
    </Card>
  );
}
