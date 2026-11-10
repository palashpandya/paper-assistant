import fs from 'node:fs';
import path from 'node:path';

export const TEXT_EXT = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.txt', '.md']);
export const ASSET_EXT = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.eps', '.svg']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build']);

export const isTextFile = (p: string) => TEXT_EXT.has(path.extname(p).toLowerCase());
export const isAssetFile = (p: string) => ASSET_EXT.has(path.extname(p).toLowerCase());
export const isSkippedDir = (name: string) => name.startsWith('.') || SKIP_DIRS.has(name);

export interface FileInfo {
  path: string;
  /** True when the file differs from its reviewed baseline (unreviewed agent/external edits). */
  pending: boolean;
}

/**
 * Tracks the text files of one LaTeX project: what is on disk, and the
 * "baseline" each file is diffed against when the agent changes it.
 */
export class Project {
  readonly root: string;
  /** Last content we saw on disk, per relative path. */
  readonly known = new Map<string, string>();
  /** Content the user has reviewed/accepted, per relative path. */
  readonly baseline = new Map<string, string>();
  /** Last content written by the browser editor, so the watcher can skip the echo. */
  readonly clientWrites = new Map<string, string>();
  main: string | null = null;

  constructor(root: string) {
    this.root = path.resolve(root);
    if (!fs.existsSync(this.root) || !fs.statSync(this.root).isDirectory()) {
      throw new Error(`Not a directory: ${this.root}`);
    }
    for (const rel of this.walk()) {
      const content = fs.readFileSync(this.abs(rel), 'utf8');
      this.known.set(rel, content);
      this.baseline.set(rel, content);
    }
    this.main = this.findMain();
  }

  /** Resolve a project-relative path, refusing anything outside the project. */
  abs(rel: string): string {
    const full = path.resolve(this.root, rel);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error(`Path escapes project: ${rel}`);
    }
    return full;
  }

  rel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  private walk(dir = ''): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(path.join(this.root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!isSkippedDir(entry.name)) out.push(...this.walk(rel));
      } else if (entry.isFile() && isTextFile(entry.name)) {
        out.push(rel);
      }
    }
    return out;
  }

  private findMain(): string | null {
    const tex = [...this.known.keys()].filter((p) => p.endsWith('.tex'));
    const hasDocClass = (p: string) => /^[^%\n]*\\documentclass/m.test(this.known.get(p) ?? '');
    const depth = (p: string) => p.split('/').length;
    const candidates = tex.filter(hasDocClass).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
    return candidates.find((p) => p === 'main.tex') ?? candidates[0] ?? null;
  }

  files(): FileInfo[] {
    return [...this.known.keys()]
      .sort((a, b) => a.localeCompare(b))
      .map((p) => ({ path: p, pending: this.known.get(p) !== (this.baseline.get(p) ?? '') }));
  }

  read(rel: string): { content: string; baseline: string } {
    const content = fs.readFileSync(this.abs(rel), 'utf8');
    if (!this.known.has(rel)) {
      this.known.set(rel, content);
      this.baseline.set(rel, content);
    }
    return { content, baseline: this.baseline.get(rel) ?? '' };
  }

  /** A save from the browser editor. User edits advance the baseline unless a review is pending. */
  writeFromClient(rel: string, content: string): { baseline: string } {
    const full = this.abs(rel);
    const prev = this.known.get(rel);
    const inReview = prev !== undefined && this.baseline.get(rel) !== prev;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    this.known.set(rel, content);
    this.clientWrites.set(rel, content);
    if (!inReview) this.baseline.set(rel, content);
    if (!this.main) this.main = this.findMain();
    return { baseline: this.baseline.get(rel) ?? '' };
  }

  setBaseline(rel: string, content: string) {
    this.abs(rel);
    this.baseline.set(rel, content);
  }

  /**
   * Called by the file watcher. Returns what changed, or null when the event
   * carries no new content (e.g. the echo of our own save).
   */
  onDiskChange(rel: string): { content: string; baseline: string; external: boolean } | null {
    let content: string;
    try {
      content = fs.readFileSync(this.abs(rel), 'utf8');
    } catch {
      return null;
    }
    if (this.known.get(rel) === content) return null;
    const isNew = !this.known.has(rel);
    this.known.set(rel, content);
    if (isNew) this.baseline.set(rel, '');
    if (!this.main) this.main = this.findMain();
    const external = this.clientWrites.get(rel) !== content;
    return { content, baseline: this.baseline.get(rel) ?? '', external };
  }

  onDiskRemove(rel: string): boolean {
    const had = this.known.delete(rel);
    this.baseline.delete(rel);
    this.clientWrites.delete(rel);
    if (this.main === rel) this.main = this.findMain();
    return had;
  }
}
