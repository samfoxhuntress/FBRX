import { ipcRenderer } from 'electron';
import type { AUTOFILL_CHANNEL, AutofillFill, AutofillReport } from '@fbrx/shared';

/**
 * FBRX Browser's sign-in helper, the Vault's extension in every web page. It runs in the page's main frame, in a world
 * of its own (the page's scripts cannot see or call it), and only ever talks to the browser window:
 *
 *  - it finds sign-in forms and says when one of their boxes has the focus, and where, so the window can offer the
 *    Vault's sign-ins for that site beside it;
 *  - it fills the focused form when the window sends a sign-in (only on the site the window asked for, and only into
 *    boxes the person can see);
 *  - it tells the window what was typed when a sign-in form is sent, so the window can offer to save it.
 *
 * It never reads the Vault itself and never fills anything on its own.
 */

// Spelled out (the shared package stays out of the page's helper), and checked against the shared name.
const CHANNEL: typeof AUTOFILL_CHANNEL = 'fbrx:autofill';
const USERNAME_TYPES = new Set(['text', 'email', 'tel', '']);
const NEW_PASSWORD = /new|confirm|repeat|again|retype|create|register|signup|sign-up/i;

interface LoginForm {
  password: HTMLInputElement;
  username: HTMLInputElement | null;
  /** Every password box of the form: two or more is a sign-up or a password change. */
  passwords: HTMLInputElement[];
  /** Choosing a new password (sign-up or change) rather than signing in. */
  isNew: boolean;
}

const report = (r: AutofillReport) => ipcRenderer.sendToHost(CHANNEL, r);

function visible(el: HTMLElement): boolean {
  if (!el.isConnected || el.hidden) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
}

/** The form (or, for a page without one, the page) a box or button belongs to. */
const scope = (el: Element): ParentNode => (el instanceof HTMLInputElement || el instanceof HTMLButtonElement ? el.form : null) ?? el.closest('form') ?? document;

/** The sign-in form a box is part of: its password box and the username box before it. */
function loginFor(el: HTMLInputElement): LoginForm | null {
  const inputs = [...scope(el).querySelectorAll('input')].filter((i) => !i.disabled && !i.readOnly && visible(i));
  const passwords = inputs.filter((i) => i.type === 'password');
  if (!passwords.length) return null;
  const password = el.type === 'password' ? el : passwords[0];
  const before = inputs.slice(0, inputs.indexOf(passwords[0]));
  const named = before.filter((i) => USERNAME_TYPES.has(i.type) && /user|login|email|account|name|id/i.test(`${i.autocomplete} ${i.name} ${i.id}`));
  const username = (el.type !== 'password' && USERNAME_TYPES.has(el.type) ? el : null) ?? named.at(-1) ?? before.filter((i) => USERNAME_TYPES.has(i.type)).at(-1) ?? null;
  if (el !== password && el !== username) return null;
  const isNew = passwords.length > 1 || passwords.some((p) => p.autocomplete === 'new-password' || NEW_PASSWORD.test(`${p.name} ${p.id}`));
  return { password, username, passwords, isNew };
}

let focused: { input: HTMLInputElement; login: LoginForm } | null = null;
/** Typing a sign-in in moves the focus too: that is not the person asking for suggestions again. */
let filling = false;

/** Types a value as a person would, so the page's own scripts (React and the like) notice it. */
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  input.focus();
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

document.addEventListener(
  'focusin',
  (e) => {
    if (filling) return;
    const input = e.target instanceof HTMLInputElement ? e.target : null;
    const login = input && (input.type === 'password' || USERNAME_TYPES.has(input.type)) ? loginFor(input) : null;
    if (!input || !login) {
      if (focused) report({ type: 'away' });
      focused = null;
      return;
    }
    focused = { input, login };
    report({ type: 'focus', field: input === login.password ? 'password' : 'username', isNew: login.isNew, rect: rectOf(input) });
  },
  true,
);

function rectOf(el: HTMLElement): { x: number; y: number; width: number; height: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/** The page scrolled or resized: the suggestions follow the box, or go when it is out of sight. */
let frame = 0;
function moved(): void {
  if (!focused || frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (!focused) return;
    const r = rectOf(focused.input);
    report(visible(focused.input) && r.y + r.height > 0 && r.y < innerHeight ? { type: 'moved', rect: r } : { type: 'away' });
  });
}

// What else the person does on the page puts the window's suggestions away: a click elsewhere, typing in the box
// themselves, or Esc.
document.addEventListener('pointerdown', (e) => focused && e.target !== focused.input && report({ type: 'away' }), true);
document.addEventListener('input', (e) => e.isTrusted && focused && e.target === focused.input && report({ type: 'away' }), true);
addEventListener('scroll', moved, true);
addEventListener('resize', moved);

/** What was typed into the form, as it is sent (the window may offer to save it). */
function sent(login: LoginForm | null): void {
  if (!login?.password.value) return;
  report({ type: 'submit', username: login.username?.value.trim() ?? '', password: login.password.value, isNew: login.isNew });
}
document.addEventListener(
  'submit',
  (e) => {
    const pw = e.target instanceof HTMLFormElement ? e.target.querySelector<HTMLInputElement>('input[type=password]') : null;
    if (pw) sent(loginFor(pw));
  },
  true,
);
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && focused) report({ type: 'away' });
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type === 'password') sent(loginFor(e.target));
  },
  true,
);
// Pages that sign in with a button and scripts instead of a form.
document.addEventListener(
  'click',
  (e) => {
    const button = e.target instanceof Element ? e.target.closest('button, input[type=submit], input[type=button], [role=button]') : null;
    if (!button || !focused) return;
    const pw = scope(button).querySelector<HTMLInputElement>('input[type=password]');
    if (pw) sent(loginFor(pw));
  },
  true,
);

// The window's sign-in for this page: only for the site it was asked for, only into boxes the person can see.
ipcRenderer.on(CHANNEL, (_e, fill: AutofillFill) => {
  if (location.origin !== fill.origin) return;
  const login = focused?.login ?? firstLogin();
  if (!login || !visible(login.password)) return;
  filling = true;
  try {
    if (fill.username && login.username && visible(login.username) && (!login.isNew || !login.username.value)) type(login.username, fill.username);
    for (const p of login.isNew ? login.passwords : [login.password]) type(p, fill.password);
  } finally {
    filling = false;
  }
  report({ type: 'filled' });
});

/** The page's first visible sign-in form (filling from the toolbar, with no box in focus). */
function firstLogin(): LoginForm | null {
  const pw = [...document.querySelectorAll<HTMLInputElement>('input[type=password]')].find(visible);
  return pw ? loginFor(pw) : null;
}

// Whether the page has a sign-in form at all (the toolbar's key shows then).
let had = false;
const look = () => {
  const has = !!firstLogin();
  if (has !== had) report({ type: 'forms', present: has });
  had = has;
};
addEventListener('DOMContentLoaded', look);
addEventListener('load', look);
let pending: ReturnType<typeof setTimeout> | null = null;
new MutationObserver(() => {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    look();
  }, 500);
}).observe(document, { childList: true, subtree: true });
