import { diff } from '@codemirror/merge';

export const CONFLICT_START = '<<<<<<< Your edits';

/** Rebase unsaved typing onto disk edits, retaining both versions on overlap. */
export function mergeContents(base: string, local: string, remote: string): string {
  if (local === base || local === remote) return remote;
  if (remote === base) return local;
  const changes = (next: string) => diff(base, next).map((c) => ({
    from: c.fromA, to: c.toA, insert: next.slice(c.fromB, c.toB),
  }));
  const ours = changes(local);
  const theirs = changes(remote);
  const combined = [...ours];
  for (const incoming of theirs) {
    if (ours.some((c) => c.from === incoming.from && c.to === incoming.to && c.insert === incoming.insert)) continue;
    // Include shared boundaries: two insertions at the same cursor are ambiguous.
    if (ours.some((c) => c.from <= incoming.to && incoming.from <= c.to)) {
      const newline = (text: string) => text.endsWith('\n') ? text : `${text}\n`;
      return `${CONFLICT_START}\n${newline(local)}=======\n${newline(remote)}>>>>>>> Disk changes\n`;
    }
    combined.push(incoming);
  }
  let merged = base;
  for (const c of combined.sort((a, b) => b.from - a.from)) {
    merged = merged.slice(0, c.from) + c.insert + merged.slice(c.to);
  }
  return merged;
}
