import { useEffect, useState } from 'react';
import type { FolderRequest } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Modal, Toggle, useAction } from '@fbrx/ui';
import { call, onEvent, pickFile } from '../client';
import { useCore } from '../hooks';
import { menuFor } from '../context-menu';

/**
 * Governance → the folders the AI may use: add one with the folder picker (another drive, a network share), take one
 * away. And the question the AI asks when it needs a folder it does not have: the person picks it, or says no.
 */

export function FoldersCard() {
  const st = useCore('governance.folders', undefined, ['policy.changed', 'governance.folderRequest']);
  const policy = useCore('governance.policy', undefined, ['policy.changed']);
  const { run, busy } = useAction();
  const s = st.data;
  if (!s) return null;
  const add = async () => {
    const path = await pickFile({ kind: 'folder', title: 'A folder your AI may use' });
    if (path) await run('add', () => call('governance.addFolder', { path }), 'Folder added');
  };
  const readOnly = async (v: boolean) => {
    if (!policy.data) return;
    const p = structuredClone(policy.data.policy);
    p.filesystem.readOnly = v;
    await run('ro', () => call('governance.updatePolicy', { policy: p }), v ? 'Your AI can only read files now' : 'Your AI can change files in these folders');
  };
  return (
    <Card
      title="Folders your AI can use"
      subtitle="It reads and works only inside these. Anything else (another drive, a network share) it has to ask you for first."
      actions={
        !s.managed && (
          <Button size="sm" icon="plus" loading={busy === 'add'} onClick={() => void add()}>
            Add a folder…
          </Button>
        )
      }
    >
      {s.managed && <Callout tone="info">Your organization decides these (FBRX Command → Governance).</Callout>}
      {s.folders.length ? (
        <div className="fx-list gov-folders">
          {s.folders.map((f) => (
            <div
              key={f.entry}
              className="fx-list-item"
              onContextMenu={menuFor([{ label: 'Take this folder away', icon: 'trash', danger: true, disabled: s.managed, onSelect: () => void run(f.entry, () => call('governance.removeFolder', { entry: f.entry }), 'Folder removed') }])}
            >
              <span className="gov-folder-icon" aria-hidden="true">
                📁
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="fx-cell-title">{f.label ?? f.path}</div>
                <div className="fx-cell-sub mono">{f.label ? f.path : f.entry !== f.path ? f.entry : ''}</div>
              </div>
              {!s.managed && (
                <Button size="sm" variant="ghost" icon="trash" aria-label={`Take ${f.label ?? f.path} away`} loading={busy === f.entry} onClick={() => void run(f.entry, () => call('governance.removeFolder', { entry: f.entry }), 'Folder removed')} />
              )}
            </div>
          ))}
        </div>
      ) : (
        <Empty title="No folders">Your AI cannot open any files until you add a folder.</Empty>
      )}
      <div style={{ marginTop: 12 }}>
        <Toggle checked={s.readOnly} disabled={s.managed || !policy.data} onChange={(v) => void readOnly(v)} label="Read only: it may look at files but never change or delete them" />
      </div>
    </Card>
  );
}

/** The AI's request for a folder, wherever the person is in FBRX. */
export function FolderRequestHost() {
  const [queue, setQueue] = useState<FolderRequest[]>([]);
  const { run, busy } = useAction();
  useEffect(() => {
    void call('governance.folders')
      .then((s) => setQueue(s.requests))
      .catch(() => undefined);
    return onEvent('governance.folderRequest', (r) => setQueue((q) => (r.state === 'open' ? [...q.filter((x) => x.id !== r.id), r] : q.filter((x) => x.id !== r.id))));
  }, []);
  const r = queue[0];
  if (!r) return null;
  const answer = (path: string | null) => run('answer', () => call('governance.answerFolder', { id: r.id, path }), path ? 'Folder added' : undefined).then(() => setQueue((q) => q.filter((x) => x.id !== r.id)));
  const pick = async () => {
    const path = await pickFile({ kind: 'folder', title: `A folder for ${r.agentName}`, defaultPath: r.path ?? undefined });
    if (path) await answer(path);
  };
  return (
    <Modal
      title={`${r.agentName} asks to use a folder`}
      onClose={() => void answer(null)}
      footer={
        <>
          <Button variant="ghost" onClick={() => void answer(null)}>
            Don’t allow
          </Button>
          <Button icon="file" onClick={() => void pick()}>
            {r.path ? 'Choose another folder…' : 'Choose a folder…'}
          </Button>
          {r.path && (
            <Button variant="primary" icon="check" loading={busy === 'answer'} onClick={() => void answer(r.path)}>
              Allow this folder
            </Button>
          )}
        </>
      }
    >
      <p style={{ marginTop: 0 }}>{r.reason}</p>
      {r.path && <div className="gov-request-path mono">{r.path}</div>}
      <p className="fx-muted" style={{ marginBottom: 0 }}>
        {r.agentName} will be able to use everything inside it, until you take it away (Governance → Folders your AI can use).
      </p>
    </Modal>
  );
}
