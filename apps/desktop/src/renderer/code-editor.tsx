import { useEffect, useRef, useState } from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { StreamLanguage, bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { rust } from '@codemirror/lang-rust';
import { php } from '@codemirror/lang-php';
import { csharp, kotlin } from '@codemirror/legacy-modes/mode/clike';
import { go } from '@codemirror/legacy-modes/mode/go';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import type { CodeLanguage } from '@fbrx/shared';

/** A real code editor (CodeMirror 6): syntax colors, line numbers, brackets, folding, search (Ctrl+F) and undo. */

function languageFor(l: CodeLanguage): Extension {
  switch (l) {
    case 'javascript':
      return javascript();
    case 'typescript':
      return javascript({ typescript: true });
    case 'python':
      return python();
    case 'c':
    case 'cpp':
      return cpp();
    case 'java':
      return java();
    case 'rust':
      return rust();
    case 'php':
      return php({ plain: false });
    case 'csharp':
      return StreamLanguage.define(csharp);
    case 'kotlin':
      return StreamLanguage.define(kotlin);
    case 'go':
      return StreamLanguage.define(go);
    case 'ruby':
      return StreamLanguage.define(ruby);
    case 'bash':
      return StreamLanguage.define(shell);
    case 'lua':
      return StreamLanguage.define(lua);
    case 'powershell':
      return StreamLanguage.define(powerShell);
    case 'swift':
      return StreamLanguage.define(swift);
    default:
      return [];
  }
}

const frame = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--code-bg)', color: 'var(--code-ink)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '10px 0' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'var(--code-gutter)', color: 'var(--text-muted)', border: 'none', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'var(--code-active)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--code-active)', color: 'var(--text-secondary)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--code-selection) !important' },
  '.cm-matchingBracket': { backgroundColor: 'var(--accent-wash)', outline: '1px solid var(--accent)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface-1)', border: '1px solid var(--border-strong)', borderRadius: '8px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-wash)', color: 'var(--text-primary)' },
  '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text-primary)' },
  '.cm-searchMatch': { backgroundColor: 'var(--accent-wash)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--surface-3)', border: 'none', color: 'var(--text-secondary)' },
});

export function useDocTheme(): 'light' | 'dark' {
  const read = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const [mode, setMode] = useState<'light' | 'dark'>(read);
  useEffect(() => {
    const mo = new MutationObserver(() => setMode(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return mode;
}

export interface CodeEditorHandle {
  /** The selected text, or the whole file when nothing is selected. */
  selection(): string;
  /** Replaces the selection (or inserts at the cursor). */
  insert(text: string): void;
  focus(): void;
}

export function CodeEditor({ value, onChange, language, readOnly, handle, label }: { value: string; onChange: (v: string) => void; language: CodeLanguage; readOnly?: boolean; handle?: { current: CodeEditorHandle | null }; label?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const comps = useRef({ lang: new Compartment(), theme: new Compartment(), ro: new Compartment(), indent: new Compartment() });
  const mode = useDocTheme();

  useEffect(() => {
    const c = comps.current;
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          EditorView.lineWrapping,
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
          frame,
          EditorView.contentAttributes.of({ 'aria-label': label ?? 'Code editor' }),
          c.lang.of(languageFor(language)),
          c.indent.of(indentUnit.of(language === 'go' ? '\t' : language === 'python' ? '    ' : '  ')),
          c.theme.of(syntaxHighlighting(mode === 'dark' ? oneDarkHighlightStyle : defaultHighlightStyle, { fallback: true })),
          c.ro.of(EditorState.readOnly.of(!!readOnly)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    if (handle)
      handle.current = {
        selection: () => {
          const r = v.state.selection.main;
          return r.empty ? v.state.doc.toString() : v.state.sliceDoc(r.from, r.to);
        },
        insert: (text) => {
          v.dispatch(v.state.replaceSelection(text));
          v.focus();
        },
        focus: () => v.focus(),
      };
    return () => {
      v.destroy();
      view.current = null;
      if (handle) handle.current = null;
    };
    // The editor is created once; later changes go through compartments and the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);
  useEffect(() => {
    const c = comps.current;
    view.current?.dispatch({ effects: [c.lang.reconfigure(languageFor(language)), c.indent.reconfigure(indentUnit.of(language === 'go' ? '\t' : language === 'python' ? '    ' : '  '))] });
  }, [language]);
  useEffect(() => {
    view.current?.dispatch({ effects: comps.current.theme.reconfigure(syntaxHighlighting(mode === 'dark' ? oneDarkHighlightStyle : defaultHighlightStyle, { fallback: true })) });
  }, [mode]);
  useEffect(() => {
    view.current?.dispatch({ effects: comps.current.ro.reconfigure(EditorState.readOnly.of(!!readOnly)) });
  }, [readOnly]);

  return <div className="code-editor" ref={host} />;
}
