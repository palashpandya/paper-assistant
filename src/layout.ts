export type PaneId = 'editor' | 'pdf' | 'chat';

export interface Preset {
  id: string;
  label: string;
  /** Columns from left to right; a column with two panes stacks them top to bottom. */
  columns: PaneId[][];
}

export const PRESETS: Preset[] = [
  { id: 'editor-pdf-chat', label: 'Editor, PDF, Agent', columns: [['editor'], ['pdf'], ['chat']] },
  { id: 'chat-editor-pdf', label: 'Agent, Editor, PDF', columns: [['chat'], ['editor'], ['pdf']] },
  { id: 'pdf-editor-chat', label: 'PDF, Editor, Agent', columns: [['pdf'], ['editor'], ['chat']] },
  { id: 'editor+chat-pdf', label: 'Editor above Agent, PDF on the right', columns: [['editor', 'chat'], ['pdf']] },
  { id: 'editor-pdf+chat', label: 'Editor on the left, PDF above Agent', columns: [['editor'], ['pdf', 'chat']] },
];

export const PANE_LETTER: Record<PaneId, string> = { editor: 'E', pdf: 'P', chat: 'A' };

export interface Sizes {
  /** Relative width of each column. */
  cols: number[];
  /** Relative heights of the two panes in a stacked column. */
  rows: [number, number];
}

const DEFAULT_WIDTH: Record<PaneId, number> = { editor: 1, pdf: 1, chat: 0.62 };

export const defaultSizes = (preset: Preset): Sizes => ({
  cols: preset.columns.map((col) => Math.max(...col.map((id) => DEFAULT_WIDTH[id]))),
  rows: [0.6, 0.4],
});

export const HANDLE = 5;

/** Small per-browser settings. Storage can be unavailable (private windows), so every access is guarded. */
export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`paper-assistant.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(`paper-assistant.${key}`, JSON.stringify(value));
  } catch {
    // Not persisted; the layout still works for this session.
  }
}
