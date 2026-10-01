import { useEffect, useMemo, useRef, useState } from 'react';
import type { SpotlightItem } from '@fbrx/shared';
import { Icons, Spinner, type IconName } from '@fbrx/ui';
import { bridge, call } from '../client';
import { Markdown } from '../markdown';

const KIND_ICON: Record<SpotlightItem['kind'], IconName> = {
  app: 'grid',
  file: 'file',
  page: 'dashboard',
  command: 'settings',
  calc: 'code',
  convert: 'refresh',
  web: 'globe',
  ask: 'sparkles',
  note: 'note',
  task: 'tasks',
  snippet: 'code',
  recent: 'history',
};
const KIND_LABEL: Partial<Record<SpotlightItem['kind'], string>> = { app: 'Apps', file: 'Files', page: 'FBRX OS', command: 'Settings & commands', note: 'Notes', task: 'Tasks', snippet: 'Snippets', recent: 'Recent' };

/** The Spotlight launcher (its own small window, opened with the global hotkey). */
export function SpotlightView({ agentName }: { agentName: string }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<SpotlightItem[]>([]);
  const [files, setFiles] = useState<SpotlightItem[]>([]);
  const [sel, setSel] = useState(0);
  const [answer, setAnswer] = useState<{ q: string; text: string | null } | null>(null);
  const [confirmItem, setConfirmItem] = useState<SpotlightItem | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.body.classList.add('spotlight-body');
    const focus = () => {
      input.current?.focus();
      input.current?.select();
    };
    focus();
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, []);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => void call('spotlight.query', { q }).then((r) => alive && (setItems(r), setSel(0))).catch(() => undefined), 40);
    const f = setTimeout(() => (q.trim().length >= 2 ? void call('spotlight.files', { q }).then((r) => alive && setFiles(r)).catch(() => undefined) : setFiles([])), 220);
    setAnswer(null);
    setConfirmItem(null);
    setMessage(null);
    return () => {
      alive = false;
      clearTimeout(t);
      clearTimeout(f);
    };
  }, [q]);

  // Merge file hits in before the trailing "ask" and "web" rows.
  const merged = useMemo(() => {
    const tail = items.filter((i) => i.kind === 'ask' || i.kind === 'web');
    const head = items.filter((i) => i.kind !== 'ask' && i.kind !== 'web');
    return [...head, ...files.slice(0, 8), ...tail];
  }, [items, files]);

  const hide = () => {
    setQ('');
    bridge.spotlightHide?.();
  };

  const exec = async (item: SpotlightItem, modifier?: 'reveal') => {
    const a = item.action;
    if (a.type === 'system' && a.confirm && confirmItem?.id !== item.id) {
      setConfirmItem(item);
      return;
    }
    if (a.type === 'copy') {
      bridge.copyText ? await bridge.copyText(a.text) : await navigator.clipboard.writeText(a.text);
      void call('spotlight.run', { item });
      setMessage('Copied');
      setTimeout(hide, 350);
      return;
    }
    try {
      const r = await call('spotlight.run', { item, modifier });
      if (r.navigate) bridge.openMain?.(r.navigate);
      else if (r.ask) bridge.openMain?.(`agent/ask/${encodeURIComponent(r.ask)}`);
      hide();
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  const quickAnswer = async () => {
    if (!q.trim()) return;
    setAnswer({ q, text: null });
    try {
      const r = await call('spotlight.ask', { q });
      setAnswer({ q, text: r.answer });
    } catch (e) {
      setAnswer({ q, text: `_${(e as Error).message}_` });
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (confirmItem) setConfirmItem(null);
      else if (q) setQ('');
      else hide();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(merged.length - 1, s + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === 'Tab') {
      e.preventDefault();
      void quickAnswer();
    } else if (e.key === 'Enter' && merged[sel]) {
      e.preventDefault();
      void exec(merged[sel], e.ctrlKey || e.metaKey ? 'reveal' : undefined);
    }
  };

  useEffect(() => {
    list.current?.querySelector('.sp-item.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  let lastGroup = '';
  return (
    <div className="sp" onKeyDown={onKey}>
      <div className="sp-search">
        <Icons.search size={20} />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search apps, files, settings — or ask ${agentName}`} aria-label="Spotlight search" spellCheck={false} />
        <kbd className="kbd">Esc</kbd>
      </div>
      {answer ? (
        <div className="sp-answer">
          <div className="sp-answer-head">
            <Icons.sparkles size={14} /> {agentName}
            <span className="fx-spacer" />
            <button className="linklike" onClick={() => bridge.openMain?.(`agent/ask/${encodeURIComponent(answer.q)}`)}>
              Continue in FBRX
            </button>
          </div>
          {answer.text === null ? <Spinner /> : <Markdown text={answer.text} />}
        </div>
      ) : (
        <div className="sp-list" ref={list} role="listbox">
          {merged.map((it, i) => {
            const Ico = Icons[KIND_ICON[it.kind] ?? 'search'];
            const group = KIND_LABEL[it.kind] ?? (i === 0 && it.score >= 100 ? 'Top hit' : '');
            const header = group && group !== lastGroup ? group : null;
            if (group) lastGroup = group;
            return (
              <div key={it.id + i}>
                {header && <div className="sp-group">{header}</div>}
                <div className={`sp-item${i === sel ? ' sel' : ''}`} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => void exec(it)}>
                  <span className="sp-icon">
                    <Ico size={16} />
                  </span>
                  <div className="sp-text">
                    <div className="sp-title">{it.title}</div>
                    {it.subtitle && <div className="sp-sub">{it.subtitle}</div>}
                  </div>
                  {confirmItem?.id === it.id ? <span className="sp-confirm">Press Enter again to confirm</span> : i === sel && <kbd className="kbd">↵</kbd>}
                </div>
              </div>
            );
          })}
          {!merged.length && <div className="sp-empty">Type to search</div>}
        </div>
      )}
      <div className="sp-foot">
        {message ?? (
          <>
            <span><kbd className="kbd">↑↓</kbd> move</span>
            <span><kbd className="kbd">↵</kbd> open</span>
            <span><kbd className="kbd">Ctrl ↵</kbd> show in folder</span>
            <span><kbd className="kbd">Tab</kbd> quick answer from {agentName}</span>
          </>
        )}
      </div>
    </div>
  );
}
