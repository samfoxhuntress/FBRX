import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CALENDAR_COLORS,
  CALENDAR_LINK_COLORS,
  CALENDAR_REPEATS,
  FBRX_CALENDAR,
  type CalendarAccount,
  type CalendarEvent,
  type CalendarLinkKind,
  type CalendarRepeat,
  type CalendarSignIn,
  type CalendarStatus,
  type DeepPartial,
  type Settings,
} from '@fbrx/shared';
import { Button, Callout, Card, ChoiceCards, Empty, Field, Icons, Input, Modal, Page, Select, Spinner, Status, Tabs, TextArea, Toggle, timeAgo, useAction, useConfirm, useToast, type IconName } from '@fbrx/ui';
import { call, onEvent, openExternal } from '../client';
import { isLocked, useCore } from '../hooks';
import { navigate, routeArg } from '../app';
import { AskButton } from '../widgets';
import { eventWhen, fmtTime } from '../calendar-format';

/**
 * Studio → Calendar: the FBRX calendar on this computer (events you add, which may repeat and be about a project, a
 * note, a task or an automation, in its color; your tasks and projects by their due dates; when automations run),
 * with shared calendars beside it as add-ons (Outlook / Microsoft 365, calendar links). As an agenda, a week or a
 * month. FBRX reminds before events, and the agent can read it (and, with approval, add events).
 */

type View = 'agenda' | 'week' | 'month';
const DAY = 86_400_000;
const HOUR_PX = 44;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
/** Weeks start on Sunday in the US, Monday elsewhere. */
const weekStartsSunday = () => /^en-US|^en-CA|^es-US|^ja|^ko|^zh-TW|^he|^pt-BR/i.test(navigator.language);
const startOfWeek = (d: Date) => {
  const s = startOfDay(d);
  const back = weekStartsSunday() ? s.getDay() : (s.getDay() + 6) % 7;
  return addDays(s, -back);
};
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDay = (d: Date) => {
  const today = startOfDay(new Date());
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, addDays(today, 1))) return 'Tomorrow';
  if (sameDay(d, addDays(today, -1))) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
};
/** Events that touch a day (all-day ones end at the next midnight). */
const onDay = (e: CalendarEvent, d: Date) => {
  const s = new Date(e.start).getTime();
  const en = new Date(e.end).getTime();
  const a = d.getTime();
  const b = addDays(d, 1).getTime();
  return s < b && (en > a || (s === en && s >= a));
};
/** What an event is about, as people say it, and the page it lives on. */
const LINKS: Record<CalendarLinkKind, { label: string; icon: IconName; page: (id: string) => string }> = {
  project: { label: 'Project', icon: 'layers', page: () => 'projects' },
  note: { label: 'Note', icon: 'note', page: (id) => `notes/${encodeURIComponent(id)}` },
  task: { label: 'Task', icon: 'tasks', page: () => 'tasks' },
  automation: { label: 'Automation', icon: 'repeat', page: () => 'automations' },
};
const REPEATS: Record<CalendarRepeat, string> = { none: 'Does not repeat', daily: 'Every day', weekdays: 'Every weekday', weekly: 'Every week', monthly: 'Every month', yearly: 'Every year' };
/** What the FBRX calendar shows from elsewhere (a task, a project's deadline, an automation's run). */
const fromElsewhere = (e: CalendarEvent) => e.accountId === FBRX_CALENDAR && e.calendarId !== 'events';

