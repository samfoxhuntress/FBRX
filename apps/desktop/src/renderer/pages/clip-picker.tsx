import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pasteFormats } from '@fbrx/shared';
import { Icons, timeAgo } from '@fbrx/ui';
import { bridge, clipHistory, type ClipEntry } from '../client';
import { useCore } from '../hooks';

/**
 * The clipboard history window (the Ctrl+Alt+Z macro), like Windows' Win+V: your recent copies, newest first.
 *
 * - W / S or ↑ / ↓ move through the list.
 * - Tab and ~ slide right and left through ways to paste the chosen copy: as copied, cleaned up, on one line,
 *   UPPERCASE…, then your saved clipboard transforms.
 * - Typing anything else searches (then W and S type as letters; the arrows still move).
 * - Enter pastes it into the app you were in. Delete removes it, Ctrl+P pins it, Esc clears the search or closes.
 */

const shortcut = (accel: string) => accel.replace(/CommandOrControl|Control/g, 'Ctrl').replace(/Command/g, '⌘').replace(/Option/g, 'Alt');

export function ClipPicker() {
  const settings = useCore('settings.get', undefined, ['settings.changed']).data?.settings;
  const presenter = useCore('presenter.status', undefined, ['presenter.changed']);
  // Presenter-safe mode: copies show as dots (they still paste, and search still finds them).
  const masked = !!presenter.data?.active && presenter.data.maskClipboard;
  const mask = (t: string) => `•••••••• ${t.length} character${t.length === 1 ? '' : 's'}${t.includes('\n') ? `, ${t.split('\n').length} lines` : ''}`;
  const [state, setState] = useState<{ enabled: boolean; entries: ClipEntry[] } | null>(null);
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [sel, setSel] = useState(0);
  const [fmt, setFmt] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => void clipHistory().then((s) => s && setState(s)), []);
  useEffect(() => {
    document.body.classList.add('spotlight-body');
    refresh();
    const offClips = bridge.onClips?.((entries) => setState((s) => ({ enabled: s?.enabled ?? true, entries: entries as ClipEntry[] })));
    // Every time it opens: back to the newest copy, no search.
    const offShown = bridge.onClipPicker?.((what) => {
      if (what !== 'shown') return;
      setQ('');
      setSearching(false);
      setSel(0);
      setFmt(0);
      setNote(null);
      search.current?.blur();
      refresh();
      presenter.reload();
    });
    return () => {
      offClips?.();
      offShown?.();
    };
  }, [refresh]);

  const items = useMemo(() => {
    const all = state?.entries ?? [];
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((e) => e.text.toLowerCase().includes(needle)) : all;
  }, [state, q]);
  const current = items[Math.min(sel, items.length - 1)];
  const formats = useMemo(() => (current ? pasteFormats(current.text, settings?.clipboard.macros ?? []) : []), [current, settings?.clipboard.macros]);
  const format = formats[Math.min(fmt, formats.length - 1)];

  useEffect(() => setFmt(0), [current?.id]);
  useEffect(() => {
    if (sel >= items.length) setSel(Math.max(0, items.length - 1));
  }, [items.length, sel]);
  useEffect(() => {
    list.current?.querySelector('.cp-item.on')?.scrollIntoView({ block: 'nearest' });
  }, [sel, items]);
  useEffect(() => {
    document.querySelector('.cp-chip.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [fmt, current?.id]);

  const close = () => void bridge.clipPicker?.('hide');
  const paste = async (text: string) => {
    const r = (await bridge.clipPicker?.('paste', text)) as { pasted: boolean } | undefined;
    if (r && !r.pasted) {
      setNote(bridge.platform === 'darwin' ? 'Copied. Press ⌘V to paste.' : 'Copied. Press Ctrl+V to paste.');
      setTimeout(close, 900);
    }
  };
  const enable = async () => {
    const s = (await bridge.clipPicker?.('enable')) as { enabled: boolean; entries: ClipEntry[] } | undefined;
    if (s) setState(s);
    if (s && !s.enabled) setNote('Your organization keeps the clipboard history off.');
  };
  const move = (d: number) => setSel((i) => Math.min(Math.max(0, i + d), Math.max(0, items.length - 1)));
  const slide = (d: number) => formats.length && setFmt((i) => (i + d + formats.length) % formats.length);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = document.activeElement === search.current;
      const k = e.key;
      if (k === 'Escape') {
        e.preventDefault();
        if (q) {
          setQ('');
          setSearching(false);
          search.current?.blur();
        } else close();
      } else if (k === 'Enter') {
        e.preventDefault();
        if (!state?.enabled) void enable();
        else if (format) void paste(format.text);
      } else if (k === 'ArrowDown' || (!typing && (k === 's' || k === 'S'))) {
        e.preventDefault();
        move(1);
      } else if (k === 'ArrowUp' || (!typing && (k === 'w' || k === 'W'))) {
        e.preventDefault();
        move(-1);
      } else if (k === 'Tab') {
        e.preventDefault();
        slide(e.shiftKey ? -1 : 1);
      } else if (e.code === 'Backquote' || k === '`' || k === '~') {
        e.preventDefault();
        slide(-1);
      } else if (k === 'ArrowRight' && !typing) {
        e.preventDefault();
        slide(1);
      } else if (k === 'ArrowLeft' && !typing) {
        e.preventDefault();
        slide(-1);
      } else if (k === 'PageDown' || k === 'End') {
        e.preventDefault();
        move(k === 'End' ? items.length : 8);
      } else if (k === 'PageUp' || k === 'Home') {
        e.preventDefault();
        move(k === 'Home' ? -items.length : -8);
      } else if (k === 'Delete' && current && !typing) {
        e.preventDefault();
        void clipHistory('remove', current.id).then((s) => s && setState(s));
      } else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'p' && current) {
        e.preventDefault();
        void clipHistory('pin', current.id, !current.pinned).then((s) => s && setState(s));
      } else if (!typing && k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && k !== ' ') {
        // Anything else starts a search.
        e.preventDefault();
        setQ(k);
        setSearching(true);
        setSel(0);
        requestAnimationFrame(() => search.current?.focus());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const hotkey = settings?.clipboard.hotkey ? shortcut(settings.clipboard.hotkey) : null;
  return (
    <div className="cp" role="dialog" aria-label="Clipboard history">
      <div className="cp-head">
        <Icons.clipboard size={16} />
        <span className="cp-title">Clipboard history</span>
        {hotkey && <kbd className="kbd">{hotkey}</kbd>}
        {masked && <span className="cp-presenting" title="Presenter-safe mode is on">Presenting</span>}
        <span className="fx-spacer" />
        <button className="cp-close" onClick={close} aria-label="Close">
          <Icons.x size={14} />
        </button>
      </div>
      <div className={`cp-search${searching || q ? ' on' : ''}`}>
        <Icons.search size={14} />
        <input
          ref={search}
          value={q}
          placeholder="Type to search your copies"
          aria-label="Search the clipboard history"
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
            if (!e.target.value) {
              setSearching(false);
              search.current?.blur();
            }
          }}
          onFocus={() => setSearching(true)}
          onBlur={() => setSearching(false)}
        />
      </div>

      {!state ? null : !state.enabled ? (
        <div className="cp-empty">
          <b>Clipboard history is off</b>
          <span>Turn it on and FBRX keeps your last 50 copies so you can paste any of them again. Kept in memory only, never saved to disk; copies that password managers mark as secret are skipped.</span>
          <button className="fx-btn primary sm" onClick={() => void enable()}>
            Turn on (Enter)
          </button>
        </div>
      ) : !items.length ? (
        <div className="cp-empty">
          <b>{q ? 'Nothing matches' : 'Nothing copied yet'}</b>
          <span>{q ? 'Try another word, or Esc to clear the search.' : 'Copy some text anywhere and it shows up here, newest first.'}</span>
        </div>
      ) : (
        <>
          <div className="cp-list" ref={list} role="listbox" aria-label="Copies, newest first">
            {items.map((e, i) => (
              <button
                key={e.id}
                role="option"
                aria-selected={e === current}
                className={`cp-item${e === current ? ' on' : ''}${e.pinned ? ' pinned' : ''}`}
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={() => setSel(i)}
                onDoubleClick={() => void paste(e === current && format ? format.text : e.text)}
              >
                <span className={`cp-text${masked ? ' cp-masked' : ''}`}>{masked ? mask(e.text) : e.text.length > 400 ? `${e.text.slice(0, 400)}…` : e.text}</span>
                <span className="cp-meta">
                  {e.pinned && <Icons.bookmark size={11} />} {timeAgo(e.at)}
                  {e.text.includes('\n') ? ` · ${e.text.split('\n').length} lines` : ''}
                </span>
              </button>
            ))}
          </div>
          {current && formats.length > 0 && (
            <div className="cp-formats">
              <div className="cp-slider" role="tablist" aria-label="Paste as">
                <kbd className="kbd" title="Previous format">~</kbd>
                <div className="cp-chips">
                  {formats.map((f, i) => (
                    <button key={f.id} role="tab" aria-selected={f === format} className={`cp-chip${f === format ? ' on' : ''}`} onMouseDown={(ev) => ev.preventDefault()} onClick={() => setFmt(i)}>
                      {f.label}
                    </button>
                  ))}
                </div>
                <kbd className="kbd" title="Next format">Tab</kbd>
              </div>
              {format && format.id !== 'original' && !masked && <pre className="cp-preview">{format.text.length > 500 ? `${format.text.slice(0, 500)}…` : format.text}</pre>}
            </div>
          )}
        </>
      )}
      <div className="cp-foot">{note ?? (searching ? '↑ ↓ move · Tab ~ format · Enter paste · Esc clear' : 'W S move · Tab ~ format · type to search · Enter paste · Esc close')}</div>
    </div>
  );
}
