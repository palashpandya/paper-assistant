import { EditorSelection, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

/** Whether the text of a line up to some point leaves math open: inline ($), display ($$) or neither. */
function mathMode(text: string): 'none' | 'inline' | 'display' {
  const t = text.replace(/\\./g, '').replace(/%.*/, '');
  let mode: 'none' | 'inline' | 'display' = 'none';
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== '$') continue;
    const double = t[i + 1] === '$';
    if (mode === 'inline') mode = 'none';
    else if (double) {
      mode = mode === 'none' ? 'display' : 'none';
      i++;
    } else if (mode === 'none') mode = 'inline';
    // A single $ in display math is the first half of its closing $$.
  }
  return mode;
}

/**
 * Typing $ opens and closes math together, the way brackets are closed:
 *  - $ gives $|$, and a second $ there gives $$|$$ for display math;
 *  - $ in front of a closing $ steps over it, and $ inside open math just closes it;
 *  - with text selected, $ wraps it;
 *  - Backspace between an empty pair removes both.
 * \$ and comments are left alone.
 */
export const mathPairs: Extension = [
  EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== '$' || view.state.readOnly) return false;
    const { state } = view;
    if (state.selection.ranges.length > 1) return false;
    const line = state.doc.lineAt(from);
    const before = line.text.slice(0, from - line.from);
    // An escaped dollar (\$) or one in a comment is just a character.
    if (/(^|[^\\])(\\\\)*\\$/.test(before) || /(^|[^\\])%/.test(before)) return false;
    const event = { userEvent: 'input.type', scrollIntoView: true };
    if (from !== to) {
      view.dispatch({ changes: [{ from, insert: '$' }, { from: to, insert: '$' }], selection: EditorSelection.range(from + 1, to + 1), ...event });
      return true;
    }
    const next = state.sliceDoc(from, from + 1);
    if (next === '$' && before.endsWith('$') && mathMode(before) === 'inline' && mathMode(before.slice(0, -1)) === 'none') {
      // $|$ becomes $$|$$.
      view.dispatch({ changes: { from, insert: '$$' }, selection: { anchor: from + 1 }, ...event });
    } else if (next === '$') {
      view.dispatch({ selection: { anchor: from + 1 }, ...event });
    } else if (mathMode(before) !== 'none') {
      return false; // Closing math that is already open.
    } else {
      view.dispatch({ changes: { from, insert: '$$' }, selection: { anchor: from + 1 }, ...event });
    }
    return true;
  }),
  keymap.of([
    {
      key: 'Backspace',
      run: (view) => {
        const sel = view.state.selection.main;
        if (!sel.empty || view.state.selection.ranges.length > 1 || view.state.sliceDoc(sel.from - 1, sel.from + 1) !== '$$') return false;
        const line = view.state.doc.lineAt(sel.from);
        // Only a pair this cursor sits inside: the $ before must be an opening one.
        if (mathMode(line.text.slice(0, sel.from - line.from - 1)) !== 'none' && view.state.sliceDoc(sel.from - 2, sel.from + 2) !== '$$$$') return false;
        view.dispatch({ changes: { from: sel.from - 1, to: sel.from + 1 }, userEvent: 'delete.backward' });
        return true;
      },
    },
  ]),
];
