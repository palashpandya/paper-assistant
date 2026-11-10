import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface CompileIssue {
  file: string | null;
  line: number | null;
  message: string;
}

export interface CompileResult {
  ok: boolean;
  hasPdf: boolean;
  pdfVersion: number;
  errors: CompileIssue[];
  warnings: string[];
  log: string;
  durationMs: number;
  engine: string;
}

const has = (cmd: string) => spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, out: `${out}\n${cmd}: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
  });
}

function parse(output: string, cwd: string, root: string): { errors: CompileIssue[]; warnings: string[] } {
  const errors: CompileIssue[] = [];
  const warnings = new Set<string>();
  const seen = new Set<string>();
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // -file-line-error format: ./main.tex:12: Undefined control sequence.
    const m = /^(\.?\/?[^:\n]+\.(?:tex|sty|cls|bib)):(\d+): (.*)$/.exec(line);
    if (m) {
      const abs = path.resolve(cwd, m[1]);
      const inProject = abs.startsWith(root + path.sep);
      let message = m[3];
      // The offending token is usually on the "l.<n> ..." line that follows.
      const ctx = lines.slice(i + 1, i + 4).find((l) => /^l\.\d+ /.test(l));
      if (ctx) message += ` — ${ctx.replace(/^l\.\d+ /, '').trim()}`;
      const key = `${m[1]}:${m[2]}:${message}`;
      if (!seen.has(key)) {
        seen.add(key);
        errors.push({
          file: inProject ? path.relative(root, abs).split(path.sep).join('/') : m[1],
          line: Number(m[2]),
          message,
        });
      }
    } else if (/^! /.test(line)) {
      const key = line;
      if (!seen.has(key)) {
        seen.add(key);
        errors.push({ file: null, line: null, message: line.slice(2) });
      }
    } else if (/^(LaTeX|Package \S+) Warning: /.test(line)) {
      let text = line;
      // Warnings wrap at 79 columns; join the continuation.
      if (line.length >= 79 && lines[i + 1]) text += lines[i + 1];
      if (/undefined|multiply.defined|Citation|Reference/i.test(text)) warnings.add(text.trim());
    }
  }
  return { errors, warnings: [...warnings] };
}

/** Files written by LaTeX during a build, as recorded in <job>.fls. */
function readGenerated(cwd: string, job: string): Set<string> {
  const out = new Set<string>();
  try {
    for (const line of fs.readFileSync(path.join(cwd, `${job}.fls`), 'utf8').split('\n')) {
      if (line.startsWith('OUTPUT ')) out.add(path.resolve(cwd, line.slice(7).trim()));
    }
  } catch {
    // No recorder file (first build failed early); nothing known to be generated.
  }
  return out;
}

/** Compiles the project, coalescing requests that arrive while a build is running. */
export class Compiler {
  private running = false;
  private queued = false;
  private readonly useLatexmk = has('latexmk');
  last: CompileResult | null = null;
  private bibKey = '';
  /** Absolute paths of files LaTeX itself wrote during the last build (from the .fls recorder file). */
  generated = new Set<string>();
  private readonly root: string;
  private readonly getMain: () => string | null;
  private readonly onStart: () => void;
  private readonly onDone: (result: CompileResult) => void;

  constructor(
    root: string,
    getMain: () => string | null,
    onStart: () => void,
    onDone: (result: CompileResult) => void,
  ) {
    this.root = root;
    this.getMain = getMain;
    this.onStart = onStart;
    this.onDone = onDone;
  }

  get busy() {
    return this.running;
  }

  pdfPath(): string | null {
    const main = this.getMain();
    return main ? path.join(this.root, main.replace(/\.tex$/, '.pdf')) : null;
  }

  private pdfVersion(): number {
    const pdf = this.pdfPath();
    try {
      return pdf ? Math.floor(fs.statSync(pdf).mtimeMs) : 0;
    } catch {
      return 0;
    }
  }

  async compile(): Promise<void> {
    if (this.running) {
      this.queued = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.queued = false;
        this.onStart();
        this.last = await this.build();
        this.onDone(this.last);
      } while (this.queued);
    } finally {
      this.running = false;
    }
  }

  private async build(): Promise<CompileResult> {
    const started = Date.now();
    const main = this.getMain();
    if (!main) {
      return {
        ok: false,
        hasPdf: false,
        pdfVersion: 0,
        errors: [{ file: null, line: null, message: 'No .tex file with \\documentclass found in this folder.' }],
        warnings: [],
        log: '',
        durationMs: 0,
        engine: 'none',
      };
    }
    const cwd = path.dirname(path.join(this.root, main));
    const file = path.basename(main);
    const job = file.replace(/\.tex$/, '');
    const before = this.pdfVersion();
    const { code, out, engine } = this.useLatexmk
      ? await this.latexmk(cwd, file)
      : await this.pdflatexLoop(cwd, file, job);
    this.generated = readGenerated(cwd, job);
    const { errors, warnings } = parse(out, cwd, this.root);
    const pdfVersion = this.pdfVersion();
    return {
      ok: code === 0 && errors.length === 0,
      hasPdf: pdfVersion > 0,
      pdfVersion: pdfVersion || before,
      errors,
      warnings,
      log: out.length > 400_000 ? out.slice(-400_000) : out,
      durationMs: Date.now() - started,
      engine,
    };
  }

  private async latexmk(cwd: string, file: string) {
    const r = await run(
      'latexmk',
      ['-pdf', '-recorder', '-synctex=1', '-interaction=nonstopmode', '-file-line-error', file],
      cwd,
    );
    return { ...r, engine: 'latexmk' };
  }

  /** Fallback when latexmk is not installed: pdflatex, bibliography if needed, then reruns. */
  private async pdflatexLoop(cwd: string, file: string, job: string) {
    const tex = () => run('pdflatex', ['-recorder', '-synctex=1', '-interaction=nonstopmode', '-file-line-error', file], cwd);
    const read = (ext: string) => {
      try {
        return fs.readFileSync(path.join(cwd, `${job}.${ext}`), 'utf8');
      } catch {
        return '';
      }
    };
    let r = await tex();
    let out = r.out;

    // Rebuild the bibliography only when the citations or the .bib files changed.
    const aux = read('aux');
    const usesBiber = fs.existsSync(path.join(cwd, `${job}.bcf`)) && has('biber');
    const usesBibtex = /\\bibdata\{/.test(aux) && /\\citation\{/.test(aux);
    let bibRan = false;
    if (usesBiber || usesBibtex) {
      const cites = aux.split('\n').filter((l) => /^\\(citation|bibdata|bibstyle|abx@aux@cite)/.test(l)).join('\n');
      const bibs = fs
        .readdirSync(cwd, { recursive: true, encoding: 'utf8' })
        .filter((f) => f.endsWith('.bib') && !f.includes('node_modules'))
        .map((f) => `${f}:${createHash('md5').update(fs.readFileSync(path.join(cwd, f))).digest('hex')}`)
        .join('|');
      const key = `${cites}\n${bibs}`;
      if (key !== this.bibKey || !fs.existsSync(path.join(cwd, `${job}.bbl`))) {
        out += (await run(usesBiber ? 'biber' : 'bibtex', [job], cwd)).out;
        this.bibKey = key;
        bibRan = true;
      }
    }

    const needsRerun = (o: string) => /Rerun to get|rerun LaTeX|undefined references|Citation.*undefined/i.test(o);
    for (let pass = 0; pass < 3 && (bibRan || needsRerun(r.out)); pass++) {
      bibRan = false;
      r = await tex();
      out = `${out}\n${r.out}`;
    }
    // Report errors and warnings from the final pass only; earlier passes are expected to be noisy.
    return { code: r.code, out: r.out, engine: 'pdflatex' };
  }
}
