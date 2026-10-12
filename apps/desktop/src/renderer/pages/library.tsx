import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Callout, Card, Empty, Icons, Input, Page, useToast } from '@fbrx/ui';
import { ARTICLES, CATS, type Article } from '../library-data';
import { LAB_HOWTOS, LAB_SECTIONS, supportPage } from '../lab-data';
import { bridge, call } from '../client';
import { navigate } from '../app';
import { useAgentName, useCore } from '../hooks';
import { LUKE_1_37, NOTHING_IS_IMPOSSIBLE, unlockTrophy } from '../fun';
import { STORIES, STORY_TRIGGER, type Story } from '../story-data';
import { addToMacros } from '../macro-add';
import { menuFor } from '../context-menu';
import { askAgent } from '../widgets';
import { FBRX_CLI_TRIGGER, FBRX_COMMAND_SETS, FBRX_HOWTOS, type FbrxCommand, type FbrxCommandSet } from '../fbrx-command-data';

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

const ROUTES: Record<string, string> = {
  files: 'files',
  network: 'network',
  security: 'security',
  storage: 'storage',
  updates: 'updates',
  agent: 'agent',
  mesh: 'mesh',
  settings: 'settings',
  bugs: 'bugs',
  backup: 'backup',
  speed: 'network/speed',
  printers: 'network/printers',
  fbrx1: 'terminal/fbrx1',
  consoles: 'terminal/console',
  server: 'server',
};

