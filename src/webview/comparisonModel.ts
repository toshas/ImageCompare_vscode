/** Pure (no DOM, no vscode): the webview's comparison model and every structural change to it, each returning the new model and an index remap (docs/tuple-matching.md). */

import { displayOrderAfterInsert } from './modalityVisibility';
import { movedIndex } from './pillReorder';
import { shiftIndexAfterRemoval } from '../watcherLogic';

// Branded index spaces, re-declared from src/types.ts (docs/tuple-matching.md trap 2).
export type OriginalModalityIndex = number & { readonly __brand: 'OriginalModalityIndex' };
export type DisplayModalityIndex = number & { readonly __brand: 'DisplayModalityIndex' };
// Tuple index is a single space (no display/original split); the brand guards it against modality indices.
export type TupleIndex = number & { readonly __brand: 'TupleIndex' };
// Mint a brand at a real boundary (a wire value known to be original/display, or a fresh tuple/display position).
export const asOriginal = (n: number): OriginalModalityIndex => n as OriginalModalityIndex;
export const asDisplay = (n: number): DisplayModalityIndex => n as DisplayModalityIndex;
export const asTuple = (n: number): TupleIndex => n as TupleIndex;
// The only sanctioned conversions: the order is the one bridge (order[display] = original).
export function toOriginal(display: DisplayModalityIndex, order: readonly OriginalModalityIndex[]): OriginalModalityIndex {
  return order[display];
}
export function toDisplay(original: OriginalModalityIndex, order: readonly OriginalModalityIndex[]): DisplayModalityIndex {
  return asDisplay(order.indexOf(original));
}

interface ImageInfo {
  name: string;
  modality: string;
  tupleIndex: TupleIndex;
  modalityIndex: OriginalModalityIndex;
  /** The host cannot delete this file; absent means deletable. */
  readOnly?: true;
}

export interface TupleInfo {
  name: string;
  images: ImageInfo[];
}

const MODALITY_COLORS = [
  '#0f0', '#f60', '#0af', '#f0f', '#ff0', '#f44', '#4f4', '#44f'
];

/** One modality column. */
interface ModalityRecord {
  readonly name: string;
  readonly path: string;
  readonly color: string;
}

/** Every per-modality value is in original (wire) order; display order exists only as `order`. */
export interface ComparisonModel {
  readonly tuples: readonly TupleInfo[];
  readonly modalities: readonly ModalityRecord[];
  /** Display position -> original index. */
  readonly order: readonly OriginalModalityIndex[];
  /** Tuple -> its winning modality, as an original index. */
  readonly winners: ReadonlyMap<TupleIndex, OriginalModalityIndex>;
  /** Original indices, in the order they were hidden; presentation only (docs/session-files.md: hidden-is-presentation-only). */
  readonly hidden: ReadonlySet<OriginalModalityIndex>;
}

/** Where an index held before a structural change lands after it; null when its slot is gone. */
interface Remap {
  tuple(t: TupleIndex): TupleIndex | null;
  modality(o: OriginalModalityIndex): OriginalModalityIndex | null;
  display(d: DisplayModalityIndex): DisplayModalityIndex | null;
}

export interface Change {
  readonly model: ComparisonModel;
  readonly remap: Remap;
}

export const EMPTY_MODEL: ComparisonModel = { tuples: [], modalities: [], order: [], winners: new Map(), hidden: new Set() };

const same = <T>(x: T): T => x;

/** The model an `init` message describes: identity order, nothing hidden, the positional palette unless the host sent one colour per modality. */
export function modelFromInit(message: {
  tuples: TupleInfo[];
  modalities: string[];
  modalityPaths: string[];
  modalityColors?: string[];
  winners?: Record<number, OriginalModalityIndex>;
}): ComparisonModel {
  const colors = message.modalityColors && message.modalityColors.length === message.modalities.length
    ? message.modalityColors
    : message.modalities.map((_, i) => MODALITY_COLORS[i % MODALITY_COLORS.length]);
  const winners = new Map<TupleIndex, OriginalModalityIndex>();
  for (const [tupleIdx, modalityIdx] of Object.entries(message.winners ?? {})) {
    winners.set(asTuple(parseInt(tupleIdx, 10)), modalityIdx);
  }
  return {
    tuples: message.tuples,
    modalities: message.modalities.map((name, i) => ({ name, path: message.modalityPaths[i], color: colors[i] })),
    order: message.modalities.map((_, i) => asOriginal(i)),
    winners,
    hidden: new Set(),
  };
}

