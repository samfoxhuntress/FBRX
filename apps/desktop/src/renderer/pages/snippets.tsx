import { useState } from 'react';
import type { Snippet } from '@fbrx/shared';
import { Button, Card, Empty, Field, Grid, Input, Modal, Page, Select, TextArea, useAction, useConfirm, useToast } from '@fbrx/ui';
import { call } from '../client';
import { useCore } from '../hooks';

const LANGUAGES = ['', 'text', 'powershell', 'bash', 'cmd', 'python', 'javascript', 'typescript', 'json', 'yaml', 'sql', 'html', 'css', 'csharp', 'go', 'rust', 'markdown', 'email'];

function SnippetEditor({ snippet, projects, onClose }: { snippet: Partial<Snippet>; projects: Array<{ id: string; name: string }>; onClose: () => void }) {
  const [s, setS] = useState<Partial<Snippet>>(snippet);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  return (
    <Modal
      title={s.id ? 'Edit snippet' : 'New snippet'}
      wide
      onClose={onClose}
      footer={
        <>
          {s.id && (
            <Button
              variant="danger"
              icon="trash"
              onClick={async () => {
                if (await confirm({ title: 'Delete this snippet?', danger: true, confirmLabel: 'Delete' })) {
                  await call('snippets.delete', { id: s.id! });
                  onClose();
                }
              }}
            >
              Delete
            </Button>
          )}
          <span className="fx-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy === 'save'}
            disabled={!s.title?.trim()}
            onClick={() => void run('save', async () => (await call('snippets.save', { id: s.id, title: s.title ?? '', language: s.language, content: s.content, tags: s.tags, projectId: s.projectId ?? null }), onClose()))}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="fx-grid">
        <div className="fx-row">
          <Field label="Title">
            <Input autoFocus value={s.title ?? ''} onChange={(e) => setS({ ...s, title: e.target.value })} />
          </Field>
          <Field label="Language">
            <Select value={s.language ?? ''} onChange={(e) => setS({ ...s, language: e.target.value })} options={LANGUAGES.map((l) => ({ value: l, label: l || '—' }))} />
          </Field>
          <Field label="Project">
            <Select value={s.projectId ?? ''} onChange={(e) => setS({ ...s, projectId: e.target.value || null })} options={[{ value: '', label: 'No project' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]} />
          </Field>
        </div>
        <Field label="Content">
          <TextArea code rows={14} value={s.content ?? ''} onChange={(e) => setS({ ...s, content: e.target.value })} />
        </Field>
        <Field label="Tags" help="Separated by commas">
          <Input value={(s.tags ?? []).join(', ')} onChange={(e) => setS({ ...s, tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })} />
        </Field>
      </div>
      {dialog}
    </Modal>
  );
}

export function SnippetsPage() {
  const [query, setQuery] = useState('');
  const snippets = useCore('snippets.list', query ? { query } : undefined, ['workspace.changed']);
  const projects = useCore('projects.list', undefined, ['workspace.changed']);
  const [editing, setEditing] = useState<Partial<Snippet> | null>(null);
  const toast = useToast();
  const copy = async (s: Snippet) => {
    await navigator.clipboard.writeText(s.content);
    toast.success('Copied', s.title);
  };
  return (
    <Page
      title="Snippets"
      description="Reusable commands, code and text. Search them from Spotlight and press Enter to copy."
      actions={
        <>
          <div style={{ width: 240 }}>
            <Input placeholder="Search snippets" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search snippets" />
          </div>
          <Button variant="primary" icon="plus" onClick={() => setEditing({ language: 'powershell' })}>
            New snippet
          </Button>
        </>
      }
    >
      {snippets.data?.length ? (
        <Grid cols={2}>
          {snippets.data.map((s) => (
            <Card
              key={s.id}
              title={s.title}
              subtitle={[s.language, ...s.tags].filter(Boolean).join(' · ') || undefined}
              actions={
                <>
                  <Button size="sm" icon="copy" onClick={() => void copy(s)}>
                    Copy
                  </Button>
                  <Button size="sm" variant="ghost" icon="edit" aria-label={`Edit ${s.title}`} onClick={() => setEditing(s)} />
                </>
              }
            >
              <pre className="fx-code" style={{ maxHeight: 180, margin: 0 }}>
                {s.content}
              </pre>
            </Card>
          ))}
        </Grid>
      ) : (
        <Empty title={query ? 'No matches' : 'No snippets yet'} action={<Button icon="plus" onClick={() => setEditing({ language: 'powershell' })}>Add a snippet</Button>}>
          Keep the commands you always look up in one place.
        </Empty>
      )}
      {editing && <SnippetEditor snippet={editing} projects={projects.data ?? []} onClose={() => (setEditing(null), snippets.reload())} />}
    </Page>
  );
}
