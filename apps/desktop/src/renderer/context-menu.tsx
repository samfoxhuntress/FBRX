import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Icons, type IconName } from '@fbrx/ui';
import { bridge, writeClipboard } from './client';
import { navigate } from './app';
import { addToMacros } from './macro-add';
import { askAgent } from './widgets';

/**
 * The right-click menu, everywhere in FBRX. Parts of the app add their own items with `menuFor(...)` (innermost first),
 * and the menu fills in what fits where you clicked: Cut, Copy and Paste in a text box; Copy and Ask about it for
 * picked text; Copy and Add to macros on a command; Open in a new window on a page in the sidebar; and "What's this?",
 * which asks the agent to explain that part of FBRX (handy in Endpoint Essentials).
 */

export type MenuItem = { label: string; icon?: IconName; onSelect: () => void; disabled?: boolean; danger?: boolean; hint?: string } | 'separator';

type MenuEvent = MouseEvent & { fbrxMenu?: MenuItem[][] };

/** onContextMenu for an element: its items lead the menu. */
export function menuFor(items: MenuItem[] | (() => MenuItem[])) {
  return (e: ReactMouseEvent) => {
    const ne = e.nativeEvent as MenuEvent;
    (ne.fbrxMenu ??= []).push(typeof items === 'function' ? items() : items);
  };
}

