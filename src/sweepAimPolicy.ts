// The sweep's aim policy (no vscode, no DOM): what the hosts report, when it settles and what the runner reads — one implementation for both products (docs/loading-architecture.md: sweep-centre-dwells).
import { SweepAim } from './thumbnailPlan';
import { LOAD_DEBOUNCE_MS } from './webview/tupleLoadPlan';

/** The `tupleFullyLoaded` report as the webview sends it: the one message that carries the strip (docs/loading-architecture.md: thumbnails-centre-out). */
export interface AimStripReport {
  modalityOrder: readonly number[];
  currentDisplayIndex: number;
  hiddenModalities: readonly number[];
  visibleRows?: number;
}

/** The host's timer primitives, nothing more: the delay, the edge and the reset are the policy's (docs/loading-architecture.md: sweep-centre-dwells). */
export interface AimTimers {
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** The dwell a moved tuple waits out before it becomes the aim — the navigation debounce (docs/loading-architecture.md: sweep-centre-dwells). */
export const AIM_DWELL_MS = LOAD_DEBOUNCE_MS;

/**
 * Where the sweep aims, for one panel/session. Hosts report raw webview messages and supply timers;
 * every decision — the trailing edge, the dwell, the un-permuting of the strip, the aim's shape —
 * is here (docs/loading-architecture.md: sweep-centre-dwells, thumbnails-centre-out).
 */
export class SweepAimPolicy {
  /** Where the user is, as last reported — the raw `setCurrentTuple` stream. */
  private tuple = 0;
  /** What the sweep reads: the tuple the user settled on. */
  private settled = 0;
  private strip?: { modality: number; modalityOrder: readonly number[]; hidden: readonly number[]; radius?: number };
  private dwell?: unknown;

  constructor(private readonly timers: AimTimers) {}

  /** A raw `setCurrentTuple`: it moves the aim only once the burst it belongs to ends (docs/loading-architecture.md: sweep-centre-dwells). */
  noteTuple(tupleIndex: number): void {
    this.tuple = tupleIndex;
    if (this.dwell !== undefined) this.timers.clearTimer(this.dwell);
    this.dwell = this.timers.setTimer(() => {
      this.dwell = undefined;
      this.settled = this.tuple;
    }, AIM_DWELL_MS);
  }

  /** A raw `tupleFullyLoaded`: the column is un-permuted here, and an unreadable report is not an aim (docs/tuple-matching.md: wire-index-is-original). */
  noteStrip(report: AimStripReport): void {
    const modality = report.modalityOrder[report.currentDisplayIndex];
    if (modality === undefined) return;
    this.strip = { modality, modalityOrder: report.modalityOrder, hidden: report.hiddenModalities, radius: report.visibleRows };
  }

  /** The sweep opens aimed where its host says the user is — the panel's own tuple, no dwell yet fired (docs/loading-architecture.md: sweep-centre-dwells). */
  noteSweepStart(tupleIndex: number): void {
    this.tuple = tupleIndex;
    this.settled = tupleIndex;
  }

  /** What the runner's `centre` reads, once per pump pass (docs/loading-architecture.md: sweep-aims-once-per-pass). */
  aim(): SweepAim {
    return { tuple: this.settled, ...this.strip };
  }

  /** Host teardown — a dwell must never fire against a dead panel or a closed session (docs/loading-architecture.md: sweep-centre-dwells). */
  dispose(): void {
    if (this.dwell !== undefined) this.timers.clearTimer(this.dwell);
    this.dwell = undefined;
  }
}
