import { defineConfig } from 'vitest/config';
import * as path from 'path';

// Layer 1 — pure-logic unit tests. We alias the `vscode` module to a minimal
// stub so we can import REAL production code (fileService, thumbnailService)
// instead of maintaining drifting hand-copies of the functions under test.
export default defineConfig({
  // Config lives in test/; pin the project root to the repo root so include
  // globs and the vscode alias resolve the same way regardless of cwd.
  root: path.resolve(__dirname, '..'),
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, 'mocks/vscode.ts'),
    },
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: 'default',
  },
});
