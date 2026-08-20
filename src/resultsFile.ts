// Pure results.txt format (no vscode): parse and serialize live only here (docs/standalone.md: results-format-shared).

/** Winner indices → durable modality names for persisting; a winner whose column no longer resolves is dropped (docs/session-files.md: durable-vote-key). */
export function winnersToNames(winners: ReadonlyMap<number, number>, modalities: readonly string[]): Map<number, string> {
  const named = new Map<number, string>();
  for (const [tupleIndex, modalityIndex] of winners) {
    const modality = modalities[modalityIndex];
    if (modality) named.set(tupleIndex, modality);
  }
  return named;
}

/** Parse `<tuple name> = <winner modality>` lines into Map<tuple name, modality>; comments and blanks skipped. */
export function parseResults(text: string): Map<string, string> {
  const winners = new Map<string, string>();

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Parse format: tuple_key = winner_modality
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const tupleKey = trimmed.substring(0, eqIndex).trim();
      const modality = trimmed.substring(eqIndex + 1).trim();
      if (tupleKey && modality) {
        winners.set(tupleKey, modality);
      }
    }
  }

  return winners;
}

/** Serialize the human-editable results file, byte-identical to what the extension writes (docs/session-files.md). */
export function serializeResults(
  tuples: ReadonlyArray<{ name: string }>,
  winners: Map<number, string>, // tupleIndex -> modality name
  modalities: readonly string[],
  now: Date = new Date()
): string {
  const lines: string[] = [
    '# ImageCompare Results',
    `# Generated: ${now.toISOString()}`,
    `# Modalities: ${modalities.join(', ')}`,
    '#',
    '# Format: tuple_key = winner_modality',
    '# Delete a line to remove the vote, edit modality name to change vote',
    ''
  ];

  for (let i = 0; i < tuples.length; i++) {
    const winnerModality = winners.get(i);
    if (winnerModality) {
      // The on-disk key is the tuple name, never the index i (docs/session-files.md: durable-vote-key).
      lines.push(`${tuples[i].name} = ${winnerModality}`);
    }
  }

  return lines.join('\n') + '\n';
}

export interface ResultsPersistIo {
  writeText(text: string): Promise<void>;
  deleteFile(): Promise<void>;
}

/** Persist winners through injected IO: no winners deletes the file (never an empty stub), else serialize-and-write; both failure modes are non-fatal (docs/standalone.md: results-format-shared). */
export async function persistResults(
  tuples: ReadonlyArray<{ name: string }>,
  modalities: readonly string[],
  winners: ReadonlyMap<number, number>,
  io: ResultsPersistIo,
  now?: Date
): Promise<void> {
  if (winners.size === 0) {
    try {
      await io.deleteFile();
    } catch {
      // File doesn't exist or can't be deleted - that's OK
    }
    return;
  }

  const content = serializeResults(tuples, winnersToNames(winners, modalities), modalities, now);
  try {
    await io.writeText(content);
  } catch (error) {
    // Non-fatal: the results file is optional.
    console.error('Failed to save results.txt:', error);
  }
}
