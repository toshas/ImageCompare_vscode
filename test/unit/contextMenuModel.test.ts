import { describe, it, expect } from 'vitest';
import {
  HostCapabilities,
  MenuContext,
  NO_HOST_CAPABILITIES,
  buildContextMenu,
  contextMenuHelpText,
} from '../../src/webview/contextMenuModel';

// The two real hosts' declared records — pinned here so a host that quietly changes what it claims
// shows up as a diff in a test, not as an item silently appearing or vanishing from a menu.
// Provider: src/imageCompareProvider.ts sendInitData (whose saveSessionAs is `!!state.sessionFileUri`;
// pinned true here for its most capable case — it is the one flag no menu item reads).
// Standalone: standalone/adapter.ts sendInit.
const EXTENSION: HostCapabilities = { revealInExplorer: true, copyTextToClipboard: true, saveSessionAs: true };
const STANDALONE: HostCapabilities = { revealInExplorer: false, copyTextToClipboard: true, saveSessionAs: false };

const image: MenuContext = { section: 'image', tupleIndex: 3, modalityIndex: 1 };
const pill: MenuContext = { section: 'pill', tupleIndex: 3, modalityIndex: 1 };

const ids = (ctx: MenuContext, caps: HostCapabilities) => buildContextMenu(ctx, caps).map((i) => i.id);

describe('context menu model (contextMenuModel.ts, real code)', () => {
  it('offers the extension the same five items the manifest used to contribute', () => {
    expect(ids(image, EXTENSION)).toEqual(['copyImage', 'copyPath', 'revealInExplorer']);
    expect(ids(pill, EXTENSION)).toEqual(['copyPath', 'revealInExplorer', 'toggleHidden']);
  });

  // The whole point of the refactor: the standalone gets a menu at all, and it differs from the
  // panel's ONLY where the host truthfully cannot serve an item.
  it('gives the standalone the same menu minus exactly the items it cannot serve', () => {
    expect(ids(image, STANDALONE)).toEqual(['copyImage', 'copyPath']);
    expect(ids(pill, STANDALONE)).toEqual(['copyPath', 'toggleHidden']);

    for (const ctx of [image, pill]) {
      const missing = ids(ctx, EXTENSION).filter((id) => !ids(ctx, STANDALONE).includes(id));
      expect(missing).toEqual(['revealInExplorer']);
      expect(STANDALONE.revealInExplorer).toBe(false);
    }
  });

  it('never offers an item the host disclaimed', () => {
    for (const ctx of [image, pill]) {
      expect(ids(ctx, NO_HOST_CAPABILITIES)).not.toContain('copyPath');
      expect(ids(ctx, NO_HOST_CAPABILITIES)).not.toContain('revealInExplorer');
    }
  });

  it('keeps the two local items reachable from any host, capabilities or not', () => {
    expect(ids(image, NO_HOST_CAPABILITIES)).toEqual(['copyImage']);
    expect(ids(pill, NO_HOST_CAPABILITIES)).toEqual(['toggleHidden']);
    // The split is exact in both directions: a host item wrongly marked local would be swallowed by
    // the webview and never reach the host, and a local one marked otherwise would post pointlessly.
    const LOCAL = ['copyImage', 'toggleHidden'];
    for (const caps of [EXTENSION, STANDALONE, NO_HOST_CAPABILITIES]) {
      for (const ctx of [image, pill]) {
        for (const item of buildContextMenu(ctx, caps)) {
          expect([item.id, item.local]).toEqual([item.id, LOCAL.includes(item.id)]);
        }
      }
    }
  });

  it('names the toggle after what the click will do', () => {
    expect(buildContextMenu({ ...pill, hidden: false }, EXTENSION).at(-1)!.label).toBe('Hide Modality');
    expect(buildContextMenu({ ...pill, hidden: true }, EXTENSION).at(-1)!.label).toBe('Show Modality');
  });

  it('separates the host items from the pill toggle', () => {
    const groups = buildContextMenu(pill, EXTENSION).map((i) => i.group);
    expect(groups).toEqual([1, 1, 2]);
  });

  // The help modal promised "copy path / reveal / copy image" in both products for two releases,
  // and the standalone offered none of it. Derived text cannot lie that way again.
  it('derives help text that names only what this host offers', () => {
    expect(contextMenuHelpText(EXTENSION)).toBe('Copy Image / Copy Path / Reveal in Explorer / Hide/Show Modality');
    expect(contextMenuHelpText(STANDALONE)).toBe('Copy Image / Copy Path / Hide/Show Modality');
    expect(contextMenuHelpText(NO_HOST_CAPABILITIES)).toBe('Copy Image / Hide/Show Modality');
  });
});
