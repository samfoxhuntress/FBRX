import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Button, Card, Empty, Icons, Input, Page } from '@fbrx/ui';
import { ARTICLES, CATS, type Article } from '../library-data';
import { LAB_HOWTOS, LAB_SECTIONS, supportPage } from '../lab-data';
import { bridge, call } from '../client';
import { navigate } from '../app';
import { useCore } from '../hooks';

/** Renders article text, allowing only <kbd> and <code> (everything else stays literal text). */
function Rich({ text, agentName }: { text: string; agentName: string }) {
  const parts: ReactNode[] = [];
  const re = /<(kbd|code)>([^<]*)<\/\1>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const src = text.replace(/\bFabrix\b/g, agentName);
  while ((m = re.exec(src))) {
    if (m.index > last) parts.push(src.slice(last, m.index));
    parts.push(m[1] === 'kbd' ? <kbd key={m.index} className="kbd">{m[2]}</kbd> : <code key={m.index}>{m[2]}</code>);
    last = m.index + m[0].length;
  }
  if (last < src.length) parts.push(src.slice(last));
  return <>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</>;
}

const ROUTES: Record<string, string> = { files: 'files', network: 'network', security: 'security', storage: 'storage', updates: 'updates', agent: 'agent', mesh: 'mesh', settings: 'settings' };

/** The Lab (Advanced mode): power-user how-tos and official download pages. */
function TheLab({ agentName }: { agentName: string }) {
  const info = useCore('sysinfo.static');
  const support = info.data ? supportPage(info.data.machine.manufacturer, info.data.machine.model) : null;
  return (
    <>
      <div className="lab-banner">
        <Icons.goggles size={34} />
        <div>
          <h2>The Lab</h2>
          <div>Advanced how-tos for people who read error messages for fun. Safety goggles recommended (sold separately).</div>
        </div>
      </div>
      <div className="lib-grid">
        {LAB_HOWTOS.map((h) => (
          <Card key={h.t} title={<span><Icons.flask size={14} /> {h.t}</span>}>
            <ol className="steps-list">
              {h.steps.map((st, i) => (
                <li key={i}>
                  <Rich text={st} agentName={agentName} />
                </li>
              ))}
            </ol>
            {(h.go || h.ask) && (
              <div className="fx-actions" style={{ marginTop: 8 }}>
                {h.go && ROUTES[h.go] && (
                  <Button size="sm" icon="chevronRight" onClick={() => navigate(ROUTES[h.go!])}>
                    Open in FBRX
                  </Button>
                )}
                {h.ask && (
                  <Button size="sm" className="ask-btn" icon="sparkles" onClick={() => navigate(`agent/ask/${encodeURIComponent(h.ask!)}`)}>
                    Ask {agentName}
                  </Button>
                )}
              </div>
            )}
          </Card>
        ))}
      </div>
      {LAB_SECTIONS.map((sec) => (
        <div key={sec.sec} className="lab-section">
          <h3>{sec.sec}</h3>
          <div className="fx-muted lab-quip">{sec.quip}</div>
          <div className="lib-grid">
            {[...sec.items, ...(sec.sec.startsWith('Diagnostics') && support ? [[support.label, support.url, 'Your computer\'s own drivers and BIOS. Plug in the charger before updating a BIOS.'] as [string, string, string]] : [])].map(([t, url, note]) => (
              <button key={url} className="choice" onClick={() => bridge.openExternal?.(url)}>
                <span style={{ fontWeight: 600, display: 'flex', gap: 6, alignItems: 'center' }}>
                  {t} <Icons.external size={12} />
                </span>
                <span className="fx-muted" style={{ fontSize: 12.5 }}>
                  <Rich text={note} agentName={agentName} />
                </span>
                <span className="mono fx-muted" style={{ fontSize: 10.5 }}>
                  {url.replace(/^https?:\/\//, '').slice(0, 60)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="fx-muted" style={{ fontSize: 12.5 }}>
        <Icons.shield size={13} /> The Lab links only to official vendor and project pages. Check checksums when a project publishes them, and never download Windows from mirrors or "activators".
      </div>
    </>
  );
}

export function LibraryPage({ agentName, advanced }: { agentName: string; advanced: boolean }) {
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
        {advanced && (
          <button className={`chip lab-chip${cat === 'lab' ? ' on' : ''}`} onClick={() => setCat('lab')} title="Advanced how-tos and official downloads">
            <Icons.flask size={13} /> The Lab
          </button>
        )}
        {CATS.map((c) => {
          const Ico = Icons[c.icon];
          return (
            <button key={c.id} className={`chip${cat === c.id ? ' on' : ''}`} onClick={() => setCat(c.id)}>
              <Ico size={13} /> {c.name}
            </button>
          );
        })}
      </div>
      {cat === 'lab' && advanced && !q.trim() ? (
        <TheLab agentName={agentName} />
      ) : open ? (
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
