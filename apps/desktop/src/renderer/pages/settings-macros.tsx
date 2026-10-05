import { useEffect, useState } from 'react';
import type { DeepPartial, Settings } from '@fbrx/shared';
import { Button, Card, Field, Icons, Toggle, useAction } from '@fbrx/ui';
import { bridge, call } from '../client';
import { isLocked, useCore } from '../hooks';
import { navigate } from '../app';

/**
 * Macros: keyboard shortcuts that work anywhere, even while FBRX is in the background. Spotlight (Alt+Space) and the
 * clipboard history (Ctrl+Alt+Z). Text you paste often lives in Snippets instead.
 */

const IS_MAC = bridge.platform === 'darwin';

/** An Electron accelerator ("Control+Alt+Z") the way people read it ("Ctrl+Alt+Z", "⌃⌥Z" on a Mac). */
export function keyLabel(accel: string): string {
  if (!accel) return 'Off';
  if (IS_MAC) return accel.replace(/CommandOrControl|Command/g, '⌘').replace(/Control/g, '⌃').replace(/Alt|Option/g, '⌥').replace(/Shift/g, '⇧').replace(/\+/g, '');
  return accel.replace(/CommandOrControl|Control/g, 'Ctrl').replace(/Super|Meta/g, 'Win');
}

const NAMED: Record<string, string> = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };

/** The accelerator for a key press, or null while only modifiers are down (or nothing sensible was pressed). */
function accelerator(e: KeyboardEvent): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return null;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.key)) key = e.key;
  else if (e.code === 'Backquote') key = '`';
  else if (NAMED[e.key]) key = NAMED[e.key];
  if (!key) return null;
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && (IS_MAC ? 'Command' : 'Super')].filter(Boolean) as string[];
  // Without Ctrl, Alt or ⌘ a shortcut would swallow normal typing; function keys are fine alone.
  if (!/^F\d/.test(key) && !mods.some((m) => m !== 'Shift')) return null;
  return [...mods, key].join('+');
}

/** A shortcut field: click it and press the new keys. Esc cancels. */
export function KeyRecorder({ value, onChange, disabled, allowOff }: { value: string; onChange: (accel: string) => void; disabled?: boolean; allowOff?: boolean }) {
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return setListening(false);
      const a = accelerator(e);
      if (!a) return;
      setListening(false);
      if (a !== value) onChange(a);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [listening, value, onChange]);
  return (
    <div className="key-recorder">
      <button className={`key-recorder-box${listening ? ' listening' : ''}`} disabled={disabled} onClick={() => setListening(!listening)} onBlur={() => setListening(false)} aria-label={listening ? 'Press the new shortcut' : `Shortcut: ${keyLabel(value)}. Click to change`}>
        {listening ? 'Press the new keys… (Esc to cancel)' : <kbd className="kbd">{keyLabel(value)}</kbd>}
      </button>
      {allowOff && value && !listening && (
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange('')}>
          Turn off
        </Button>
      )}
    </div>
  );
}

const PICKER_KEYS: Array<[string, string]> = [
  ['W / S or ↑ / ↓', 'Move up and down the list, newest at the top'],
  ['Tab / ~', 'Slide right and left through ways to paste it: as copied, clean, one line, UPPERCASE… and your saved transforms'],
  ['Type anything', 'Search your copies (then W and S type letters; the arrows still move)'],
  ['Enter', 'Paste it into the app you were in'],
  ['Delete · Ctrl+P', 'Remove it · pin it (pinned copies stay when you clear)'],
  ['Esc', 'Clear the search, or close'],
];

export function MacroSettings() {
  const s = useCore('settings.get', undefined, ['settings.changed']);
  const settings = s.data?.settings;
  const locked = (p: string) => isLocked(s.data?.locked, p);
  const { run } = useAction();
  if (!settings) return null;
  const patch = (p: DeepPartial<Settings>, ok?: string) => run('patch', () => call('settings.update', { patch: p }), ok);
  const c = settings.clipboard;
  return (
    <>
      <Card title="Macros" subtitle="Keyboard shortcuts that work anywhere, even while FBRX is in the background. Click a shortcut and press new keys to change it. (Text you paste often lives in Snippets.)">
        <div className="macro-keys">
          <div className="macro-key">
            <div className="macro-key-what">
              <Icons.clipboard size={16} />
              <div>
                <b>Clipboard history</b>
                <span>Your recent copies near the pointer, like Win+V. Pick one and it pastes where you were typing.</span>
              </div>
            </div>
            <KeyRecorder value={c.hotkey} allowOff disabled={locked('clipboard.hotkey')} onChange={(v) => void patch({ clipboard: { hotkey: v } }, v ? `Clipboard history: ${keyLabel(v)}` : 'Clipboard history shortcut off')} />
          </div>
          <div className="macro-key">
            <div className="macro-key-what">
              <Icons.search size={16} />
              <div>
                <b>Spotlight</b>
                <span>Search apps, files, settings and quick answers. Inside FBRX, Ctrl+K opens it too.</span>
              </div>
            </div>
            <KeyRecorder value={settings.spotlight.enabled ? settings.spotlight.hotkey : ''} allowOff onChange={(v) => void patch(v ? { spotlight: { enabled: true, hotkey: v } } : { spotlight: { enabled: false } }, v ? `Spotlight: ${keyLabel(v)}` : 'Spotlight shortcut off')} />
          </div>
          <div className="macro-key">
            <div className="macro-key-what">
              <Icons.presentation size={16} />
              <div>
                <b>Presenter-safe mode</b>
                <span>On and off before you share your screen or plug into the projector (Settings → Presenting).</span>
              </div>
            </div>
            <KeyRecorder value={settings.presenter.hotkey} allowOff disabled={locked('presenter.hotkey')} onChange={(v) => void patch({ presenter: { hotkey: v } }, v ? `Presenter-safe mode: ${keyLabel(v)}` : 'Presenter-safe mode shortcut off')} />
          </div>
        </div>
      </Card>

      <Card
        title="Clipboard history"
        subtitle={`Opens with ${keyLabel(c.hotkey) || 'its shortcut (off)'}. Kept in memory only: never saved to disk, gone when FBRX quits. Copies that password managers mark as secret are skipped.`}
        actions={
          <Button size="sm" icon="clipboard" disabled={!bridge.clipPicker} onClick={() => void bridge.clipPicker?.('show')}>
            Open it now
          </Button>
        }
      >
        <div className="fx-form">
          <Toggle checked={c.history} disabled={locked('clipboard.history')} onChange={(v) => void patch({ clipboard: { history: v } }, v ? 'Clipboard history on' : 'Clipboard history off')} label="Keep a clipboard history while FBRX is running" />
          <Toggle
            checked={c.autoPaste}
            disabled={locked('clipboard.autoPaste')}
            onChange={(v) => void patch({ clipboard: { autoPaste: v } })}
            label={IS_MAC ? 'Paste right away (on a Mac, FBRX puts it on the clipboard and you press ⌘V)' : 'Paste right away (otherwise it is only put on the clipboard)'}
          />
          <Field label="In the clipboard history">
            <div className="kv-mini">
              {PICKER_KEYS.map(([k, v]) => (
                <div key={k}>
                  <code>{k}</code>
                  <span>{v}</span>
                </div>
              ))}
            </div>
          </Field>
          <div className="fx-actions">
            <Button size="sm" variant="ghost" icon="copy" onClick={() => navigate('clipboard')}>
              Clipboard page (history, transforms)
            </Button>
          </div>
        </div>
      </Card>
    </>
  );
}
