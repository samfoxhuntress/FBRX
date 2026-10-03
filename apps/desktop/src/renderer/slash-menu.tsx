import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { Settings, Snippet } from '@fbrx/shared';
import { expandMacro, slashAt } from '@fbrx/shared';
import { Icons } from '@fbrx/ui';
import { call, readClipboard } from './client';
import { useCore } from './hooks';
import { navigate } from './app';

/**
 * The "/" menu: type a slash in the chat, the Terminal, FBRX/1 or the clipboard editor and your quick snippets pop up.
 * "/snip" lists the snippet library (keep typing to search it). Quick snippets are edited in Settings → Snippets.
 */

export type SlashScope = 'chat' | 'terminal' | 'text';

interface Item {
  key: string;
  title: string;
  hint: string;
  icon: 'zap' | 'bookmark' | 'copy' | 'clock' | 'settings';
  /** The text that replaces "/word", or null when the item handles it itself. */
  apply: () => Promise<{ text: string; cursor?: number } | null>;
}

export const RESERVED_TRIGGERS = ['snip', 'clip', 'date', 'time', 'now', 'snippets', 'macros'];

let hostCache: string | null = null;
async function hostName(): Promise<string> {
  if (hostCache === null) hostCache = await call('sysinfo.static').then((s) => s.os.hostname, () => '');
  return hostCache;
}

async function expand(text: string, s: Settings | undefined) {
  const needsClip = /\{clipboard\}/i.test(text);
  return expandMacro(text, {
    name: s?.profile.name ?? '',
    callMe: s?.profile.callMe ?? '',
    host: /\{host\}/i.test(text) ? await hostName() : '',
    clipboard: needsClip ? await readClipboard() : undefined,
  });
}

