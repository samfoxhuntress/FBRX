import { useEffect, useMemo, useState } from 'react';
import type { EventLevel, EventLogEntry } from '@fbrx/shared';
import { EVENT_LEVELS } from '@fbrx/shared';
import { BarList, Button, Callout, Card, Empty, Icons, Input, KeyValue, Select, Spinner, formatDate, type Column, Table, useToast } from '@fbrx/ui';
import { call, openExternal, writeClipboard } from '../client';
import { useCore } from '../hooks';
import { QuickAiPanel, useQuickAi } from '../quick-ai';

/**
 * Event Viewer: Windows event logs (or the systemd journal / macOS unified log), filtered by level, time, source and
 * event ID, with Fabrix beside it to explain a single event or make sense of the whole list.
 */

const LEVEL_LABEL: Record<EventLevel, string> = { critical: 'Critical', error: 'Error', warning: 'Warning', information: 'Information' };
const RANGES = [
  { value: '1', label: 'Last hour' },
  { value: '6', label: 'Last 6 hours' },
  { value: '24', label: 'Last 24 hours' },
  { value: '72', label: 'Last 3 days' },
  { value: '168', label: 'Last 7 days' },
  { value: '720', label: 'Last 30 days' },
];

function LevelIcon({ level }: { level: EventLevel }) {
  const Ico = level === 'critical' ? Icons.octagon : level === 'error' ? Icons.xCircle : level === 'warning' ? Icons.alert : Icons.info;
  return <Ico size={14} className={`ev-ico ${level}`} aria-label={LEVEL_LABEL[level]} />;
}

const firstLine = (m: string) => m.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
const describe = (e: EventLogEntry) =>
  [`Log: ${e.log}`, `Level: ${LEVEL_LABEL[e.level]}`, `Time: ${e.time}`, `Source: ${e.source}`, e.eventId ? `Event ID: ${e.eventId}` : '', e.task ? `Task: ${e.task}` : '', e.pid ? `Process ID: ${e.pid}` : '', `Message:\n${e.message}`].filter(Boolean).join('\n');

