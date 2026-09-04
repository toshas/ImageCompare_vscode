/** Pure (no vscode, no DOM): what the user is told when an action finishes — one wording, one action rule, both products (docs/standalone.md: affordances-rendered-by-the-webview). */
import { HostCapabilities, REVEAL_LABEL } from './contextMenuModel';

/** What happened, never how to say it: a host reports the event and the wording is decided here. */
export type NoticeEvent =
  | { kind: 'pptxSaved'; path: string }
  | { kind: 'pptxFailed'; error: string }
  | { kind: 'sessionSaved'; path: string }
  | { kind: 'sessionSaveFailed'; error: string }
  | { kind: 'pathCopied' }
  | { kind: 'copyPathFailed'; error: string };

export interface Notice {
  text: string;
  tone: 'info' | 'error';
  /** Offered only where the host can act on it; a notice with no action dismisses itself. */
  action?: { label: string; path: string };
}

/** Wording plus the capability gate on the reveal action — the one place a notice is composed. */
export function buildNotice(event: NoticeEvent, caps: HostCapabilities): Notice {
  const reveal = (path: string) => (caps.revealInExplorer ? { label: REVEAL_LABEL, path } : undefined);
  switch (event.kind) {
    case 'pptxSaved':
      return { text: `PPTX exported: ${event.path}`, tone: 'info', action: reveal(event.path) };
    case 'pptxFailed':
      return { text: `PPTX export failed: ${event.error}`, tone: 'error' };
    case 'sessionSaved':
      return { text: `Session saved: ${event.path}`, tone: 'info', action: reveal(event.path) };
    case 'sessionSaveFailed':
      return { text: `Could not save the session: ${event.error}`, tone: 'error' };
    case 'pathCopied':
      return { text: 'Path copied', tone: 'info' };
    case 'copyPathFailed':
      return { text: `Could not copy the path: ${event.error}`, tone: 'error' };
  }
}
