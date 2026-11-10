import { spawn } from 'node:child_process';
import path from 'node:path';

function synctex(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('synctex', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out));
  });
}

const field = (out: string, name: string) => {
  const m = new RegExp(`^${name}:(.*)$`, 'm').exec(out);
  return m ? m[1].trim() : null;
};

export interface PdfBox {
  page: number;
  /** PDF points from the top-left of the page. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Source line -> position in the PDF. */
export async function forward(pdf: string, texFile: string, line: number): Promise<PdfBox | null> {
  const cwd = path.dirname(pdf);
  const input = path.relative(cwd, texFile);
  const out = await synctex(['view', '-i', `${line}:0:${input}`, '-o', path.basename(pdf)], cwd);
  const page = Number(field(out, 'Page'));
  if (!page) return null;
  const h = Number(field(out, 'h'));
  const v = Number(field(out, 'v'));
  const W = Number(field(out, 'W'));
  const H = Number(field(out, 'H'));
  return { page, x: h, y: v - H, width: W, height: H };
}

/** Position in the PDF -> source file and line. */
export async function reverse(
  pdf: string,
  page: number,
  x: number,
  y: number,
): Promise<{ file: string; line: number } | null> {
  const cwd = path.dirname(pdf);
  const out = await synctex(['edit', '-o', `${page}:${x}:${y}:${path.basename(pdf)}`], cwd);
  const input = field(out, 'Input');
  const line = Number(field(out, 'Line'));
  if (!input || !line) return null;
  return { file: path.resolve(cwd, input), line };
}
