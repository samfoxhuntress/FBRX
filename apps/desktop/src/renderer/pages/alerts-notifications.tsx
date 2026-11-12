import { useEffect, useState } from 'react';
import { NOTIFICATION_KINDS, type DeepPartial, type NotificationSettings, type NotificationShow, type NotificationSound, type Settings } from '@fbrx/shared';
import { Button, Callout, Card, ChoiceCards, Field, Select, Toggle, useAction, useToast } from '@fbrx/ui';
import { bridge, call } from '../client';
import { isLocked } from '../hooks';
import { playChime } from '../notify-sound';

/**
 * Alerts → Notifications: whether FBRX pops up at all, which kinds, where (inside FBRX or the system's notifications;
 * by default one place, never both) and the sound: FBRX's own chime, the system's, or none.
 */

const MAC = bridge.platform === 'darwin';
const SYSTEM = MAC ? 'Notification Center' : 'Windows notifications';

export function NotificationsTab({ settings, locked }: { settings: Settings; locked: string[] | undefined }) {
  const ns = settings.notifications;
  const [volume, setVolume] = useState(ns.volume);
  useEffect(() => setVolume(ns.volume), [ns.volume]);
  const { run, busy } = useAction();
  const toast = useToast();
  const L = (p: string) => isLocked(locked, p);
  const save = (patch: DeepPartial<Settings>) => run('save', () => call('settings.update', { patch }));
  const setNs = (p: Partial<NotificationSettings>) => save({ notifications: p });

  const kindOn = (id: string) => (id === 'alerts' ? settings.alerts.channels.desktop : id === 'messages' ? settings.messages.notify : !ns.muted.includes(id));
  const setKind = (id: string, on: boolean) =>
    id === 'alerts'
      ? save({ alerts: { channels: { desktop: on } } })
      : id === 'messages'
        ? save({ messages: { notify: on } })
        : setNs({ muted: on ? ns.muted.filter((m) => m !== id) : [...ns.muted, id] });
  const kindLocked = (id: string) => (id === 'alerts' ? L('alerts.channels') : id === 'messages' ? L('messages.notify') : L('notifications.muted'));

  const test = async () => {
    toast.info('A test notification comes in 4 seconds', ns.show === 'auto' ? `Switch to another app to see it in ${SYSTEM}, or stay here to see it in FBRX.` : undefined);
    await new Promise((r) => setTimeout(r, 4000));
    await run('test', () => call('alerts.test', { channel: 'desktop' }));
  };

  return (
    <>
      <Card title="Notifications" subtitle="What pops up when FBRX has something to tell you. Alerts still land in the inbox either way.">
        <div className="fx-form">
          <Toggle checked={ns.enabled} disabled={L('notifications.enabled')} onChange={(v) => void setNs({ enabled: v })} label="Show notifications" />
          {ns.enabled && (
            <>
              <Field label="Where they show" info={`FBRX shows each notification in one place: no more seeing the same one twice, in FBRX and in ${SYSTEM}.`}>
                <ChoiceCards<NotificationShow>
                  label="Where notifications show"
                  value={ns.show}
                  onChange={(v) => void setNs({ show: v })}
                  options={[
                    { value: 'auto', icon: 'sparkles', title: 'Automatic', description: `Inside FBRX while you are using it, otherwise in ${SYSTEM}. One place, never both.` },
                    { value: 'app', icon: 'layers', title: 'Only in FBRX', description: 'Nothing pops up over your other apps.' },
                    { value: 'system', icon: 'bell', title: `Only in ${SYSTEM}`, description: `Always ${MAC ? 'macOS' : 'Windows'}' own pop-ups, kept in its list until you clear them.` },
                    { value: 'both', icon: 'copy', title: 'Both', description: `In FBRX and in ${SYSTEM} (the way it was before).` },
                  ]}
                />
              </Field>
              <div className="fx-row" style={{ alignItems: 'flex-end' }}>
                <Field label="Sound">
                  <Select
                    value={ns.sound}
                    disabled={L('notifications.sound')}
                    onChange={(e) => void setNs({ sound: e.target.value as NotificationSound })}
                    options={[
                      { value: 'fbrx', label: 'FBRX sound' },
                      { value: 'system', label: `${MAC ? 'macOS' : 'Windows'} sound` },
                      { value: 'off', label: 'No sound' },
                    ]}
                  />
                </Field>
                {ns.sound === 'fbrx' && (
                  <Field label={`Volume (${Math.round(volume * 100)}%)`}>
                    <input
                      type="range"
                      min={0.1}
                      max={1}
                      step={0.05}
                      value={volume}
                      aria-label="Notification volume"
                      disabled={L('notifications.volume')}
                      onChange={(e) => setVolume(Number(e.target.value))}
                      onPointerUp={() => {
                        playChime('info', volume);
                        void setNs({ volume });
                      }}
                      onKeyUp={() => void setNs({ volume })}
                    />
                  </Field>
                )}
              </div>
              {ns.sound === 'fbrx' && (
                <div className="fx-actions notify-hear">
                  <span className="fx-muted">Hear it:</span>
                  <Button size="sm" variant="ghost" icon="play" onClick={() => playChime('info', volume)}>
                    Notification
                  </Button>
                  <Button size="sm" variant="ghost" icon="play" onClick={() => playChime('success', volume)}>
                    Done
                  </Button>
                  <Button size="sm" variant="ghost" icon="play" onClick={() => playChime('warning', volume)}>
                    Warning
                  </Button>
                  <Button size="sm" variant="ghost" icon="play" onClick={() => playChime('error', volume)}>
                    Problem
                  </Button>
                </div>
              )}
              <div className="fx-actions">
                <Button icon="bell" loading={busy === 'test'} onClick={() => void test()}>
                  Send a test notification
                </Button>
              </div>
            </>
          )}
          {!ns.enabled && <Callout tone="info">Nothing pops up. Alerts still collect in the inbox, and approvals still wait for you under Approvals.</Callout>}
        </div>
      </Card>
      {ns.enabled && (
        <Card title="Which notifications" subtitle="Turn off the kinds you do not want to see. Presenter-safe mode also holds them back while you present." flush>
          <div className="fx-list">
            {NOTIFICATION_KINDS.map((k) => (
              <div key={k.id} className="fx-list-item">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="fx-cell-title">{k.label}</div>
                  <div className="fx-cell-sub">{k.help}</div>
                </div>
                <Toggle checked={kindOn(k.id)} disabled={kindLocked(k.id)} onChange={(v) => void setKind(k.id, v)} title={`${k.label} notifications`} />
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
