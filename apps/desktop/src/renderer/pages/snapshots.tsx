import { useEffect, useState } from 'react';
import { SNAPSHOT_DELAYS, SNAPSHOT_MODES, SNAPSHOT_MODE_NAMES, type ScreenSnapshot, type SnapshotAfter, type SnapshotMode } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, Icons, Page, Select, Toggle, timeAgo, useAction, type IconName } from '@fbrx/ui';
import { bridge, call, pickFile } from '../client';
import { isLocked, useAgentName, useCore } from '../hooks';
import { navigate, routeArg } from '../app';
import { KeyRecorder } from './settings-macros';
import { SnapshotEditor } from './snapshot-editor';

const MODE_ICON: Record<SnapshotMode, IconName> = { region: 'crop', window: 'appWindow', screen: 'monitor' };
const AFTER_NAMES: Record<SnapshotAfter, string> = { editor: 'Open it to mark it up', notify: 'Only say it was taken' };

/** Thumbnails of snapshots already seen, by file and time. */
const thumbs = new Map<string, string>();

function Thumb({ shot }: { shot: ScreenSnapshot }) {
  const key = `${shot.id}@${shot.createdAt}`;
  const [src, setSrc] = useState(thumbs.get(key) ?? null);
  useEffect(() => {
    if (src) return;
    void call('snapshots.read', { id: shot.id, size: 480 })
      .then((p) => {
        const url = `data:${p.mime};base64,${p.data}`;
        thumbs.set(key, url);
        setSrc(url);
      })
      .catch(() => undefined);
  }, [key, src, shot.id]);
  return src ? <img src={src} alt="" loading="lazy" /> : <Icons.image size={22} />;
}

function useRouteArg(): string | null {
  const [arg, setArg] = useState(routeArg());
  useEffect(() => {
    const onHash = () => setArg(routeArg());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return arg;
}

/** FBRX Snapshot: take a picture of the screen, the ones taken so far, and how it works. */
export function SnapshotsPage() {
  const arg = useRouteArg();
  if (arg) return <SnapshotEditor id={decodeURIComponent(arg)} />;
  return <SnapshotGallery />;
}

function SnapshotGallery() {
  const agentName = useAgentName();
  const shots = useCore('snapshots.list', undefined, ['snapshots.changed']);
  const s = useCore('settings.get', undefined, ['settings.changed']);
  const folder = useCore('snapshots.folder', undefined, ['settings.changed']).data?.path;
  const [delay, setDelay] = useState(0);
  const { run } = useAction();
  const snap = s.data?.settings.snapshot;
  const locked = (path: string) => isLocked(s.data?.locked, `snapshot.${path}`);
  const update = (patch: Partial<NonNullable<typeof snap>>, msg?: string) => run('set', () => call('settings.update', { patch: { snapshot: patch } }), msg);
  const take = (mode: SnapshotMode) => void bridge.snap?.('start', { mode, delay });
  const hotkey = snap?.hotkey.replace('Control', 'Ctrl');
  return (
    <Page
      title="Snapshot"
      description={`A picture of the screen: an area, one window or all of it. Mark it up, then copy it, save it or ask ${agentName} about it.${hotkey ? ` From any app: ${hotkey}.` : ''}`}
      actions={
        bridge.snap && (
          <>
            <Select aria-label="Wait before taking it" style={{ width: 150 }} value={String(delay)} options={SNAPSHOT_DELAYS.map((d) => ({ value: String(d), label: d ? `In ${d} seconds` : 'Right away' }))} onChange={(e) => setDelay(Number(e.target.value))} />
            {SNAPSHOT_MODES.map((m) => (
              <Button key={m} variant={m === 'region' ? 'primary' : undefined} icon={MODE_ICON[m]} onClick={() => take(m)}>
                {SNAPSHOT_MODE_NAMES[m]}
              </Button>
            ))}
          </>
        )
      }
    >
      {!bridge.snap && <Callout tone="info">Snapshots are taken in the FBRX desktop app.</Callout>}
      {shots.error && <Callout tone="warning">{shots.error}</Callout>}
      <Card title="Recent" subtitle={shots.data?.length ? 'Click one to mark it up, copy it or ask about it.' : undefined}>
        {!shots.data?.length ? (
          <Empty title="No snapshots yet">Take one with the buttons above{hotkey ? ` or ${hotkey} from any app` : ''}. They are saved in your Pictures folder.</Empty>
        ) : (
          <div className="snap-grid">
            {shots.data.map((shot) => (
              <button key={shot.id} className="snap-card" onClick={() => navigate(`snapshots/${encodeURIComponent(shot.id)}`)}>
                <span className="snap-thumb">
                  <Thumb shot={shot} />
                </span>
                <span className="snap-card-name">{timeAgo(shot.createdAt)}</span>
              </button>
            ))}
          </div>
        )}
      </Card>
      {snap && (
        <Card title="Settings">
          <div className="fx-form">
            <Field label="Shortcut" help="Starts a snapshot from any app.">
              <KeyRecorder value={snap.hotkey} allowOff disabled={locked('hotkey')} onChange={(next) => void update({ hotkey: next }, next ? `Shortcut set to ${next.replace('Control', 'Ctrl')}` : 'Shortcut off')} />
            </Field>
            <Toggle checked={snap.printScreen} disabled={locked('printScreen')} onChange={(printScreen) => void update({ printScreen })} label="The Print Screen key takes a snapshot too" />
            <Toggle checked={snap.copy} disabled={locked('copy')} onChange={(copy) => void update({ copy })} label="Copy each snapshot, ready to paste" />
            <Field label="After taking one">
              <Select value={snap.after} disabled={locked('after')} options={(Object.keys(AFTER_NAMES) as SnapshotAfter[]).map((a) => ({ value: a, label: AFTER_NAMES[a] }))} onChange={(e) => void update({ after: e.target.value as SnapshotAfter })} />
            </Field>
            <Field label="Saved in">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <code style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }} title={folder}>
                  {folder ?? snap.folder}
                </code>
                {folder && bridge.reveal && shots.data?.length ? (
                  <Button size="sm" variant="ghost" icon="folder" onClick={() => void bridge.reveal!(shots.data![0].path)}>
                    Show
                  </Button>
                ) : null}
                {bridge.dialog && (
                  <Button
                    size="sm"
                    disabled={locked('folder')}
                    onClick={async () => {
                      const folder = await pickFile({ kind: 'folder', title: 'Where to save snapshots' });
                      if (folder) void update({ folder }, 'Snapshots are saved there from now on');
                    }}
                  >
                    Change…
                  </Button>
                )}
              </div>
            </Field>
          </div>
        </Card>
      )}
    </Page>
  );
}
