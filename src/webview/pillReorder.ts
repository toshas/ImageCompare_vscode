/** Pure (no vscode, no DOM): what moving one pill does to every display index, where a lifted pill drops, and how far each other pill slides aside meanwhile (docs/pointer-input.md). */

/** Where display index `k` lands when the item at `from` moves to `to`: the moved one lands at `to`, the ones between close up by one (docs/pointer-input.md: reorder-is-one-move). */
export function movedIndex(k: number, from: number, to: number): number {
  if (k === from) return to;
  if (from < k && k <= to) return k - 1;
  if (to <= k && k < from) return k + 1;
  return k;
}

/** First index in [lo, hi) whose value passes `pred`, for a predicate monotone over ascending `a`. */
function firstWhere(a: readonly number[], lo: number, hi: number, pred: (v: number) => boolean): number {
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (pred(a[m])) hi = m; else lo = m + 1;
  }
  return lo;
}

/** The slot a pill lifted from `from` belongs in with its centre at `centre`, over every pill's resting midpoint `mids` (ascending); a neighbour is passed only strictly beyond its midpoint. */
export function dropSlot(mids: readonly number[], from: number, centre: number): number {
  const passedRight = firstWhere(mids, from + 1, mids.length, (m) => m >= centre) - (from + 1);
  const passedLeft = from - firstWhere(mids, 0, from, (m) => m > centre);
  return from + passedRight - passedLeft;
}

/** How far pill `j` (not the lifted one) slides while the pill from `from` hovers over slot `to`; `shift` is the lifted pill's width plus one gap. */
export function slotShift(j: number, from: number, to: number, shift: number): number {
  if (j > from && j <= to) return -shift;
  if (j < from && j >= to) return shift;
  return 0;
}
