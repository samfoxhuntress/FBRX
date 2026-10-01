import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Button, Card, Empty, Icons, Input, Page } from '@fbrx/ui';
import { ARTICLES, CATS, type Article } from '../library-data';
import { call } from '../client';
import { navigate } from '../app';

/** Renders article text, allowing only <kbd> and <code> (everything else stays literal text). */
function Rich({ text, agentName }: { text: string; agentName: string }) {
  const parts: ReactNode[] = [];
  const re = /<(kbd|code)>([^<]*)<\/\1>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const src = text.replace(/\bFabric\b/g, agentName);
  while ((m = re.exec(src))) {
    if (m.index > last) parts.push(src.slice(last, m.index));
    parts.push(m[1] === 'kbd' ? <kbd key={m.index} className="kbd">{m[2]}</kbd> : <code key={m.index}>{m[2]}</code>);
    last = m.index + m[0].length;
  }
  if (last < src.length) parts.push(src.slice(last));
  return <>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</>;
}

const ROUTES: Record<string, string> = { files: 'files', network: 'network', security: 'security', storage: 'storage', updates: 'updates', agent: 'agent', mesh: 'mesh', settings: 'settings' };

export function LibraryPage({ agentName }: { agentName: string }) {
  const [cat, setCat] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Article | null>(null);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return ARTICLES.filter((a) => (!cat || a.cat === cat) && (!s || `${a.t} ${a.s} ${a.steps.join(' ')}`.toLowerCase().includes(s)));
  }, [cat, q]);

  return (
    <Page title="Library" description={`Short how-tos for everyday computer tasks. Stuck? Ask ${agentName} to walk you through it.`} actions={<div style={{ width: 280 }}><Input placeholder="Search the library" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the library" /></div>}>
      <div className="chips">
        <button className={`chip${!cat ? ' on' : ''}`} onClick={() => setCat(null)}>
          All
        </button>
        {CATS.map((c) => {
          const Ico = Icons[c.icon];
          return (
            <button key={c.id} className={`chip${cat === c.id ? ' on' : ''}`} onClick={() => setCat(c.id)}>
              <Ico size={13} /> {c.name}
            </button>
          );
        })}
      </div>
      {open ? (
        <Card
          title={<Rich text={open.t} agentName={agentName} />}
          subtitle={<Rich text={open.s} agentName={agentName} />}
          actions={
            <Button size="sm" variant="ghost" icon="x" onClick={() => setOpen(null)}>
              Back
            </Button>
          }
        >
          <ol className="steps-list">
            {open.steps.map((s, i) => (
              <li key={i}>
                <Rich text={s} agentName={agentName} />
              </li>
            ))}
          </ol>
          <div className="fx-actions" style={{ marginTop: 12 }}>
            {open.open && (
              <Button icon="external" onClick={() => void call('spotlight.run', { item: { id: `lib:${open.id}`, kind: 'command', title: open.t, score: 0, action: { type: 'url', url: open.open! } } })}>
                Open the setting
              </Button>
            )}
            {open.go && ROUTES[open.go] && (
              <Button icon="chevronRight" onClick={() => navigate(ROUTES[open.go!])}>
                Open in FBRX
              </Button>
            )}
            <Button variant="primary" icon="sparkles" onClick={() => navigate(`agent/ask/${encodeURIComponent(open.ask ?? `Help me with this: ${open.t}. Walk me through it step by step on this computer.`)}`)}>
              Ask {agentName} to help
            </Button>
          </div>
        </Card>
      ) : list.length ? (
        <div className="lib-grid">
          {list.map((a) => (
            <button key={a.id} className="choice" onClick={() => setOpen(a)}>
              <span style={{ fontWeight: 600 }}>
                <Rich text={a.t} agentName={agentName} />
              </span>
              <span className="fx-muted" style={{ fontSize: 12.5 }}>
                <Rich text={a.s} agentName={agentName} />
              </span>
            </button>
          ))}
        </div>
      ) : (
        <Empty title="Nothing found">Try other words, or ask {agentName}.</Empty>
      )}
    </Page>
  );
}
