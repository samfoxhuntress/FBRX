import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ComponentProps, type ReactNode, type SelectHTMLAttributes } from 'react';
import { FbrxMark } from './brand';
import { Icon, Icons, type IconName } from './icons';

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

// ------------------------------------------------------------------------------------- layout

export interface NavItem {
  id: string;
  label: string;
  icon: IconName;
  count?: number;
  section?: string;
  /** Small tag after the label, e.g. "New". */
  tag?: string;
}

/** A sidebar section: a name with its icon that opens to the pages inside it. */
export interface NavGroup {
  id: string;
  label: string;
  /** What is inside, in plain words ("Tasks, notes and projects"). */
  hint: string;
  icon: IconName;
  items: NavItem[];
}

/** Marks a feature that comes with FBRX Endpoint Ultra. */
export function AdvancedTag({ label = 'Ultra', title = 'Part of FBRX Endpoint Ultra' }: { label?: string; title?: string }) {
  return (
    <span className="fx-adv-tag" title={title}>
      {label}
    </span>
  );
}

/** A tab label with the Ultra tag. */
export function advancedLabel(label: ReactNode): ReactNode {
  return (
    <>
      {label} <AdvancedTag />
    </>
  );
}

export function Shell(props: {
  /** The product name beside the logo (FBRX OS unless told otherwise). */
  brandName?: ReactNode;
  brandSub?: string;
  /** Clicks on the logo (the desktop app counts them for an easter egg). */
  onBrandClick?: () => void;
  brandClassName?: string;
  nav: NavItem[];
  /** Sections that open to their pages; replaces the flat `nav` list when given. */
  groups?: NavGroup[];
  /** Sidebar shows icons only (with groups). */
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  active: string;
  onNavigate: (id: string) => void;
  topbar?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  let lastSection: string | undefined;
  const collapsed = !!props.groups && !!props.collapsed;
  return (
    <div className={cx('fx-shell', props.groups && 'grouped', collapsed && 'collapsed')}>
      <aside className="fx-sidebar">
        <div className="fx-brand">
          <FbrxMark className={cx('fx-brand-mark', props.brandClassName)} onClick={props.onBrandClick} />
          {!collapsed && (
            <div>
              <div className="fx-brand-name">{props.brandName ?? 'FBRX OS'}</div>
              <div className="fx-brand-sub">{props.brandSub ?? 'Fabrics Operating System'}</div>
            </div>
          )}
        </div>
        {props.groups ? (
          <GroupedNav groups={props.groups} active={props.active} onNavigate={props.onNavigate} collapsed={collapsed} />
        ) : (
          <nav className="fx-nav" aria-label="Main">
            {props.nav.map((item) => {
              const header = item.section && item.section !== lastSection ? item.section : null;
              lastSection = item.section ?? lastSection;
              return (
                <div key={item.id}>
                  {header && <div className="fx-nav-section">{header}</div>}
                  <NavButton item={item} active={props.active === item.id} onClick={() => props.onNavigate(item.id)} />
                </div>
              );
            })}
          </nav>
        )}
        {props.groups && props.onCollapsedChange && (
          <button className="fx-collapse" onClick={() => props.onCollapsedChange!(!collapsed)} title={collapsed ? 'Show the full sidebar' : 'Shrink the sidebar to icons'} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            {collapsed ? <Icons.chevronRight size={16} /> : <Icons.chevronLeft size={16} />}
            {!collapsed && <span>Collapse</span>}
          </button>
        )}
        {props.footer && !collapsed && <div className="fx-sidebar-foot">{props.footer}</div>}
      </aside>
      <main className="fx-main">
        {props.topbar && <div className="fx-topbar">{props.topbar}</div>}
        <div className="fx-content">{props.children}</div>
      </main>
    </div>
  );
}

function NavButton({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  const Ico = Icons[item.icon];
  return (
    <button className={cx('fx-nav-item', active && 'active')} onClick={onClick} aria-current={active ? 'page' : undefined}>
      <Ico />
      <span>{item.label}</span>
      {item.tag && <span className="fx-adv-tag">{item.tag}</span>}
      {!!item.count && <span className="fx-nav-count">{item.count}</span>}
    </button>
  );
}

/**
 * Sections that open to their pages. Expanded, a section opens in place (one at a time; the one holding the page
 * on screen opens by itself). Collapsed to icons, a section's pages slide out next to it.
 */
function GroupedNav({ groups, active, onNavigate, collapsed }: { groups: NavGroup[]; active: string; onNavigate: (id: string) => void; collapsed: boolean }) {
  const current = groups.find((g) => g.items.some((i) => i.id === active))?.id ?? null;
  const [open, setOpen] = useState<string | null>(current);
  const [flyout, setFlyout] = useState<{ id: string; top: number } | null>(null);
  const flyRef = useRef<HTMLDivElement>(null);
  // Follow the page on screen when it changes from elsewhere (a link, Spotlight, a notification).
  useEffect(() => {
    if (current) setOpen(current);
  }, [current]);
  useEffect(() => {
    if (!flyout) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !flyRef.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.fx-group-head')) setFlyout(null);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [flyout]);
  useEffect(() => {
    if (!collapsed) setFlyout(null);
  }, [collapsed]);
  return (
    <nav className={cx('fx-nav', 'fx-groups', collapsed && 'collapsed')} aria-label="Main">
      {groups.map((g) => {
        const Ico = Icons[g.icon];
        const isOpen = !collapsed && open === g.id;
        const count = g.items.reduce((n, i) => n + (i.count ?? 0), 0);
        const flying = collapsed && flyout?.id === g.id;
        return (
          <div key={g.id} className={cx('fx-group', isOpen && 'open', current === g.id && 'here')}>
            <button
              className="fx-group-head"
              aria-expanded={collapsed ? flying : isOpen}
              title={collapsed ? `${g.label}: ${g.hint}` : undefined}
              onClick={(e) => {
                if (collapsed) {
                  const r = e.currentTarget.getBoundingClientRect();
                  setFlyout(flying ? null : { id: g.id, top: r.top });
                } else setOpen(isOpen ? null : g.id);
              }}
            >
              <span className="fx-group-icon">
                <Ico size={18} />
              </span>
              {!collapsed && (
                <span className="fx-group-text">
                  <span className="fx-group-name">{g.label}</span>
                  <span className="fx-group-hint">{g.hint}</span>
                </span>
              )}
              {count > 0 && <span className="fx-nav-count">{count}</span>}
              {!collapsed && <Icons.chevronDown size={14} className="fx-group-chev" />}
            </button>
            {isOpen && (
              <div className="fx-group-items">
                {g.items.map((item) => (
                  <NavButton key={item.id} item={item} active={active === item.id} onClick={() => onNavigate(item.id)} />
                ))}
              </div>
            )}
            {flying && (
              <div className="fx-flyout" ref={flyRef} role="menu" style={{ top: Math.min(flyout.top, window.innerHeight - 60 - g.items.length * 36) }}>
                <div className="fx-flyout-head">
                  <b>{g.label}</b>
                  <span>{g.hint}</span>
                </div>
                {g.items.map((item) => (
                  <NavButton
                    key={item.id}
                    item={item}
                    active={active === item.id}
                    onClick={() => {
                      setFlyout(null);
                      onNavigate(item.id);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

export function Page({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="fx-page">
      <div className="fx-page-header">
        <div>
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="fx-actions">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function Card({ title, subtitle, actions, children, flush, className }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode; flush?: boolean; className?: string }) {
  return (
    <section className={cx('fx-card', className)}>
      {(title || actions) && (
        <div className="fx-card-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <div className="fx-card-sub">{subtitle}</div>}
          </div>
          {actions && <div className="fx-actions">{actions}</div>}
        </div>
      )}
      <div className={cx('fx-card-body', flush && 'flush')}>{children}</div>
    </section>
  );
}

export function Grid({ cols = 2, children }: { cols?: 2 | 3 | 4 | 'auto'; children: ReactNode }) {
  return <div className={`fx-grid cols-${cols}`}>{children}</div>;
}

// -------------------------------------------------------------------------------------- inputs

export function Button({ variant, size, icon, loading, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'danger' | 'danger-solid' | 'ghost'; size?: 'sm'; icon?: IconName; loading?: boolean }) {
  const Ico = icon ? Icons[icon] : null;
  return (
    <button
      type="button"
      className={cx('fx-btn', variant === 'danger-solid' ? 'danger solid' : variant, size, !children && Ico && 'icon', className)}
      disabled={rest.disabled || loading}
      {...rest}
    >
      {loading ? <span className="fx-spinner" /> : Ico && <Ico size={size === 'sm' ? 14 : 16} />}
      {children}
    </button>
  );
}

export function Field({ label, help, error, children }: { label?: ReactNode; help?: ReactNode; error?: ReactNode; children: ReactNode }) {
  return (
    <div className="fx-field">
      {label && <label>{label}</label>}
      {children}
      {error ? <div className="fx-error-text">{error}</div> : help ? <div className="fx-help">{help}</div> : null}
    </div>
  );
}

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cx('fx-input', className)} {...props} />;
}

export function Select({ options, className, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { options: Array<{ value: string; label: string; disabled?: boolean } | string> }) {
  return (
    <select className={cx('fx-select', className)} {...props}>
      {options.map((o) => {
        const v = typeof o === 'string' ? { value: o, label: o } : o;
        return (
          <option key={v.value} value={v.value} disabled={'disabled' in v ? v.disabled : undefined}>
            {v.label}
          </option>
        );
      })}
    </select>
  );
}

export function TextArea({ code, className, ...props }: ComponentProps<'textarea'> & { code?: boolean }) {
  return <textarea className={cx('fx-textarea', code && 'code', className)} spellCheck={!code} {...props} />;
}

export function Toggle({ checked, onChange, label, disabled, title }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; title?: string }) {
  return (
    <label className="fx-toggle" title={title}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label && <span>{label}</span>}
    </label>
  );
}

/** A row of large radio cards: one choice that decides what follows (the kind of tenant, a plan…). */
export function ChoiceCards<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; title: ReactNode; description?: ReactNode; detail?: ReactNode; icon?: IconName }>; label: string }) {
  return (
    <div className="fx-choices" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={`fx-choice${value === o.value ? ' active' : ''}`} onClick={() => onChange(o.value)}>
          <span className="fx-choice-head">
            {o.icon && <Icon name={o.icon} size={18} />}
            <b>{o.title}</b>
            <span className="fx-choice-dot" aria-hidden="true" />
          </span>
          {o.description && <span className="fx-choice-desc">{o.description}</span>}
          {o.detail && <span className="fx-choice-detail">{o.detail}</span>}
        </button>
      ))}
    </div>
  );
}

/** JSON editor with live validation. */
export function JsonEditor({ value, onChange, rows = 12, onValidity }: { value: string; onChange: (v: string) => void; rows?: number; onValidity?: (ok: boolean) => void }) {
  let error: string | null = null;
  try {
    if (value.trim()) JSON.parse(value);
  } catch (e) {
    error = (e as Error).message;
  }
  useEffect(() => onValidity?.(!error), [error, onValidity]);
  return (
    <div className="fx-field">
      <TextArea code rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
      {error && <div className="fx-error-text">{error}</div>}
    </div>
  );
}

// ----------------------------------------------------------------------------------- display

export function Badge({ children, tone }: { children: ReactNode; tone?: 'accent' }) {
  return <span className={cx('fx-badge', tone)}>{children}</span>;
}

export type StatusTone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral' | 'info' | 'busy';

const STATUS_ICON: Record<StatusTone, IconName | null> = {
  good: 'checkCircle',
  warning: 'alert',
  serious: 'alert',
  critical: 'octagon',
  neutral: null,
  info: 'info',
  busy: null,
};

/** Status is never color-alone: icon + label, with the status hue on the icon only. */
export function Status({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  const name = STATUS_ICON[tone];
  const Ico = name ? Icons[name] : null;
  const color = tone === 'info' ? 'var(--accent)' : tone === 'neutral' ? 'var(--neutral)' : tone === 'busy' ? 'var(--accent)' : `var(--${tone})`;
  return (
    <span className="fx-status">
      {tone === 'busy' ? <span className="fx-spinner" style={{ width: 12, height: 12 }} /> : Ico ? <Ico size={14} style={{ color }} /> : <span className="fx-dot" style={{ background: color }} />}
      <span>{children}</span>
    </span>
  );
}

export function Callout({ tone = 'info', title, children, actions }: { tone?: 'info' | 'warning' | 'critical' | 'good'; title?: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  const icon: IconName = tone === 'critical' ? 'octagon' : tone === 'warning' ? 'alert' : tone === 'good' ? 'checkCircle' : 'info';
  const Ico = Icons[icon];
  const color = tone === 'info' ? 'var(--accent)' : `var(--${tone})`;
  return (
    <div className={`fx-callout ${tone}`} role={tone === 'critical' ? 'alert' : undefined}>
      <Ico size={18} style={{ color, flex: 'none', marginTop: 1 }} />
      <div className="fx-callout-body">
        {title && <div className="fx-callout-title">{title}</div>}
        {children}
      </div>
      {actions}
    </div>
  );
}

export function Empty({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="fx-empty">
      <h3>{title}</h3>
      {children && <div style={{ marginBottom: action ? 14 : 0 }}>{children}</div>}
      {action}
    </div>
  );
}

export function Spinner() {
  return <span className="fx-spinner" role="status" aria-label="Loading" />;
}

export function KeyValue({ items }: { items: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="fx-kv">
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CopyText({ value, secret }: { value: string; secret?: boolean }) {
  const [shown, setShown] = useState(!secret);
  const [copied, setCopied] = useState(false);
  return (
    <div className="fx-copy-line">
      <code>{shown ? value : '•'.repeat(Math.min(value.length, 32))}</code>
      {secret && <Button size="sm" variant="ghost" icon={shown ? 'eyeOff' : 'eye'} onClick={() => setShown(!shown)} aria-label={shown ? 'Hide' : 'Show'} />}
      <Button
        size="sm"
        icon={copied ? 'check' : 'copy'}
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, active, onChange }: { tabs: Array<{ id: T; label: ReactNode }>; active: T; onChange: (id: T) => void }) {
  return (
    <div className="fx-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={active === t.id} className={cx('fx-tab', active === t.id && 'active')} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  className?: string;
  width?: number | string;
}

export function Table<T>({ columns, rows, rowKey, onRowClick, empty }: { columns: Column<T>[]; rows: T[]; rowKey: (r: T) => string; onRowClick?: (r: T) => void; empty?: ReactNode }) {
  if (!rows.length) return <>{empty ?? <Empty title="Nothing here yet" />}</>;
  return (
    <div className="fx-table-wrap">
      <table className="fx-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.className} style={{ width: c.width }}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={rowKey(r)}
              className={onRowClick ? 'clickable' : undefined}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={onRowClick ? (e) => e.key === 'Enter' && onRowClick(r) : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} className={c.className}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------------------- overlays

export function Modal({ title, description, children, footer, onClose, wide }: { title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Focus the first field once, when the dialog opens. (Callers often pass a new onClose on every render, e.g. while
  // typing; refocusing then would yank the cursor back to the first box.)
  useEffect(() => {
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) el.querySelector<HTMLElement>('input, textarea, select, button')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="fx-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('fx-modal', wide && 'wide')} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
        <div className="fx-modal-head">
          <h2 id={id}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <div className="fx-modal-body">{children}</div>
        {footer && <div className="fx-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: number;
  title: string;
  body?: string;
  tone: 'info' | 'good' | 'warning' | 'critical';
  action?: ToastAction;
  icon?: ReactNode;
}

const ToastCtx = createContext<(t: Omit<ToastItem, 'id'>) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-4), { ...t, id }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.tone === 'critical' || t.action ? 9000 : 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fx-toasts" aria-live="polite">
        {items.map((t) => {
          const Ico = Icons[t.tone === 'good' ? 'checkCircle' : t.tone === 'critical' ? 'octagon' : t.tone === 'warning' ? 'alert' : 'info'];
          return (
            <div className="fx-toast" key={t.id}>
              {t.icon ?? <Ico size={18} style={{ color: t.tone === 'info' ? 'var(--accent)' : `var(--${t.tone})`, flex: 'none' }} />}
              <div>
                <div className="fx-toast-title">{t.title}</div>
                {t.body && <div className="fx-secondary">{t.body}</div>}
                {t.action && (
                  <button
                    className="fx-toast-action"
                    onClick={() => {
                      t.action!.onClick();
                      setItems((xs) => xs.filter((x) => x.id !== t.id));
                    }}
                  >
                    {t.action.label}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastCtx);
  return {
    info: (title: string, body?: string, action?: ToastAction) => push({ title, body, tone: 'info', action }),
    success: (title: string, body?: string, action?: ToastAction) => push({ title, body, tone: 'good', action }),
    warning: (title: string, body?: string, action?: ToastAction) => push({ title, body, tone: 'warning', action }),
    error: (title: string, body?: string, action?: ToastAction) => push({ title, body, tone: 'critical', action }),
    /** A toast with its own icon (for example a trophy badge). */
    custom: (t: { title: string; body?: string; tone?: ToastItem['tone']; action?: ToastAction; icon?: ReactNode }) => push({ tone: 'good', ...t }),
  };
}

/** Confirmation dialog hook: `const confirm = useConfirm(); if (await confirm({...})) …` */
export function useConfirm() {
  const [state, setState] = useState<{ title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean; resolve: (v: boolean) => void } | null>(null);
  const confirm = useCallback(
    (o: { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean }) => new Promise<boolean>((resolve) => setState({ ...o, resolve })),
    [],
  );
  const dialog = state ? (
    <Modal
      title={state.title}
      onClose={() => {
        state.resolve(false);
        setState(null);
      }}
      footer={
        <>
          <Button
            onClick={() => {
              state.resolve(false);
              setState(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant={state.danger ? 'danger-solid' : 'primary'}
            onClick={() => {
              state.resolve(true);
              setState(null);
            }}
          >
            {state.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    >
      {state.body}
    </Modal>
  ) : null;
  return { confirm, dialog };
}

/** Runs async work with loading state and toast on failure. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(key);
      try {
        const r = await fn();
        if (success) toast.success(success);
        return r;
      } catch (err) {
        toast.error('Something went wrong', (err as Error).message);
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { busy, run };
}
