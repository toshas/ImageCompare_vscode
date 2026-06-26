import { defineConfig } from 'vitest/config';
import * as path from 'path';

// Layer 1 — pure-logic unit tests. We alias the `vscode` module to a minimal
// stub so we can import REAL production code (fileService, thumbnailService)
// instead of maintaining drifting hand-copies of the functions under test.
export default defineConfig({
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, 'test/mocks/vscode.ts'),
    },
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: 'default',
  },
});
