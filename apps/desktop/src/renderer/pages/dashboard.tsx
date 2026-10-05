import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SystemLive, SystemStatus } from '@fbrx/shared';
import { TIER_NAMES, TROPHIES, displayVersion } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Grid, Icons, KeyValue, LineChart, Meter, StatTile, Status, formatBytes, formatDuration, timeAgo, useAction, type IconName } from '@fbrx/ui';
import { call, onEvent } from '../client';
import { useCore } from '../hooks';
import { navigate } from '../app';
import { dashboardQuip, unlockTrophy } from '../fun';
import { AskButton, NamePrompt } from '../widgets';
import { SplitFlapBoard } from '../splitflap';
import { useLearner, useTier, useVertical } from '../edition';

function serviceTone(state: string) {
  return state === 'running' ? 'good' : state === 'failed' ? 'critical' : state === 'degraded' ? 'warning' : 'neutral';
}

/** Live metrics: history from the core plus pushed samples. */
export function useLive(): SystemLive[] {
  const [points, setPoints] = useState<SystemLive[]>([]);
  useEffect(() => {
    let alive = true;
    void call('sysinfo.live').then((r) => alive && setPoints(r.history));
    const off = onEvent('sysinfo.live', (p) => setPoints((prev) => [...prev.slice(-179), p]));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return points;
}

const rate = (b: number) => `${formatBytes(b)}/s`;

/** On student computers (FBRX OS Education). */
const LEARNER_TIPS = [
  'Ask Fabrix to explain something from class in simpler words, or to quiz you on it.',
  'Stuck with the computer? Get help sends a message to the IT team.',
  'Make a to-do list for your homework in Tasks.',
  'Notes keeps your ideas in one place.',
];

/** On a child's computer (FBRX OS Home). */
const HOME_LEARNER_TIPS = [
  'Ask Fabrix to explain something in simpler words, or to quiz you on it.',
  'Need a hand with the computer? Get help sends a message to a parent.',
  'Make a list of your chores or homework in Tasks.',
  'Notes keeps your ideas and stories in one place.',
];

const ULTRA_TIPS = [
  'Terminal → FBRX/1 manages FBRX like a switch: try "show system status".',
  'Library → The Lab has power-user how-tos. Goggles recommended.',
];
const ALL_TIPS = [
  'Press Ctrl+K anywhere for Spotlight: apps, files, settings and quick answers.',
  'Press Ctrl+Alt+Z for your clipboard history: W and S move, type to search, Enter pastes.',
  'The big red Emergency stop in Settings → Agent halts every AI action at once.',
  'Network Center → Speed is a real speedometer. Patience is rewarded. Impatience more so.',
  'Snippets save commands you reuse; the Terminal lists them on the right.',
  'Backups are encrypted .fbrxsnap files: restore one on a new PC and carry on.',
  'Ask Fabrix "is this good?" next to most results to get them explained.',
];

/** A score out of 100 from what usually needs attention, with the reasons that cost points. */
function healthScore(o: { status: SystemStatus; critical: number; unread: number; memPct: number; fullestDiskPct: number; aiReady: boolean }) {
  const reasons: string[] = [];
  let score = 100;
  const hit = (n: number, why: string) => {
    score -= n;
    reasons.push(why);
  };
  const failing = o.status.services.filter((s) => s.state === 'failed').length;
  if (failing) hit(Math.min(30, failing * 15), `${failing} service${failing > 1 ? 's' : ''} failing`);
  // Locked on purpose (password at start, or by hand) is not a problem.
  if (o.status.vault.state === 'locked' && o.status.vault.lockReason !== 'password' && o.status.vault.lockReason !== 'manual') hit(15, 'vault locked');
  if (o.critical) hit(Math.min(25, o.critical * 10), `${o.critical} critical alert${o.critical > 1 ? 's' : ''}`);
  if (o.fullestDiskPct > 95) hit(15, 'a drive is almost full');
  else if (o.fullestDiskPct > 88) hit(7, 'a drive is getting full');
  if (o.memPct > 92) hit(8, 'memory is tight');
  if (!o.status.stats.lastBackupAt || Date.now() - Date.parse(o.status.stats.lastBackupAt) > 14 * 86400_000) hit(8, 'no recent backup');
  if (o.status.aiHalt) hit(5, 'AI on emergency stop');
  else if (!o.aiReady) hit(4, 'no AI model ready');
  if (o.status.pendingApprovals) hit(3, 'approvals waiting');
  score = Math.max(0, Math.round(score));
  return { score, label: score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 55 ? 'Needs a look' : 'Needs attention', reasons };
}

function HealthRing({ score, label }: { score: number; label: string }) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const tone = score >= 90 ? 'var(--good)' : score >= 75 ? 'var(--accent)' : score >= 55 ? 'var(--warning)' : 'var(--critical)';
  return (
    <div className="glass-ring" title={`Health ${score} of 100`}>
      <svg viewBox="0 0 120 120" width="120" height="120" aria-hidden>
        <circle cx="60" cy="60" r={r} fill="none" stroke="currentColor" strokeOpacity="0.12" strokeWidth="10" />
        <circle cx="60" cy="60" r={r} fill="none" stroke={tone} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${(c * score) / 100} ${c}`} transform="rotate(-90 60 60)" style={{ transition: 'stroke-dasharray 0.8s ease' }} />
      </svg>
      <div className="glass-ring-text">
        <b>{score}</b>
        <span>{label}</span>
      </div>
    </div>
  );
}

/** A glass tile with an icon, a headline and a line under it. */
function Insight({ icon, title, value, foot, onClick, className, children }: { icon: IconName; title: string; value: ReactNode; foot?: ReactNode; onClick?: () => void; className?: string; children?: ReactNode }) {
  const Ico = Icons[icon];
  return (
    <div className={`glass-tile${onClick ? ' clickable' : ''}${className ? ` ${className}` : ''}`} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined} onKeyDown={(e) => onClick && (e.key === 'Enter' || e.key === ' ') && onClick()}>
      <div className="glass-tile-head">
        <Ico size={15} />
        {title}
      </div>
      <div className="glass-tile-value">{value}</div>
      {foot && <div className="glass-tile-foot">{foot}</div>}
      {children}
    </div>
  );
}

/**
 * The tip tile is not screwed on properly. It rattles when clicked; on the sixth click it swings off its last screw
 * and falls, showing what was behind it. "Screw it back on" puts it back.
 */
function LooseTip({ fun }: { fun: boolean }) {
  const learner = useLearner();
  const tier = useTier();
  const vertical = useVertical();
  const TIPS = learner ? (vertical === 'home' ? HOME_LEARNER_TIPS : LEARNER_TIPS) : tier === 'ultra' ? [...ALL_TIPS, ...ULTRA_TIPS] : ALL_TIPS;
  const [tip, setTip] = useState(() => Math.floor(Math.random() * TIPS.length));
  const [clicks, setClicks] = useState(0);
  const [rattle, setRattle] = useState(0);
  const [state, setState] = useState<'on' | 'falling' | 'off'>('on');
  useEffect(() => {
    const t = setInterval(() => setTip((i) => (i + 1) % TIPS.length), 12_000);
    return () => clearInterval(t);
  }, []);
  const click = () => {
    if (!fun) {
      setTip((i) => (i + 1) % TIPS.length);
      return;
    }
    const n = clicks + 1;
    setClicks(n);
    setRattle((r) => r + 1);
    if (n > 5) {
      setState('falling');
      unlockTrophy('loose');
      setTimeout(() => setState('off'), 1900);
    }
  };
  const remark = ['', 'Hm. That rattled.', 'It\'s a little loose.', 'Definitely loose.', 'Someone should tighten that.', 'Please stop. It\'s hanging by one screw.'][Math.min(clicks, 5)];
  return (
    <div className="loose-slot">
      {state !== 'on' && (
        <div className={`loose-behind${state === 'off' ? ' settled' : ''}`}>
          <div className="loose-stripes" aria-hidden />
          <div className="loose-found">
            <b>Behind the panel you find:</b>
            <span>a lost sock (so that's where it went), a shiny coin, and a note in goose handwriting: “Honk. Someone should tighten these.”</span>
          </div>
          {state === 'off' && (
            <Button
              size="sm"
              icon="wrench"
              onClick={() => {
                setClicks(0);
                setState('on');
              }}
            >
              Screw it back on
            </Button>
          )}
        </div>
      )}
      {state !== 'off' && (
        <div key={rattle} className={`glass-tile loose-tile${fun ? ' wobbly' : ''}${rattle ? ' rattle' : ''}${state === 'falling' ? ' falling' : ''}`} onClick={click} role="button" tabIndex={0} title={fun ? 'This panel seems a little loose' : 'Next tip'} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && click()}>
          {fun && (
            <>
              <span className="screw s-tl" aria-hidden />
              <span className="screw s-tr" aria-hidden />
              <span className="screw s-bl" aria-hidden />
              <span className={`screw s-br loose${clicks > 2 ? ' looser' : ''}`} aria-hidden />
            </>
          )}
          <div className="glass-tile-head">
            <Icons.info size={15} />
            Tip
          </div>
          <div className="glass-tile-tip">{TIPS[tip % TIPS.length]}</div>
          {fun && clicks > 0 && <div className="glass-tile-foot">{remark}</div>}
        </div>
      )}
    </div>
  );
}

export function DashboardPage({ status, agentName, easterEggs, who }: { status: SystemStatus; agentName: string; easterEggs: boolean; who: string | null }) {
  const { run, busy } = useAction();
  const live = useLive();
  const cur = live[live.length - 1];
  const info = useCore('sysinfo.static');
  const tasks = useCore('tasks.list', undefined, ['workspace.changed']);
  const alerts = useCore('alerts.inbox', { limit: 6 }, ['alerts.changed']);
  const providers = useCore('ai.providers', undefined, ['settings.changed', 'runtime.changed', 'policy.changed']);
  const updates = useCore('updates.status', undefined, ['updates.changed']);
  const aiReady = providers.data?.some((p) => p.available);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const quip = easterEggs ? dashboardQuip({ uptimeSeconds: cur?.uptime ?? status.uptimeSeconds, battery: cur?.battery ?? null }) : null;
  const today = new Date().toISOString().slice(0, 10);
  const open = (tasks.data ?? []).filter((t) => t.status !== 'done');
  const due = open.filter((t) => t.due && t.due.slice(0, 10) <= today);
  const memPct = cur ? (cur.memUsed / cur.memTotal) * 100 : 0;
  const disks = info.data?.disks ?? [];
  const t = (k: (p: SystemLive) => number) => live.map((p) => ({ t: p.ts, v: k(p) }));

  const counts = useCore('alerts.counts', undefined, ['alerts.changed'], 60_000);
  const speed = useCore('net.speedHistory');
  const trophies = useCore('fun.trophies', undefined, ['fun.trophy']);
  const fullest = disks.reduce<(typeof disks)[number] | null>((m, d) => (!m || d.used / d.size > m.used / m.size ? d : m), null);
  const freeTotal = disks.reduce((n, d) => n + (d.size - d.used), 0);
  const health = healthScore({ status, critical: counts.data?.critical ?? 0, unread: counts.data?.unread ?? 0, memPct, fullestDiskPct: fullest ? (fullest.used / fullest.size) * 100 : 0, aiReady: !!aiReady });
  const lastSpeed = speed.data?.[0];
  const found = TROPHIES.filter((x) => trophies.data?.unlocked[x.id]).length;
  const flapsDone = useRef(false);
  const now = new Date();
  const messages = useMemo(() => {
    const m: string[][] = [who ? [`${greeting},`, who] : [greeting, status.deviceName]];
    const failing = status.services.filter((x) => x.state === 'failed').length;
    m.push([failing ? `${failing} SERVICE${failing > 1 ? 'S' : ''} FAILING` : 'ALL SYSTEMS GO', cur ? `CPU ${cur.cpu.toFixed(0)}%  MEM ${memPct.toFixed(0)}%` : 'MEASURING…']);
    m.push([`${open.length} OPEN TASK${open.length === 1 ? '' : 'S'}`, due.length ? `${due.length} DUE TODAY` : 'NOTHING DUE TODAY']);
    if (fullest) m.push([`DRIVE ${fullest.mount} ${formatBytes(fullest.size - fullest.used)} FREE`, `OF ${formatBytes(fullest.size)}`]);
    m.push([status.aiHalt ? 'AI ON EMERGENCY STOP' : aiReady ? `${agentName} READY` : `${agentName} NEEDS A MODEL`, `HEALTH ${health.score} · ${health.label}`]);
    m.push([now.toLocaleDateString(undefined, { weekday: 'long' }), now.toLocaleDateString(undefined, { month: 'short', day: '2-digit', year: 'numeric' })]);
    m.push(['UPTIME', formatDuration(cur?.uptime ?? status.uptimeSeconds)]);
    if (easterEggs) m.push(Math.random() < 0.5 ? ['FBRX GLASS', 'NOW 40% MORE SHINY'] : ['HONK', 'THE GOOSE SAYS HI']);
    return m;
    // Rebuilt every half minute (and when the big things change) so the board isn't restarted on every sample.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [greeting, who, status.deviceName, status.aiHalt, open.length, due.length, aiReady, health.score, easterEggs, Math.floor(Date.now() / 30_000)]);

  return (
    <div className="fx-page glass-dash">
      <div className="glass-aurora" aria-hidden />
      <section className="glass-hero">
        <span className="screw s-tl" aria-hidden />
        <span className="screw s-tr" aria-hidden />
        <span className="screw s-bl" aria-hidden />
        <span className="screw s-br" aria-hidden />
        <div className="glass-hero-main">
          <div className="glass-eyebrow">
            FBRX <b>Glass</b>
          </div>
          <SplitFlapBoard
            messages={messages}
            sound={easterEggs}
            onHoverCount={(n) => {
              if (easterEggs && n >= 20 && !flapsDone.current) {
                flapsDone.current = true;
                unlockTrophy('flaps');
              }
            }}
          />
          <div className="glass-sub">
            {`${status.deviceName} · ${status.edition?.productName ?? TIER_NAMES[status.license.tier]} ${displayVersion(status.version)} · up ${formatDuration(cur?.uptime ?? status.uptimeSeconds)}`}
            {quip && <span className="quip">{quip}</span>}
          </div>
        </div>
        <div className="glass-hero-side">
          <HealthRing score={health.score} label={health.label} />
          <div className="glass-reasons">{health.reasons.length ? health.reasons.slice(0, 3).join(' · ') : 'Nothing needs attention'}</div>
          <div className="fx-actions">
            <AskButton
              label="Health check"
              prompt="Give me a quick health check of this computer: performance right now, storage, security status and any recent errors. Tell me what (if anything) needs attention."
              context={cur ? { score: health.score, reasons: health.reasons, cpu: `${cur.cpu.toFixed(0)}%`, memory: `${formatBytes(cur.memUsed)} of ${formatBytes(cur.memTotal)}`, disks: disks.map((d) => ({ drive: d.mount, free: formatBytes(d.size - d.used), size: formatBytes(d.size) })), uptime: formatDuration(cur.uptime), battery: cur.battery, temperature: cur.tempC } : undefined}
            />
            <Button size="sm" icon="tasks" onClick={() => navigate('tasks')}>
              Tasks
            </Button>
          </div>
        </div>
      </section>

      <NamePrompt fun={easterEggs} />
      <div className="glass-insights">
        <Insight icon="tasks" title="Focus" value={open.length ? (open[0].title.length > 38 ? `${open[0].title.slice(0, 38)}…` : open[0].title) : 'All clear'} foot={due.length ? `${due.length} due today · ${open.length} open` : `${open.length} open task${open.length === 1 ? '' : 's'}`} onClick={() => navigate('tasks')} />
        <Insight icon="gauge" title="Internet" value={lastSpeed ? `↓ ${lastSpeed.downloadMbps} Mbps` : 'Not measured'} foot={lastSpeed ? `↑ ${lastSpeed.uploadMbps} Mbps · ${timeAgo(lastSpeed.at)}` : 'Run a speed test'} onClick={() => navigate('network/speed')} />
        <Insight icon="drive" title="Storage" value={`${formatBytes(freeTotal)} free`} foot={fullest ? `${fullest.mount} is ${Math.round((fullest.used / fullest.size) * 100)}% full` : 'Reading drives…'} onClick={() => navigate('storage')} />
        <LooseTip fun={easterEggs} />
        <Insight icon="sparkles" title={agentName} value={status.aiHalt ? 'Emergency stop' : aiReady ? (status.activeRuns ? 'Working…' : 'Ready') : 'Needs a model'} foot={`${status.stats.agentRuns24h} chats · ${status.stats.toolCalls24h} tool calls today`} onClick={() => navigate(aiReady ? 'agent' : 'runtime')} />
        <Insight icon="archive" title="Protection" value={status.stats.lastBackupAt ? `Backed up ${timeAgo(status.stats.lastBackupAt)}` : 'No backup yet'} foot={`Vault ${status.vault.state} · ${status.stats.policyDenials24h} blocked today`} onClick={() => navigate('backup')} />
        <Insight icon="bell" title="Alerts" value={counts.data?.critical ? `${counts.data.critical} critical` : counts.data?.unread ? `${counts.data.unread} unread` : 'Quiet'} foot={status.pendingApprovals ? `${status.pendingApprovals} approval${status.pendingApprovals > 1 ? 's' : ''} waiting` : 'No approvals waiting'} onClick={() => navigate(status.pendingApprovals ? 'approvals' : 'alerts')} />
        {easterEggs ? (
          <Insight icon="trophy" title="Trophy case" value={`${found} of ${TROPHIES.length}`} foot={found === TROPHIES.length ? 'The goose is very proud' : 'Easter eggs found'} onClick={() => navigate('settings/trophies')} />
        ) : (
          <Insight icon="clock" title="Uptime" value={formatDuration(cur?.uptime ?? status.uptimeSeconds)} foot={`${status.stats.errors24h} errors logged today`} onClick={() => navigate('bugs')} />
        )}
      </div>

      {status.vault.state === 'locked' && (
        <Callout
          tone={status.vault.lockReason === 'keychain' ? 'warning' : 'info'}
          title={status.vault.lockReason === 'moved' ? 'Bring your saved credentials over' : 'Your saved credentials are locked'}
          actions={<Button size="sm" onClick={() => navigate('vault')}>{status.vault.lockReason === 'moved' ? 'Bring them over' : 'Unlock'}</Button>}
        >
          {status.vault.lockReason === 'moved'
            ? `They are still in ${status.vault.movedFrom}, which FBRX no longer uses (it kept asking for your Mac password). One click brings them over.`
            : status.vault.lockReason === 'keychain'
              ? "This computer could not open your credentials (for example after copying the data folder). Enter your recovery passphrase to unlock."
              : 'Enter your vault passphrase to use them.'}
        </Callout>
      )}
      {providers.data && !aiReady && (
        <Callout tone="info" title={`Give ${agentName} a brain`} actions={<Button size="sm" onClick={() => navigate('runtime')}>Choose a model</Button>}>
          Download a local model to run fully offline, connect Ollama, or add a Claude API key.
        </Callout>
      )}
      {status.pendingApprovals > 0 && (
        <Callout tone="warning" title={`${status.pendingApprovals} action(s) need your approval`} actions={<Button size="sm" variant="primary" onClick={() => navigate('approvals')}>Review</Button>}>
          {agentName} is waiting for you before it changes files, runs commands or contacts other systems.
        </Callout>
      )}
      {updates.data?.state === 'downloaded' && (
        <Callout tone="good" title={`FBRX ${updates.data.availableVersion} is ready`} actions={<Button size="sm" onClick={() => void run('u', () => call('updates.install'))}>Restart to update</Button>}>
          The update was downloaded from your organization's control plane.
        </Callout>
      )}

      <Grid cols={4}>
        <StatTile label="Processor" value={cur ? `${cur.cpu.toFixed(0)}%` : '—'} foot={cur?.tempC ? `${cur.tempC} °C` : `${cur?.cores.length ?? '—'} threads`} trend={live.slice(-12).map((p) => p.cpu)} />
        <StatTile label="Memory" value={cur ? `${memPct.toFixed(0)}%` : '—'} foot={cur ? `${formatBytes(cur.memUsed)} of ${formatBytes(cur.memTotal)}` : ''} trend={live.slice(-12).map((p) => (p.memUsed / p.memTotal) * 100)} />
        <StatTile label="Network" value={cur ? `↓ ${rate(cur.netRx)}` : '—'} foot={cur ? `↑ ${rate(cur.netTx)}` : ''} trend={live.slice(-12).map((p) => p.netRx)} />
        <StatTile
          label={cur?.battery ? 'Battery' : 'Open tasks'}
          value={cur?.battery ? `${cur.battery.percent}%` : String(open.length)}
          foot={cur?.battery ? (cur.battery.charging ? 'Charging' : 'On battery') : due.length ? <Status tone="warning">{due.length} due today</Status> : 'Nothing due today'}
        />
      </Grid>

      <Grid cols={2}>
        <Card title="Performance" subtitle="Last few minutes, sampled every 2 seconds">
          {live.length > 1 ? (
            <LineChart
              height={190}
              yMax={100}
              yFormat={(n) => `${n}%`}
              series={[
                { key: 'cpu', label: 'Processor', slot: 0, points: t((p) => Math.round(p.cpu)) },
                { key: 'mem', label: 'Memory', slot: 1, points: t((p) => Math.round((p.memUsed / p.memTotal) * 100)) },
              ]}
            />
          ) : (
            <Empty title="Collecting samples…" />
          )}
        </Card>
        <Card
          title="Today"
          subtitle={`${open.length} open task(s)`}
          actions={
            <>
              {open.length > 0 && <AskButton label="Plan my day" prompt="Look at my open tasks and create a prioritized plan for today. Add any missing steps as tasks if I agree." context={open.map((t) => ({ title: t.title, priority: t.priority, due: t.due, status: t.status }))} />}
              <Button size="sm" variant="ghost" onClick={() => navigate('tasks')}>
                All tasks
              </Button>
            </>
          }
          flush
        >
          {open.length ? (
            <div className="fx-list">
              {open.slice(0, 7).map((tk) => (
                <div className="fx-list-item" key={tk.id}>
                  <input
                    type="checkbox"
                    aria-label={`Complete ${tk.title}`}
                    onChange={() => void run(tk.id, () => call('tasks.save', { id: tk.id, title: tk.title, status: 'done' }))}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="fx-cell-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {tk.title}
                    </div>
                    <div className="fx-cell-sub">
                      {tk.priority}
                      {tk.due ? ` · due ${tk.due.slice(0, 10)}` : ''}
                    </div>
                  </div>
                  {tk.due && tk.due.slice(0, 10) < today ? <Status tone="critical">overdue</Status> : tk.status === 'doing' ? <Status tone="busy">doing</Status> : null}
                </div>
              ))}
            </div>
          ) : (
            <Empty title="All clear" action={<Button size="sm" icon="plus" onClick={() => navigate('tasks')}>Add a task</Button>}>
              Nothing on your list.
            </Empty>
          )}
        </Card>
      </Grid>

      <Grid cols={3}>
        <Card title="Drives" actions={<Button size="sm" variant="ghost" onClick={() => navigate('storage')}>Storage</Button>}>
          <div className="fx-grid" style={{ gap: 12 }}>
            {disks.map((d) => (
              <div key={d.mount}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                  <span className="mono">{d.mount}</span>
                  <span className="fx-muted">
                    {formatBytes(d.size - d.used)} free of {formatBytes(d.size)}
                  </span>
                </div>
                <Meter value={d.used} max={d.size} label={`${d.mount} used`} />
              </div>
            ))}
            {!disks.length && <span className="fx-muted">Reading drives…</span>}
          </div>
        </Card>
        <Card title="Recent alerts" actions={<Button size="sm" variant="ghost" onClick={() => navigate('alerts')}>Inbox</Button>} flush>
          {alerts.data?.length ? (
            <div className="fx-list">
              {alerts.data.map((a) => (
                <div className="fx-list-item" key={a.id} style={{ fontSize: 13 }}>
                  <Status tone={a.severity === 'critical' ? 'critical' : a.severity === 'warning' ? 'warning' : 'info'}>{a.severity}</Status>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: a.read ? 400 : 600 }}>{a.title}</span>
                  <span className="fx-muted" style={{ fontSize: 12 }}>{timeAgo(a.createdAt)}</span>
                </div>
              ))}
            </div>
          ) : (
            <Empty title="No alerts">FBRX watches performance, storage, security and your network in the background.</Empty>
          )}
        </Card>
        <Card title="This computer">
          <KeyValue
            items={[
              ['Model', info.data ? `${info.data.machine.manufacturer} ${info.data.machine.model}`.trim() || '—' : '…'],
              ['System', info.data ? `${info.data.os.name} ${info.data.os.version}` : status.platform],
              ['Processor', info.data ? `${info.data.cpu.model} (${info.data.cpu.cores} cores)` : '…'],
              ['Memory', info.data ? formatBytes(info.data.memoryTotal) : '…'],
              ['Graphics', info.data?.gpus.map((g) => g.model).join(', ') || '—'],
              ['License', `${status.license.edition} (${status.license.state})`],
              ['Organization', status.fleet.state === 'unenrolled' ? 'Standalone' : `${status.fleet.tenantName} · ${status.fleet.state}`],
            ]}
          />
        </Card>
      </Grid>

      <Card title="Services" subtitle="Supervised by the watchdog; failed services restart automatically" flush>
        <div className="fx-list">
          {status.services.map((sv) => (
            <div className="fx-list-item" key={sv.name}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="fx-cell-title">{sv.title}</div>
                <div className="fx-cell-sub" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {sv.message ?? sv.description}
                </div>
              </div>
              <Status tone={serviceTone(sv.state)}>{sv.state}</Status>
              {sv.state !== 'disabled' && (
                <Button size="sm" variant="ghost" icon="refresh" title={`Restart ${sv.title}`} aria-label={`Restart ${sv.title}`} loading={busy === sv.name} onClick={() => void run(sv.name, () => call('system.restartService', { name: sv.name }), `${sv.title} restarted`)} />
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