export function EventViewer() {
  const logs = useCore('events.logs');
  const [log, setLog] = useState('');
  const [levels, setLevels] = useState<EventLevel[]>(['critical', 'error', 'warning']);
  const [hours, setHours] = useState('24');
  const [source, setSource] = useState('');
  const [eventId, setEventId] = useState('');
  const [data, setData] = useState<{ entries: EventLogEntry[]; note: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<EventLogEntry | null>(null);
  const [q, setQ] = useState('');
  const ai = useQuickAi();
  const toast = useToast();

  useEffect(() => {
    if (!log && logs.data?.length) setLog(logs.data[0].id);
  }, [logs.data, log]);

  const load = async () => {
    if (!log) return;
    setLoading(true);
    setError(null);
    try {
      const id = eventId.trim() ? Number(eventId) : undefined;
      setData(await call('events.query', { log, levels, hours: Number(hours), source: source.trim() || undefined, eventId: id !== undefined && Number.isFinite(id) ? id : undefined, limit: 500 }));
      setSelected(null);
    } catch (e) {
      setError((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  };
  // Reload when the log, levels or time range change; source and ID apply with Enter or the button.
  useEffect(() => {
    void load();
  }, [log, levels.join(','), hours]); // eslint-disable-line react-hooks/exhaustive-deps

  const entries = useMemo(() => {
    const all = data?.entries ?? [];
    const s = q.trim().toLowerCase();
    return s ? all.filter((e) => `${e.source} ${e.eventId} ${e.message}`.toLowerCase().includes(s)) : all;
  }, [data, q]);
  const counts = useMemo(() => {
    const c: Record<EventLevel, number> = { critical: 0, error: 0, warning: 0, information: 0 };
    for (const e of data?.entries ?? []) c[e.level]++;
    return c;
  }, [data]);
  const topSources = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) m.set(e.source, (m.get(e.source) ?? 0) + 1);
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([label, value]) => ({ key: label, label, value }));
  }, [entries]);

  const logName = logs.data?.find((l) => l.id === log)?.name ?? log;
  const digest = () => {
    // Group repeats so a chatty source doesn't crowd out the rest.
    const groups = new Map<string, { e: EventLogEntry; n: number; last: string }>();
    for (const e of entries) {
      const k = `${e.source}|${e.eventId}|${firstLine(e.message).slice(0, 80)}`;
      const g = groups.get(k);
      if (g) g.n++;
      else groups.set(k, { e, n: 1, last: e.time });
    }
    return [...groups.values()]
      .slice(0, 60)
      .map(({ e, n, last }) => `[${LEVEL_LABEL[e.level]}] ${e.source}${e.eventId ? ` (ID ${e.eventId})` : ''} ×${n}, latest ${last}: ${firstLine(e.message).slice(0, 240)}`)
      .join('\n');
  };
  const scope = `${logName} log, ${RANGES.find((r) => r.value === hours)?.label.toLowerCase()}, levels: ${levels.map((l) => LEVEL_LABEL[l]).join(', ')}`;
  const toggle = (l: EventLevel) => setLevels((ls) => (ls.includes(l) ? (ls.length > 1 ? ls.filter((x) => x !== l) : ls) : [...ls, l]));

  const columns: Column<EventLogEntry>[] = [
    { key: 'level', header: '', render: (e) => <LevelIcon level={e.level} />, width: 30 },
    { key: 'time', header: 'Time', render: (e) => <span className="ev-time">{formatDate(e.time)}</span>, width: 150 },
    { key: 'source', header: 'Source', render: (e) => <span className="ev-source" title={e.source}>{e.source}</span>, width: 190 },
    { key: 'id', header: 'ID', render: (e) => <span className="mono">{e.eventId || '—'}</span>, width: 64 },
    { key: 'msg', header: 'Message', render: (e) => <span className="ev-msg">{firstLine(e.message)}</span> },
  ];

  return (
    <div className="tm-layout">
      <div className="ev-main">
        <Card flush>
          <div className="ev-filters">
            <div className="ev-filter-log">
              <Select aria-label="Event log" value={log} onChange={(e) => setLog(e.target.value)} options={(logs.data ?? []).map((l) => ({ value: l.id, label: `${l.name}${l.admin ? ' (admin)' : ''}` }))} />
            </div>
            <div className="seg" role="group" aria-label="Levels">
              {EVENT_LEVELS.map((l) => (
                <button key={l} className={levels.includes(l) ? 'on' : ''} aria-pressed={levels.includes(l)} onClick={() => toggle(l)}>
                  <LevelIcon level={l} /> {LEVEL_LABEL[l]}
                  {data && <span className="ev-count">{counts[l]}</span>}
                </button>
              ))}
            </div>
            <div className="ev-filter-range">
              <Select aria-label="Time range" value={hours} onChange={(e) => setHours(e.target.value)} options={RANGES} />
            </div>
            <Input className="ev-filter-src" value={source} placeholder="Source" aria-label="Source" onChange={(e) => setSource(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void load()} />
            <Input className="ev-filter-id" value={eventId} placeholder="Event ID" aria-label="Event ID" inputMode="numeric" onChange={(e) => setEventId(e.target.value.replace(/\D/g, '').slice(0, 5))} onKeyDown={(e) => e.key === 'Enter' && void load()} />
            <Button size="sm" icon="refresh" loading={loading} onClick={() => void load()}>
              Refresh
            </Button>
          </div>
          {logs.data?.find((l) => l.id === log)?.description && <div className="ev-desc">{logs.data.find((l) => l.id === log)!.description}</div>}
        </Card>

        {error && <Callout tone="critical" title="Could not read the log">{error}</Callout>}
        {data?.note && <Callout tone="info">{data.note}</Callout>}

        <Card
          title={data ? `${entries.length.toLocaleString()} event${entries.length === 1 ? '' : 's'}${entries.length === 500 ? ' (newest 500)' : ''}` : 'Events'}
          actions={
            <div style={{ width: 220 }}>
              <Input value={q} placeholder="Search these events" aria-label="Search events" onChange={(e) => setQ(e.target.value)} />
            </div>
          }
          flush
        >
          <div className="ev-table">
            {loading && !data ? (
              <div className="ev-loading">
                <Spinner /> Reading the {logName} log…
              </div>
            ) : (
              <Table columns={columns} rows={entries} rowKey={(e) => `${e.time}-${e.recordId ?? ''}-${e.source}-${e.eventId}`} onRowClick={setSelected} empty={<Empty title="No events">Nothing matches in this time range. That's usually good news.</Empty>} />
            )}
          </div>
        </Card>

        {selected && (
          <Card
            title={
              <span className="ev-detail-title">
                <LevelIcon level={selected.level} /> {selected.source}
                {selected.eventId ? ` · Event ${selected.eventId}` : ''}
              </span>
            }
            subtitle={formatDate(selected.time)}
            actions={
              <>
                <Button size="sm" className="ask-btn" icon="sparkles" disabled={ai.busy} onClick={() => void ai.ask(`Explain ${selected.source}${selected.eventId ? ` ${selected.eventId}` : ''}`, 'Explain this event log entry in plain language: what happened, whether it matters, the usual causes, and what I should do about it (if anything). Say clearly if it is harmless noise.', describe(selected))}>
                  Explain this event
                </Button>
                <Button size="sm" variant="ghost" icon="copy" aria-label="Copy the event" onClick={() => void writeClipboard(describe(selected)).then(() => toast.success('Copied'))} />
                <Button size="sm" variant="ghost" icon="globe" aria-label="Search the web for this event" title="Search the web" onClick={() => openExternal(`https://www.bing.com/search?q=${encodeURIComponent(`${selected.source} event ${selected.eventId || ''} ${firstLine(selected.message).slice(0, 80)}`)}`)} />
                <Button size="sm" variant="ghost" icon="x" aria-label="Close" onClick={() => setSelected(null)} />
              </>
            }
          >
            <pre className="ev-detail-msg">{selected.message || '(no message)'}</pre>
            <KeyValue
              items={[
                ['Log', selected.log],
                ['Level', LEVEL_LABEL[selected.level]],
                ...(selected.recordId ? ([['Record', String(selected.recordId)]] as Array<[string, string]>) : []),
                ...(selected.task ? ([['Task', selected.task]] as Array<[string, string]>) : []),
                ...(selected.user ? ([['User', selected.user]] as Array<[string, string]>) : []),
                ...(selected.pid ? ([['Process ID', String(selected.pid)]] as Array<[string, string]>) : []),
              ]}
            />
          </Card>
        )}
      </div>

      <div className="tm-side">
        {topSources.length > 0 && (
          <Card title="Most frequent sources">
            <BarList items={topSources} format={(n) => `${n} event${n === 1 ? '' : 's'}`} />
          </Card>
        )}
        <QuickAiPanel
          ai={ai}
          className="tm-ai"
          onAsk={(t) => void ai.ask(t, t, `Events from the ${scope}:\n${digest()}${selected ? `\n\nThe event I selected:\n${describe(selected)}` : ''}`)}
          empty="Click an event to have it explained, or ask about the whole list."
          actions={
            <>
              <Button size="sm" disabled={!entries.length || ai.busy} onClick={() => void ai.ask('Analyze these events', 'Here are events from my computer\'s log (repeats grouped). Tell me what is going on: group related events, say which ones matter and which are harmless noise, the likely causes, and what to do first. Keep it practical.', `Events from the ${scope}:\n${digest()}`)}>
                Analyze these events
              </Button>
              <Button size="sm" disabled={!entries.length || ai.busy} onClick={() => void ai.ask('What should I fix first?', 'From these events, pick the three problems most worth fixing on this computer, in order, with the steps to fix each.', `Events from the ${scope}:\n${digest()}`)}>
                What to fix first?
              </Button>
            </>
          }
        />
      </div>
    </div>
  );
}
