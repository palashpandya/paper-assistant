import { useEffect, useRef, useState } from 'react';
import { basicSetup } from 'codemirror';
import { Annotation, Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { getOriginalDoc, unifiedMergeView } from '@codemirror/merge';
import { latexCompletion } from './latexComplete';
import { mathPairs } from './latexInput';
import { CONFLICT_START, mergeContents } from './fileSync';
import type { FileSaveResult } from './api';

export interface EditorDoc {
  path: string;
  content: string;
  /** The reviewed version this file is diffed against. */
  baseline: string;
  /** Bumped whenever content arrives from outside the editor (file load, agent edit). */
  version: number;
}

export interface EditorSelection {
  line: number;
  fromLine: number;
  toLine: number;
  text: string;
}

interface Props {
  doc: EditorDoc | null;
  jump: { path: string; line: number; nonce: number } | null;
  onSave: (path: string, content: string, expected: string) => Promise<FileSaveResult>;
  onBaseline: (path: string, content: string) => void;
  onShowInPdf: (path: string, line: number) => void;
  onSelection: (selection: EditorSelection | null) => void;
}

/** Syntax colours come from CSS variables, so switching theme needs no editor reconfiguration. */
const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.tagName, color: 'var(--syn-command)' },
    { tag: tags.keyword, color: 'var(--syn-keyword)' },
    { tag: [tags.atom, tags.standard(tags.variableName)], color: 'var(--syn-atom)' },
    { tag: tags.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
    { tag: tags.string, color: 'var(--syn-string)' },
    { tag: tags.number, color: 'var(--syn-number)' },
    { tag: tags.bracket, color: 'var(--syn-bracket)' },
    { tag: [tags.special(tags.variableName), tags.meta], color: 'var(--syn-math)' },
    { tag: tags.invalid, color: 'var(--bad)' },
  ]),
);

const latex = StreamLanguage.define(stex);

/** Marks transactions that load content from outside, so they are not saved back. */
const External = Annotation.define<boolean>();

const reviewExtension = (original: string) =>
  unifiedMergeView({ original, mergeControls: true, highlightChanges: true, gutter: true });

