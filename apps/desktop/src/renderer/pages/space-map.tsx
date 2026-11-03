import { useMemo, useState } from 'react';
import { SPACE_KINDS, type SpaceDuplicates, type SpaceHog, type SpaceKind, type SpaceMap, type SpaceNode } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Input, Spinner, SERIES, formatBytes, timeAgo, useAction, useConfirm, useToast } from '@fbrx/ui';
import { bridge, call, pickFile } from '../client';
import { useCore } from '../hooks';
import { IS_WINDOWS } from '../app';
import { AskButton } from '../widgets';

/**
 * The space map: where the space in a folder goes, as a treemap colored by kind of file (click a folder to go into
 * it), the space hogs inside it with what to do about each, and the largest files with Show and Move to Trash. Endpoint
 * Ultra scans deeper, finds duplicate files and shows what grew since the folder was last mapped. Below it, the known
 * space hogs on the whole computer (caches, AI models, games, phone backups) with one-click clearing for caches.
 */

const KIND_LABEL: Record<SpaceKind, string> = {
  videos: 'Videos',
  pictures: 'Pictures',
  music: 'Music',
  documents: 'Documents',
  archives: 'Archives and disk images',
  apps: 'Apps, installers and models',
  code: 'Code',
  other: 'Other',
};
const kindColor = (k: SpaceKind) => SERIES[SPACE_KINDS.indexOf(k)];
const dominant = (n: SpaceNode): SpaceKind => SPACE_KINDS[n.kinds.reduce((best, b, i) => (b > n.kinds[best] ? i : best), 0)];

