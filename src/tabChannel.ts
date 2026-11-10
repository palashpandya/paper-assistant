import type { PdfBox } from './api';

/**
 * Messages between the main window and the PDF when it is open in its own tab (`?view=pdf`).
 * Both are the same origin, so they talk over a BroadcastChannel; the server is not involved.
 */
export type TabMsg =
  // From the PDF tab.
  | { type: 'hello' }
  | { type: 'bye' }
  | { type: 'goto'; path: string; line: number }
  | { type: 'ask'; label: string; body: string }
  | { type: 'thread'; id: number }
  | { type: 'created'; id: number; send: boolean }
  // From the main window.
  | { type: 'ping' }
  | { type: 'close' }
  | { type: 'highlight'; box: PdfBox }
  | { type: 'showThread'; id: number }
  | { type: 'view'; activeThread: number | null; showResolved: boolean };

export const isPdfTab = new URLSearchParams(location.search).get('view') === 'pdf';

export interface TabChannel {
  post: (msg: TabMsg) => void;
  close: () => void;
}

/** BroadcastChannel can be missing or blocked; the app then simply has no separate-tab mode. */
export function openChannel(onMsg: (msg: TabMsg) => void): TabChannel | null {
  try {
    const channel = new BroadcastChannel('paper-assistant.pdf');
    channel.onmessage = (e) => onMsg(e.data as TabMsg);
    return { post: (msg) => channel.postMessage(msg), close: () => channel.close() };
  } catch {
    return null;
  }
}

/** Opens the PDF tab, or brings the existing one forward. False if the browser blocked it. */
export const openPdfTab = () => window.open(`${location.pathname}?view=pdf`, 'paper-assistant-pdf') !== null;