export function useSlashMenu<T extends HTMLTextAreaElement | HTMLInputElement>(opts: { value: string; setValue: (v: string) => void; inputRef: RefObject<T | null>; scope: SlashScope }): {
  menu: ReactNode;
  /** Call first in the input's onKeyDown; true means the menu used the key. */
  onKeyDown: (e: KeyboardEvent) => boolean;
} {
  const { value, setValue, inputRef, scope } = opts;
  const settings = useCore('settings.get', undefined, ['settings.changed']).data?.settings;
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [snippets, setSnippets] = useState<Snippet[] | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Follow the caret and focus from the input itself, so pages only pass a ref. Not on "input": updating state in
  // the middle of that event re-renders the controlled box before React's onChange sees the new text, which would
  // swallow the keystroke. The caret after typing is read once React has committed the new value (below).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const sync = () => setCaret(el.selectionStart ?? el.value.length);
    const on = () => {
      setFocused(true);
      sync();
    };
    const off = () => setTimeout(() => setFocused(document.activeElement === el), 120);
    el.addEventListener('keyup', sync);
    el.addEventListener('click', sync);
    el.addEventListener('focus', on);
    el.addEventListener('blur', off);
    if (document.activeElement === el) on();
    return () => {
      el.removeEventListener('keyup', sync);
      el.removeEventListener('click', sync);
      el.removeEventListener('focus', on);
      el.removeEventListener('blur', off);
    };
  }, [inputRef]);
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el && document.activeElement === el) setCaret(el.selectionStart ?? el.value.length);
  }, [value, inputRef]);

  const token = focused ? slashAt(value, Math.min(caret, value.length)) : null;
  const tokenKey = token ? `${token.start}:${token.word}:${token.arg ?? ''}` : null;
  const snipMode = token?.word === 'snip' && token.arg !== undefined;

  useEffect(() => {
    if (snipMode && snippets === null) void call('snippets.list').then(setSnippets, () => setSnippets([]));
  }, [snipMode, snippets]);
  useEffect(() => setActive(0), [tokenKey]);

  const items = useMemo<Item[]>(() => {
    if (!token) return [];
    if (snipMode) {
      const q = (token.arg ?? '').trim().toLowerCase();
      return (snippets ?? [])
        .filter((s) => !q || `${s.title} ${s.tags.join(' ')} ${s.content}`.toLowerCase().includes(q))
        .slice(0, 30)
        .map((s) => ({ key: `snip-${s.id}`, title: s.title, hint: `${s.language} · ${s.content.split('\n')[0].slice(0, 80)}`, icon: 'bookmark' as const, apply: async () => ({ text: s.content }) }));
    }
    const builtins: Item[] = [
      { key: 'b-snip', title: '/snip', hint: 'Insert a snippet from your library', icon: 'bookmark', apply: async () => ({ text: '/snip ' }) },
      { key: 'b-clip', title: '/clip', hint: 'Paste what is on the clipboard', icon: 'copy', apply: async () => ({ text: await readClipboard() }) },
      { key: 'b-date', title: '/date', hint: "Today's date", icon: 'clock', apply: async () => expand('{date}', settings) },
      { key: 'b-time', title: '/time', hint: 'The time', icon: 'clock', apply: async () => expand('{time}', settings) },
      { key: 'b-now', title: '/now', hint: 'Date and time', icon: 'clock', apply: async () => expand('{datetime}', settings) },
      {
        key: 'b-snippets',
        title: '/snippets',
        hint: 'Add or edit your quick snippets',
        icon: 'settings',
        apply: async () => {
          navigate('settings/snippets');
          return { text: '' };
        },
      },
      {
        key: 'b-macros',
        title: '/macros',
        hint: 'Keyboard shortcuts, like the clipboard history',
        icon: 'settings',
        apply: async () => {
          navigate('settings/macros');
          return { text: '' };
        },
      },
    ];
    const mine: Item[] = (settings?.macros ?? [])
      .filter((m) => !RESERVED_TRIGGERS.includes(m.trigger) && (scope === 'text' || m.scope === 'everywhere' || m.scope === scope))
      .map((m) => ({ key: `m-${m.id}`, title: `/${m.trigger}`, hint: m.description || m.text.split('\n')[0].slice(0, 80), icon: 'zap' as const, apply: () => expand(m.text, settings) }));
    const w = token.word;
    const all = [...mine, ...builtins].filter((i) => i.title.slice(1).startsWith(w) || (w.length > 1 && i.title.includes(w)));
    return all.sort((a, b) => Number(b.title === `/${w}`) - Number(a.title === `/${w}`)).slice(0, 12);
  }, [token?.word, token?.arg, snipMode, snippets, settings, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = !!token && dismissed !== tokenKey && (items.length > 0 || snipMode);

  const choose = async (item: Item) => {
    if (!token) return;
    const end = Math.min(caret, value.length);
    const r = await item.apply();
    if (!r) return;
    const next = value.slice(0, token.start) + r.text + value.slice(end);
    const pos = token.start + (r.cursor ?? r.text.length);
    setValue(next);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (!open) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = Math.max(1, items.length);
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
      return true;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && items[active]) {
      e.preventDefault();
      void choose(items[active]);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(tokenKey);
      return true;
    }
    return false;
  };

  const menu = open ? (
    <div className="slash-menu" role="listbox" aria-label={snipMode ? 'Snippet library' : 'Snippets'} ref={listRef}>
      <div className="slash-head">
        {snipMode ? (
          <>
            <Icons.bookmark size={12} /> Snippets{token?.arg ? ` matching “${token.arg.trim()}”` : ''}: keep typing to search
          </>
        ) : (
          <>
            <Icons.zap size={12} /> Snippets: ↑ ↓ to choose, Enter to insert, Esc to close
          </>
        )}
      </div>
      {items.map((it, i) => {
        const Ico = Icons[it.icon];
        return (
          <div
            key={it.key}
            role="option"
            aria-selected={i === active}
            className={`slash-item${i === active ? ' active' : ''}`}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              void choose(it);
            }}
          >
            <Ico size={14} />
            <span className="slash-title">{it.title}</span>
            <span className="slash-hint">{it.hint}</span>
          </div>
        );
      })}
      {snipMode && snippets !== null && !items.length && (
        <div className="slash-empty">
          No snippets{token?.arg?.trim() ? ' match' : ' yet'}. Save one from the Terminal or <button onMouseDown={(e) => (e.preventDefault(), navigate('snippets'))}>Snippets</button>.
        </div>
      )}
    </div>
  ) : null;

  return { menu, onKeyDown };
}
