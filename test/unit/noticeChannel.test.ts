import { describe, it, expect } from 'vitest';
import { HostCapabilities } from '../../src/webview/contextMenuModel';
import { NoticeEvent, buildNotice } from '../../src/webview/noticeChannel';

const EXTENSION: HostCapabilities = { revealInExplorer: true, copyTextToClipboard: true, saveSessionAs: true };
const STANDALONE: HostCapabilities = { revealInExplorer: false, copyTextToClipboard: true, saveSessionAs: false };

describe('notice channel (noticeChannel.ts, real code)', () => {
  // Pinned against the strings the provider used to pass to showInformationMessage/showErrorMessage,
  // so the wording survived the move off the host's notification API.
  it('keeps the wording the vscode notifications used', () => {
    expect(buildNotice({ kind: 'pptxSaved', path: '/out/comparison_01.pptx' }, EXTENSION).text)
      .toBe('PPTX exported: /out/comparison_01.pptx');
    expect(buildNotice({ kind: 'sessionSaved', path: '/out/x.imagecompare' }, EXTENSION).text)
      .toBe('Session saved: /out/x.imagecompare');
    expect(buildNotice({ kind: 'sessionSaveFailed', error: 'EACCES' }, EXTENSION).text)
      .toBe('Could not save the session: EACCES');
    expect(buildNotice({ kind: 'copyPathFailed', error: 'denied' }, EXTENSION).text)
      .toBe('Could not copy the path: denied');
    // Was a bare showCopyToast call in the webview until the channel took it over.
    expect(buildNotice({ kind: 'pptxFailed', error: 'disk full' }, EXTENSION).text)
      .toBe('PPTX export failed: disk full');
  });

  it('offers the reveal action only to a host that can reveal', () => {
    const saved: NoticeEvent[] = [
      { kind: 'pptxSaved', path: '/out/deck.pptx' },
      { kind: 'sessionSaved', path: '/out/x.imagecompare' },
    ];
    for (const event of saved) {
      const withReveal = buildNotice(event, EXTENSION);
      expect(withReveal.action).toEqual({ label: 'Reveal in Explorer', path: (event as { path: string }).path });
      expect(buildNotice(event, STANDALONE).action).toBeUndefined();
      // The text itself never changes with the capability — only whether the action rides along.
      expect(buildNotice(event, STANDALONE).text).toBe(withReveal.text);
    }
  });

  it('never offers an action on a failure', () => {
    const failures: NoticeEvent[] = [
      { kind: 'sessionSaveFailed', error: 'EACCES' },
      { kind: 'copyPathFailed', error: 'denied' },
      { kind: 'pptxFailed', error: 'disk full' },
    ];
    for (const event of failures) {
      expect(buildNotice(event, EXTENSION).action).toBeUndefined();
      expect(buildNotice(event, EXTENSION).tone).toBe('error');
    }
  });

  it('tones a success as info', () => {
    expect(buildNotice({ kind: 'pathCopied' }, STANDALONE))
      .toEqual({ text: 'Path copied', tone: 'info', action: undefined });
  });
});