const EDITABLE = 'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]):not([type=color]):not([type=file]), textarea, [contenteditable=""], [contenteditable="true"]';
const short = (t: string, n = 40) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** The first line of what an element shows, without a count badge at the end ("Alerts 3" → "Alerts"). */
const firstLine = (el: Element | null | undefined) =>
  ((el as HTMLElement | null)?.innerText ?? el?.textContent ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
    ?.replace(/\s*\d+\+?$/, '') ?? '';

/** A name for the thing under the pointer: a field's label, a button's words, a card's title, or the page's. */
function describe(el: Element): { thing: string; page: string; nav: boolean } {
  const page = firstLine(document.querySelector('.fx-page-header h1')) || document.title;
  const nav = el.closest('[data-nav]');
  const field = el.closest('.fx-field');
  const labelled = el.closest('[aria-label], button, a, label, [role=tab], [title]');
  let thing = nav ? firstLine(nav) : field ? firstLine(field.querySelector('label')) : '';
  if (!thing && labelled) thing = labelled.getAttribute('aria-label') || firstLine(labelled) || labelled.getAttribute('title') || '';
  if (!thing) thing = firstLine(el.closest('.fx-card')?.querySelector('.fx-card-head h2'));
  return { thing: short(thing.replace(/\s+/g, ' '), 60), page, nav: !!nav };
}

function build(e: MenuEvent, o: { agentName: string; ultra: boolean; essentials: boolean }): MenuItem[] {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return [];
  const groups: MenuItem[][] = [...(e.fbrxMenu ?? [])];
  const edit = (action: Parameters<NonNullable<typeof bridge.edit>>[0]) => () => void bridge.edit?.(action);

  const field = target.closest<HTMLInputElement | HTMLTextAreaElement | HTMLElement>(EDITABLE);
  const picked = window.getSelection()?.toString().trim() ?? '';
  if (field) {
    field.focus();
    const ro = 'readOnly' in field && (field.readOnly || (field as HTMLInputElement).disabled);
    const has = 'selectionStart' in field && field.selectionStart !== null ? field.selectionStart !== field.selectionEnd : !!picked;
    const canEdit = !!bridge.edit;
    groups.push(
      ro
        ? [{ label: 'Copy', icon: 'copy', disabled: !has || !canEdit, onSelect: edit('copy') }, { label: 'Select all', onSelect: edit('selectAll'), disabled: !canEdit }]
        : [
            { label: 'Undo', onSelect: edit('undo'), disabled: !canEdit, hint: 'Ctrl+Z' },
            { label: 'Redo', onSelect: edit('redo'), disabled: !canEdit },
            'separator',
            { label: 'Cut', icon: 'scissors', disabled: !has || !canEdit, onSelect: edit('cut'), hint: 'Ctrl+X' },
            { label: 'Copy', icon: 'copy', disabled: !has || !canEdit, onSelect: edit('copy'), hint: 'Ctrl+C' },
            { label: 'Paste', icon: 'clipboard', disabled: !canEdit, onSelect: edit('paste'), hint: 'Ctrl+V' },
            'separator',
            { label: 'Select all', onSelect: edit('selectAll'), disabled: !canEdit, hint: 'Ctrl+A' },
          ],
    );
  } else {
    const code = target.closest('pre, code');
    const command = code?.textContent?.trim() ?? '';
    if (picked) {
      groups.push([
        { label: 'Copy', icon: 'copy', onSelect: () => void writeClipboard(picked), hint: 'Ctrl+C' },
        { label: `Ask ${o.agentName} about “${short(picked, 24)}”`, icon: 'sparkles', onSelect: () => askAgent(`Explain this, in plain language:\n\n${picked.slice(0, 4000)}`) },
        ...(!o.essentials && picked.length <= 5000 ? [{ label: 'Add to macros…', icon: 'zap' as const, onSelect: () => addToMacros({ name: short(picked.split('\n')[0], 40), text: picked }) }] : []),
      ]);
    } else if (command && command.length <= 5000) {
      groups.push([
        { label: 'Copy', icon: 'copy', onSelect: () => void writeClipboard(command) },
        ...(!o.essentials ? [{ label: 'Add to macros…', icon: 'zap' as const, onSelect: () => addToMacros({ name: short(command.split('\n')[0], 40), text: command, slash: true }) }] : []),
        ...(o.ultra && !command.includes('\n') && !target.closest('.cli') ? [{ label: 'Put it in the Terminal', icon: 'terminal' as const, onSelect: () => navigate(`terminal/cmd/${encodeURIComponent(command)}`) }] : []),
      ]);
    }
    const link = target.closest<HTMLAnchorElement>('a[href^="http"]');
    if (link) groups.push([{ label: 'Open link', icon: 'external', onSelect: () => link.click() }, { label: 'Copy link address', icon: 'link', onSelect: () => void writeClipboard(link.href) }]);
    const nav = target.closest<HTMLElement>('[data-nav]');
    if (nav?.dataset.nav) {
      const route = nav.dataset.nav;
      groups.push([{ label: 'Open', icon: 'chevronRight', onSelect: () => navigate(route) }, ...(bridge.popOut ? [{ label: 'Open in a new window', icon: 'external' as const, onSelect: () => void bridge.popOut?.(route) }] : [])]);
    }
  }

  // What's this (unless the thing brought its own items), and the page itself.
  const { thing, page, nav: onNav } = describe(target);
  const tail: MenuItem[] = [];
  const ask = onNav
    ? `In FBRX, what is the "${thing}" page for, and what can I do there? Keep it short and simple.`
    : thing
      ? `In FBRX, on the ${page} page, what is "${thing}" and how do I use it? Keep it short and simple.`
      : `In FBRX, what is the ${page} page for, and what can I do there? Keep it short and simple.`;
  if (!picked && !field && !e.fbrxMenu?.length) tail.push({ label: thing ? `What’s “${short(thing, 26)}”?` : 'What’s this page for?', icon: 'help', onSelect: () => askAgent(ask) });
  if (history.length > 1 && !field) tail.push({ label: 'Back', icon: 'chevronLeft', onSelect: () => history.back() });
  const here = location.hash.replace(/^#\/?/, '');
  if (bridge.popOut && here && !field && !document.body.classList.contains('popout')) tail.push({ label: 'Open this page in a new window', icon: 'external', onSelect: () => void bridge.popOut?.(here) });
  if (tail.length) groups.push(tail);

  const out: MenuItem[] = [];
  for (const g of groups.filter((x) => x.length)) {
    if (out.length) out.push('separator');
    out.push(...g);
  }
  // No separators at the ends or twice in a row.
  return out.filter((x, i, a) => x !== 'separator' || (i > 0 && i < a.length - 1 && a[i - 1] !== 'separator'));
}

/** The menu itself: once, at the top of each window. */
export function ContextMenuHost(o: { agentName: string; ultra: boolean; essentials: boolean }) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const opts = useRef(o);
  opts.current = o;

  useEffect(() => {
    const on = (e: MouseEvent) => {
      // Shift+right-click keeps the plain menu (where there is one), for people who want it.
      if (e.shiftKey) return;
      const items = build(e as MenuEvent, opts.current);
      e.preventDefault();
      if (!items.length) return setMenu(null);
      setActive(-1);
      setMenu({ x: e.clientX, y: e.clientY, items });
    };
    window.addEventListener('contextmenu', on);
    return () => window.removeEventListener('contextmenu', on);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && close();
    const key = (e: KeyboardEvent) => {
      const usable = menu.items.map((x, i) => (x !== 'separator' && !x.disabled ? i : -1)).filter((i) => i >= 0);
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const at = usable.indexOf(active);
        setActive(usable[(at + (e.key === 'ArrowDown' ? 1 : usable.length - 1) + (at < 0 && e.key === 'ArrowUp' ? 1 : 0)) % usable.length] ?? -1);
      } else if (e.key === 'Enter' && active >= 0) {
        const it = menu.items[active];
        if (it !== 'separator') {
          close();
          it.onSelect();
        }
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('hashchange', close);
    document.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('hashchange', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [menu, active]);

  // Kept on screen: flips left or up near the edges.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!menu || !box.current) return setPos(null);
    const r = box.current.getBoundingClientRect();
    setPos({ left: menu.x + r.width > innerWidth - 8 ? Math.max(8, menu.x - r.width) : menu.x, top: menu.y + r.height > innerHeight - 8 ? Math.max(8, innerHeight - r.height - 8) : menu.y });
  }, [menu]);

  if (!menu) return null;
  return (
    <div ref={box} className="ctx-menu" role="menu" style={{ left: pos?.left ?? menu.x, top: pos?.top ?? menu.y, visibility: pos ? 'visible' : 'hidden' }} onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((it, i) => {
        if (it === 'separator') return <div key={i} className="ctx-sep" role="separator" />;
        const Ico = it.icon ? Icons[it.icon] : null;
        return (
          <button
            key={i}
            role="menuitem"
            className={`ctx-item${i === active ? ' on' : ''}${it.danger ? ' danger' : ''}`}
            disabled={it.disabled}
            onMouseEnter={() => setActive(i)}
            onClick={() => {
              setMenu(null);
              it.onSelect();
            }}
          >
            <span className="ctx-ico">{Ico && <Ico size={14} />}</span>
            <span className="ctx-label">{it.label}</span>
            {it.hint && <kbd className="ctx-hint">{it.hint}</kbd>}
          </button>
        );
      })}
    </div>
  );
}
