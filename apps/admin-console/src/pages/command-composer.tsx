import { useState } from 'react';
import { COMMAND_DESCRIPTIONS, COMMAND_TYPES, type CommandType } from '@fbrx/shared';
import { Button, Callout, Field, Input, JsonEditor, Modal, Select, TextArea, Toggle, useToast } from '@fbrx/ui';
import { api } from '../api';
import { useApp } from '../state';

const PRESETS: Partial<Record<CommandType, unknown>> = {
  'update.install': { restartNow: false },
  'backup.create': { label: 'Remote backup', upload: true },
  'diagnostics.collect': { auditEntries: 100 },
  notify: { title: 'Message from IT', body: '' },
  'service.restart': { name: 'runtime' },
  'plugin.setEnabled': { id: '', enabled: true },
  'plugin.uninstall': { id: '' },
};

const PRIVILEGED = new Set(['agent.run', 'plugin.install', 'plugin.uninstall', 'update.install', 'vault.lock', 'app.restart', 'backup.create']);

/** Sends a remote command to one device, a set of devices, a group, or the whole tenant. */
export function CommandComposer({ target, onClose, onSent }: { target: { deviceId?: string; deviceIds?: string[]; groupId?: string; all?: boolean; label: string }; onClose: () => void; onSent?: () => void }) {
  const app = useApp();
  const toast = useToast();
  const privileged = app.can('commands.privileged');
  const types = COMMAND_TYPES.filter((t) => t !== 'plugin.install' && (privileged || !PRIVILEGED.has(t)));
  const [type, setType] = useState<CommandType>('ping');
  const [payload, setPayload] = useState('{}');
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('Message from IT');
  const [body, setBody] = useState('');
  const [restartNow, setRestartNow] = useState(false);
  const [valid, setValid] = useState(true);
  const [busy, setBusy] = useState(false);

  const choose = (t: CommandType) => {
    setType(t);
    setPayload(JSON.stringify(PRESETS[t] ?? {}, null, 2));
  };

  const buildPayload = (): unknown => {
    if (type === 'agent.run') return { prompt };
    if (type === 'notify') return { title, body };
    if (type === 'update.install') return { restartNow };
    return payload.trim() ? JSON.parse(payload) : {};
  };

  const send = async () => {
    setBusy(true);
    try {
      const p = buildPayload();
      if (target.deviceId) await api('POST', `/v1/admin/devices/${target.deviceId}/commands`, { type, payload: p });
      else {
        const r = await api<{ queued: number }>('POST', '/v1/admin/commands/bulk', { type, payload: p, deviceIds: target.deviceIds, groupId: target.groupId, all: target.all });
        toast.success(`Queued for ${r.queued} device(s)`);
      }
      if (target.deviceId) toast.success('Command sent', COMMAND_DESCRIPTIONS[type]);
      onSent?.();
      onClose();
    } catch (err) {
      toast.error('Could not send command', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const simple = type === 'agent.run' || type === 'notify' || type === 'update.install' || !PRESETS[type];
  return (
    <Modal
      title="Send remote command"
      description={`Target: ${target.label}. Online devices receive it instantly; offline devices pick it up when they reconnect (expires after 24 hours).`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="send" loading={busy} disabled={!valid || (type === 'agent.run' && !prompt.trim()) || (type === 'notify' && !body.trim())} onClick={() => void send()}>
            Send
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Command" help={COMMAND_DESCRIPTIONS[type]}>
          <Select value={type} onChange={(e) => choose(e.target.value as CommandType)} options={types.map((t) => ({ value: t, label: t }))} />
        </Field>
        {type === 'agent.run' && (
          <>
            <Callout tone="info">The device's agent runs under that device's governance policy. Tools that need approval wait for the person at the workstation.</Callout>
            <Field label="Task for the agent">
              <TextArea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. Check free disk space and list the five largest folders in ~/Downloads" />
            </Field>
          </>
        )}
        {type === 'notify' && (
          <>
            <Field label="Title">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
            </Field>
            <Field label="Message">
              <TextArea rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} />
            </Field>
          </>
        )}
        {type === 'update.install' && <Toggle checked={restartNow} onChange={setRestartNow} label="Restart the app immediately after downloading" />}
        {type === 'vault.lock' && <Callout tone="warning">The user will need their recovery passphrase to unlock the vault again.</Callout>}
        {!simple && (
          <Field label="Payload (JSON)">
            <JsonEditor value={payload} onChange={setPayload} rows={6} onValidity={setValid} />
          </Field>
        )}
      </div>
    </Modal>
  );
}
