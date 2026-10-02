import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CodeLanguage } from '@fbrx/shared';
import { Button, Callout, Card, Icons, Input, Select, Tabs, TextArea, timeAgo, useAction, useConfirm, useToast } from '@fbrx/ui';
import { bridge, call, openExternal, writeClipboard, type CodeRunResult } from './client';
import { useCore } from './hooks';
import { navigate } from './app';
import { CodeEditor, type CodeEditorHandle } from './code-editor';
import { LANGS, blankFile, langForFile, langInfo, type LangInfo } from './code-starters';
import { QuickAiPanel, useQuickAi, whatIfPrompt } from './quick-ai';

/**
 * Terminal → Code: an editor with Fabrix beside it. Nothing here can reach your computer or the network: JavaScript
 * runs in a hidden window with every request blocked, PowerShell and batch files run only inside Windows Sandbox
 * (networking off, the code folder read-only), and other languages are explained, not run. "Run it yourself" shows
 * how to run any of them outside FBRX, and "What if?" says what a file would do before you run it anywhere.
 */

const LAST_KEY = 'fbrx.codelab.last';
const NAME = /^[A-Za-z0-9][\w .()-]{0,79}\.([a-z0-9]+)$/;
let docSeq = 1;

interface Doc {
  /** Changes when another file is opened, so the editor starts a fresh undo history. */
  id: number;
  name: string;
  content: string;
  /** What is on disk; null for a file that was never saved. */
  saved: string | null;
  /** What a new file started as (a quick start or an AI answer), so an untouched one doesn't count as a change. */
  base: string;
}

/** A code fence's language ("py", "c#", "pwsh") → the code lab language it is. */
function fenceLang(tag: string): LangInfo | null {
  const t = tag.trim().toLowerCase();
  if (!t) return null;
  const alias: Record<string, CodeLanguage> = { py: 'python', js: 'javascript', ts: 'typescript', 'c#': 'csharp', cs: 'csharp', sh: 'bash', shell: 'bash', zsh: 'bash', ps: 'powershell', ps1: 'powershell', pwsh: 'powershell', bat: 'batch', cmd: 'batch', 'c++': 'cpp', golang: 'go', rb: 'ruby', rs: 'rust', kt: 'kotlin' };
  const id = alias[t] ?? (t as CodeLanguage);
  return LANGS.find((l) => l.id === id) ?? null;
}

