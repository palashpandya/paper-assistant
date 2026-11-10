import fs from 'node:fs';
import path from 'node:path';
import type { Project } from './project.ts';
import { forward, forwardAll, reverse } from './synctex.ts';

/** All coordinates are PDF points from the top-left of the page. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ThreadMessage {
  author: 'user' | 'agent';
  /** Which agent wrote it, for agent messages. */
  agent?: string;
  text: string;
  at: string;
}

export interface Thread {
  id: number;
  kind: 'comment' | 'drawing';
  /** Who made it. Absent on threads saved before agents could annotate, which are the user's. */
  author?: 'user' | 'agent';
  page: number;
  /** Highlighted text boxes (comments). */
  rects: Rect[];
  /** Freehand strokes (drawings), each a flat list x0, y0, x1, y1, ... */
  strokes: number[][];
  /** The text that was selected in the PDF (comments). */
  quote: string;
  /** Project-relative path of a picture of the marked-up region (drawings). */
  image: string | null;
  /** Where the annotation points to in the source, used to follow the text when the PDF changes. */
  anchor: {
    path: string;
    line: number;
    endLine: number;
    lineText: string;
    box: { page: number; x: number; y: number };
  } | null;
  messages: ThreadMessage[];
  resolved: boolean;
  resolvedBy?: 'user' | 'agent';
  createdAt: string;
}

export interface ThreadView extends Thread {
  /** Where to draw the annotation in the current PDF. */
  view: { page: number; dx: number; dy: number; stale: boolean };
}

export interface NewThread {
  kind: 'comment' | 'drawing';
  page: number;
  rects?: Rect[];
  strokes?: number[][];
  quote?: string;
  text?: string;
  /** PNG data URL of the marked-up region. */
  image?: string;
}

/** One entry of the file an agent writes to put its own comments on the PDF. */
interface AgentNote {
  file: string;
  line: number;
  endLine?: number;
  /** A few words from the first line, used to correct a line number that is slightly off. */
  quote?: string;
  text: string;
  mark?: 'highlight' | 'box' | 'circle';
}

const DIR = '.paper-assistant';
/** Where agents drop their notes; see INSTRUCTIONS in agent.ts, which describes this format to them. */
export const AGENT_NOTES = `${DIR}/agent-notes.json`;

/** A closed outline around a region, as one stroke. */
function outline(b: Rect, shape: 'box' | 'circle'): number[] {
  const pad = 3;
  const x0 = b.x - pad;
  const y0 = b.y - pad;
  const x1 = b.x + b.w + pad;
  const y1 = b.y + b.h + pad;
  if (shape === 'box') return [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];
  // Typeset lines are wide and flat, so a little extra on each side encloses the text without swallowing the page.
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2 + 8;
  const ry = (y1 - y0) / 2 + 5;
  const points: number[] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    points.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
  }
  return points;
}

function bounds(t: Pick<Thread, 'rects' | 'strokes'>): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x: number, y: number) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const r of t.rects) {
    add(r.x, r.y);
    add(r.x + r.w, r.y + r.h);
  }
  for (const s of t.strokes) for (let i = 0; i + 1 < s.length; i += 2) add(s[i], s[i + 1]);
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
}

/** Review comments and drawings on the PDF, stored in the project under .paper-assistant/. */
export class Annotations {
  private threads: Thread[] = [];
  private next = 1;
  private readonly project: Project;
  private readonly getPdf: () => string | null;
  private readonly file: string;

