import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// The webview suite's own worker sizing is the one rule CI structurally cannot pin: on a GitHub
// runner os.cpus().length === os.availableParallelism(), so rewriting the config back to the
// cpus() count computes the identical number there and stays green forever — while on a
// cgroup/SLURM/container host it starts dozens of Chromiums on a handful of cores until specs
// time out for reasons unrelated to the change under test. This suite mocks node:os to that
// host's shape (many cores reported, few usable) and imports the REAL config module, never a
// copy. Same for the report layout: Playwright refuses an HTML report folder nested inside the
// test output folder, which is what the default outputDir produced. See docs/testing.md, Findings.

const here = path.dirname(fileURLToPath(import.meta.url));
const configDir = path.resolve(here, '..', 'webview');
const repoRoot = path.resolve(here, '..', '..');

interface WebviewConfig {
  workers?: number;
  outputDir?: string;
  reporter?: unknown;
}

/** The real config, evaluated against a host that reports `reported` cores and allows `usable`. */
async function loadConfig(reported: number, usable: number): Promise<WebviewConfig> {
  vi.resetModules();
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  const fake = {
    ...actual,
    cpus: () => new Array(reported).fill({ model: 'mock' }) as ReturnType<typeof actual.cpus>,
    availableParallelism: () => usable,
  };
  vi.doMock('node:os', () => ({ ...fake, default: fake }));
  const mod = (await import('../webview/playwright.config')) as { default: WebviewConfig };
  return mod.default;
}

/** Playwright resolves outputDir against the config's own directory; unset means <repo>/test-results. */
function resolvedOutputDir(cfg: WebviewConfig): string {
  return cfg.outputDir === undefined
    ? path.resolve(repoRoot, 'test-results')
    : path.resolve(configDir, cfg.outputDir);
}

function htmlReportFolder(cfg: WebviewConfig): string {
  const entries = cfg.reporter as [string, { outputFolder?: string }?][];
  const html = entries.find((r) => r[0] === 'html');
  expect(html, 'the webview suite must keep an html reporter').toBeTruthy();
  const folder = html![1]?.outputFolder;
  expect(folder, 'the html reporter must name its outputFolder').toBeTruthy();
  return path.resolve(configDir, folder!);
}

describe('webview suite worker sizing (test/webview/playwright.config.ts)', () => {
  // Expected counts are written out as literals, not re-derived from the config's own expression.
  it('sizes workers from usable parallelism, never the reported core count', async () => {
    const constrained = await loadConfig(256, 4);
    expect(constrained.workers).toBe(2);
    expect(constrained.workers).not.toBe(128);

    expect((await loadConfig(256, 1)).workers).toBe(1);
    expect((await loadConfig(64, 3)).workers).toBe(1);
  });

  it('keeps the 50% shape where the two counts agree', async () => {
    expect((await loadConfig(8, 8)).workers).toBe(4);
    expect((await loadConfig(4, 4)).workers).toBe(2);
    expect((await loadConfig(2, 2)).workers).toBe(1);
    expect((await loadConfig(1, 1)).workers).toBe(1);
  });

  it('keeps the HTML report outside the test output folder', async () => {
    const cfg = await loadConfig(8, 8);
    const out = resolvedOutputDir(cfg);
    const html = htmlReportFolder(cfg);
    expect(html, `${html} must not be the output folder ${out} itself`).not.toBe(out);
    expect(
      html.startsWith(out + path.sep),
      `${html} must not sit inside ${out} (Playwright: "output folder clashes")`,
    ).toBe(false);
  });
});