function RunItYourself({ lang, name, folder }: { lang: LangInfo; name: string; folder: string | null }) {
  const toast = useToast();
  const cmds = lang.commands.map((c) => c.replace(new RegExp(lang.file.replace('.', '\\.'), 'g'), name));
  return (
    <div className="code-howto">
      <div className="code-howto-row">
        <span className="code-howto-label">Get it</span>
        <button className="link-btn" onClick={() => openExternal(lang.get.url)}>
          {lang.get.label} <Icons.external size={12} />
        </button>
      </div>
      <ol>
        {lang.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      {cmds.length > 0 && (
        <div className="code-howto-cmds">
          {cmds.map((c) => (
            <div key={c} className="code-howto-cmd">
              <code>{c}</code>
              {!c.startsWith('#') && <Button size="sm" variant="ghost" icon="copy" aria-label="Copy" onClick={() => void writeClipboard(c.replace(/\s+#.*$/, '')).then(() => toast.success('Copied'))} />}
            </div>
          ))}
        </div>
      )}
      {folder && (
        <div className="fx-help">
          Your code lab files are in <span className="mono">{folder}</span>.{' '}
          <button className="link-btn" onClick={() => bridge.reveal?.(folder)}>
            Show the folder
          </button>
        </div>
      )}
      <Callout tone="info" title="Before you run code from anywhere">
        Read it first, or press <b>What if?</b>: Fabrix says what it would read, change, delete or download. Run code you don't trust in Windows Sandbox or a virtual machine, never as administrator.
      </Callout>
    </div>
  );
}

export function CodeLabPanel() {
  const files = useCore('codelab.list');
  const editors = useCore('codelab.editors');
  const folder = useCore('codelab.folder');
  const [doc, setDoc] = useState<Doc | null>(null);
  const [inputs, setInputs] = useState('rock\npaper\nscissors\nq');
  const [out, setOut] = useState<CodeRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [side, setSide] = useState<'ai' | 'howto'>('ai');
  const [newLang, setNewLang] = useState<CodeLanguage | ''>('');
  const editor = useRef<CodeEditorHandle | null>(null);
  const ai = useQuickAi();
  const { run } = useAction();
  const { confirm, dialog } = useConfirm();
  const toast = useToast();

  const lang = (doc && langForFile(doc.name)) || langInfo('javascript');
  const nameOk = !!doc && NAME.test(doc.name) && !!langForFile(doc.name);
  const dirty = !!doc && doc.content !== (doc.saved ?? doc.base);

  const openFile = useCallback(async (name: string) => {
    const r = await call('codelab.read', { name }).catch(() => null);
    if (!r) return false;
    setDoc({ id: docSeq++, name: r.name, content: r.content, saved: r.content, base: r.content });
    setOut(null);
    try {
      localStorage.setItem(LAST_KEY, name);
    } catch {
      /* private window */
    }
    return true;
  }, []);

  // Open the last file, or the JavaScript quick start the first time.
  useEffect(() => {
    if (doc || !files.data) return;
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_KEY);
    } catch {
      /* private window */
    }
    const pick = (last && files.data.find((f) => f.name === last)?.name) || files.data[0]?.name;
    if (pick) void openFile(pick);
    else setDoc({ id: docSeq++, name: 'rps.js', content: langInfo('javascript').starter, saved: null, base: langInfo('javascript').starter });
  }, [files.data, doc, openFile]);

  const leave = async () => !dirty || (await confirm({ title: `Discard changes to ${doc!.name}?`, body: 'Your unsaved changes will be lost.', danger: true, confirmLabel: 'Discard' }));

  const startFrom = async (l: LangInfo, content: string, name = l.file) => {
    if (!(await leave())) return;
    const exists = files.data?.some((f) => f.name === name);
    setDoc({ id: docSeq++, name, content, saved: null, base: content });
    setOut(null);
    setSide(l.runs === 'outside' ? 'howto' : 'ai');
    if (exists) toast.info(`${name} already exists`, 'Saving replaces it. Change the name first to keep both.');
  };

  const save = async (): Promise<boolean> => {
    if (!doc) return false;
    if (!nameOk) {
      toast.error('Check the file name', 'Use a simple name with a code extension, like game.py or rps.ps1.');
      return false;
    }
    const r = await run('save', () => call('codelab.save', { name: doc.name, content: doc.content }));
    if (!r) return false;
    setDoc((d) => (d ? { ...d, saved: d.content } : d));
    files.reload();
    try {
      localStorage.setItem(LAST_KEY, doc.name);
    } catch {
      /* private window */
    }
    return true;
  };

  const runCode = async () => {
    if (!doc) return;
    if (lang.runs === 'here') {
      if (!bridge.runCode) return toast.info('Running code needs the FBRX OS desktop app');
      setRunning(true);
      setOut(null);
      try {
        setOut((await bridge.runCode(doc.content, inputs.split('\n'))) as CodeRunResult);
      } finally {
        setRunning(false);
      }
    } else if (lang.runs === 'windows-sandbox') {
      if (!editors.data?.sandbox) {
        toast.info('Windows Sandbox is not turned on', 'Turn it on in Virtual lab → Windows Sandbox (Windows Pro or Enterprise), then try again.');
        return;
      }
      if (!(await save())) return;
      const ok = await run('sandbox', () => call('codelab.sandbox', { name: doc.name }));
      if (ok) toast.info('Windows Sandbox is starting…', `${doc.name} opens inside it in a few seconds: no network, and the code folder is read-only. Close the sandbox to throw everything away.`);
    } else setSide('howto');
  };

  const openIn = async (app: 'vscode' | 'ise' | 'notepad' | 'folder') => {
    if (!doc) return;
    if ((dirty || doc.saved === null) && !(await save())) return;
    await run('open', () => call('codelab.open', { name: doc.name, app }));
  };

  const remove = async () => {
    if (!doc || doc.saved === null) return;
    if (!(await confirm({ title: `Delete ${doc.name}?`, body: 'The file is removed from the code lab folder.', danger: true, confirmLabel: 'Delete' }))) return;
    if (await run('del', () => call('codelab.delete', { name: doc.name }), `${doc.name} deleted`)) {
      setDoc(null);
      files.reload();
    }
  };

  // The code (and what is selected) goes with every question.
  const context = () => {
    if (!doc) return '';
    const sel = editor.current?.selection() ?? doc.content;
    const focus = sel && sel !== doc.content ? `\n\nThe part I selected:\n\`\`\`${lang.id}\n${sel}\n\`\`\`` : '';
    return `File: ${doc.name} (${lang.name})\n\`\`\`${lang.id}\n${doc.content}\n\`\`\`${focus}`;
  };
  const askAi = (label: string, prompt: string) => {
    setSide('ai');
    void ai.ask(label, prompt, context());
  };
  const [convertTo, setConvertTo] = useState<CodeLanguage | ''>('');

  const codeActions = useCallback(
    (code: string, tag: string) => {
      const target = fenceLang(tag);
      const same = !target || target.id === lang.id;
      return (
        <>
          <Button size="sm" variant="ghost" icon="copy" onClick={() => void writeClipboard(code).then(() => toast.success('Copied'))}>
            Copy
          </Button>
          {same ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => editor.current?.insert(code)} title="Insert at the cursor (replaces what is selected)">
                Insert
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDoc((d) => (d ? { ...d, content: code.endsWith('\n') ? code : `${code}\n` } : d))} title="Replace the whole file (Ctrl+Z undoes it)">
                Replace file
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => void startFrom(target, code.endsWith('\n') ? code : `${code}\n`, `${(doc?.name ?? 'code').replace(/\.[^.]+$/, '')}.${target.ext}`)}>
              Open as {target.name} file
            </Button>
          )}
        </>
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lang.id, doc?.name, dirty],
  );

  const sortedLangs = useMemo(() => [...LANGS].sort((a, b) => a.name.localeCompare(b.name)), []);

  return (
    <div
      className="code-lab"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
          e.preventDefault();
          void save();
        } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          void runCode();
        }
      }}
    >
      <aside className="code-files">
        <Card
          title="Files"
          actions={
            folder.data && bridge.reveal ? <Button size="sm" variant="ghost" icon="folder" aria-label="Show the code lab folder" title="Show the code lab folder" onClick={() => void bridge.reveal!(folder.data!.path)} /> : undefined
          }
          flush
        >
          <div className="code-file-list">
            {(files.data ?? []).map((f) => (
              <button key={f.name} className={`code-file${doc?.name === f.name ? ' active' : ''}`} onClick={() => void leave().then((ok) => ok && openFile(f.name))}>
                <span className="code-file-name">{f.name}</span>
                <span className="code-file-meta">
                  {langInfo(f.language).name} · {timeAgo(f.updatedAt)}
                </span>
              </button>
            ))}
            {!files.data?.length && <div className="code-file-empty">Saved files show up here.</div>}
          </div>
          <div className="code-new">
            <Select
              aria-label="New file"
              value={newLang}
              onChange={(e) => {
                const l = langInfo(e.target.value as CodeLanguage);
                setNewLang('');
                void startFrom(l, blankFile(l), `untitled.${l.ext}`);
              }}
              options={[{ value: '', label: '+ New file…' }, ...sortedLangs.map((l) => ({ value: l.id, label: l.name }))]}
            />
          </div>
        </Card>
        <Card title="Quick start" subtitle="Rock, Paper, Scissors in every language" flush>
          <div className="code-starters">
            {sortedLangs.map((l) => (
              <button key={l.id} className={`code-starter${doc?.name === l.file && doc.content === l.starter ? ' active' : ''}`} onClick={() => void startFrom(l, l.starter)} title={`Open Rock, Paper, Scissors in ${l.name}`}>
                <span>{l.name}</span>
                {l.runs === 'here' ? <span className="code-starter-tag good">runs here</span> : l.runs === 'windows-sandbox' ? <span className="code-starter-tag">Sandbox</span> : null}
              </button>
            ))}
          </div>
        </Card>
      </aside>

      <section className="code-main">
        <div className="code-toolbar">
          <div className="code-name">
            <Input className={`mono${doc && !nameOk ? ' invalid' : ''}`} value={doc?.name ?? ''} aria-label="File name" spellCheck={false} maxLength={84} onChange={(e) => setDoc((d) => (d ? { ...d, name: e.target.value.trim() } : d))} />
            <span className="code-lang">{lang.name}</span>
            {dirty && <span className="code-dirty" title="Not saved" />}
          </div>
          <Button size="sm" icon="check" disabled={!doc || (!dirty && doc.saved !== null)} onClick={() => void save()} title="Save (Ctrl+S)">
            Save
          </Button>
          {lang.runs === 'here' ? (
            <Button size="sm" variant="primary" icon="play" loading={running} disabled={!doc} onClick={() => void runCode()} title="Run in FBRX's sandbox: no network, no files (Ctrl+Enter)">
              Run
            </Button>
          ) : lang.runs === 'windows-sandbox' ? (
            <Button size="sm" variant="primary" icon="box" disabled={!doc} onClick={() => void runCode()} title="Run inside Windows Sandbox: a throwaway Windows with no network">
              Run in Sandbox
            </Button>
          ) : (
            <Button size="sm" icon="book" onClick={() => setSide('howto')} title={`FBRX doesn't run ${lang.name}. See how to run it yourself.`}>
              How to run it
            </Button>
          )}
          <Button size="sm" className="ask-btn" icon="sparkles" disabled={!doc?.content.trim()} onClick={() => askAi('What if I run this?', whatIfPrompt(`${lang.name} file`))}>
            What if?
          </Button>
          <div className="code-toolbar-gap" />
          {editors.data?.vscode && (
            <Button size="sm" variant="ghost" icon="external" disabled={!doc} onClick={() => void openIn('vscode')}>
              VS Code
            </Button>
          )}
          {editors.data?.ise && lang.id === 'powershell' && (
            <Button size="sm" variant="ghost" icon="external" disabled={!doc} onClick={() => void openIn('ise')}>
              PowerShell ISE
            </Button>
          )}
          <Button size="sm" variant="ghost" icon="edit" disabled={!doc} onClick={() => void openIn('notepad')} title="Open in your text editor">
            Editor
          </Button>
          {doc?.saved !== null && <Button size="sm" variant="ghost" icon="trash" aria-label={`Delete ${doc?.name ?? ''}`} disabled={!doc} onClick={() => void remove()} />}
        </div>

        <div className="code-editor-wrap">{doc ? <CodeEditor key={doc.id} value={doc.content} language={lang.id} onChange={(v) => setDoc((d) => (d ? { ...d, content: v } : d))} handle={editor} label={`${lang.name} code`} /> : <div className="code-editor-empty">Pick a file or a quick start on the left.</div>}</div>

        {lang.runs === 'here' ? (
          <div className="code-run">
            <div className="code-run-input">
              <label htmlFor="code-inputs">Input</label>
              <TextArea id="code-inputs" code rows={4} value={inputs} onChange={(e) => setInputs(e.target.value)} placeholder="Answers for prompt(), one per line" />
              <div className="fx-help">One answer per line, for each prompt() the program asks.</div>
            </div>
            <div className="code-run-out" aria-live="polite">
              <div className="code-run-head">
                <span>Output</span>
                {out && (
                  <span className="fx-muted">
                    {out.timedOut ? 'stopped' : `finished in ${out.ms} ms`}
                    {out.truncated ? ' · output cut short' : ''}
                  </span>
                )}
                {running && (
                  <Button size="sm" variant="ghost" icon="stop" onClick={() => void bridge.stopCode?.()}>
                    Stop
                  </Button>
                )}
                {out?.lines.some((l) => l.level === 'error') && (
                  <Button size="sm" variant="ghost" icon="sparkles" onClick={() => askAi('Why did it fail?', `My ${lang.name} program failed with this output. Explain the error in plain words and show the fix.\n\nOutput:\n${out.lines.map((l) => l.text).join('\n').slice(-6000)}`)}>
                    Why?
                  </Button>
                )}
              </div>
              <pre className="code-run-lines">
                {!out && !running && <span className="term-dim">Press Run (Ctrl+Enter). The program can't reach the network or your files.</span>}
                {running && <span className="term-dim">Running…</span>}
                {out?.lines.map((l, i) => (
                  <div key={i} className={`code-line ${l.level}`}>
                    {l.text}
                  </div>
                ))}
                {out && !out.lines.length && <span className="term-dim">(no output)</span>}
              </pre>
            </div>
          </div>
        ) : (
          <div className="code-run-note">
            <Icons.shield size={15} />
            {lang.runs === 'windows-sandbox' ? (
              <span>
                FBRX never runs {lang.name} on this computer. <b>Run in Windows Sandbox</b> opens it inside a disposable Windows with no network; the file is read-only there. {editors.data && !editors.data.sandbox && <button className="link-btn" onClick={() => navigate('lab')}>Turn on Windows Sandbox</button>}
              </span>
            ) : (
              <span>
                FBRX doesn't run {lang.name}: it stays text here. Use <b>What if?</b> to see what it would do, and <button className="link-btn" onClick={() => setSide('howto')}>Run it yourself</button> for the tools and commands.
              </span>
            )}
          </div>
        )}
      </section>

      <aside className="code-side">
        <Tabs
          active={side}
          onChange={setSide}
          tabs={[
            { id: 'ai', label: 'Fabrix' },
            { id: 'howto', label: 'Run it yourself' },
          ]}
        />
        {side === 'ai' ? (
          <QuickAiPanel
            ai={ai}
            codeActions={codeActions}
            onAsk={(t) => void ai.ask(t, `${t}\n\n(This is about the ${lang.name} file ${doc?.name ?? ''} in my code lab, attached below. When you change code, give it in a fenced code block with the language.)`, context())}
            empty={`Ask anything about ${doc?.name ?? 'your code'}: how it works, why it fails, how to add a feature. Select lines first to ask about just those.`}
            placeholder="Ask about this code… (/ for macros)"
            actions={
              <>
                <Button size="sm" disabled={!doc?.content.trim() || ai.busy} onClick={() => askAi('Explain this code', `Explain this ${lang.name} code for someone learning: first what it does, then walk through it section by section.`)}>
                  Explain
                </Button>
                <Button size="sm" disabled={!doc?.content.trim() || ai.busy} onClick={() => askAi('Find and fix bugs', `Find bugs, mistakes and risky parts in this ${lang.name} code. For each, say what is wrong and why. Then give the corrected full file in one \`\`\`${lang.id} code block.`)}>
                  Fix
                </Button>
                <Button size="sm" disabled={!doc?.content.trim() || ai.busy} onClick={() => askAi('Add comments', `Add clear, helpful comments to this ${lang.name} code without changing what it does. Give the full file in one \`\`\`${lang.id} code block.`)}>
                  Comment
                </Button>
                <div className="qa-convert">
                  <Select
                    aria-label="Convert to another language"
                    value={convertTo}
                    disabled={!doc?.content.trim() || ai.busy}
                    onChange={(e) => {
                      const t = langInfo(e.target.value as CodeLanguage);
                      setConvertTo('');
                      askAi(`Convert to ${t.name}`, `Rewrite this ${lang.name} program in ${t.name} with the same behavior. Give the full file in one \`\`\`${t.id} code block, then the command to run it.`);
                    }}
                    options={[{ value: '', label: 'Convert to…' }, ...sortedLangs.filter((l) => l.id !== lang.id).map((l) => ({ value: l.id, label: l.name }))]}
                  />
                </div>
              </>
            }
          />
        ) : (
          <RunItYourself lang={lang} name={doc?.name && nameOk ? doc.name : lang.file} folder={folder.data?.path ?? null} />
        )}
      </aside>
      {dialog}
    </div>
  );
}
