import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isAssetFile, isSkippedDir, type Project } from './project.ts';

/** What the editor's completion offers from the paper itself. Mirrored by hand in src/api.ts. */
export interface Symbols {
  /** `\label`s, with where they are. */
  labels: { name: string; file: string; line: number }[];
  /** Citation keys from the .bib files and any `\bibitem`s, with author, year and title when known. */
  cites: { key: string; detail: string }[];
  /** Commands the paper defines, without the backslash, with their number of arguments. */
  macros: { name: string; args: number }[];
  /** Environments and theorems the paper defines. */
  envs: string[];
  /** Files for `\input`, `\bibliography` and `\includegraphics`, relative to the main file's folder. */
  tex: string[];
  bib: string[];
  graphics: string[];
}

const uncommented = (line: string) => line.replace(/(^|[^\\])%.*/, '$1');

const field = (entry: string, name: string): string => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:\\{((?:[^{}]|\\{[^{}]*\\})*)\\}|"([^"]*)"|(\\d+))`, 'i').exec(entry);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
};

function bibEntries(content: string): Symbols['cites'] {
  const out: Symbols['cites'] = [];
  const starts = [...content.matchAll(/^[ \t]*@([a-zA-Z]+)\s*\{\s*([^,\s{}]+)\s*,/gm)];
  starts.forEach((m, i) => {
    if (/^(comment|string|preamble)$/i.test(m[1])) return;
    const entry = content.slice(m.index, starts[i + 1]?.index ?? content.length);
    const authors = field(entry, 'author') || field(entry, 'editor');
    const first = authors.split(/\s+and\s+/)[0] ?? '';
    // "Last, First" or "First Last": either way the family name is what people look for.
    const family = first.includes(',') ? first.split(',')[0] : (first.split(' ').pop() ?? '');
    const who = family && authors.includes(' and ') ? `${family} et al.` : family;
    const detail = [[who, field(entry, 'year')].filter(Boolean).join(' '), field(entry, 'title')].filter(Boolean).join(': ');
    out.push({ key: m[2], detail: detail.length > 90 ? `${detail.slice(0, 89)}…` : detail });
  });
  return out;
}

function assets(root: string, dir = ''): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!isSkippedDir(entry.name)) out.push(...assets(root, rel));
    } else if (entry.isFile() && isAssetFile(entry.name)) out.push(rel);
  }
  return out;
}

export function projectSymbols(project: Project): Symbols {
  const out: Symbols = { labels: [], cites: [], macros: [], envs: [], tex: [], bib: [], graphics: [] };
  const macros = new Map<string, number>();
  const envs = new Set<string>();
  const cites = new Map<string, string>();
  // LaTeX resolves file names against the folder it runs in, which is the main file's.
  const base = project.main ? path.posix.dirname(project.main) : '.';
  const fromBase = (rel: string) => path.posix.relative(base, rel);

  for (const [rel, content] of project.known) {
    const ext = path.extname(rel).toLowerCase();
    if (ext === '.bib') {
      for (const c of bibEntries(content)) if (!cites.has(c.key)) cites.set(c.key, c.detail);
      out.bib.push(fromBase(rel).replace(/\.bib$/i, ''));
      continue;
    }
    if (ext !== '.tex' && ext !== '.sty' && ext !== '.cls') continue;
    if (ext === '.tex' && rel !== project.main) out.tex.push(fromBase(rel).replace(/\.tex$/i, ''));
    content.split('\n').forEach((raw, i) => {
      const line = uncommented(raw);
      if (!line.includes('\\')) return;
      for (const m of line.matchAll(/\\label\{([^{}]+)\}/g)) out.labels.push({ name: m[1], file: rel, line: i + 1 });
      for (const m of line.matchAll(/\\bibitem(?:\[[^\]]*\])?\{([^{}]+)\}/g)) if (!cites.has(m[1])) cites.set(m[1], '');
      for (const m of line.matchAll(/\\(?:re)?newcommand\*?\s*\{?\\([a-zA-Z@]+)\}?(?:\[(\d)\])?/g)) macros.set(m[1], Number(m[2] ?? 0));
      for (const m of line.matchAll(/\\(?:providecommand|DeclareRobustCommand)\*?\s*\{?\\([a-zA-Z@]+)\}?(?:\[(\d)\])?/g)) macros.set(m[1], Number(m[2] ?? 0));
      for (const m of line.matchAll(/\\(?:New|Renew|Provide|Declare)DocumentCommand\s*\{?\\([a-zA-Z@]+)\}?\s*\{([^{}]*)\}/g)) {
        macros.set(m[1], (m[2].match(/\bm\b/g) ?? []).length);
      }
      for (const m of line.matchAll(/\\DeclareMathOperator\*?\s*\{?\\([a-zA-Z@]+)\}?/g)) macros.set(m[1], 0);
      for (const m of line.matchAll(/\\(?:e|g|x)?def\s*\\([a-zA-Z@]+)((?:#\d)*)/g)) macros.set(m[1], m[2].length / 2);
      for (const m of line.matchAll(/\\(?:(?:re)?newenvironment|newtheorem|(?:New|Renew)DocumentEnvironment|declaretheorem|newmdtheoremenv)\*?(?:\[[^\]]*\])?\s*\{([a-zA-Z@*]+)\}/g)) {
        envs.add(m[1]);
      }
    });
  }

  const pdf = project.main ? project.main.replace(/\.tex$/i, '.pdf') : null;
  out.graphics = assets(project.root)
    .filter((p) => p !== pdf)
    .map(fromBase);
  out.cites = [...cites].map(([key, detail]) => ({ key, detail }));
  // Internal commands (with @) are not something to offer while writing.
  out.macros = [...macros].filter(([name]) => !name.includes('@')).map(([name, args]) => ({ name, args }));
  out.envs = [...envs];
  for (const list of [out.tex, out.bib, out.graphics, out.envs]) list.sort((a, b) => a.localeCompare(b));
  return out;
}

// ---------- the installed TeX distribution ----------

export interface TexInstalled {
  packages: string[];
  classes: string[];
}

let installed: Promise<TexInstalled> | null = null;

/**
 * Every package and document class in the TeX installation, read from its file-name
 * indexes (ls-R), which TeX Live keeps for its own lookups. Empty when there are none
 * (MiKTeX, or a tree without an index); the editor then falls back on a built-in list.
 */
export function texInstalled(): Promise<TexInstalled> {
  installed ??= new Promise((resolve) => {
    execFile('kpsewhich', ['-all', 'ls-R'], { timeout: 10_000 }, (err, stdout) => {
      const packages = new Set<string>();
      const classes = new Set<string>();
      for (const file of err ? [] : new Set(stdout.split('\n').map((l) => l.trim()).filter(Boolean))) {
        try {
          for (const m of fs.readFileSync(file, 'utf8').matchAll(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\.(sty|cls)$/gm)) {
            (m[2] === 'sty' ? packages : classes).add(m[1]);
          }
        } catch {
          // An index we cannot read; the others still count.
        }
      }
      resolve({ packages: [...packages].sort(), classes: [...classes].sort() });
    });
  });
  return installed;
}