/** Carries the winners and the hidden set through `remap`, keeping their entry order. */
function changed(m: ComparisonModel, next: Pick<ComparisonModel, 'tuples' | 'modalities' | 'order'>, remap: Remap): Change {
  const winners = new Map<TupleIndex, OriginalModalityIndex>();
  for (const [t, o] of m.winners) {
    const t2 = remap.tuple(t);
    const o2 = remap.modality(o);
    if (t2 !== null && o2 !== null) winners.set(t2, o2);
  }
  // Original-index-keyed, so it shifts with the splice like everything else (docs/file-watching.md: reindex-in-lockstep).
  const hidden = new Set<OriginalModalityIndex>();
  for (const o of m.hidden) {
    const o2 = remap.modality(o);
    if (o2 !== null) hidden.add(o2);
  }
  return { model: { ...next, winners, hidden }, remap };
}

/** A row inserted at `at`: every row at or after it moves down one. */
export function tupleAdded(m: ComparisonModel, at: TupleIndex, tuple: TupleInfo): Change {
  const tuples = m.tuples.slice();
  tuples.splice(at, 0, tuple);
  const tupleMap = (t: TupleIndex) => asTuple(t >= at ? t + 1 : t);
  return changed(m, { tuples, modalities: m.modalities, order: m.order }, { tuple: tupleMap, modality: same, display: same });
}

/** The row at `at` removed: its winner goes, every later row moves up one. */
export function tupleRemoved(m: ComparisonModel, at: TupleIndex): Change {
  const tuples = m.tuples.slice();
  tuples.splice(at, 1);
  const tupleMap = (t: TupleIndex) => (t === at ? null : asTuple(t > at ? t - 1 : t));
  return changed(m, { tuples, modalities: m.modalities, order: m.order }, { tuple: tupleMap, modality: same, display: same });
}

/** A column inserted at original index `modalityIndex`, its colour and every other one taken from the wire's post-insert palette. */
export function modalityAdded(
  m: ComparisonModel,
  message: { modality: string; modalityPath: string; modalityColors: string[]; modalityIndex: OriginalModalityIndex }
): Change {
  const w = message.modalityIndex;
  // The user's arrangement survives the insert; the new column lands beside its original-order predecessor (docs/tuple-matching.md: rearrangement-survives-insert).
  const inserted = displayOrderAfterInsert(m.order, w);
  const displayPos = inserted.displayPos;
  const records = m.modalities.slice();
  records.splice(w, 0, { name: message.modality, path: message.modalityPath, color: '' });
  const tuples = m.tuples.map((tuple, t) => {
    const images = tuple.images.slice();
    // Empty name marks a missing slot, keeping webview tuples dense (docs/tuple-matching.md: sparse-vs-dense-tuples)
    images.splice(w, 0, { name: '', modality: message.modality, tupleIndex: asTuple(t), modalityIndex: w });
    return { ...tuple, images: images.map((img, i) => (i > w ? { ...img, modalityIndex: asOriginal(i) } : img)) };
  });
  return changed(m, {
    tuples,
    modalities: records.map((r, i) => ({ ...r, color: message.modalityColors[i] })),
    order: inserted.order.map(asOriginal),
  }, {
    tuple: same,
    modality: o => asOriginal(o >= w ? o + 1 : o),
    // The arrangement is kept, so a display index shifts only at the insertion point.
    display: d => asDisplay(d >= displayPos ? d + 1 : d),
  });
}