export function CalendarPage({ agentName, learner }: { agentName: string; learner: boolean }) {
  const status = useCore('calendar.status', undefined, ['calendar.changed', 'settings.changed', 'vault.changed']);
  const [view, setView] = useState<View>(() => {
    const arg = routeArg();
    return arg === 'week' || arg === 'month' ? arg : 'agenda';
  });
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ event?: CalendarEvent; date: Date; hour?: number } | null>(null);
  const [open, setOpen] = useState<CalendarEvent | null>(null);
  const { run, busy } = useAction();

  const range = useMemo(() => {
    if (view === 'month') {
      const from = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
      return { from, to: addDays(from, 42) };
    }
    const from = view === 'week' ? startOfWeek(anchor) : anchor;
    return { from, to: addDays(from, view === 'week' ? 7 : 14) };
  }, [view, anchor]);
  // Tasks, projects and automations show on the FBRX calendar too, so it follows them.
  const events = useCore('calendar.events', { from: range.from.toISOString(), to: range.to.toISOString() }, ['calendar.changed', 'workspace.changed', 'automations.changed']);
  const st = status.data;
  const accounts = st?.accounts ?? [];
  const list = events.data ?? [];

  const step = (dir: -1 | 1) => setAnchor((a) => (view === 'month' ? new Date(a.getFullYear(), a.getMonth() + dir, 1) : addDays(a, dir * (view === 'week' ? 7 : 14))));
  const title =
    view === 'month'
      ? anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
      : view === 'week'
        ? `${range.from.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${addDays(range.to, -1).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
        : null;
  const create = (date: Date, hour?: number) => setEditing({ date, hour });

  return (
    <Page
      title="Calendar"
      description={`Your FBRX calendar, with your projects, tasks and automations on it, and shared calendars beside it. FBRX reminds you before events, and ${agentName} can see what is on.`}
      actions={
        <>
          {!learner && (
            <AskButton
              label="Prepare my day"
              prompt="Look at my calendar for today and tomorrow and help me prepare: what is coming up, any clashes or back-to-back meetings, and when I have time to focus."
            />
          )}
          <Button variant="primary" icon="plus" onClick={() => create(new Date())}>
            New event
          </Button>
        </>
      }
    >
      {status.error && <Callout tone="warning">{status.error}</Callout>}
      {!st ? (
        <Spinner />
      ) : (
        <div className="cal-layout">
          <div className="cal-main">
            <div className="cal-toolbar">
              <Button size="sm" onClick={() => setAnchor(startOfDay(new Date()))}>
                Today
              </Button>
              <Button size="sm" variant="ghost" icon="chevronLeft" aria-label="Earlier" title="Earlier" onClick={() => step(-1)} />
              <Button size="sm" variant="ghost" icon="chevronRight" aria-label="Later" title="Later" onClick={() => step(1)} />
              {title && <b className="cal-range">{title}</b>}
              <span className="fx-spacer" />
              <Tabs<View>
                tabs={[
                  { id: 'agenda', label: 'Agenda' },
                  { id: 'week', label: 'Week' },
                  { id: 'month', label: 'Month' },
                ]}
                active={view}
                onChange={setView}
              />
            </div>
            {view === 'agenda' ? (
              <Agenda from={range.from} events={list} onOpen={setOpen} />
            ) : view === 'week' ? (
              <Week from={range.from} events={list} onOpen={setOpen} onCreate={create} />
            ) : (
              <Month month={anchor} from={range.from} events={list} onOpen={setOpen} onCreate={create} onDay={(d) => (setAnchor(d), setView('week'))} />
            )}
          </div>
          <aside className="cal-side">
            <Accounts status={st} onAdd={() => setAdding(true)} syncing={busy === 'sync'} onSync={() => void run('sync', () => call('calendar.sync', {}))} />
            <Legend events={list} agentName={agentName} />
            <CalendarSettings status={st} learner={learner} />
          </aside>
        </div>
      )}
      {adding && <AddCalendar status={st} onClose={() => setAdding(false)} />}
      {editing && <EventEditor accounts={accounts} event={editing.event} date={editing.date} hour={editing.hour} onClose={() => setEditing(null)} />}
      {open && <EventDetails event={open} agentName={agentName} onClose={() => setOpen(null)} onEdit={() => (setEditing({ event: open, date: new Date(open.start) }), setOpen(null))} />}
    </Page>
  );
}

// ------------------------------------------------------------------------------------------------ agenda

function EventRow({ e, onOpen }: { e: CalendarEvent; onOpen: (e: CalendarEvent) => void }) {
  const now = Date.now();
  const live = !e.allDay && new Date(e.start).getTime() - 10 * 60_000 <= now && new Date(e.end).getTime() > now;
  return (
    <div className={`cal-row${e.cancelled ? ' cancelled' : ''}${new Date(e.end).getTime() < now ? ' past' : ''}`} onClick={() => onOpen(e)} role="button" tabIndex={0} onKeyDown={(k) => k.key === 'Enter' && onOpen(e)}>
      <span className="cal-bar" style={{ background: e.color }} aria-hidden />
      <span className="cal-when">{eventWhen(e)}</span>
      <span className="cal-what">
        <b className="private">{e.title}</b>
        <span className="cal-sub">
          {[
            e.link && !fromElsewhere(e) ? `${LINKS[e.link.kind].label}: ${e.link.name}` : null,
            e.link?.project && e.link.kind !== 'project' ? e.link.project.name : null,
            e.repeat !== 'none' ? REPEATS[e.repeat] : null,
            e.location,
            e.showAs === 'tentative' ? 'Tentative' : e.showAs === 'free' && !fromElsewhere(e) ? 'Free' : e.showAs === 'oof' ? 'Away' : null,
            e.cancelled ? 'Cancelled' : null,
            fromElsewhere(e) ? e.calendarName : e.accountName,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      {e.madeBy === 'fabrix' && <Icons.sparkles size={13} className="cal-fabrix" aria-label="Added by your assistant" />}
      {e.joinUrl && !e.cancelled && (
        <Button
          size="sm"
          variant={live ? 'primary' : 'ghost'}
          icon="video"
          onClick={(ev) => {
            ev.stopPropagation();
            openExternal(e.joinUrl!);
          }}
        >
          Join
        </Button>
      )}
    </div>
  );
}

function Agenda({ from, events, onOpen }: { from: Date; events: CalendarEvent[]; onOpen: (e: CalendarEvent) => void }) {
  const days = Array.from({ length: 14 }, (_, i) => addDays(from, i));
  const withEvents = days.filter((d) => events.some((e) => onDay(e, d)));
  if (!withEvents.length) return <Empty title="Nothing on">No events in these two weeks.</Empty>;
  return (
    <div className="cal-agenda">
      {withEvents.map((d) => (
        <section key={d.toISOString()} className={sameDay(d, new Date()) ? 'today' : undefined}>
          <h3>{fmtDay(d)}</h3>
          {events
            .filter((e) => onDay(e, d))
            .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start))
            .map((e) => (
              <EventRow key={`${e.accountId}:${e.id}`} e={e} onOpen={onOpen} />
            ))}
        </section>
      ))}
    </div>
  );
}

// -------------------------------------------------------------------------------------------------- week

/** Side-by-side columns for events that overlap. */
function layoutDay(list: CalendarEvent[], day: Date) {
  const items = list
    .map((e) => {
      const s = Math.max(new Date(e.start).getTime(), day.getTime());
      const en = Math.min(Math.max(new Date(e.end).getTime(), s + 15 * 60_000), addDays(day, 1).getTime());
      return { e, s, en, col: 0, cols: 1 };
    })
    .sort((a, b) => a.s - b.s || b.en - a.en);
  let cluster: typeof items = [];
  let clusterEnd = 0;
  const flush = () => {
    const n = Math.max(1, ...cluster.map((c) => c.col + 1));
    for (const c of cluster) c.cols = n;
    cluster = [];
  };
  for (const it of items) {
    if (cluster.length && it.s >= clusterEnd) flush();
    const used = new Set(cluster.filter((c) => c.en > it.s).map((c) => c.col));
    let col = 0;
    while (used.has(col)) col++;
    it.col = col;
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.en);
  }
  flush();
  return items;
}

function Week({ from, events, onOpen, onCreate }: { from: Date; events: CalendarEvent[]; onOpen: (e: CalendarEvent) => void; onCreate: (date: Date, hour: number) => void }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 7 * HOUR_PX;
  }, [from]);
  const allDay = events.filter((e) => e.allDay || new Date(e.end).getTime() - new Date(e.start).getTime() >= DAY);
  const timed = events.filter((e) => !allDay.includes(e));
  return (
    <div className="cal-week">
      <div className="cal-week-head">
        <span />
        {days.map((d) => (
          <span key={d.toISOString()} className={sameDay(d, now) ? 'today' : undefined}>
            <small>{d.toLocaleDateString(undefined, { weekday: 'short' })}</small>
            <b>{d.getDate()}</b>
          </span>
        ))}
      </div>
      {allDay.length > 0 && (
        <div className="cal-week-allday">
          <span className="cal-hour">all day</span>
          {days.map((d) => (
            <span key={d.toISOString()}>
              {allDay
                .filter((e) => onDay(e, d))
                .map((e) => (
                  <button key={`${e.accountId}:${e.id}`} className="cal-chip private" style={{ borderColor: e.color }} onClick={() => onOpen(e)} title={e.title}>
                    {e.title}
                  </button>
                ))}
            </span>
          ))}
        </div>
      )}
      <div className="cal-week-body" ref={scroller}>
        <div className="cal-week-grid" style={{ height: 24 * HOUR_PX }}>
          <div className="cal-hours">
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} style={{ top: h * HOUR_PX }}>
                {h ? new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' }) : ''}
              </span>
            ))}
          </div>
          {days.map((d) => (
            <div
              key={d.toISOString()}
              className={`cal-day${sameDay(d, now) ? ' today' : ''}`}
              onDoubleClick={(ev) => {
                const y = ev.clientY - (ev.currentTarget as HTMLElement).getBoundingClientRect().top;
                onCreate(d, Math.max(0, Math.min(23, Math.floor(y / HOUR_PX))));
              }}
            >
              {layoutDay(
                timed.filter((e) => onDay(e, d)),
                d,
              ).map(({ e, s, en, col, cols }) => {
                const top = ((s - d.getTime()) / 3_600_000) * HOUR_PX;
                const height = Math.max(18, ((en - s) / 3_600_000) * HOUR_PX - 2);
                return (
                  <button
                    key={`${e.accountId}:${e.id}`}
                    className={`cal-block${e.cancelled ? ' cancelled' : ''}${e.showAs === 'tentative' ? ' tentative' : ''}`}
                    style={{ top, height, left: `calc(${(col / cols) * 100}% + 2px)`, width: `calc(${100 / cols}% - 4px)`, ['--cal' as string]: e.color }}
                    onClick={() => onOpen(e)}
                    title={`${e.title} · ${eventWhen(e)}`}
                  >
                    <b className="private">{e.title}</b>
                    {height > 30 && <small>{fmtTime(e.start)}{e.location ? ` · ${e.location}` : ''}</small>}
                  </button>
                );
              })}
              {sameDay(d, now) && <span className="cal-now" style={{ top: ((now.getTime() - d.getTime()) / 3_600_000) * HOUR_PX }} aria-hidden />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------- month

/** Six weeks around a month: each day's first events (in their colors), a double-click away from adding one. */
function Month({ month, from, events, onOpen, onCreate, onDay: openDay }: { month: Date; from: Date; events: CalendarEvent[]; onOpen: (e: CalendarEvent) => void; onCreate: (date: Date) => void; onDay: (d: Date) => void }) {
  const days = Array.from({ length: 42 }, (_, i) => addDays(from, i));
  const today = new Date();
  return (
    <div className="cal-month">
      <div className="cal-month-head">
        {days.slice(0, 7).map((d) => (
          <span key={d.getDay()}>{d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
        ))}
      </div>
      <div className="cal-month-grid">
        {days.map((d) => {
          // Room is short: automations' runs come after the rest.
          const later = (e: CalendarEvent) => Number(e.accountId === FBRX_CALENDAR && e.calendarId === 'automations');
          const list = events.filter((e) => onDay(e, d)).sort((a, b) => later(a) - later(b) || Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
          return (
            <div key={d.toISOString()} className={`cal-mday${d.getMonth() !== month.getMonth() ? ' other' : ''}${sameDay(d, today) ? ' today' : ''}`} onDoubleClick={() => onCreate(d)}>
              <button className="cal-mday-num" onClick={() => openDay(d)} title="Show this week">
                {d.getDate()}
              </button>
              {list.slice(0, 3).map((e) => (
                <button key={`${e.accountId}:${e.id}`} className="cal-mchip private" style={{ ['--cal' as string]: e.color }} onClick={() => onOpen(e)} title={`${e.title} · ${eventWhen(e)}`}>
                  {!e.allDay && <small>{fmtTime(e.start)}</small>} {e.title}
                </button>
              ))}
              {list.length > 3 && (
                <button className="cal-more" onClick={() => openDay(d)}>
                  {list.length - 3} more
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- details

function EventDetails({ event: e, agentName, onClose, onEdit }: { event: CalendarEvent; agentName: string; onClose: () => void; onEdit: () => void }) {
  const { confirm, dialog } = useConfirm();
  const { run, busy } = useAction();
  const day = new Date(e.start).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const fbrx = e.accountId === FBRX_CALENDAR;
  const until = e.repeatUntil ? `, until ${new Date(`${e.repeatUntil}T00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}` : '';
  const go = (page: string) => (onClose(), navigate(page));
  return (
    <Modal
      title={e.title}
      description={`${day} · ${eventWhen(e)}`}
      onClose={onClose}
      footer={
        <>
          {e.canDelete && (
            <Button
              variant="danger"
              icon="trash"
              loading={busy === 'del'}
              onClick={async () => {
                const body = fbrx
                  ? `It is removed from your FBRX calendar${e.repeat !== 'none' ? ', every time it repeats' : ''}.`
                  : 'It is removed from your Outlook calendar too. If you organized a meeting, Outlook tells the people you invited.';
                if (await confirm({ title: 'Delete this event?', body, danger: true, confirmLabel: 'Delete' })) {
                  await run('del', () => call('calendar.delete', { accountId: e.accountId, id: e.id }), 'Event deleted');
                  onClose();
                }
              }}
            >
              Delete
            </Button>
          )}
          <span className="fx-spacer" />
          {e.link && (
            <Button icon={LINKS[e.link.kind].icon} onClick={() => go(LINKS[e.link!.kind].page(e.link!.id))}>
              Open {LINKS[e.link.kind].label.toLowerCase()}
            </Button>
          )}
          {e.canEdit && (
            <Button variant="primary" icon="edit" onClick={onEdit}>
              Edit
            </Button>
          )}
          {e.webLink && (
            <Button icon="external" onClick={() => openExternal(e.webLink!)}>
              Open in Outlook
            </Button>
          )}
          {e.joinUrl && !e.cancelled && (
            <Button variant="primary" icon="video" onClick={() => openExternal(e.joinUrl!)}>
              Join meeting
            </Button>
          )}
        </>
      }
    >
      <div className="cal-details">
        {e.cancelled && <Callout tone="warning">This event was cancelled.</Callout>}
        <dl>
          {e.link && (
            <>
              <dt>About</dt>
              <dd>
                {LINKS[e.link.kind].label}: <b>{e.link.name}</b>
                {e.link.project && e.link.kind !== 'project' ? ` · project ${e.link.project.name}` : ''}
              </dd>
            </>
          )}
          {e.repeat !== 'none' && (
            <>
              <dt>Repeats</dt>
              <dd>
                {REPEATS[e.repeat]}
                {until}
              </dd>
            </>
          )}
          {e.location && (
            <>
              <dt>Where</dt>
              <dd className="private">{e.location}</dd>
            </>
          )}
          {e.organizer && (
            <>
              <dt>Organizer</dt>
              <dd className="private">{e.organizer}</dd>
            </>
          )}
          <dt>Calendar</dt>
          <dd>
            <span className="cal-dot" style={{ background: e.color }} /> {e.accountName}
            {e.calendarName !== e.accountName ? ` · ${e.calendarName}` : ''}
          </dd>
          {!fromElsewhere(e) && (
            <>
              <dt>Shows as</dt>
              <dd>{{ free: 'Free', tentative: 'Tentative', busy: 'Busy', oof: 'Away', workingElsewhere: 'Working elsewhere', unknown: 'Busy' }[e.showAs]}</dd>
            </>
          )}
          {e.madeBy === 'fabrix' && (
            <>
              <dt>Added by</dt>
              <dd>
                <Icons.sparkles size={12} /> {agentName}
              </dd>
            </>
          )}
        </dl>
        {e.notes && <p className="cal-notes private">{e.notes}</p>}
        <div className="fx-actions">
          <AskButton label={`Prepare with ${agentName}`} prompt={`Help me prepare for "${e.title}" (${day}, ${eventWhen(e)}). What should I have ready? Check my calendar around it for anything that clashes.`} context={{ title: e.title, when: `${day} ${eventWhen(e)}`, location: e.location, organizer: e.organizer }} />
        </div>
      </div>
      {dialog}
    </Modal>
  );
}

// --------------------------------------------------------------------------------------------- accounts

function Accounts({ status, onAdd, onSync, syncing }: { status: CalendarStatus; onAdd: () => void; onSync: () => void; syncing: boolean }) {
  const [editing, setEditing] = useState<CalendarAccount | null>(null);
  const shared = status.accounts.some((a) => a.kind !== 'fbrx');
  const { confirm, dialog } = useConfirm();
  const { run } = useAction();
  const toast = useToast();
  const signInAgain = async () => {
    try {
      const s = await call('calendar.signIn');
      openExternal(s.url);
      toast.info('Finish signing in in your browser', 'FBRX picks it up from there.');
    } catch (err) {
      toast.error('Could not start signing in', (err as Error).message);
    }
  };
  return (
    <Card
      title="Calendars"
      actions={shared && <Button size="sm" variant="ghost" icon="refresh" loading={syncing} aria-label="Update the shared calendars now" title="Update the shared calendars now" onClick={onSync} />}
    >
      <div className="cal-accounts">
        {status.accounts.map((a) => (
          <div key={a.id} className={`cal-account${a.enabled ? '' : ' off'}`}>
            <div className="cal-account-head">
              <span className="cal-dot" style={{ background: a.color }} />
              <div className="cal-account-name">
                <b>{a.name}</b>
                <small className="private">{a.kind === 'fbrx' ? 'On this computer' : a.kind === 'microsoft' ? (a.address ?? 'Outlook / Microsoft 365') : `Link · ${a.address ?? ''}`}</small>
              </div>
              <Toggle checked={a.enabled} onChange={(v) => void run('t', () => call('calendar.update', { id: a.id, enabled: v }))} title={a.enabled ? 'Shown' : 'Hidden'} />
            </div>
            {(a.kind === 'fbrx' || a.kind === 'microsoft') && a.enabled && a.calendars.length > 1 && (
              <div className="cal-subcals">
                {a.calendars.map((c) => (
                  <label key={c.id}>
                    <input type="checkbox" checked={c.enabled} onChange={(ev) => void run('c', () => call('calendar.update', { id: a.id, calendars: [{ id: c.id, enabled: ev.target.checked }] }))} />
                    {c.name}
                  </label>
                ))}
              </div>
            )}
            <div className="cal-account-foot">
              {a.kind === 'fbrx' ? (
                <small>
                  {a.events} event{a.events === 1 ? '' : 's'} of yours
                </small>
              ) : a.lastError ? (
                <Status tone="warning">{a.lastError}</Status>
              ) : (
                <small>
                  {a.lastSyncAt ? `Updated ${timeAgo(a.lastSyncAt)}` : 'Not updated yet'} · {a.events} event{a.events === 1 ? '' : 's'}
                  {a.kind === 'microsoft' && !a.canWrite ? ' · read-only' : ''}
                </small>
              )}
              <span className="fx-spacer" />
              {a.kind === 'microsoft' && a.lastError && /sign in/i.test(a.lastError) && (
                <Button size="sm" onClick={() => void signInAgain()}>
                  Sign in again
                </Button>
              )}
              <Button size="sm" variant="ghost" icon="edit" aria-label={`Edit ${a.name}`} title="Name and color" onClick={() => setEditing(a)} />
              {a.kind !== 'fbrx' && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  aria-label={`Remove ${a.name}`}
                  title="Remove"
                  onClick={async () => {
                    if (await confirm({ title: `Remove ${a.name}?`, body: 'Its events disappear from FBRX and FBRX forgets the sign-in or link. Nothing changes in the calendar itself.', danger: true, confirmLabel: 'Remove' })) {
                      await run('rm', () => call('calendar.remove', { id: a.id }), 'Calendar removed');
                    }
                  }}
                />
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="cal-add-shared">
        <Button size="sm" variant="ghost" icon="plus" onClick={onAdd}>
          Add a shared calendar
        </Button>
        {!shared && <small>Outlook / Microsoft 365, or a calendar link from Google, Apple or your school, beside your FBRX calendar.</small>}
      </div>
      {status.signIn && (
        <div className="cal-pending">
          <Spinner /> Waiting for the browser sign-in…{' '}
          <button className="link-btn" onClick={() => openExternal(status.signIn!.url)}>
            Open it again
          </button>{' '}
          ·{' '}
          <button className="link-btn" onClick={() => void call('calendar.cancelSignIn')}>
            Cancel
          </button>
        </div>
      )}
      {editing && <EditAccount account={editing} onClose={() => setEditing(null)} />}
      {dialog}
    </Card>
  );
}

function EditAccount({ account, onClose }: { account: CalendarAccount; onClose: () => void }) {
  const [name, setName] = useState(account.name);
  const [color, setColor] = useState(account.color);
  const { run, busy } = useAction();
  return (
    <Modal
      title="Calendar name and color"
      onClose={onClose}
      footer={
        <>
          <span className="fx-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy === 'save'}
            disabled={!name.trim()}
            onClick={async () => {
              await run('save', () => call('calendar.update', { id: account.id, name: name.trim(), color }));
              onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <Field label="Name">
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </Field>
      <Field label="Color">
        <div className="cal-colors" role="radiogroup" aria-label="Color">
          {CALENDAR_COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={c === color} aria-label={c} className={c === color ? 'active' : undefined} style={{ background: c }} onClick={() => setColor(c)} />
          ))}
        </div>
      </Field>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------ add calendar

function AddCalendar({ status, onClose }: { status: CalendarStatus | null; onClose: () => void }) {
  const [kind, setKind] = useState<'microsoft' | 'link'>('microsoft');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [pending, setPending] = useState<CalendarSignIn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();
  const toast = useToast();
  const configured = !!status?.microsoft.configured;

  useEffect(
    () =>
      onEvent('calendar.changed', (c) => {
        if (!c.signIn || c.signIn.id !== pending?.id) return;
        if (c.signIn.ok) {
          toast.success('Calendar connected', 'Your Outlook calendars are on their way.');
          onClose();
        } else {
          setPending(null);
          setError(c.signIn.error ?? 'Sign-in did not finish.');
        }
      }),
    [pending, onClose, toast],
  );

  const signIn = async () => {
    setError(null);
    try {
      const s = await call('calendar.signIn');
      setPending(s);
      openExternal(s.url);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const addLink = () =>
    run('link', async () => {
      setError(null);
      try {
        const a = await call('calendar.addLink', { name: name.trim(), url: url.trim() });
        toast.success(`${a.name} added`, `${a.events} event${a.events === 1 ? '' : 's'} in the next two months.`);
        onClose();
      } catch (err) {
        setError((err as Error).message);
      }
    });

  return (
    <Modal
      title="Add a shared calendar"
      wide
      onClose={() => {
        if (pending) void call('calendar.cancelSignIn');
        onClose();
      }}
      footer={
        <>
          <span className="fx-spacer" />
          <Button
            onClick={() => {
              if (pending) void call('calendar.cancelSignIn');
              onClose();
            }}
          >
            Cancel
          </Button>
          {kind === 'link' ? (
            <Button variant="primary" loading={busy === 'link'} disabled={!url.trim()} onClick={() => void addLink()}>
              Add calendar
            </Button>
          ) : configured && !pending ? (
            <Button variant="primary" icon="external" onClick={() => void signIn()}>
              Sign in with Microsoft
            </Button>
          ) : null}
        </>
      }
    >
      <ChoiceCards<'microsoft' | 'link'>
        label="Kind of calendar"
        value={kind}
        onChange={(k) => {
          setKind(k);
          setError(null);
        }}
        options={[
          { value: 'microsoft', icon: 'briefcase', title: 'Outlook / Microsoft 365', description: 'Sign in with a work, school or personal Microsoft account. Every calendar in it; you can add events from FBRX.' },
          { value: 'link', icon: 'link', title: 'Calendar link', description: 'Paste an iCal address from Outlook.com, Google, Apple or your school. Read-only, no sign-in.' },
        ]}
      />
      <div style={{ marginTop: 14 }}>
        {error && <Callout tone="warning">{error}</Callout>}
        {kind === 'link' ? (
          <div className="fx-grid">
            <Field label="Calendar link" help="Starts with https:// or webcal:// and usually ends in .ics. Treat it like a password: anyone with it can see the calendar.">
              <Input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://outlook.office365.com/owa/calendar/…/calendar.ics" onKeyDown={(e) => e.key === 'Enter' && url.trim() && void addLink()} />
            </Field>
            <Field label="Name (optional)" help="Uses the calendar's own name if empty.">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Family" maxLength={80} />
            </Field>
            <details className="cal-howto">
              <summary>Where do I find the link?</summary>
              <ul>
                <li>
                  <b>Outlook on the web / Outlook.com:</b> Settings → Calendar → Shared calendars → Publish a calendar → pick the calendar and “Can view all details” → Publish → copy the <i>ICS</i> link.
                </li>
                <li>
                  <b>Google Calendar:</b> Settings → your calendar → Integrate calendar → <i>Secret address in iCal format</i>.
                </li>
                <li>
                  <b>Apple iCloud:</b> Calendar → the share button next to a calendar → Public Calendar → copy the link.
                </li>
                <li>
                  <b>School or team calendars:</b> look for “Subscribe”, “iCal” or “ICS” on the calendar's page.
                </li>
              </ul>
            </details>
          </div>
        ) : pending ? (
          <div className="cal-waiting">
            <Spinner />
            <div>
              <b>Finish signing in in your browser</b>
              <p>Choose your account and allow FBRX to read your calendar. This window updates by itself when you are done.</p>
              <button className="link-btn" onClick={() => openExternal(pending.url)}>
                Open the sign-in page again
              </button>
            </div>
          </div>
        ) : configured ? (
          <p className="fx-muted">
            Your browser opens Microsoft's sign-in page. FBRX never sees your password; it keeps only a sign-in token, locked away with your saved credentials.
            {status?.microsoft.readOnly ? ' FBRX asks to read your calendars only.' : ' FBRX asks to read your calendars and add events (it never invites anyone on its own).'}
          </p>
        ) : (
          <MicrosoftAppSetup />
        )}
      </div>
    </Modal>
  );
}

/** Without an app (client) ID there is nothing to sign in to: how to get one, and where to put it. */
function MicrosoftAppSetup() {
  const [clientId, setClientId] = useState('');
  const [tenant, setTenant] = useState('common');
  const { run, busy } = useAction();
  return (
    <div className="fx-grid">
      <Callout tone="info" title="One-time setup">
        Signing in to Microsoft needs an app registration. If your organization uses FBRX Command, ask IT: they can set it for every computer. You can also create your own in a few minutes, free; or use a calendar link instead.
      </Callout>
      <details className="cal-howto">
        <summary>Create an app registration</summary>
        <ol>
          <li>Open the Microsoft Entra admin center (entra.microsoft.com) → Applications → App registrations → New registration.</li>
          <li>Name it “FBRX Calendar”. Under supported accounts pick the one with “personal Microsoft accounts” if you use Outlook.com, or your organization only.</li>
          <li>Redirect URI: choose <i>Public client/native (mobile &amp; desktop)</i> and enter <code>http://localhost</code>. Register.</li>
          <li>API permissions → Add → Microsoft Graph → Delegated: <code>Calendars.ReadWrite</code> (or <code>Calendars.Read</code>), <code>User.Read</code>, <code>offline_access</code>.</li>
          <li>Copy the <i>Application (client) ID</i> from Overview and paste it below.</li>
        </ol>
      </details>
      <div className="fx-row">
        <Field label="Application (client) ID">
          <Input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />
        </Field>
        <Field label="Accounts" help="“common” for any account; your domain or tenant ID for one organization.">
          <Input value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="common" />
        </Field>
      </div>
      <div className="fx-actions">
        <Button variant="primary" loading={busy === 'save'} disabled={!/^[0-9a-f-]{20,}$/i.test(clientId.trim())} onClick={() => void run('save', () => call('settings.update', { patch: { calendar: { microsoft: { clientId: clientId.trim(), tenant: tenant.trim() || 'common' } } } }))}>
          Save
        </Button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------------------- an event

const KINDS_SHOWN: Record<Exclude<CalendarLinkKind, 'project'>, string> = { note: 'Notes', task: 'Tasks', automation: 'Automations' };

/**
 * Adds an event, or changes one of the FBRX calendar's (all of it, when it repeats). On the FBRX calendar it can
 * repeat and be about a project, a note, a task or an automation, whose color it takes unless it has one of its own.
 */
function EventEditor({ accounts, event, date, hour, onClose }: { accounts: CalendarAccount[]; event?: CalendarEvent; date: Date; hour?: number; onClose: () => void }) {
  const projects = useCore('projects.list', undefined, ['workspace.changed']).data ?? [];
  const notes = useCore('notes.list', undefined, ['workspace.changed']).data ?? [];
  const tasks = useCore('tasks.list', undefined, ['workspace.changed']).data ?? [];
  const automations = useCore('automations.list', undefined, ['automations.changed']).data ?? [];
  // Where it can go: the FBRX calendar, and the Outlook calendars that take events.
  const targets = [
    { value: `${FBRX_CALENDAR}|events`, label: accounts.find((a) => a.id === FBRX_CALENDAR)?.name ?? 'FBRX' },
    ...accounts
      .filter((a) => a.kind === 'microsoft' && a.enabled && a.canWrite)
      .flatMap((a) => a.calendars.filter((c) => c.canWrite).map((c) => ({ value: `${a.id}|${c.id}`, label: a.calendars.length > 1 ? `${a.name} · ${c.name}` : a.name }))),
  ];
  // A repeating event is changed as a whole, from its first day.
  const first = event ? new Date(event.seriesStart ?? event.start) : null;
  const last = event && first ? new Date(first.getTime() + new Date(event.end).getTime() - new Date(event.start).getTime()) : null;
  const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const startHour = hour ?? Math.min(22, new Date().getHours() + 1);
  const [f, setF] = useState(() => ({
    title: event?.title ?? '',
    day: ymd(first ?? date),
    lastDay: event?.allDay && last ? ymd(addDays(last, -1)) : ymd(first ?? date),
    start: first && !event?.allDay ? hm(first) : `${pad(startHour)}:00`,
    end: last && !event?.allDay ? hm(last) : `${pad(startHour)}:30`,
    allDay: event?.allDay ?? false,
    location: event?.location ?? '',
    notes: event?.notes ?? '',
    target: targets[0].value,
    repeat: event?.repeat ?? ('none' as CalendarRepeat),
    until: event?.repeatUntil ?? '',
    linkKind: event?.link?.kind ?? ('' as CalendarLinkKind | ''),
    linkId: event?.link?.id ?? '',
    color: event?.ownColor ?? (null as string | null),
  }));
  const { run, busy } = useAction();
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const fbrx = f.target.startsWith(`${FBRX_CALENDAR}|`);
  const options: Array<{ value: string; label: string }> =
    f.linkKind === 'project'
      ? projects.map((p) => ({ value: p.id, label: p.name }))
      : f.linkKind === 'note'
        ? notes.slice(0, 300).map((n) => ({ value: n.id, label: n.title }))
        : f.linkKind === 'task'
          ? tasks.filter((t) => t.status !== 'done' || t.id === f.linkId).map((t) => ({ value: t.id, label: t.title }))
          : f.linkKind === 'automation'
            ? automations.map((x) => ({ value: x.id, label: x.name }))
            : [];
  // The color it gets without one of its own (as the FBRX calendar works it out).
  const projectOf = (id: string | null | undefined) => projects.find((p) => p.id === id);
  const linkedProject =
    f.linkKind === 'project' ? projectOf(f.linkId) : f.linkKind === 'note' ? projectOf(notes.find((n) => n.id === f.linkId)?.projectId) : f.linkKind === 'task' ? projectOf(tasks.find((t) => t.id === f.linkId)?.projectId) : undefined;
  const auto =
    linkedProject?.color ??
    (f.linkKind && f.linkKind !== 'project' && f.linkId ? CALENDAR_LINK_COLORS[f.linkKind] : null) ??
    (event?.madeBy === 'fabrix' ? CALENDAR_LINK_COLORS.fabrix : (accounts.find((a) => a.id === FBRX_CALENDAR)?.color ?? CALENDAR_COLORS[0]));
  const timesWrong = !f.allDay && f.end <= f.start;
  const untilWrong = f.repeat !== 'none' && !!f.until && f.until < f.day;
  const save = () =>
    run(
      'save',
      async () => {
        const [accountId, calendarId] = f.target.split('|');
        const when = f.allDay
          ? { start: f.day, end: f.lastDay > f.day ? f.lastDay : undefined, allDay: true }
          : { start: new Date(`${f.day}T${f.start}`).toISOString(), end: new Date(`${f.day}T${f.end}`).toISOString(), allDay: false };
        const own = fbrx ? { repeat: f.repeat, repeatUntil: f.repeat === 'none' ? null : f.until || null, link: f.linkKind && f.linkId ? { kind: f.linkKind, id: f.linkId } : null, color: f.color } : {};
        if (event) await call('calendar.edit', { id: event.series!, title: f.title.trim(), ...when, location: f.location.trim(), notes: f.notes.trim(), ...own });
        else await call('calendar.create', { accountId, calendarId, title: f.title.trim(), ...when, location: f.location.trim() || undefined, notes: f.notes.trim() || undefined, ...own });
        onClose();
      },
      event ? 'Event changed' : 'Event added',
    );
  return (
    <Modal
      title={event ? 'Edit event' : 'New event'}
      description={event && event.repeat !== 'none' ? 'Changes apply every time it repeats.' : undefined}
      onClose={onClose}
      footer={
        <>
          <span className="fx-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 'save'} disabled={!f.title.trim() || timesWrong || untilWrong || (!!f.linkKind && !f.linkId)} onClick={() => void save()}>
            {event ? 'Save' : 'Add event'}
          </Button>
        </>
      }
    >
      <div className="fx-grid">
        <Field label="Title">
          <Input autoFocus value={f.title} onChange={(e) => set({ title: e.target.value })} maxLength={255} />
        </Field>
        <div className="fx-row">
          <Field label={f.repeat !== 'none' ? 'First day' : 'Day'}>
            <Input type="date" value={f.day} onChange={(e) => set({ day: e.target.value, lastDay: e.target.value > f.lastDay ? e.target.value : f.lastDay })} />
          </Field>
          {f.allDay ? (
            <Field label="Last day">
              <Input type="date" value={f.lastDay} min={f.day} onChange={(e) => set({ lastDay: e.target.value })} />
            </Field>
          ) : (
            <>
              <Field label="Starts">
                <Input type="time" value={f.start} onChange={(e) => set({ start: e.target.value, end: e.target.value >= f.end ? `${pad(Math.min(23, Number(e.target.value.slice(0, 2)) + 1))}:${e.target.value.slice(3)}` : f.end })} />
              </Field>
              <Field label="Ends" error={timesWrong ? 'Ends before it starts' : undefined}>
                <Input type="time" value={f.end} onChange={(e) => set({ end: e.target.value })} />
              </Field>
            </>
          )}
        </div>
        <Toggle checked={f.allDay} onChange={(v) => set({ allDay: v })} label="All day" />
        {fbrx && (
          <>
            <div className="fx-row">
              <Field label="Repeats">
                <Select value={f.repeat} onChange={(e) => set({ repeat: e.target.value as CalendarRepeat })} options={CALENDAR_REPEATS.map((r) => ({ value: r, label: REPEATS[r] }))} />
              </Field>
              {f.repeat !== 'none' && (
                <Field label="Until" help={f.until ? undefined : 'Empty: for good'} error={untilWrong ? 'Before it starts' : undefined}>
                  <Input type="date" value={f.until} min={f.day} onChange={(e) => set({ until: e.target.value })} />
                </Field>
              )}
            </div>
            <div className="fx-row">
              <Field label="About" help="It takes the color of what it is about.">
                <Select
                  value={f.linkKind}
                  onChange={(e) => set({ linkKind: e.target.value as CalendarLinkKind | '', linkId: '' })}
                  options={[{ value: '', label: 'Nothing in particular' }, ...(Object.keys(LINKS) as CalendarLinkKind[]).map((k) => ({ value: k, label: LINKS[k].label }))]}
                />
              </Field>
              {f.linkKind && (
                <Field label={LINKS[f.linkKind].label}>
                  <Select value={f.linkId} onChange={(e) => set({ linkId: e.target.value })} options={[{ value: '', label: options.length ? 'Choose…' : `No ${f.linkKind === 'project' ? 'projects' : KINDS_SHOWN[f.linkKind].toLowerCase()} yet` }, ...options]} />
                </Field>
              )}
            </div>
            <Field label="Color" help={f.color ? 'Its own color.' : 'Automatic: its project’s color, else what it is about, else the calendar’s.'}>
              <div className="cal-colors" role="radiogroup" aria-label="Color">
                <button type="button" role="radio" aria-checked={f.color === null} aria-label="Automatic" title="Automatic" className={`auto${f.color === null ? ' active' : ''}`} style={{ background: auto }} onClick={() => set({ color: null })} />
                {CALENDAR_COLORS.map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={c === f.color} aria-label={c} className={c === f.color ? 'active' : undefined} style={{ background: c }} onClick={() => set({ color: c })} />
                ))}
              </div>
            </Field>
          </>
        )}
        <Field label="Where">
          <Input value={f.location} onChange={(e) => set({ location: e.target.value })} maxLength={255} />
        </Field>
        <Field label="Notes">
          <TextArea rows={3} value={f.notes} onChange={(e) => set({ notes: e.target.value })} maxLength={4000} />
        </Field>
        {!event && targets.length > 1 && (
          <Field label="Calendar" help={fbrx ? undefined : 'Outlook events do not repeat from FBRX or take a project’s color.'}>
            <Select value={f.target} onChange={(e) => set({ target: e.target.value })} options={targets} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------------ colors

/** What the colors on screen stand for: projects, what events are about, who added them, and the calendars. */
function Legend({ events, agentName }: { events: CalendarEvent[]; agentName: string }) {
  const entries = new Map<string, string>();
  for (const e of events) {
    if (e.ownColor) continue;
    const label = e.link?.project ? e.link.project.name : e.link && e.link.kind !== 'project' ? KINDS_SHOWN[e.link.kind] : e.madeBy === 'fabrix' ? `Added by ${agentName}` : e.accountName;
    if (!entries.has(label)) entries.set(label, e.color);
  }
  if (!entries.size) return null;
  return (
    <Card title="Colors">
      <div className="cal-legend">
        {[...entries].map(([label, color]) => (
          <span key={label}>
            <span className="cal-dot" style={{ background: color }} /> {label}
          </span>
        ))}
      </div>
    </Card>
  );
}

// --------------------------------------------------------------------------------------------- settings

function CalendarSettings({ status, learner }: { status: CalendarStatus; learner: boolean }) {
  const s = useCore('settings.get', undefined, ['settings.changed']);
  const { run } = useAction();
  const locked = s.data?.locked;
  const L = (p: string) => isLocked(locked, `calendar.${p}`);
  const patch = (p: DeepPartial<Settings['calendar']>) => void run('patch', () => call('settings.update', { patch: { calendar: p } }));
  const ms = s.data?.settings.calendar.microsoft;
  const [clientId, setClientId] = useState<string | null>(null);
  return (
    <Card title="Calendar settings">
      <div className="fx-grid">
        <Field label="Remind me">
          <Select
            value={String(status.remindMinutes)}
            disabled={L('remindMinutes')}
            onChange={(e) => patch({ remindMinutes: Number(e.target.value) })}
            options={[
              { value: '0', label: 'Never' },
              { value: '5', label: '5 minutes before' },
              { value: '10', label: '10 minutes before' },
              { value: '15', label: '15 minutes before' },
              { value: '30', label: '30 minutes before' },
            ]}
          />
        </Field>
        <Field label="Update every">
          <Select
            value={String(status.syncMinutes)}
            disabled={L('syncMinutes')}
            onChange={(e) => patch({ syncMinutes: Number(e.target.value) })}
            options={[5, 15, 30, 60].map((m) => ({ value: String(m), label: `${m} minutes` }))}
          />
        </Field>
        {!learner && ms && (
          <details className="cal-howto">
            <summary>Microsoft sign-in</summary>
            {status.microsoft.managed ? (
              <p className="fx-muted">Set by your organization.</p>
            ) : (
              <div className="fx-grid">
                <Field label="Application (client) ID" help={status.microsoft.builtIn && !ms.clientId ? 'Empty uses the one built into FBRX.' : 'From your Microsoft Entra app registration.'}>
                  <Input value={clientId ?? ms.clientId} disabled={L('microsoft.clientId')} onChange={(e) => setClientId(e.target.value)} onBlur={() => clientId !== null && clientId !== ms.clientId && patch({ microsoft: { clientId: clientId.trim() } })} />
                </Field>
                <Field label="Accounts" help="“common”, “organizations”, or your domain">
                  <Input defaultValue={ms.tenant} disabled={L('microsoft.tenant')} onBlur={(e) => e.target.value.trim() !== ms.tenant && patch({ microsoft: { tenant: e.target.value.trim() || 'common' } })} />
                </Field>
                <Toggle checked={ms.readOnly} disabled={L('microsoft.readOnly')} onChange={(v) => patch({ microsoft: { readOnly: v } })} label="Read calendars only (no new events)" />
              </div>
            )}
          </details>
        )}
      </div>
    </Card>
  );
}