export function Editor({ doc, jump, onSave, onBaseline, onShowInPdf, onSelection }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const [saveFinished, setSaveFinished] = useState(0);

  // Mutable state the CodeMirror listeners read; kept in refs so the view is created once.
  const s = useRef({
    path: null as string | null,
    baseline: '',
    diskContent: '',
    saving: false,
    loadedVersion: -1,
    reviewing: false,
    saveTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    review: new Compartment(),
    doneJump: 0,
    cb: { onSave, onBaseline, onShowInPdf, onSelection },
  });
  s.current.cb = { onSave, onBaseline, onShowInPdf, onSelection };

  const setReview = (on: boolean) => {
    s.current.reviewing = on;
    setReviewing(on);
  };

  const scheduleSave = () => {
    clearTimeout(s.current.saveTimer);
    s.current.saveTimer = setTimeout(() => void flushSave(), 300);
  };

  const flushSave = async () => {
    const st = s.current;
    const view = viewRef.current;
    if (!st.saveTimer || !view || !st.path || st.saving) return;
    clearTimeout(st.saveTimer);
    st.saveTimer = undefined;
    const content = view.state.doc.toString();
    const path = st.path;
    const expected = st.diskContent;
    st.saving = true;
    let succeeded = false;
    try {
      const result = await st.cb.onSave(path, content, expected);
      succeeded = true;
      if (st.path === path && st.diskContent === expected) {
        if (result.saved) {
          st.diskContent = content;
          st.baseline = result.baseline;
        } else applyRemote(result.content, result.baseline);
      }
      setSaveError(null);
    } catch (err) {
      setSaveError(`Could not save: ${(err as Error).message}. Your edits are still in the editor.`);
    } finally {
      st.saving = false;
      if ((succeeded || st.path !== path) && viewRef.current && viewRef.current.state.doc.toString() !== st.diskContent) scheduleSave();
      if (succeeded) setSaveFinished((n) => n + 1);
    }
  };

  const applyRemote = (content: string, baseline: string) => {
    const st = s.current;
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    const next = mergeContents(st.diskContent, current, content);
    st.diskContent = content;
    clearTimeout(st.saveTimer);
    st.saveTimer = undefined;
    let start = 0;
    const max = Math.min(current.length, next.length);
    while (start < max && current.charCodeAt(start) === next.charCodeAt(start)) start++;
    let endCur = current.length;
    let endNext = next.length;
    while (endCur > start && endNext > start && current.charCodeAt(endCur - 1) === next.charCodeAt(endNext - 1)) {
      endCur--;
      endNext--;
    }
    st.baseline = baseline;
    const review = next !== baseline;
    setReview(review);
    view.dispatch({
      changes: { from: start, to: endCur, insert: next.slice(start, endNext) },
      annotations: External.of(true),
      effects: st.review.reconfigure(review ? reviewExtension(baseline) : []),
    });
    if (next !== content) scheduleSave();
  };

  const endReview = () => {
    const view = viewRef.current;
    if (!view || !s.current.reviewing) return;
    setReview(false);
    view.dispatch({ effects: s.current.review.reconfigure([]) });
  };

  const extensions = (review: boolean, baseline: string) => [
    mathPairs, // Before basicSetup, so its Backspace is tried first.
    basicSetup,
    latex,
    latex.data.of({ autocomplete: latexCompletion }),
    highlight,
    EditorView.lineWrapping,
    // The active-line background is painted over the selection layer; see .cm-has-selection in themes.css.
    EditorView.editorAttributes.compute(['selection'], (state) => ({
      class: state.selection.ranges.some((r) => !r.empty) ? 'cm-has-selection' : '',
    })),
    keymap.of([
      {
        key: 'Alt-Enter',
        run: (view) => {
          const st = s.current;
          if (st.path) st.cb.onShowInPdf(st.path, view.state.doc.lineAt(view.state.selection.main.head).number);
          return true;
        },
      },
    ]),
    s.current.review.of(review ? reviewExtension(baseline) : []),
    EditorView.updateListener.of((u) => {
      const st = s.current;
      if (u.docChanged && !u.transactions.some((t) => t.annotation(External))) {
        scheduleSave();
      }
      if (st.reviewing && st.path) {
        const original = getOriginalDoc(u.state).toString();
        if (original !== st.baseline) {
          // The user accepted a chunk.
          st.baseline = original;
          st.cb.onBaseline(st.path, original);
        }
        if (original === u.state.doc.toString()) setTimeout(endReview);
      }
      if (u.selectionSet || u.docChanged) {
        setConflicted(u.state.doc.toString().includes(CONFLICT_START));
        const sel = u.state.selection.main;
        st.cb.onSelection({
          line: u.state.doc.lineAt(sel.head).number,
          fromLine: u.state.doc.lineAt(sel.from).number,
          toLine: u.state.doc.lineAt(sel.to).number,
          text: u.state.sliceDoc(sel.from, sel.to),
        });
      }
    }),
  ];

  useEffect(() => {
    const view = new EditorView({ parent: hostRef.current!, state: EditorState.create({ doc: '' }) });
    viewRef.current = view;
    return () => {
      void flushSave();
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load a file, or apply a change that came from outside the editor.
  useEffect(() => {
    const view = viewRef.current;
    const st = s.current;
    if (!view || !doc) return;
    const review = doc.content !== doc.baseline;

    if (doc.path !== st.path) {
      // Finish the old file before replacing its buffer, including edits typed
      // while its previous save was in flight.
      if (st.saving) return;
      if (st.path && view.state.doc.toString() !== st.diskContent) {
        scheduleSave();
        void flushSave();
        return;
      }
      st.path = doc.path;
      st.baseline = doc.baseline;
      st.diskContent = doc.content;
      st.loadedVersion = doc.version;
      setSaveError(null);
      setConflicted(doc.content.includes(CONFLICT_START));
      setReview(review);
      // A fresh state per file keeps undo history from crossing files.
      view.setState(EditorState.create({ doc: doc.content, extensions: extensions(review, doc.baseline) }));
      st.cb.onSelection({ line: 1, fromLine: 1, toLine: 1, text: '' });
      return;
    }

    if (st.loadedVersion !== doc.version) {
      st.loadedVersion = doc.version;
      applyRemote(doc.content, doc.baseline);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.path, doc?.version, saveFinished]);

  // Jump to a line (from the PDF or the error list) once the right file is loaded.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !jump || !doc || jump.path !== doc.path || s.current.doneJump === jump.nonce) return;
    s.current.doneJump = jump.nonce;
    const line = view.state.doc.line(Math.max(1, Math.min(jump.line, view.state.doc.lines)));
    view.dispatch({
      selection: { anchor: line.from, head: line.to },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    });
    view.focus();
  }, [jump, doc?.path, doc?.version]);

  const acceptAll = () => {
    const view = viewRef.current;
    const st = s.current;
    if (!view || !st.path) return;
    const content = view.state.doc.toString();
    st.baseline = content;
    st.cb.onBaseline(st.path, content);
    endReview();
  };

  const rejectAll = () => {
    const view = viewRef.current;
    if (!view) return;
    const original = getOriginalDoc(view.state).toString();
    // A normal (user) change, so it is saved back to disk.
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: original } });
  };

  const showInPdf = () => {
    const view = viewRef.current;
    if (view && s.current.path) {
      onShowInPdf(s.current.path, view.state.doc.lineAt(view.state.selection.main.head).number);
    }
  };

  return (
    <div className="pane editor-pane">
      <div className="pane-bar">
        <span className="pane-title">{doc?.path ?? 'No file open'}</span>
        {reviewing && (
          <span className="review">
            <span className="review-label">Unreviewed changes</span>
            <button className="btn small ok" onClick={acceptAll}>
              Accept all
            </button>
            <button className="btn small" onClick={rejectAll}>
              Reject all
            </button>
          </span>
        )}
        <span className="spacer" />
        <button className="btn small" onClick={showInPdf} disabled={!doc} title="Show this line in the PDF (Alt+Enter)">
          Show in PDF
        </button>
      </div>
      {saveError && <div className="bar" role="alert">{saveError} <button className="btn small" onClick={() => { scheduleSave(); }}>Retry save</button></div>}
      {conflicted && <div className="bar" role="alert">Both versions were kept between conflict markers. Resolve the marked text to restore a valid LaTeX file.</div>}
      <div className="editor-host" ref={hostRef} />
    </div>
  );
}
