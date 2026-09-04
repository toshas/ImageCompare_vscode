/** The context menu's DOM only — positioning, dismissal and click routing. It renders whatever the model hands it and decides nothing (docs/standalone.md: affordances-rendered-by-the-webview). */
import { MenuActionId, MenuItem } from './contextMenuModel';

const menuEl = document.getElementById('context-menu')!;
let pick: ((id: MenuActionId) => void) | null = null;

export function isContextMenuOpen(): boolean {
  return menuEl.classList.contains('visible');
}

export function closeContextMenu(): void {
  if (!isContextMenuOpen()) return;
  menuEl.classList.remove('visible');
  menuEl.innerHTML = '';
  pick = null;
}

/** Open at viewport coordinates `x`/`y`, clamped to stay on screen. An empty item list opens nothing. */
export function openContextMenu(
  items: readonly MenuItem[],
  x: number,
  y: number,
  onPick: (id: MenuActionId) => void
): void {
  closeContextMenu();
  if (items.length === 0) return;
  pick = onPick;

  let lastGroup = items[0].group;
  for (const item of items) {
    if (item.group !== lastGroup) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-sep';
      menuEl.appendChild(sep);
      lastGroup = item.group;
    }
    const btn = document.createElement('button');
    btn.className = 'context-menu-item';
    btn.textContent = item.label;
    btn.dataset.actionId = item.id;
    btn.addEventListener('click', () => {
      const handler = pick;
      closeContextMenu();
      handler?.(item.id);
    });
    menuEl.appendChild(btn);
  }

  // Measure from a known origin: a stale `left` caps the shrink-to-fit width, same trap as the pill tooltip.
  menuEl.style.left = '0px';
  menuEl.style.top = '0px';
  menuEl.classList.add('visible');
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.max(2, Math.min(x, window.innerWidth - r.width - 2))}px`;
  menuEl.style.top = `${Math.max(2, Math.min(y, window.innerHeight - r.height - 2))}px`;
}

// Dismissal is global and in capture: a menu that outlives its target is worse than one that closes early.
document.addEventListener('mousedown', (e) => {
  if (isContextMenuOpen() && !(e.target as HTMLElement)?.closest?.('#context-menu')) closeContextMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !isContextMenuOpen()) return;
  // Swallowed, so Escape dismisses the menu without also resetting the view's zoom.
  e.preventDefault();
  e.stopPropagation();
  closeContextMenu();
}, true);
document.addEventListener('wheel', () => closeContextMenu(), true);
window.addEventListener('blur', () => closeContextMenu());
window.addEventListener('resize', () => closeContextMenu());