/** The Lab (Endpoint Ultra): power-user how-tos and official download pages. */
function TheLab({ agentName }: { agentName: string }) {
  const info = useCore('sysinfo.static');
  // Safety first: the dress code earns a badge.
  useEffect(() => unlockTrophy('goggles'), []);
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

/** Story time: how-tos nobody needed, each with a wink at a film or game. */
function StoryTime({ q, agentName }: { q: string; agentName: string }) {
  const [open, setOpen] = useState<Story | null>(null);
  const s = STORY_TRIGGER.test(q.trim()) ? '' : q.trim().toLowerCase();
  const list = STORIES.filter((x) => !s || `${x.t} ${x.s} ${x.steps.join(' ')} ${x.ref}`.toLowerCase().includes(s));
  return (
    <>
      <div className="lab-banner story-banner">
        <Icons.book size={34} />
        <div>
          <h2>Story time</h2>
          <div>Gather round. None of these will help you with your computer. Well, a few might. Each one is inspired by a film or game. No titles: can you guess them?</div>
        </div>
      </div>
      {open ? (
        <Card
          title={open.t}
          subtitle={open.s}
          actions={
            <Button size="sm" variant="ghost" icon="x" onClick={() => setOpen(null)}>
              Back
            </Button>
          }
        >
          <ol className="steps-list">
            {open.steps.map((st, i) => (
              <li key={i}>
                <Rich text={st} agentName={agentName} />
              </li>
            ))}
          </ol>
          <div className="story-ref">{open.ref}</div>
          {open.go && ROUTES[open.go] && (
            <div className="fx-actions" style={{ marginTop: 10 }}>
              <Button size="sm" icon="chevronRight" onClick={() => navigate(ROUTES[open.go!])}>
                Take me there
              </Button>
            </div>
          )}
        </Card>
      ) : list.length ? (
        <div className="lib-grid">
          {list.map((x) => (
            <button key={x.id} className="choice story-choice" onClick={() => setOpen(x)}>
              <span style={{ fontWeight: 600 }}>{x.t}</span>
              <span className="fx-muted" style={{ fontSize: 12.5 }}>
                {x.s}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <Empty title="No story like that">Try "tell me a story" again.</Empty>
      )}
    </>
  );
}

/** One command: FBRX/1 ones open in FBRX/1 already typed in; server ones are copied for a device console. */
function CommandRow({ c, set }: { c: FbrxCommand; set: FbrxCommandSet }) {
  const toast = useToast();
  const agentName = useAgentName();
  const copy = () => void navigator.clipboard.writeText(c.cmd).then(() => toast.success('Copied', set.kind === 'fbrx1' ? 'Paste it into FBRX/1.' : "Paste it into the server's console."));
  const macro = () => addToMacros({ name: c.what, text: c.cmd, slash: true });
  return (
    <div
      className="fbrx-cmd"
      onContextMenu={menuFor([
        ...(set.kind === 'fbrx1' ? [{ label: 'Try it in FBRX/1', icon: 'terminal' as const, onSelect: () => navigate(`terminal/fbrx1/${encodeURIComponent(c.cmd)}`) }] : []),
        { label: 'Copy', icon: 'copy', onSelect: copy },
        { label: 'Add to macros…', icon: 'zap', onSelect: macro },
        { label: `Ask ${agentName} to explain it`, icon: 'sparkles', onSelect: () => askAgent(`Explain the FBRX command "${c.cmd}" (${set.title}): what it does, when I would use it, and whether it changes anything.`) },
      ])}
    >
      <div className="fbrx-cmd-text">
        <code>{c.cmd}</code>
        <div className="fx-muted">
          {c.danger && <span className="fbrx-cmd-tag">changes something</span>}
          {c.what}
        </div>
      </div>
      <div className="fbrx-cmd-actions">
        {set.kind === 'fbrx1' ? (
          <Button size="sm" variant="ghost" icon="terminal" onClick={() => navigate(`terminal/fbrx1/${encodeURIComponent(c.cmd)}`)} title="Opens FBRX/1 with the command typed in; press Enter to run it">
            Try it
          </Button>
        ) : (
          <Button size="sm" variant="ghost" icon="copy" aria-label={`Copy ${c.cmd}`} onClick={copy} />
        )}
        <Button size="sm" variant="ghost" icon="zap" aria-label={`Add ${c.cmd} to macros`} title="Add to macros: a shortcut that types it" onClick={macro} />
      </div>
    </div>
  );
}

/** The FBRX command library: FBRX/1 on this computer, FBRX Server and FBRX Gate, and how-tos that use them. */
function FbrxCommands({ q, agentName }: { q: string; agentName: string }) {
  const s = FBRX_CLI_TRIGGER.test(q.trim()) ? '' : q.trim().toLowerCase();
  const [setId, setSetId] = useState(FBRX_COMMAND_SETS[0].id);
  const match = (text: string) => !s || text.toLowerCase().includes(s);
  const sets = FBRX_COMMAND_SETS.map((set) => ({ ...set, groups: set.groups.map((g) => ({ ...g, items: g.items.filter((c) => match(`${c.cmd} ${c.what} ${g.name} ${set.title}`)) })).filter((g) => g.items.length) })).filter((set) => set.groups.length);
  const howtos = FBRX_HOWTOS.filter((h) => match(`${h.t} ${h.s} ${h.steps.join(' ')}`));
  // While searching, every set with a hit shows; otherwise one at a time.
  const shown = s ? sets : sets.filter((set) => set.id === setId);
  return (
    <>
      <div className="lab-banner cli-banner">
        <Icons.terminal size={34} />
        <div>
          <h2>FBRX commands</h2>
          <div>The command lines of FBRX: FBRX/1 on this computer, and FBRX Server and FBRX Gate on your servers. Show, request, configure, commit. Your network gear would be proud.</div>
        </div>
      </div>
      {!s && (
        <div className="chips">
          {FBRX_COMMAND_SETS.map((set) => {
            const Ico = Icons[set.icon];
            return (
              <button key={set.id} className={`chip${set.id === setId ? ' on' : ''}`} onClick={() => setSetId(set.id)}>
                <Ico size={13} /> {set.title}
              </button>
            );
          })}
        </div>
      )}
      {shown.map((set) => (
        <div key={set.id} className="lab-section">
          {s && <h3>{set.title}</h3>}
          <div className="fx-muted lab-quip">{set.where}</div>
          <div className="lib-grid fbrx-cmd-grid">
            {set.groups.map((g) => (
              <Card key={g.name} title={g.name}>
                <div className="fbrx-cmds">
                  {g.items.map((c) => (
                    <CommandRow key={c.cmd} c={c} set={set} />
                  ))}
                </div>
              </Card>
            ))}
          </div>
          {set.kind === 'server' && (
            <div className="fx-actions" style={{ marginTop: 8 }}>
              <Button size="sm" icon="chevronRight" onClick={() => navigate('terminal/console')}>
                Open a device console
              </Button>
            </div>
          )}
        </div>
      ))}
      {howtos.length > 0 && (
        <div className="lab-section">
          <h3>How-tos</h3>
          <div className="lib-grid">
            {howtos.map((h) => (
              <Card key={h.id} title={<span><Icons.terminal size={14} /> {h.t}</span>} subtitle={h.s}>
                <ol className="steps-list">
                  {h.steps.map((st, i) => (
                    <li key={i}>
                      <Rich text={st} agentName={agentName} />
                    </li>
                  ))}
                </ol>
                {h.go && ROUTES[h.go] && (
                  <div className="fx-actions" style={{ marginTop: 8 }}>
                    <Button size="sm" icon="chevronRight" onClick={() => navigate(ROUTES[h.go!])}>
                      {h.go === 'fbrx1' ? 'Open FBRX/1' : h.go === 'consoles' ? 'Open Device consoles' : 'Open FBRX Server'}
                    </Button>
                  </div>
                )}
              </Card>
            ))}
          </div>
        </div>
      )}
      {!sets.length && !howtos.length && <Empty title="No FBRX command like that">Try other words, like "backup", "gate" or "commit".</Empty>}
    </>
  );
}

export function LibraryPage({ agentName, advanced, easterEggs }: { agentName: string; advanced: boolean; easterEggs: boolean }) {
  const [cat, setCat] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Article | null>(null);
  const trophies = useCore('fun.trophies', undefined, ['fun.trophy']);
  const storyAsked = easterEggs && STORY_TRIGGER.test(q.trim());
  const storiesFound = easterEggs && (!!trophies.data?.unlocked.stories || storyAsked);
  const verse = easterEggs && NOTHING_IS_IMPOSSIBLE.test(q);
  // Ultra: the FBRX command library. In Fun Mode it hides until someone talks to the search like a switch.
  const cliAsked = advanced && FBRX_CLI_TRIGGER.test(q.trim());
  const cliFound = advanced && (!easterEggs || !!trophies.data?.unlocked.operator || cliAsked);
  useEffect(() => {
    if (!storyAsked) return;
    unlockTrophy('stories');
    setOpen(null);
    setCat('stories');
  }, [storyAsked]);
  useEffect(() => {
    if (!cliAsked) return;
    if (easterEggs) unlockTrophy('operator');
    setOpen(null);
    setCat('fbrx-cli');
  }, [cliAsked, easterEggs]);
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
        {cliFound && (
          <button className={`chip cli-chip${cat === 'fbrx-cli' ? ' on' : ''}`} onClick={() => setCat('fbrx-cli')} title="FBRX/1, FBRX Server and FBRX Gate commands">
            <Icons.terminal size={13} /> FBRX commands
          </button>
        )}
        {storiesFound && (
          <button className={`chip story-chip${cat === 'stories' ? ' on' : ''}`} onClick={() => setCat('stories')} title="How-tos nobody needed">
            <Icons.book size={13} /> Story time
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
      {verse && <Callout tone="good">{LUKE_1_37}</Callout>}
      {cat === 'lab' && advanced && !q.trim() ? (
        <TheLab agentName={agentName} />
      ) : cat === 'fbrx-cli' && cliFound ? (
        <FbrxCommands q={q} agentName={agentName} />
      ) : cat === 'stories' && storiesFound ? (
        <StoryTime q={q} agentName={agentName} />
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
