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
  onSave: (path: string, content: string) => void;
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

  // Mutable state the CodeMirror listeners read; kept in refs so the view is created once.
  const s = useRef({
    path: null as string | null,
    baseline: '',
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

  const flushSave = () => {
    const st = s.current;
    const view = viewRef.current;
    if (!st.saveTimer || !view || !st.path) return;
    clearTimeout(st.saveTimer);
    st.saveTimer = undefined;
    const content = view.state.doc.toString();
    if (!st.reviewing) st.baseline = content;
    st.cb.onSave(st.path, content);
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
        clearTimeout(st.saveTimer);
        st.saveTimer = setTimeout(flushSave, 300);
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
      flushSave();
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
      flushSave();
      st.path = doc.path;
      st.baseline = doc.baseline;
      setReview(review);
      // A fresh state per file keeps undo history from crossing files.
      view.setState(EditorState.create({ doc: doc.content, extensions: extensions(review, doc.baseline) }));
      st.cb.onSelection({ line: 1, fromLine: 1, toLine: 1, text: '' });
      return;
    }

    // Same file changed on disk (usually the agent): drop any unsaved keystrokes and apply a minimal change.
    clearTimeout(st.saveTimer);
    st.saveTimer = undefined;
    const current = view.state.doc.toString();
    const next = doc.content;
    let start = 0;
    const max = Math.min(current.length, next.length);
    while (start < max && current.charCodeAt(start) === next.charCodeAt(start)) start++;
    let endCur = current.length;
    let endNext = next.length;
    while (endCur > start && endNext > start && current.charCodeAt(endCur - 1) === next.charCodeAt(endNext - 1)) {
      endCur--;
      endNext--;
    }
    st.baseline = doc.baseline;
    setReview(review);
    view.dispatch({
      changes: { from: start, to: endCur, insert: next.slice(start, endNext) },
      annotations: External.of(true),
      effects: st.review.reconfigure(review ? reviewExtension(doc.baseline) : []),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.path, doc?.version]);

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
      <div className="editor-host" ref={hostRef} />
    </div>
  );
}
