import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import katex from 'katex';
import rehypeKatex from 'rehype-katex';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';

/** Code and existing math; these parts of a message are left untouched. */
const PROTECTED = /(```[\s\S]*?```|`[^`\n]*`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/;

/** A run of LaTeX starting with a command: \rho, \alpha_{ij}, \frac{1}{2}, \hat{H}^2 ... */
const BARE_LATEX = /\\[a-zA-Z]+(?:\{[^{}]*\}|[_^](?:\{[^{}]*\}|[A-Za-z0-9])|\\[a-zA-Z]+)*/g;

const isMath = (tex: string) => {
  try {
    katex.renderToString(tex, { throwOnError: true, strict: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const outsideProtected = (text: string, fn: (plain: string) => string) =>
  text
    .split(PROTECTED)
    .map((part, i) => (i % 2 ? part : fn(part)))
    .join('');

/** \( \) and \[ \] become $ and $$, which the Markdown math plugin understands. */
const normaliseDelimiters = (text: string) =>
  outsideProtected(text, (plain) =>
    plain.replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => `$${tex}$`).replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => `$$${tex}$$`),
  )
    // $$...$$ is only typeset as a display equation when it sits on its own lines.
    .split(PROTECTED)
    .map((part, i) => (i % 2 && part.startsWith('$$') ? `\n\n$$\n${part.slice(2, -2).trim()}\n$$\n\n` : part))
    .join('');

/**
 * Wraps bare LaTeX in $...$ so it is typeset even without delimiters, e.g. a
 * user typing "make \rho_{ij} bold". Commands that are not math (\section,
 * \cite, ...) are left as plain text.
 */
export const autoMath = (text: string) =>
  outsideProtected(normaliseDelimiters(text), (plain) => plain.replace(BARE_LATEX, (tex) => (isMath(tex) ? `$${tex}$` : tex)));

export const hasMath = (text: string) => /\$[^$\n]+\$|\$\$[\s\S]+?\$\$/.test(autoMath(text));

interface Props {
  text: string;
  /** For text typed by the user: typeset bare LaTeX and keep single line breaks. */
  user?: boolean;
}

export const Markdown = memo(function Markdown({ text, user }: Props) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={user ? [remarkGfm, remarkMath, remarkBreaks] : [remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: 'ignore' }]]}
      >
        {user ? autoMath(text) : normaliseDelimiters(text)}
      </ReactMarkdown>
    </div>
  );
});