  constructor(project: Project, getPdf: () => string | null) {
    this.project = project;
    this.getPdf = getPdf;
    this.file = path.join(project.root, DIR, 'annotations.json');
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.threads = data.threads ?? [];
      this.next = data.next ?? this.threads.reduce((n, t) => Math.max(n, t.id + 1), 1);
    } catch {
      // No annotations yet.
    }
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ next: this.next, threads: this.threads }, null, 2));
  }

  private get(id: number): Thread {
    const t = this.threads.find((x) => x.id === id);
    if (!t) throw new Error(`No comment #${id}`);
    return t;
  }

  private lines(rel: string): string[] | null {
    const content = this.project.known.get(rel);
    return content === undefined ? null : content.split('\n');
  }

  async create(input: NewThread): Promise<Thread> {
    const thread: Thread = {
      id: this.next++,
      kind: input.kind,
      page: input.page,
      rects: input.rects ?? [],
      strokes: input.strokes ?? [],
      quote: input.quote ?? '',
      image: null,
      anchor: null,
      messages: input.text?.trim() ? [{ author: 'user', text: input.text.trim(), at: new Date().toISOString() }] : [],
      resolved: false,
      createdAt: new Date().toISOString(),
    };

    if (input.image?.startsWith('data:image/png;base64,')) {
      const rel = `${DIR}/annotations/${thread.id}.png`;
      fs.mkdirSync(path.dirname(path.join(this.project.root, rel)), { recursive: true });
      fs.writeFileSync(path.join(this.project.root, rel), Buffer.from(input.image.slice(22), 'base64'));
      thread.image = rel;
    }

    thread.anchor = await this.findAnchor(thread);
    this.threads.push(thread);
    this.save();
    return thread;
  }

  /**
   * Turns the notes file an agent left behind into threads, and removes the file.
   * Agents know source lines, not PDF coordinates, so each note names lines and
   * SyncTeX says where they are typeset. Returns how many threads were made.
   */
  async collectAgentNotes(agent: string): Promise<number> {
    const file = path.join(this.project.root, AGENT_NOTES);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return 0;
    }
    fs.rmSync(file, { force: true });
    let notes: unknown;
    try {
      notes = JSON.parse(raw);
    } catch {
      return 0;
    }
    if (!Array.isArray(notes)) notes = (notes as { comments?: unknown } | null)?.comments;
    if (!Array.isArray(notes)) return 0;

    let made = 0;
    for (const note of notes.slice(0, 100) as Partial<AgentNote>[]) {
      if (!note || typeof note.file !== 'string' || typeof note.text !== 'string' || !note.text.trim()) continue;
      const rel = path.relative(this.project.root, path.resolve(this.project.root, note.file));
      let lines: string[];
      try {
        lines = fs.readFileSync(this.project.abs(rel), 'utf8').split('\n');
      } catch {
        continue; // Not a file in this project.
      }
      let line = Math.min(lines.length, Math.max(1, Math.round(Number(note.line)) || 1));
      let endLine = Math.min(lines.length, Math.max(line, Math.round(Number(note.endLine)) || line));
      // Line numbers from an agent can be slightly off; the quote says which line was meant.
      const quote = typeof note.quote === 'string' ? note.quote.trim() : '';
      if (quote && !lines[line - 1].includes(quote)) {
        for (let d = 1; d < lines.length; d++) {
          const i = [line - 1 - d, line - 1 + d].find((j) => j >= 0 && j < lines.length && lines[j].includes(quote));
          if (i !== undefined) {
            endLine = Math.min(lines.length, endLine + i + 1 - line);
            line = i + 1;
            break;
          }
        }
      }

      const mark = note.mark === 'box' || note.mark === 'circle' ? note.mark : 'highlight';
      const placed = await this.place(rel, line, endLine);
      const source = lines.slice(line - 1, endLine).join(' ').replace(/\s+/g, ' ').trim();
      const thread: Thread = {
        id: this.next++,
        kind: mark === 'highlight' ? 'comment' : 'drawing',
        author: 'agent',
        page: placed?.page ?? 1,
        rects: placed && mark === 'highlight' ? placed.rects : [],
        strokes: placed && mark !== 'highlight' ? [outline(bounds({ rects: placed.rects, strokes: [] }), mark)] : [],
        quote: source.length > 240 ? `${source.slice(0, 239)}…` : source,
        image: null,
        anchor: {
          path: rel,
          line: placed?.line ?? line,
          endLine: Math.max(endLine, placed?.line ?? line),
          lineText: (lines[(placed?.line ?? line) - 1] ?? '').trim(),
          box: placed?.box ?? { page: 1, x: 0, y: 0 },
        },
        messages: [{ author: 'agent', agent, text: note.text.trim(), at: new Date().toISOString() }],
        resolved: false,
        createdAt: new Date().toISOString(),
      };
      this.threads.push(thread);
      made++;
    }
    if (made) this.save();
    return made;
  }

  /** Where source lines are typeset: one rectangle per PDF line, on the page where they start. */
  private async place(rel: string, line: number, endLine: number) {
    const pdf = this.getPdf();
    if (!pdf || !fs.existsSync(pdf)) return null;
    const abs = this.project.abs(rel);
    // Blank lines, comments and some commands leave no trace in the PDF; then use the nearest line that does.
    const range = Array.from({ length: Math.min(endLine - line + 1, 200) }, (_, i) => line + i);
    const nearby = [1, 2].flatMap((d) => [endLine + d, line - d]).filter((l) => l >= 1);
    let anchorLine = 0;
    let box = null;
    for (const l of [...range, ...nearby]) {
      box = await forward(pdf, abs, l);
      if (box) {
        anchorLine = l;
        break;
      }
    }
    if (!box) return null;
    const page = box.page;
    const rects: Rect[] = [];
    for (const l of anchorLine >= line && anchorLine <= endLine ? range.filter((x) => x >= anchorLine) : [anchorLine]) {
      const all = (await forwardAll(pdf, abs, l)).filter((b) => b.page === page);
      // SyncTeX sometimes also reports the enclosing column or page; keep the line-sized boxes.
      const small = all.filter((b) => b.height <= 40);
      for (const b of small.length ? small : all.slice(0, 1)) {
        const r = { x: b.x, y: b.y, w: b.width, h: b.height + 2 };
        if (!rects.some((o) => Math.abs(o.x - r.x) < 0.5 && Math.abs(o.y - r.y) < 0.5 && Math.abs(o.w - r.w) < 0.5)) rects.push(r);
      }
    }
    return { page, line: anchorLine, rects, box: { page, x: box.x, y: box.y } };
  }

  /** Asks SyncTeX which source lines the annotation covers. */
  private async findAnchor(t: Thread): Promise<Thread['anchor']> {
    const pdf = this.getPdf();
    if (!pdf || !fs.existsSync(pdf)) return null;
    const b = bounds(t);
    const probes: [number, number][] = [];
    if (t.rects.length) {
      const first = t.rects[0];
      const last = t.rects[t.rects.length - 1];
      probes.push([first.x + 2, first.y + first.h / 2], [last.x + last.w - 2, last.y + last.h / 2]);
    } else {
      probes.push([b.x + b.w / 2, b.y + b.h / 2], [b.x, b.y], [b.x + b.w, b.y + b.h], [b.x + b.w, b.y], [b.x, b.y + b.h]);
    }
    const hits: { path: string; line: number }[] = [];
    for (const [x, y] of probes) {
      const hit = await reverse(pdf, t.page, x, y);
      if (hit && hit.file.startsWith(this.project.root + path.sep)) {
        hits.push({ path: this.project.rel(hit.file), line: hit.line });
      }
    }
    if (!hits.length) return null;
    const rel = hits[0].path;
    const same = hits.filter((h) => h.path === rel).map((h) => h.line);
    const line = Math.min(...same);
    const endLine = Math.max(...same);
    const box = await forward(pdf, this.project.abs(rel), line);
    return {
      path: rel,
      line,
      endLine,
      lineText: (this.lines(rel)?.[line - 1] ?? '').trim(),
      box: box ? { page: box.page, x: box.x, y: box.y } : { page: t.page, x: 0, y: 0 },
    };
  }

  /**
   * Annotations with their position in the current PDF. When the text an
   * annotation points to has moved (edits above it, reflow), the annotation
   * moves with it; when the text cannot be found any more it is marked stale.
   */
  async views(): Promise<ThreadView[]> {
    const pdf = this.getPdf();
    let dirty = false;
    const out = await Promise.all(
      this.threads.map(async (t): Promise<ThreadView> => {
        const still = { page: t.page, dx: 0, dy: 0, stale: false };
        if (t.resolved || !t.anchor || !pdf || !fs.existsSync(pdf)) return { ...t, view: still };
        const a = t.anchor;
        const lines = this.lines(a.path);
        if (!lines) return { ...t, view: { ...still, stale: true } };

        // Follow the source line if lines were added or removed above it.
        if ((lines[a.line - 1] ?? '').trim() !== a.lineText) {
          let found = -1;
          if (a.lineText.length > 3) {
            for (let d = 1; d < lines.length && found < 0; d++) {
              for (const i of [a.line - 1 - d, a.line - 1 + d]) {
                if (i >= 0 && i < lines.length && lines[i].trim() === a.lineText) {
                  found = i;
                  break;
                }
              }
            }
          }
          if (found < 0) return { ...t, view: { ...still, stale: true } };
          a.endLine += found + 1 - a.line;
          a.line = found + 1;
          dirty = true;
        }

        const box = await forward(pdf, this.project.abs(a.path), a.line);
        if (!box) return { ...t, view: { ...still, stale: true } };
        return { ...t, view: { page: box.page, dx: box.x - a.box.x, dy: box.y - a.box.y, stale: false } };
      }),
    );
    if (dirty) this.save();
    return out;
  }

  addMessage(id: number, message: Omit<ThreadMessage, 'at'>) {
    this.get(id).messages.push({ ...message, at: new Date().toISOString() });
    this.save();
  }

  setResolved(id: number, resolved: boolean, by: 'user' | 'agent' = 'user') {
    const t = this.get(id);
    t.resolved = resolved;
    t.resolvedBy = resolved ? by : undefined;
    this.save();
  }

  remove(id: number) {
    const t = this.get(id);
    if (t.image) fs.rmSync(path.join(this.project.root, t.image), { force: true });
    this.threads = this.threads.filter((x) => x.id !== id);
    this.save();
  }

  imagePath(id: number): string | null {
    const t = this.get(id);
    return t.image ? path.join(this.project.root, t.image) : null;
  }

  /** The message that asks an agent to work through the given comments. */
  prompt(ids: number[]): string {
    const blocks = ids.map((id) => {
      const t = this.get(id);
      const where = t.anchor
        ? `source ${t.anchor.path} ${t.anchor.line === t.anchor.endLine ? `line ${t.anchor.line}` : `lines ${t.anchor.line}-${t.anchor.endLine}`}`
        : 'source location unknown';
      const lines = [`Comment #${t.id} (PDF page ${t.page}, ${where})`];
      if (t.author === 'agent') {
        lines.push(`This note was put on the PDF by an agent, not by the user. Source text it points at: "${t.quote}"`);
      } else if (t.kind === 'drawing') {
        lines.push(
          t.image
            ? `The user drew on the PDF. Picture of the marked-up region (their marks are in red): ${t.image} — read this image before doing anything else. The source lines above are approximate.`
            : 'The user drew on the PDF at this location.',
        );
      } else if (t.quote) {
        lines.push(`Text the user highlighted in the PDF: "${t.quote}"`);
      }
      if (t.messages.length) {
        lines.push('Thread:');
        for (const m of t.messages) lines.push(`- ${m.author === 'user' ? 'User' : 'Agent'}: ${m.text}`);
      } else {
        lines.push('The user left no note; work out what they want from the marked-up region.');
      }
      return lines.join('\n');
    });
    return [
      `Address the following review ${ids.length === 1 ? 'comment' : 'comments'} on the compiled PDF.`,
      ...blocks,
      'When you are done, finish with one line per comment in exactly this form:\n' +
        '#<number>: <what you changed, or your answer>\n' +
        'End the line with [resolved] if the comment is fully dealt with. Leave it off if you need the user to decide or clarify something.',
    ].join('\n\n');
  }

  /** Files the agent's "#3: ..." lines into the matching threads. */
  applyReply(ids: number[], reply: string, agent: string) {
    const sections = new Map<number, string[]>();
    let current: string[] | null = null;
    for (const line of reply.split('\n')) {
      const m = /^\s*(?:[-*]\s*)?\**#(\d+)\**\s*:\s*(.*)$/.exec(line);
      if (m && ids.includes(Number(m[1]))) {
        current = [m[2]];
        sections.set(Number(m[1]), current);
      } else if (current) {
        current.push(line);
      }
    }
    for (const id of ids) {
      if (!this.threads.some((t) => t.id === id)) continue;
      // If the agent ignored the format, keep its whole reply rather than lose it.
      let text = (sections.get(id)?.join('\n') ?? (sections.size === 0 ? reply : '')).trim();
      if (!text) continue;
      const resolved = /\[resolved\]/i.test(text) && sections.has(id);
      text = text.replace(/\s*\[resolved\]\s*/gi, ' ').trim();
      this.addMessage(id, { author: 'agent', agent, text });
      if (resolved) this.setResolved(id, true, 'agent');
    }
  }
}
