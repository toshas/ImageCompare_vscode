// Pure init-message assembly (no vscode): both the provider and the standalone adapter build their `init` payload here (docs/standalone.md: adapter-contains-no-logic).
import {
  ExtensionMessage,
  HostCapabilities,
  TupleInfo,
  WebViewConfig,
  OriginalModalityIndex,
  asOriginal,
  asTuple,
  MODALITY_COLORS,
} from './types';

/** The sparse-tuple shape both products hold; only name/modality matter for the wire payload. */
export interface SparseTuple {
  name: string;
  images: ReadonlyArray<{ name: string; modality: string }>;
}

/** Dense over ALL modalities: a modality the sparse tuple lacks becomes a `name: ''` placeholder (docs/tuple-matching.md: sparse-vs-dense-tuples). */
export function denseTupleInfo(tuple: SparseTuple, tupleIndex: number, modalities: readonly string[]): TupleInfo {
  return {
    name: tuple.name,
    images: modalities.map((modality, modalityIndex) => {
      const img = tuple.images.find(i => i.modality === modality);
      return {
        name: img?.name || '',
        modality,
        tupleIndex: asTuple(tupleIndex),
        modalityIndex: asOriginal(modalityIndex),
      };
    }),
  };
}

export interface InitPayloadArgs {
  tuples: readonly SparseTuple[];
  modalities: readonly string[];
  modalityPaths: readonly string[];
  winners: ReadonlyMap<number, number>;
  config: WebViewConfig;
  votingEnabled: boolean;
  labelsExplicit: boolean;
  /** Product version shown in the help modal; provider passes its manifest version, standalone its build constant. */
  version: string;
  /** What this host can serve — the webview's whole affordance surface keys off it (docs/standalone.md: affordances-rendered-by-the-webview). */
  capabilities: HostCapabilities;
  /** Per-column color override (e.g. session-file colors); a falsy return falls back to the positional palette. */
  colorOverride?: (modality: string, index: number) => string | undefined;
}

/** Assemble the `init` message: dense tuples, positional palette defaults, winners map → record. */
export function buildInitPayload(args: InitPayloadArgs): ExtensionMessage {
  const winnersRecord: Record<number, OriginalModalityIndex> = {};
  for (const [tupleIndex, modalityIndex] of args.winners) {
    winnersRecord[tupleIndex] = asOriginal(modalityIndex);
  }
  return {
    type: 'init',
    tuples: args.tuples.map((tuple, tupleIndex) => denseTupleInfo(tuple, tupleIndex, args.modalities)),
    modalities: [...args.modalities],
    modalityPaths: [...args.modalityPaths],
    modalityColors: args.modalities.map((m, i) => args.colorOverride?.(m, i) || MODALITY_COLORS[i % MODALITY_COLORS.length]),
    config: args.config,
    winners: winnersRecord,
    votingEnabled: args.votingEnabled,
    labelsExplicit: args.labelsExplicit,
    version: args.version,
    capabilities: args.capabilities,
  };
}
