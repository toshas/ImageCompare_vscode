import { buildHarness } from './harness';

// Regenerate the harness HTML (from the current shell + bundle) before the run.
export default function globalSetup(): void {
  buildHarness();
}