/** The column at original index `removed` dropped; the order resets to identity, as it always has. */
export function modalityRemoved(m: ComparisonModel, removed: OriginalModalityIndex): Change {
  const removedName = m.modalities[removed]?.name;
  const records = m.modalities.slice();
  records.splice(removed, 1);
  const tuples = m.tuples.map(tuple => ({
    ...tuple,
    images: tuple.images.filter(img => img.modality !== removedName).map((img, i) => ({ ...img, modalityIndex: asOriginal(i) })),
  }));
  const modality = (o: OriginalModalityIndex) => {
    const shifted = shiftIndexAfterRemoval(o, removed);
    return shifted === null ? null : asOriginal(shifted);
  };
  return changed(m, { tuples, modalities: records, order: records.map((_, i) => asOriginal(i)) }, {
    tuple: same,
    modality,
    // A display index names a slot of the previous order; the new order is identity, so its original is its display index.
    display: d => {
      const o = m.order[d];
      const carried = o === undefined ? null : modality(o);
      return carried === null ? null : asDisplay(carried);
    },
  });
}

/** The column at display `from` moved to `to`, the ones between closing up; null when the move is refused (docs/pointer-input.md: reorder-is-one-move). */
export function modalityMoved(m: ComparisonModel, from: number, to: number): Change | null {
  if (to < 0 || to >= m.order.length || to === from) return null;
  const order = m.order.slice();
  order.splice(to, 0, order.splice(from, 1)[0]);
  // Winners and hidden are original-indexed, so only display indices move.
  return changed(m, { tuples: m.tuples, modalities: m.modalities, order }, {
    tuple: same,
    modality: same,
    display: d => asDisplay(movedIndex(d, from, to)),
  });
}

/** Sets or clears a tuple's winner; an original index the order does not hold is ignored. */
export function winnerSet(m: ComparisonModel, t: TupleIndex, o: OriginalModalityIndex | null): ComparisonModel {
  if (o !== null && !m.order.includes(o)) return m;
  const winners = new Map(m.winners);
  if (o === null) winners.delete(t);
  else winners.set(t, o);
  return { ...m, winners };
}

/** Replaces every winner from the wire's record, dropping indices the order does not hold. */
export function winnersReset(m: ComparisonModel, record: Record<number, OriginalModalityIndex>): ComparisonModel {
  const winners = new Map<TupleIndex, OriginalModalityIndex>();
  for (const [tupleIdx, o] of Object.entries(record)) {
    if (m.order.includes(o)) winners.set(asTuple(parseInt(tupleIdx, 10)), o);
  }
  return { ...m, winners };
}

/** Hides a visible column or shows a hidden one. */
export function hiddenToggled(m: ComparisonModel, o: OriginalModalityIndex): ComparisonModel {
  const hidden = new Set(m.hidden);
  if (hidden.has(o)) hidden.delete(o);
  else hidden.add(o);
  return { ...m, hidden };
}

/** The column shown at display position `d`. */
export function modalityAt(m: ComparisonModel, d: number): ModalityRecord | undefined {
  return m.modalities[m.order[d]];
}

/** A tuple's winner as a display index, -1 when its column is not in the order. */
export function winnerAt(m: ComparisonModel, t: TupleIndex): DisplayModalityIndex | undefined {
  const o = m.winners.get(t);
  return o === undefined ? undefined : toDisplay(o, m.order);
}

export function hiddenByDisplay(m: ComparisonModel): boolean[] {
  return m.order.map(o => m.hidden.has(o));
}

/** Permutes an original-ordered slot array into display order; a slot past its end is undefined. */
export function reorderImagesForDisplay<T>(originalImages: readonly T[], order: readonly OriginalModalityIndex[]): (T | undefined)[] {
  const reordered: (T | undefined)[] = new Array(order.length);
  for (let displayIdx = 0; displayIdx < order.length; displayIdx++) {
    const originalIdx = order[displayIdx];
    reordered[displayIdx] = originalIdx < originalImages.length ? originalImages[originalIdx] : undefined;
  }
  return reordered;
}
