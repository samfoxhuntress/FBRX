import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { FbrxMark } from './brand';
import { Icons, type IconName } from './icons';

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

// ------------------------------------------------------------------------------------- layout

export interface NavItem {
  id: string;
  label: string;
  icon: IconName;
  count?: number;
  section?: string;
}

export function Shell(props: {
  brandSub?: string;
  nav: NavItem[];
  active: string;
  onNavigate: (id: string) => void;
  topbar?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  let lastSection: string | undefined;
  return (
    <div className="fx-shell">
      <aside className="fx-sidebar">
        <div className="fx-brand">
          <FbrxMark className="fx-brand-mark" />
          <div>
            <div className="fx-brand-name">FBRX OS</div>
            <div className="fx-brand-sub">{props.brandSub ?? 'Fabrics Operating System'}</div>
          </div>
        </div>
        <nav className="fx-nav" aria-label="Main">
          {props.nav.map((item) => {
            const Ico = Icons[item.icon];
            const header = item.section && item.section !== lastSection ? item.section : null;
            lastSection = item.section ?? lastSection;
            return (
              <div key={item.id}>
                {header && <div className="fx-nav-section">{header}</div>}
                <button className={cx('fx-nav-item', props.active === item.id && 'active')} onClick={() => props.onNavigate(item.id)} aria-current={props.active === item.id ? 'page' : undefined}>
                  <Ico />
                  <span>{item.label}</span>
                  {!!item.count && <span className="fx-nav-count">{item.count}</span>}
                </button>
              </div>
            );
          })}
        </nav>
        {props.footer && <div className="fx-sidebar-foot">{props.footer}</div>}
      </aside>
      <main className="fx-main">
        {props.topbar && <div className="fx-topbar">{props.topbar}</div>}
        <div className="fx-content">{props.children}</div>
      </main>
    </div>
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

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="fx-input" {...props} />;
}

export function Select({ options, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { options: Array<{ value: string; label: string } | string> }) {
  return (
    <select className="fx-select" {...props}>
      {options.map((o) => {
        const v = typeof o === 'string' ? { value: o, label: o } : o;
        return (
          <option key={v.value} value={v.value}>
            {v.label}
          </option>
        );
      })}
    </select>
  );
}

export function TextArea({ code, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { code?: boolean }) {
  return <textarea className={cx('fx-textarea', code && 'code')} spellCheck={!code} {...props} />;
}

export function Toggle({ checked, onChange, label, disabled, title }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; title?: string }) {
  return (
    <label className="fx-toggle" title={title}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label && <span>{label}</span>}
    </label>
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
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

interface ToastItem {
  id: number;
  title: string;
  body?: string;
  tone: 'info' | 'good' | 'warning' | 'critical';
}

const ToastCtx = createContext<(t: Omit<ToastItem, 'id'>) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-4), { ...t, id }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.tone === 'critical' ? 9000 : 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fx-toasts" aria-live="polite">
        {items.map((t) => {
          const Ico = Icons[t.tone === 'good' ? 'checkCircle' : t.tone === 'critical' ? 'octagon' : t.tone === 'warning' ? 'alert' : 'info'];
          return (
            <div className="fx-toast" key={t.id}>
              <Ico size={18} style={{ color: t.tone === 'info' ? 'var(--accent)' : `var(--${t.tone})`, flex: 'none' }} />
              <div>
                <div className="fx-toast-title">{t.title}</div>
                {t.body && <div className="fx-secondary">{t.body}</div>}
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
    info: (title: string, body?: string) => push({ title, body, tone: 'info' }),
    success: (title: string, body?: string) => push({ title, body, tone: 'good' }),
    warning: (title: string, body?: string) => push({ title, body, tone: 'warning' }),
    error: (title: string, body?: string) => push({ title, body, tone: 'critical' }),
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
