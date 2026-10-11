import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MESSAGE_MAX_CHARS, type MessageThread, type ThreadMessage } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Icons, InfoTip, Input, Modal, Page, Spinner, TextArea, timeAgo, useAction, type IconName } from '@fbrx/ui';
import { call, onEvent } from '../client';
import { useCore } from '../hooks';
import { navigate, routeArg } from '../app';
import { useLearner, useTier, useVertical } from '../edition';

/**
 * Messages: chat with your other computers and your phone (FBRX Mesh, end to end) and with the computers in your
 * organization or family (FBRX Command passes those on). A household can talk here without the help desk.
 */
export function MessagesPage() {
  const overview = useCore('messages.overview', undefined, ['messages.changed', 'mesh.changed', 'fleet.changed', 'settings.changed'], 60_000);
  const [picked, setPicked] = useState<string | null>(() => routeArg());
  const [query, setQuery] = useState('');
  const [starting, setStarting] = useState(false);
  const ultra = useTier() === 'ultra';
  const learner = useLearner();
  const home = useVertical() === 'home';

  // A link to a conversation (Mesh & phone, a notification) picks it.
  useEffect(() => {
    const on = () => {
      if (location.hash.startsWith('#/messages')) setPicked(routeArg());
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const o = overview.data;
  const threads = o?.threads ?? [];
  // Nothing picked yet: open the conversation with something new in it (or the first), and stay there.
  useEffect(() => {
    if (!picked && threads.length) setPicked((threads.find((t) => t.unread > 0) ?? threads[0]).id);
  }, [picked, threads]);
  const current = threads.find((t) => t.id === picked) ?? null;
  const shown = query.trim() ? threads.filter((t) => `${t.title} ${t.subtitle ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())) : threads;
  const mesh = shown.filter((t) => t.place === 'mesh');
  const org = shown.filter((t) => t.place === 'org');
  const pick = (id: string) => {
    setPicked(id);
    navigate(`messages/${id}`);
  };

  if (o && !o.enabled) {
    return (
      <Page title="Messages" description="Chat with your other devices and the computers in your organization.">
        <Card>
          <Empty title="Messages are off" action={!learner && <Button onClick={() => navigate('settings/messages')}>Open Settings</Button>}>
            {o.mesh.note ?? 'Messages are turned off on this computer.'}
          </Empty>
        </Card>
      </Page>
    );
  }

  const orgName = o?.org.name ?? (home ? 'your family' : 'your organization');
  const meshNote = !ultra && !o?.mesh.on ? null : o?.mesh.note;
  return (
    <Page
      title="Messages"
      description={home ? 'Chat with the family’s computers and your own devices. Messages arrive the moment they are sent.' : 'Chat with your other devices and with the computers in your organization.'}
      actions={
        o?.org.on && (
          <Button variant="primary" icon="plus" onClick={() => setStarting(true)}>
            New message
          </Button>
        )
      }
    >
      {overview.error && <Callout tone="warning">{overview.error}</Callout>}
      {!o ? (
        <Card>
          <Empty title="Loading…" />
        </Card>
      ) : threads.length === 0 ? (
        <Card>
          <Empty title="Nobody to message yet">
            <div className="im-start">
              {o.org.note && <p>{o.org.note}</p>}
              {!o.org.name && <p>{home ? 'Join your family’s FBRX Command (Organization page) and every computer in it shows up here.' : 'Join your organization’s FBRX Command (Organization page) and its computers show up here.'}</p>}
              {meshNote && <p>{meshNote}</p>}
              <div className="fx-actions" style={{ justifyContent: 'center' }}>
                {!o.org.name && !learner && <Button onClick={() => navigate('fleet')}>Organization</Button>}
                {ultra && !learner && (
                  <Button icon="phone" onClick={() => navigate('mesh')}>
                    Mesh &amp; phone
                  </Button>
                )}
              </div>
            </div>
          </Empty>
        </Card>
      ) : (
        <div className="im-layout">
          <Card className="im-list" flush>
            <div className="im-search">
              <Icons.search size={14} />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search conversations" aria-label="Search conversations" />
            </div>
            <div className="private">
              {mesh.length > 0 && (
                <>
                  <div className="im-section">
                    My devices
                    <InfoTip>Your computers and phone on FBRX Mesh. Messages go straight between them, encrypted end to end; FBRX Command never sees them.</InfoTip>
                  </div>
                  {mesh.map((t) => (
                    <ThreadRow key={t.id} t={t} active={current?.id === t.id} onClick={() => pick(t.id)} />
                  ))}
                </>
              )}
              {org.length > 0 && (
                <>
                  <div className="im-section">
                    {o.org.name ?? 'Organization'}
                    <InfoTip>{home ? 'The family’s computers in FBRX Command. FBRX Command passes messages on and keeps them for 180 days.' : 'Computers in your organization. FBRX Command passes messages on and keeps them for 180 days; IT can read and remove what goes to everyone.'}</InfoTip>
                  </div>
                  {org.map((t) => (
                    <ThreadRow key={t.id} t={t} active={current?.id === t.id} onClick={() => pick(t.id)} />
                  ))}
                </>
              )}
              {!mesh.length && !org.length && <div className="im-none">Nothing matches “{query}”.</div>}
            </div>
            {(o.org.note || meshNote) && (
              <div className="im-notes">
                {o.org.note && <div>{o.org.note}</div>}
                {meshNote && <div>{meshNote}</div>}
              </div>
            )}
          </Card>
          {current ? (
            <ThreadView key={current.id} t={current} />
          ) : (
            <Card className="hd-empty">
              <Empty title="Pick a conversation">{picked ? 'That conversation is not here any more.' : 'Messages show here.'}</Empty>
            </Card>
          )}
        </div>
      )}
      {starting && (
        <NewMessage
          orgName={orgName}
          onClose={() => setStarting(false)}
          onPick={(id) => {
            setStarting(false);
            pick(id);
          }}
        />
      )}
    </Page>
  );
}

function threadIcon(t: Pick<MessageThread, 'kind' | 'subtitle' | 'place'>): IconName {
  if (t.kind === 'group') return t.place === 'org' ? 'users' : 'orbit';
  return t.subtitle === 'Phone' ? 'phone' : 'laptop';
}

function Avatar({ t }: { t: MessageThread }) {
  const Ico = Icons[threadIcon(t)];
  return (
    <span className={`im-avatar ${t.place}`}>
      <Ico size={16} />
      {t.online !== null && <span className={`im-dot${t.online ? ' on' : ''}`} title={t.online ? 'Online' : 'Offline'} />}
    </span>
  );
}

function ThreadRow({ t, active, onClick }: { t: MessageThread; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`im-row${active ? ' active' : ''}${t.unread ? ' unread' : ''}`} onClick={onClick}>
      <Avatar t={t} />
      <span className="im-row-main">
        <span className="im-row-top">
          <span className="im-title">{t.title}</span>
          {t.last && <span className="im-when">{shortTime(t.last.at)}</span>}
        </span>
        <span className="im-row-sub">
          <span className="im-preview">{t.last ? `${t.last.mine ? 'You: ' : t.kind === 'group' ? `${t.last.fromName}: ` : ''}${t.last.text}` : (t.subtitle ?? '')}</span>
          {t.unread > 0 && <span className="im-badge">{t.unread > 99 ? '99+' : t.unread}</span>}
        </span>
      </span>
    </button>
  );
}

function ThreadView({ t }: { t: MessageThread }) {
  const [msgs, setMsgs] = useState<ThreadMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const { run } = useAction();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const PAGE = 100;

  const load = useCallback(async () => {
    try {
      const rows = await call('messages.thread', { id: t.id, limit: PAGE });
      setMsgs(rows);
      setMore(rows.length >= PAGE);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setMsgs([]);
    }
  }, [t.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // This conversation is on screen: no pop-ups for it, and what arrives is read (not while the window is hidden).
  useEffect(() => {
    const focus = () => void call('messages.focus', { id: document.visibilityState === 'visible' ? t.id : null }).catch(() => undefined);
    focus();
    document.addEventListener('visibilitychange', focus);
    return () => {
      document.removeEventListener('visibilitychange', focus);
      void call('messages.focus', { id: null }).catch(() => undefined);
    };
  }, [t.id]);

  // New messages and delivery changes, as they happen.
  useEffect(
    () =>
      onEvent('messages.changed', (e) => {
        if (e.threadId !== t.id || !e.message) return;
        const m = e.message;
        setMsgs((xs) => {
          if (!xs) return xs;
          const i = xs.findIndex((x) => x.id === m.id);
          if (i >= 0) return xs.map((x, j) => (j === i ? m : x));
          return [...xs, m];
        });
      }),
    [t.id],
  );

  // Follow the conversation down, unless you scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const older = async () => {
    if (!msgs?.length) return;
    const el = scroller.current;
    const before = el?.scrollHeight ?? 0;
    const rows = await call('messages.thread', { id: t.id, before: msgs[0].at, limit: PAGE }).catch(() => []);
    setMore(rows.length >= PAGE);
    stick.current = false;
    setMsgs((xs) => [...rows.filter((r) => !xs?.some((x) => x.id === r.id)), ...(xs ?? [])]);
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - before;
    });
  };

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    stick.current = true;
    try {
      const m = await call('messages.send', { id: t.id, text: body });
      setText('');
      setMsgs((xs) => (xs?.some((x) => x.id === m.id) ? xs.map((x) => (x.id === m.id ? m : x)) : [...(xs ?? []), m]));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const groups = useMemo(() => groupMessages(msgs ?? []), [msgs]);
  const meta = t.kind === 'group' ? t.subtitle : t.online === null ? t.subtitle : `${t.subtitle ?? ''}${t.subtitle ? ' · ' : ''}${t.online ? 'online' : 'offline'}`;
  const tooLong = text.length > MESSAGE_MAX_CHARS;
  return (
    <Card className="im-view" flush>
      <div className="im-head">
        <Avatar t={t} />
        <div>
          <div className="im-head-title">{t.title}</div>
          <div className="im-head-sub">
            {meta}
            {t.place === 'mesh' ? ' · end-to-end encrypted' : ''}
          </div>
        </div>
      </div>
      <div
        className="im-thread private"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {msgs === null ? (
          <div className="im-loading">
            <Spinner />
          </div>
        ) : (
          <>
            {more && (
              <button type="button" className="im-older" onClick={() => void older()}>
                Show earlier messages
              </button>
            )}
            {msgs.length === 0 && !error && <div className="im-hello">{t.kind === 'group' ? `Say hello to ${t.title.replace(/^Everyone (on|at) /, '')}.` : `Say hello to ${t.title}.`}</div>}
            {groups.map((g) => (
              <Fragment key={g.key}>
                {g.day && <div className="im-day">{g.day}</div>}
                <div className={`im-group${g.mine ? ' mine' : ''}`}>
                  {!g.mine && (t.kind === 'group' || g.admin) && (
                    <div className="im-from">
                      {g.fromName}
                      {g.admin && <span className="im-admin">FBRX Command</span>}
                    </div>
                  )}
                  {g.items.map((m) => (
                    <div key={m.id} className={`im-bubble${m.state === 'failed' ? ' failed' : m.state === 'waiting' ? ' waiting' : ''}`} title={new Date(m.at).toLocaleString()}>
                      {m.text}
                    </div>
                  ))}
                  <div className="im-meta">
                    {shortTime(g.items[g.items.length - 1].at)}
                    <Delivery m={g.items[g.items.length - 1]} onRetry={(id) => void run(id, () => call('messages.resend', { messageId: id }))} />
                  </div>
                </div>
              </Fragment>
            ))}
          </>
        )}
      </div>
      {error && (
        <div style={{ padding: '0 14px' }}>
          <Callout tone="warning">{error}</Callout>
        </div>
      )}
      <div className="im-compose">
        {t.cannotSend ? (
          <div className="fx-muted" style={{ fontSize: 13 }}>
            {t.cannotSend}
          </div>
        ) : (
          <>
            <TextArea
              rows={Math.min(6, Math.max(1, text.split('\n').length))}
              value={text}
              placeholder={`Message ${t.kind === 'group' ? t.title.replace(/^Everyone/, 'everyone') : t.title}`}
              aria-label="Message"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <Button variant="primary" icon="send" loading={sending} disabled={!text.trim() || tooLong} onClick={() => void send()} aria-label="Send">
              Send
            </Button>
          </>
        )}
      </div>
      {tooLong && <div className="im-limit">Up to {MESSAGE_MAX_CHARS} characters ({text.length} now).</div>}
    </Card>
  );
}

function Delivery({ m, onRetry }: { m: ThreadMessage; onRetry: (id: string) => void }) {
  if (!m.mine || !m.state) return null;
  if (m.state === 'waiting')
    return (
      <span className="im-state waiting" title={m.error ?? undefined}>
        <Icons.clock size={11} /> waiting
      </span>
    );
  if (m.state === 'failed')
    return (
      <span className="im-state failed">
        <Icons.alert size={11} /> {m.error ?? 'not delivered'}
        {m.threadId !== 'mesh:all' && (
          <button type="button" onClick={() => onRetry(m.id)}>
            Try again
          </button>
        )}
      </span>
    );
  return m.error ? <span className="im-state">{m.error}</span> : null;
}

/** Runs of messages from one sender, a few minutes apart, with a line where the day changes. */
function groupMessages(msgs: ThreadMessage[]) {
  const out: Array<{ key: string; day: string | null; mine: boolean; fromName: string; admin: boolean; items: ThreadMessage[] }> = [];
  let lastDay = '';
  for (const m of msgs) {
    const day = new Date(m.at).toDateString();
    const prev = out[out.length - 1];
    const prevMsg = prev?.items[prev.items.length - 1];
    // A message still waiting or not delivered stands on its own, so its note sits right under it.
    const settled = (x: ThreadMessage) => (x.state ?? 'sent') === 'sent' && !x.error;
    const sameRun = prev && day === lastDay && prev.mine === m.mine && prev.fromName === m.fromName && Date.parse(m.at) - Date.parse(prevMsg.at) < 5 * 60_000 && settled(m) && settled(prevMsg);
    if (sameRun) prev.items.push(m);
    else out.push({ key: m.id, day: day !== lastDay ? dayLabel(m.at) : null, mine: m.mine, fromName: m.fromName, admin: !!m.fromAdmin, items: [m] });
    lastDay = day;
  }
  return out;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(Date.now() - 86400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Date.now() - d.getTime() < 60_000) return 'now';
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (Date.now() - d.getTime() < 6 * 86400_000) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return timeAgo(iso);
}

function NewMessage({ orgName, onClose, onPick }: { orgName: string; onClose: () => void; onPick: (id: string) => void }) {
  const dir = useCore('messages.directory');
  const [q, setQ] = useState('');
  const list = (dir.data ?? []).filter((x) => `${x.title} ${x.subtitle}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Modal title="New message" description={`Pick a computer in ${orgName}, or everyone at once.`} onClose={onClose} footer={<Button onClick={onClose}>Cancel</Button>}>
      <div className="fx-form">
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name" aria-label="Search computers" />
        {dir.error && <Callout tone="warning">{dir.error}</Callout>}
        <div className="im-pick">
          <button type="button" className="im-row" onClick={() => onPick('org:all')}>
            <span className="im-avatar org">
              <Icons.users size={16} />
            </span>
            <span className="im-row-main">
              <span className="im-title">Everyone at {orgName}</span>
            </span>
          </button>
          {!dir.data ? (
            <div className="im-loading">
              <Spinner />
            </div>
          ) : (
            list.map((x) => (
              <button key={x.id} type="button" className="im-row" onClick={() => onPick(x.id)}>
                <span className="im-avatar org">
                  <Icons.laptop size={16} />
                  <span className={`im-dot${x.online ? ' on' : ''}`} />
                </span>
                <span className="im-row-main">
                  <span className="im-title">{x.title}</span>
                  <span className="im-preview">
                    {x.subtitle} · {x.online ? 'online' : 'offline'}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}

