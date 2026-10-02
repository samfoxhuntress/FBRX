import { useEffect, useState } from 'react';
import type { FileEntry, FilePreview } from '@fbrx/shared';
import { Button, Card, Empty, Icons, Input, Spinner, Status, TextArea, Toggle, formatBytes, formatDate, useAction, useToast } from '@fbrx/ui';
import { bridge, call } from '../client';
import { useCore } from '../hooks';
import { AskButton } from '../widgets';

/** File explorer with preview and a plain-text editor. */
export function FilesPage() {
  const home = useCore('files.home');
  const [path, setPath] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [listing, setListing] = useState<{ path: string; parent: string | null; items: FileEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<FileEntry[] | null>(null);
  const [addr, setAddr] = useState('');
  const { run, busy } = useAction();
  const toast = useToast();

  useEffect(() => {
    if (!path && home.data) setPath(home.data.home);
  }, [home.data, path]);
  useEffect(() => {
    if (!path) return;
    setError(null);
    setResults(null);
    setAddr(path);
    call('files.list', { path, hidden })
      .then((l) => setListing(l))
      .catch((e: Error) => setError(e.message));
  }, [path, hidden]);

  const open = async (f: FileEntry) => {
    if (f.dir) {
      setPath(f.path);
      setPreview(null);
      return;
    }
    setEdit(null);
    const p = await run('preview', () => call('files.read', { path: f.path }));
    if (p) setPreview(p);
  };
  const doSearch = async () => {
    if (!search.trim() || !path) return;
    const r = await run('search', () => call('files.search', { root: path, pattern: search.trim() }));
    if (r) setResults(r.results);
  };
  const items = results ?? listing?.items ?? [];
  const crumbs = (listing?.path ?? '').split(/[\\/]/).filter(Boolean);
  const sep = bridge.platform === 'win32' ? '\\' : '/';

  return (
    <div className="split files">
      <Card className="split-list" title="Places" flush>
        <div className="split-items">
          {(home.data?.places ?? []).map((p) => (
            <button key={p.path} className={`agent-conv${listing?.path === p.path ? ' active' : ''}`} onClick={() => setPath(p.path)}>
              <div className="agent-conv-title">
                <Icons.folder size={13} style={{ marginRight: 6, verticalAlign: -2 }} />
                {p.name}
              </div>
            </button>
          ))}
          <div className="fx-nav-section">Drives</div>
          {(home.data?.drives ?? []).map((d) => (
            <button key={d} className={`agent-conv${listing?.path === d ? ' active' : ''}`} onClick={() => setPath(d)}>
              <div className="agent-conv-title">
                <Icons.drive size={13} style={{ marginRight: 6, verticalAlign: -2 }} />
                {d}
              </div>
            </button>
          ))}
        </div>
      </Card>
      <Card className="split-main" flush>
        <div className="files-bar">
          <Button size="sm" variant="ghost" icon="chevronRight" style={{ transform: 'rotate(180deg)' }} aria-label="Up one folder" disabled={!listing?.parent} onClick={() => listing?.parent && setPath(listing.parent)} />
          <Input value={addr} onChange={(e) => setAddr(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setPath(addr)} aria-label="Folder path" className="mono" />
          <div style={{ width: 220 }}>
            <Input placeholder="Find in this folder…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void doSearch()} aria-label="Search files" />
          </div>
          <Toggle checked={hidden} onChange={setHidden} label="Hidden" />
        </div>
        <div className="crumbs">
          {crumbs.map((c, i) => (
            <button key={i} className="linklike" onClick={() => setPath((bridge.platform === 'win32' ? '' : '/') + crumbs.slice(0, i + 1).join(sep) + (i === 0 && bridge.platform === 'win32' ? sep : ''))}>
              {c}
            </button>
          ))}
          {results && (
            <Status tone="info">
              {results.length} match(es) for “{search}” <button className="linklike" onClick={() => setResults(null)}>clear</button>
            </Status>
          )}
        </div>
        <div className="files-body">
          <div className="files-list">
            {error ? (
              <Empty title="Cannot open this folder">{error}</Empty>
            ) : busy === 'search' ? (
              <div style={{ padding: 24 }}>
                <Spinner />
              </div>
            ) : (
              <table className="fx-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th style={{ width: 110 }}>Size</th>
                    <th style={{ width: 170 }}>Modified</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((f) => (
                    <tr key={f.path} className={`clickable${preview?.path === f.path ? ' selected' : ''}`} onClick={() => void open(f)} onDoubleClick={() => !f.dir && void run('open', () => call('files.open', { path: f.path }))}>
                      <td>
                        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                          {f.dir ? <Icons.folder size={14} style={{ color: 'var(--accent)' }} /> : <Icons.file size={14} className="fx-muted" />}
                          {results ? f.path : f.name}
                        </span>
                      </td>
                      <td className="fx-muted">{f.dir ? '' : formatBytes(f.size)}</td>
                      <td className="fx-muted">{f.modifiedAt ? formatDate(f.modifiedAt) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {!error && !items.length && listing && <Empty title="Empty folder" />}
          </div>
          {preview && (
            <div className="files-preview">
              <div className="files-preview-head">
                <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{preview.path.split(/[\\/]/).pop()}</strong>
                <Button size="sm" variant="ghost" icon="external" aria-label="Open with default app" onClick={() => void run('open', () => call('files.open', { path: preview.path }))} />
                {bridge.reveal && <Button size="sm" variant="ghost" icon="folder" aria-label="Show in folder" onClick={() => void bridge.reveal!(preview.path)} />}
                {preview.kind === 'text' && edit === null && (
                  <AskButton label="Summarize" prompt={`Read this file from my PC (${preview.path}) and tell me what it is, summarize what is in it, and point out anything important or unusual.`} context={preview.content.slice(0, 10_000)} />
                )}
                {preview.kind !== 'text' && <AskButton iconOnly label="What is this file" prompt="What is this file on my PC, what opens it, and is it safe to keep or delete? Use your tools to look closer if needed." context={{ path: preview.path, size: formatBytes(preview.size), kind: preview.kind }} />}
                {preview.kind === 'text' && !preview.truncated && edit === null && <Button size="sm" icon="edit" onClick={() => setEdit(preview.content)}>Edit</Button>}
                <Button size="sm" variant="ghost" icon="x" aria-label="Close preview" onClick={() => setPreview(null)} />
              </div>
              <div className="fx-muted" style={{ fontSize: 12, padding: '0 12px 8px' }}>
                {formatBytes(preview.size)}
                {preview.truncated ? ' · showing the first 512 KB' : ''}
              </div>
              {edit !== null ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, flex: 1, minHeight: 0 }}>
                  <TextArea code value={edit} onChange={(e) => setEdit(e.target.value)} style={{ flex: 1, minHeight: 300 }} />
                  <div className="fx-actions">
                    <Button onClick={() => setEdit(null)}>Cancel</Button>
                    <Button
                      variant="primary"
                      loading={busy === 'save'}
                      onClick={() =>
                        void run('save', async () => {
                          await call('files.write', { path: preview.path, content: edit });
                          setPreview({ ...preview, content: edit, size: new Blob([edit]).size });
                          setEdit(null);
                          toast.success('Saved');
                        })
                      }
                    >
                      Save
                    </Button>
                  </div>
                </div>
              ) : preview.kind === 'image' ? (
                <div style={{ padding: 12, overflow: 'auto' }}>
                  <img src={preview.content} alt="" style={{ maxWidth: '100%' }} />
                </div>
              ) : preview.kind === 'text' ? (
                <pre className="fx-code" style={{ margin: 12, flex: 1, overflow: 'auto' }}>
                  {preview.content}
                </pre>
              ) : (
                <Empty title="No preview">Double-click to open with its app.</Empty>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
