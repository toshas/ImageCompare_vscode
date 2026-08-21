import { buildHarness } from './harness';
import { ensureStandaloneArtifact } from './standaloneArtifact';

// Regenerate the harness HTML (from the current shell + bundle) before the run.
export default function globalSetup(): void {
  buildHarness();
  // One build, in the main process, before any worker can read the page (docs/testing.md).
  ensureStandaloneArtifact();
}
