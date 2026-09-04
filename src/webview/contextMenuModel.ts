/** Pure (no vscode, no DOM): which items the in-comparison context menu offers, and where each runs (docs/standalone.md: affordances-rendered-by-the-webview). */

/** What a host can do on the webview's behalf. Data, never identity: nothing here ever asks which product it runs in. */
export interface HostCapabilities {
  /** The host can show a path in a file tree or explorer. */
  revealInExplorer: boolean;
  /** The host can put text on the system clipboard. */
  copyTextToClipboard: boolean;
  /** The host can save a copy of the session file. */
  saveSessionAs: boolean;
}

/** An `init` that names no capabilities claims none — an unstated capability is absent, never assumed. */
export const NO_HOST_CAPABILITIES: HostCapabilities = {
  revealInExplorer: false,
  copyTextToClipboard: false,
  saveSessionAs: false,
};

/** The reveal action's one label, shared with the notice channel so the item text has a single definition. */
export const REVEAL_LABEL = 'Reveal in Explorer';

/** Which surface was right-clicked: the displayed image, or a modality pill. */
export type MenuSection = 'image' | 'pill';
export type MenuActionId = 'copyImage' | 'copyPath' | 'revealInExplorer' | 'toggleHidden';

/** The clicked target. Indices are wire values: a tuple index and an ORIGINAL modality index. */
export interface MenuContext {
  section: MenuSection;
  tupleIndex: number;
  modalityIndex: number;
  /** Pill only: whether that modality is hidden right now — decides the toggle's label. */
  hidden?: boolean;
}

export interface MenuItem {
  id: MenuActionId;
  label: string;
  /** Groups are rendered in ascending order with a separator between them. */
  group: number;
  /** True when the webview performs the action itself; the rest post `menuAction` to the host. */
  local: boolean;
}

/** The menu for one target: local items always, host items only where the host says it can serve them. */
export function buildContextMenu(ctx: MenuContext, caps: HostCapabilities): MenuItem[] {
  const items: MenuItem[] = [];
  if (ctx.section === 'image') {
    items.push({ id: 'copyImage', label: 'Copy Image', group: 1, local: true });
  }
  if (caps.copyTextToClipboard) {
    items.push({ id: 'copyPath', label: 'Copy Path', group: 1, local: false });
  }
  if (caps.revealInExplorer) {
    items.push({ id: 'revealInExplorer', label: REVEAL_LABEL, group: 1, local: false });
  }
  if (ctx.section === 'pill') {
    // The label is the only thing hiding changes here; the pill stays clickable (docs/session-files.md: hidden-is-presentation-only).
    items.push({ id: 'toggleHidden', label: ctx.hidden ? 'Show Modality' : 'Hide Modality', group: 2, local: true });
  }
  return items;
}

/** The help modal's right-click row, derived from the same model so it cannot promise an item this host does not offer. */
export function contextMenuHelpText(caps: HostCapabilities): string {
  const probe: MenuContext = { section: 'image', tupleIndex: 0, modalityIndex: 0 };
  const labels = [
    ...buildContextMenu(probe, caps),
    ...buildContextMenu({ ...probe, section: 'pill' }, caps),
  ].map(item => (item.id === 'toggleHidden' ? 'Hide/Show Modality' : item.label));
  return [...new Set(labels)].join(' / ');
}