interface Tile {
  node: SpaceNode | null;
  label: string;
  size: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Squarified treemap: rows laid along the shorter side, each kept as square as it can be. */
function squarify(items: Array<{ node: SpaceNode | null; label: string; size: number }>, x: number, y: number, w: number, h: number): Tile[] {
  const total = items.reduce((a, i) => a + i.size, 0);
  if (!total || w <= 0 || h <= 0) return [];
  const scale = (w * h) / total;
  let rest = items.filter((i) => i.size > 0).map((i) => ({ ...i, area: i.size * scale }));
  const out: Tile[] = [];
  while (rest.length) {
    const side = Math.min(w, h);
    const worst = (row: typeof rest) => {
      const s = row.reduce((a, r) => a + r.area, 0);
      return Math.max(...row.map((r) => Math.max((side * side * r.area) / (s * s), (s * s) / (side * side * r.area))));
    };
    let n = 1;
    while (n < rest.length && worst(rest.slice(0, n + 1)) <= worst(rest.slice(0, n))) n++;
    const row = rest.slice(0, n);
    const thick = row.reduce((a, r) => a + r.area, 0) / side;
    let off = 0;
    for (const r of row) {
      const len = r.area / thick;
      out.push(w >= h ? { node: r.node, label: r.label, size: r.size, x, y: y + off, w: thick, h: len } : { node: r.node, label: r.label, size: r.size, x: x + off, y, w: len, h: thick });
      off += len;
    }
    if (w >= h) {
      x += thick;
      w -= thick;
    } else {
      y += thick;
      h -= thick;
    }
    rest = rest.slice(n);
  }
  return out;
}

const W = 1000;
const H = 420;

function Treemap({ node, onOpen }: { node: SpaceNode; onOpen: (n: SpaceNode) => void }) {
  const tiles = useMemo(
    () =>
      squarify(
        [...(node.children ?? []).map((c) => ({ node: c, label: c.name, size: c.size })), ...(node.rest ? [{ node: null, label: 'Smaller files and folders', size: node.rest }] : [])].sort((a, b) => b.size - a.size),
        0,
        0,
        W,
        H,
      ),
    [node],
  );
  return (
    <svg className="space-map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Space map of ${node.name}`}>
      {tiles.map((t) => {
        const color = t.node ? kindColor(dominant(t.node)) : 'var(--text-muted)';
        const opens = !!t.node?.dir && !!t.node.children?.length;
        return (
          <g key={t.node?.path ?? 'rest'} className={opens ? 'opens' : undefined} onClick={() => opens && onOpen(t.node!)}>
            <title>{`${t.label}: ${formatBytes(t.size)}${opens ? ' (click to go in)' : ''}`}</title>
            <rect x={t.x + 1} y={t.y + 1} width={Math.max(0, t.w - 2)} height={Math.max(0, t.h - 2)} rx={4} style={{ fill: `color-mix(in srgb, ${color} ${t.node ? 34 : 14}%, var(--surface-1))`, stroke: color }} />
            {t.w > 74 && t.h > 34 && (
              <text x={t.x + 9} y={t.y + 21} className="space-map-label">
                <tspan>{t.label.length > t.w / 8 ? `${t.label.slice(0, Math.max(3, Math.floor(t.w / 8) - 1))}…` : t.label}</tspan>
                {t.h > 52 && (
                  <tspan x={t.x + 9} dy={17} className="space-map-size">
                    {formatBytes(t.size)}
                  </tspan>
                )}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** One row of a list: a name, its path, its size and what can be done. */
function Row({ title, sub, size, children }: { title: string; sub?: string; size: number; children?: React.ReactNode }) {
  return (
    <div className="fx-list-item">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="fx-cell-title">{title}</div>
        {sub && (
          <div className="fx-cell-sub mono" title={sub} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {sub}
          </div>
        )}
      </div>
      <strong>{formatBytes(size)}</strong>
      {children}
    </div>
  );
}

export function SpaceMapCard() {
  const home = useCore('files.home');
  const [path, setPath] = useState('');
  const [map, setMap] = useState<SpaceMap | null>(null);
  const [trail, setTrail] = useState<SpaceNode[]>([]);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [dupes, setDupes] = useState<SpaceDuplicates | null>(null);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const toast = useToast();

  const scan = async (p: string) => {
    setPath(p);
    setDupes(null);
    const r = await run('map', () => call('storage.space', { path: p }));
    if (r) {
      setMap(r);
      setTrail([r.tree]);
      setGone(new Set());
    }
  };
  const trash = async (paths: string[], what: string) => {
    if (!(await confirm({ title: `Move ${what} to the Trash?`, body: 'You can put it back from the Trash (Recycle Bin) until it is emptied.', confirmLabel: 'Move to Trash' }))) return;
    const r = await run('trash', () => call('files.trash', { paths }));
    if (!r) return;
    setGone((g) => new Set([...g, ...paths.filter((p) => !r.failed.includes(p))]));
    if (r.failed.length) toast.error(`${r.failed.length} could not be moved`, 'It may be open in another app, or protected.');
    else toast.success('Moved to the Trash');
  };
  const remove = async (h: SpaceHog) => {
    if (!(await confirm({ title: `Delete this ${h.label}?`, body: `${h.what} ${formatBytes(h.size)} is freed right away (it does not go to the Trash).`, confirmLabel: 'Delete', danger: true }))) return;
    const r = await run(`hog:${h.path}`, () => call('storage.clearHog', { id: h.id, path: h.path }));
    if (r) {
      setGone((g) => new Set([...g, h.path]));
      toast.success(`Freed ${formatBytes(r.freed)}`);
    }
  };
  const show = (p: string) => void (bridge.reveal ? bridge.reveal(p) : call('files.open', { path: p }));
  const here = trail[trail.length - 1];
  const whole = IS_WINDOWS ? 'C:\\' : bridge.platform === 'linux' ? '/' : null;

  return (
    <Card title="Space map" subtitle="Where the space goes: click a folder to go into it, and act on what you find">
      <div className="fx-actions" style={{ marginBottom: 12 }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <Input className="mono" placeholder="Folder to map" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void scan(path)} />
        </div>
        <Button
          icon="folder"
          onClick={async () => {
            const p = await pickFile({ kind: 'folder', title: 'Folder to map' });
            if (p) void scan(p);
          }}
        >
          Choose…
        </Button>
        {whole && (
          <Button size="sm" onClick={() => void scan(whole)}>
            Whole drive
          </Button>
        )}
        {(home.data?.places ?? []).slice(0, 4).map((p) => (
          <Button key={p.path} size="sm" onClick={() => void scan(p.path)}>
            {p.name}
          </Button>
        ))}
        <Button variant="primary" loading={busy === 'map'} disabled={!path} onClick={() => void scan(path)}>
          Map
        </Button>
      </div>
      {busy === 'map' && (
        <div className="fx-muted" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Spinner /> Mapping… a whole drive takes a minute or two.
        </div>
      )}
      {map && busy !== 'map' && here && (
        <div className="fx-grid" style={{ gap: 14 }}>
          <div className="space-head">
            <div className="space-trail" aria-label="Where you are">
              {trail.map((n, i) => (
                <button key={n.path} className={i === trail.length - 1 ? 'on' : ''} onClick={() => setTrail(trail.slice(0, i + 1))}>
                  {n.name}
                </button>
              ))}
            </div>
            <span className="fx-muted">
              {formatBytes(here.size)} in {here.files.toLocaleString()} files{map.partial ? ' · stopped early (very large)' : ''}
            </span>
            <AskButton
              label="What can I clean up?"
              prompt={`This is what is using space in ${here.path} on my computer. Tell me what the big folders and files are, which are safe to delete or move, and which to keep. Do not delete anything without asking.`}
              context={{ total: formatBytes(here.size), folders: (here.children ?? []).slice(0, 20).map((c) => ({ name: c.name, size: formatBytes(c.size), folder: c.dir })), largest: map.largest.slice(0, 15).map((f) => ({ path: f.path, size: formatBytes(f.size) })), found: map.found.slice(0, 10).map((h) => ({ what: h.label, path: h.path, size: formatBytes(h.size) })) }}
            />
          </div>
          <Treemap node={here} onOpen={(n) => setTrail([...trail, n])} />
          <div className="space-kinds" aria-label="Space by kind of file">
            <div className="space-kinds-bar">
              {map.kinds.map((k) => (
                <span key={k.kind} style={{ flex: k.size, background: kindColor(k.kind) }} title={`${KIND_LABEL[k.kind]}: ${formatBytes(k.size)}`} />
              ))}
            </div>
            <div className="space-legend">
              {map.kinds
                .slice()
                .sort((a, b) => b.size - a.size)
                .map((k) => (
                  <span key={k.kind}>
                    <i style={{ background: kindColor(k.kind) }} />
                    {KIND_LABEL[k.kind]} <b>{formatBytes(k.size)}</b>
                  </span>
                ))}
            </div>
          </div>

          {map.changes && map.changes.length > 0 && (
            <div>
              <div className="fx-label">Since you last mapped it ({timeAgo(map.since)})</div>
              <div className="fx-list">
                {map.changes.map((c) => (
                  <Row key={c.path} title={`${c.name} ${c.after > c.before ? 'grew' : 'shrank'} by ${formatBytes(Math.abs(c.after - c.before))}`} sub={c.path} size={c.after} />
                ))}
              </div>
            </div>
          )}

          {map.found.filter((h) => !gone.has(h.path)).length > 0 && (
            <div>
              <div className="fx-label">Space hogs in here</div>
              <div className="fx-list">
                {map.found
                  .filter((h) => !gone.has(h.path))
                  .map((h) => (
                    <Row key={h.path} title={h.label} sub={h.path} size={h.size}>
                      <Button size="sm" variant="ghost" icon="folder" aria-label="Show in folder" title={h.what} onClick={() => show(h.path)} />
                      {h.action === 'remove' && (
                        <Button size="sm" variant="danger" loading={busy === `hog:${h.path}`} title={h.what} onClick={() => void remove(h)}>
                          Delete
                        </Button>
                      )}
                    </Row>
                  ))}
              </div>
            </div>
          )}

          <div>
            <div className="fx-label">
              Largest files{map.old.files ? ` · ${formatBytes(map.old.size)} in ${map.old.files.toLocaleString()} files not changed for two years` : ''}
            </div>
            <div className="fx-list" style={{ maxHeight: 380, overflow: 'auto' }}>
              {map.largest
                .filter((f) => !gone.has(f.path))
                .map((f) => (
                  <Row key={f.path} title={f.path.split(/[\\/]/).pop() ?? f.path} sub={`${f.path} · changed ${timeAgo(f.modified)}`} size={f.size}>
                    <Button size="sm" variant="ghost" icon="folder" aria-label="Show in folder" onClick={() => show(f.path)} />
                    <Button size="sm" variant="ghost" icon="trash" aria-label="Move to Trash" title="Move to Trash" onClick={() => void trash([f.path], 'this file')} />
                  </Row>
                ))}
            </div>
          </div>

          {map.ultra ? (
            <div>
              <div className="fx-actions" style={{ alignItems: 'center' }}>
                <div className="fx-label" style={{ flex: 1, margin: 0 }}>
                  Duplicate files{dupes ? `: ${formatBytes(dupes.wasted)} to free${dupes.partial ? ' (stopped early)' : ''}` : ''}
                </div>
                <Button size="sm" loading={busy === 'dupes'} onClick={async () => setDupes((await run('dupes', () => call('storage.duplicates', { path: map.path }))) ?? null)}>
                  {dupes ? 'Look again' : 'Find duplicates'}
                </Button>
              </div>
              {dupes &&
                (dupes.groups.length ? (
                  <div className="fx-list" style={{ maxHeight: 380, overflow: 'auto' }}>
                    {dupes.groups.map((g) => {
                      const extra = g.paths.slice(1).filter((p) => !gone.has(p));
                      return (
                        <Row key={g.paths[0]} title={`${g.paths.length} copies of ${g.paths[0].split(/[\\/]/).pop()}`} sub={g.paths.join('  ·  ')} size={g.size * extra.length}>
                          <Button size="sm" variant="ghost" icon="folder" aria-label="Show the first copy" onClick={() => show(g.paths[0])} />
                          {extra.length > 0 && (
                            <Button size="sm" variant="ghost" icon="trash" title="Keeps the first copy and moves the others to the Trash" onClick={() => void trash(extra, `${extra.length} extra cop${extra.length === 1 ? 'y' : 'ies'}`)}>
                              Keep one
                            </Button>
                          )}
                        </Row>
                      );
                    })}
                  </div>
                ) : (
                  <Empty title="No duplicates">No two files of 1 MB or more have the same contents here.</Empty>
                ))}
            </div>
          ) : (
            <Callout tone="info">Endpoint Ultra maps whole drives in depth, finds duplicate files and shows what grew since you last looked.</Callout>
          )}
        </div>
      )}
      {dialog}
    </Card>
  );
}

/** The known space hogs on the whole computer: caches that come back by themselves, and libraries to look through. */
export function SpaceHogsCard() {
  const [hogs, setHogs] = useState<SpaceHog[] | null>(null);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const toast = useToast();
  const look = async () => setHogs((await run('look', () => call('storage.hogs'))) ?? null);
  const clear = async (h: SpaceHog) => {
    if (!(await confirm({ title: `Clear the ${h.label}?`, body: `${h.what} About ${formatBytes(h.size)} is freed.`, confirmLabel: 'Clear' }))) return;
    const r = await run(`clear:${h.id}`, () => call('storage.clearHog', { id: h.id }));
    if (r) {
      toast.success(`Freed ${formatBytes(r.freed)}`, r.skipped ? `${r.skipped} item(s) in use were left` : undefined);
      void look();
    }
  };
  return (
    <Card
      title="Space hogs on this computer"
      subtitle="Caches, AI models, games and backups that grow quietly"
      actions={
        <Button size="sm" loading={busy === 'look'} onClick={() => void look()}>
          {hogs ? 'Look again' : 'Look'}
        </Button>
      }
    >
      {!hogs ? (
        <span className="fx-muted">Checks the usual places: npm, pip and Gradle caches, browser caches, Xcode, Docker, Ollama and LM Studio models, Steam, phone backups and temporary files.</span>
      ) : !hogs.length ? (
        <Empty title="Nothing big">None of the usual places holds more than 50 MB.</Empty>
      ) : (
        <div className="fx-list">
          {hogs.map((h) => (
            <Row key={h.path} title={h.label} sub={h.path} size={h.size}>
              <Button size="sm" variant="ghost" icon="info" aria-label="What is it?" title={h.what} onClick={() => toast.info(h.label, h.what)} />
              <Button size="sm" variant="ghost" icon="folder" aria-label="Show in folder" onClick={() => void (bridge.reveal ? bridge.reveal(h.path) : call('files.open', { path: h.path }))} />
              {h.action === 'clear' && (
                <Button size="sm" variant="primary" loading={busy === `clear:${h.id}`} onClick={() => void clear(h)}>
                  Clear
                </Button>
              )}
            </Row>
          ))}
        </div>
      )}
      {dialog}
    </Card>
  );
}
