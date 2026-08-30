// Pure (no DOM): what the viewer says once a comparison has nothing left to draw (docs/loading-architecture.md: empty-comparison-is-terminal).

export interface EmptyNoticeInput {
  tupleCount: number;
  modalityCount: number;
  /** The comparison root, once the host has established it is gone rather than merely emptied; null otherwise. */
  missingRootPath: string | null;
}

/** Headline plus the one fact under it: a path when the folder itself went, an explanation when only its files did. */
export interface EmptyNotice {
  title: string;
  detail: string;
}

/** The terminal notice, or null while anything is still drawable — content always wins over a missing root. */
export function emptyNotice(input: EmptyNoticeInput): EmptyNotice | null {
  if (input.tupleCount > 0 && input.modalityCount > 0) return null;
  if (input.missingRootPath !== null) {
    return { title: 'Folder no longer exists', detail: input.missingRootPath };
  }
  return { title: 'Nothing left to compare', detail: 'Every image in this comparison was deleted or moved.' };
}
