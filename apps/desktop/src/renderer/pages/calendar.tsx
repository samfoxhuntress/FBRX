import { useEffect, useMemo, useRef, useState } from 'react';
import { CALENDAR_COLORS, type CalendarAccount, type CalendarEvent, type CalendarSignIn, type CalendarStatus, type DeepPartial, type Settings } from '@fbrx/shared';
import { Button, Callout, Card, ChoiceCards, Empty, Field, Input, Modal, Page, Select, Spinner, Status, Tabs, TextArea, Toggle, timeAgo, useAction, useConfirm, useToast } from '@fbrx/ui';
import { call, onEvent, openExternal } from '../client';
import { isLocked, useCore } from '../hooks';
import { routeArg } from '../app';
import { AskButton } from '../widgets';
import { eventWhen, fmtTime } from '../calendar-format';

/**
 * Workspace → Calendar: Outlook / Microsoft 365 accounts and calendar links side by side, as an agenda or a week.
 * FBRX keeps the last week and the next two months on the computer, reminds before meetings, and the agent can
 * read it (and, with approval, add events).
 */

type View = 'agenda' | 'week';
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

export function CalendarPage({ agentName, learner }: { agentName: string; learner: boolean }) {
  const status = useCore('calendar.status', undefined, ['calendar.changed', 'settings.changed', 'vault.changed']);
  const [view, setView] = useState<View>(() => (routeArg() === 'week' ? 'week' : 'agenda'));
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState<{ date: Date; hour?: number } | null>(null);
  const [open, setOpen] = useState<CalendarEvent | null>(null);
  const { run, busy } = useAction();

  const range = useMemo(() => {
    const from = view === 'week' ? startOfWeek(anchor) : anchor;
    return { from, to: addDays(from, view === 'week' ? 7 : 14) };
  }, [view, anchor]);
  const events = useCore('calendar.events', { from: range.from.toISOString(), to: range.to.toISOString() }, ['calendar.changed']);
  const st = status.data;
  const accounts = st?.accounts ?? [];
  const writable = accounts.some((a) => a.enabled && a.canWrite);
  const list = events.data ?? [];

  const step = (dir: -1 | 1) => setAnchor((a) => addDays(a, dir * (view === 'week' ? 7 : 14)));
  const title = view === 'week' ? `${range.from.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${addDays(range.to, -1).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : null;

  return (
    <Page
      title="Calendar"
      description={`Outlook / Microsoft 365 and calendar links in one place. FBRX reminds you before meetings, and ${agentName} can see what is on.`}
      actions={
        accounts.length ? (
          <>
            {!learner && (
              <AskButton
                label="Prepare my day"
                prompt="Look at my calendar for today and tomorrow and help me prepare: what is coming up, any clashes or back-to-back meetings, and when I have time to focus."
              />
            )}
            {writable && (
              <Button icon="plus" onClick={() => setCreating({ date: new Date() })}>
                New event
              </Button>
            )}
            <Button variant="primary" icon="calendar" onClick={() => setAdding(true)}>
              Add calendar
            </Button>
          </>
        ) : undefined
      }
    >
      {status.error && <Callout tone="warning">{status.error}</Callout>}
      {!st ? (
        <Spinner />
      ) : !accounts.length ? (
        <Welcome onAdd={() => setAdding(true)} />
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
                ]}
                active={view}
                onChange={setView}
              />
            </div>
            {view === 'agenda' ? <Agenda from={range.from} events={list} onOpen={setOpen} /> : <Week from={range.from} events={list} onOpen={setOpen} onCreate={writable ? (date, hour) => setCreating({ date, hour }) : undefined} />}
          </div>
          <aside className="cal-side">
            <Accounts status={st} onAdd={() => setAdding(true)} syncing={busy === 'sync'} onSync={() => void run('sync', () => call('calendar.sync', {}))} />
            <CalendarSettings status={st} learner={learner} />
          </aside>
        </div>
      )}
      {adding && <AddCalendar status={st} onClose={() => setAdding(false)} />}
      {creating && <NewEvent accounts={accounts} date={creating.date} hour={creating.hour} onClose={() => setCreating(null)} />}
      {open && <EventDetails event={open} agentName={agentName} onClose={() => setOpen(null)} />}
    </Page>
  );
}

function Welcome({ onAdd }: { onAdd: () => void }) {
  return (
    <Card>
      <Empty
        title="Bring your calendar to FBRX"
        action={
          <Button variant="primary" icon="calendar" onClick={onAdd}>
            Add a calendar
          </Button>
        }
      >
        Sign in to Outlook / Microsoft 365, or paste a calendar link from Outlook.com, Google, Apple or your school. Your meetings show here and on FBRX Glass, FBRX reminds you before they start, and your
        assistant can tell you what is on or find a free hour.
      </Empty>
    </Card>
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
          {[e.location, e.showAs === 'tentative' ? 'Tentative' : e.showAs === 'free' ? 'Free' : e.showAs === 'oof' ? 'Away' : null, e.cancelled ? 'Cancelled' : null, e.accountName].filter(Boolean).join(' · ')}
        </span>
      </span>
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

function Week({ from, events, onOpen, onCreate }: { from: Date; events: CalendarEvent[]; onOpen: (e: CalendarEvent) => void; onCreate?: (date: Date, hour: number) => void }) {
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
                if (!onCreate) return;
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

// ---------------------------------------------------------------------------------------------- details

function EventDetails({ event: e, agentName, onClose }: { event: CalendarEvent; agentName: string; onClose: () => void }) {
  const { confirm, dialog } = useConfirm();
  const { run, busy } = useAction();
  const day = new Date(e.start).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
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
                if (await confirm({ title: 'Delete this event?', body: 'It is removed from your Outlook calendar too. If you organized a meeting, Outlook tells the people you invited.', danger: true, confirmLabel: 'Delete' })) {
                  await run('del', () => call('calendar.delete', { accountId: e.accountId, id: e.id }), 'Event deleted');
                  onClose();
                }
              }}
            >
              Delete
            </Button>
          )}
          <span className="fx-spacer" />
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
          <dt>Shows as</dt>
          <dd>{{ free: 'Free', tentative: 'Tentative', busy: 'Busy', oof: 'Away', workingElsewhere: 'Working elsewhere', unknown: 'Busy' }[e.showAs]}</dd>
        </dl>
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
      actions={
        <>
          <Button size="sm" variant="ghost" icon="refresh" loading={syncing} aria-label="Update now" title="Update now" onClick={onSync} />
          <Button size="sm" variant="ghost" icon="plus" aria-label="Add calendar" title="Add calendar" onClick={onAdd} />
        </>
      }
    >
      <div className="cal-accounts">
        {status.accounts.map((a) => (
          <div key={a.id} className={`cal-account${a.enabled ? '' : ' off'}`}>
            <div className="cal-account-head">
              <span className="cal-dot" style={{ background: a.color }} />
              <div className="cal-account-name">
                <b>{a.name}</b>
                <small className="private">{a.kind === 'microsoft' ? (a.address ?? 'Outlook / Microsoft 365') : `Link · ${a.address ?? ''}`}</small>
              </div>
              <Toggle checked={a.enabled} onChange={(v) => void run('t', () => call('calendar.update', { id: a.id, enabled: v }))} title={a.enabled ? 'Shown' : 'Hidden'} />
            </div>
            {a.kind === 'microsoft' && a.enabled && a.calendars.length > 1 && (
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
              {a.lastError ? (
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
            </div>
          </div>
        ))}
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
      title="Add a calendar"
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

// -------------------------------------------------------------------------------------------- new event

function NewEvent({ accounts, date, hour, onClose }: { accounts: CalendarAccount[]; date: Date; hour?: number; onClose: () => void }) {
  const targets = accounts.filter((a) => a.enabled && a.canWrite).flatMap((a) => a.calendars.filter((c) => c.canWrite).map((c) => ({ value: `${a.id}|${c.id}`, label: a.calendars.length > 1 ? `${a.name} · ${c.name}` : a.name, isDefault: c.isDefault })));
  const startHour = hour ?? Math.min(22, new Date().getHours() + 1);
  const [f, setF] = useState({ title: '', day: ymd(date), start: `${pad(startHour)}:00`, end: `${pad(startHour)}:30`, allDay: false, location: '', notes: '', target: (targets.find((t) => t.isDefault) ?? targets[0])?.value ?? '' });
  const { run, busy } = useAction();
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const save = () =>
    run(
      'save',
      async () => {
        const [accountId, calendarId] = f.target.split('|');
        await call('calendar.create', {
          accountId,
          calendarId,
          title: f.title.trim(),
          start: f.allDay ? f.day : new Date(`${f.day}T${f.start}`).toISOString(),
          end: f.allDay ? undefined : new Date(`${f.day}T${f.end}`).toISOString(),
          allDay: f.allDay,
          location: f.location.trim() || undefined,
          notes: f.notes.trim() || undefined,
        });
        onClose();
      },
      'Event added',
    );
  return (
    <Modal
      title="New event"
      onClose={onClose}
      footer={
        <>
          <span className="fx-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 'save'} disabled={!f.title.trim() || !f.target || (!f.allDay && f.end <= f.start)} onClick={() => void save()}>
            Add event
          </Button>
        </>
      }
    >
      <div className="fx-grid">
        <Field label="Title">
          <Input autoFocus value={f.title} onChange={(e) => set({ title: e.target.value })} maxLength={255} />
        </Field>
        <div className="fx-row">
          <Field label="Day">
            <Input type="date" value={f.day} onChange={(e) => set({ day: e.target.value })} />
          </Field>
          {!f.allDay && (
            <>
              <Field label="Starts">
                <Input type="time" value={f.start} onChange={(e) => set({ start: e.target.value, end: e.target.value >= f.end ? `${pad(Math.min(23, Number(e.target.value.slice(0, 2)) + 1))}:${e.target.value.slice(3)}` : f.end })} />
              </Field>
              <Field label="Ends" error={f.end <= f.start ? 'Ends before it starts' : undefined}>
                <Input type="time" value={f.end} onChange={(e) => set({ end: e.target.value })} />
              </Field>
            </>
          )}
        </div>
        <Toggle checked={f.allDay} onChange={(v) => set({ allDay: v })} label="All day" />
        <Field label="Where">
          <Input value={f.location} onChange={(e) => set({ location: e.target.value })} maxLength={255} />
        </Field>
        <Field label="Notes">
          <TextArea rows={3} value={f.notes} onChange={(e) => set({ notes: e.target.value })} maxLength={4000} />
        </Field>
        {targets.length > 1 && (
          <Field label="Calendar">
            <Select value={f.target} onChange={(e) => set({ target: e.target.value })} options={targets.map(({ value, label }) => ({ value, label }))} />
          </Field>
        )}
      </div>
    </Modal>
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
