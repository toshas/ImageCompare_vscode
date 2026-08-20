import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, it, expect } from 'vitest';
import { Uri, __channelLines, __resetChannels, __resetConfig, __setConfig } from '../mocks/vscode';
import { ImageCompareProvider } from '../../src/imageCompareProvider';
import { Priority, WorkPool } from '../../src/workPool';
import { disposeDebugLog, initDebugLog } from '../../src/debugChannel';
import { makeSolidPng } from '../fixtures/synthetic';

// The REAL existence poll, because the defect is what the poll writes when it finds nothing: a remote
// session left idle logged `[IC-EXT] pool active=0/16 run=[0,…] queued=[0,…]` every ~10s forever, so a
// channel opened after a while held nothing but that. Only the real runDeleteSweep can show it — the
// line is emitted by the cycle itself, before any of its work is submitted.
// (docs/loading-architecture.md: idle-poll-logs-nothing-new)

const CHANNEL = 'ImageCompare';
const tmpRoots: string[] = [];
afterAll(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

interface Bed { provider: ImageCompareProvider; state: Record<string, unknown>; files: string[] }

/** One modality dir under a base dir, three files, all known — a poll cycle with nothing to report. */
function makeBed(): Bed {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-pollnoise-'));
  tmpRoots.push(root);
  const base = path.join(root, 'session');
  const modDir = path.join(base, 'gt');
  fs.mkdirSync(modDir, { recursive: true });
  const files: string[] = [];
  for (let i = 0; i < 3; i++) {
    const file = path.join(modDir, `img${i}.png`);
    fs.writeFileSync(file, makeSolidPng(4, 4, [i, i, i]));
    files.push(file);
  }
  const provider = new ImageCompareProvider(
    { globalStorageUri: Uri.file(path.join(root, 'globalStorage')) } as unknown as import('vscode').ExtensionContext
  );
  const state = {
    panel: { webview: { postMessage: () => undefined } },
    scanResult: {
      modalities: ['gt'],
      tuples: files.map((f, i) => ({ name: `img${i}`, images: [{ uri: Uri.file(f), name: path.basename(f), modality: 'gt' }] })),
      mode: 1,
      roots: [Uri.file(base)],
      isMultiTupleMode: true
    },
    loadedImages: new Map(),
    currentTupleIndex: 0,
    disposed: false,
    visible: true,
    deleteSweepRunning: false,
    watchedDirs: new Set([base, modDir]),
    baseUri: Uri.file(base),
    barrenDirs: new Map(),
    adoptingDirs: new Set(),
    modalityDirs: new Map([['gt', Uri.file(modDir)]]),
    recentlyDeleted: [],
    winners: new Map(),
    poolKey: `pollnoise-${Math.random().toString(36).slice(2)}`,
    webviewReady: true,
    pendingDebugMessages: []
  };
  return { provider, state, files };
}

const runSweep = (bed: Bed) =>
  (bed.provider as unknown as { runDeleteSweep(s: unknown): Promise<void> }).runDeleteSweep(bed.state);

function poolLines(): string[] {
  return __channelLines(CHANNEL).filter(l => l.includes('[IC-EXT] pool active='));
}

describe('existence-poll logging (real ImageCompareProvider)', () => {
  beforeEach(() => {
    __resetConfig();
    __resetChannels();
    disposeDebugLog();
    __setConfig('debug', true);
    initDebugLog();
  });

  afterEach(() => {
    disposeDebugLog();
    __resetConfig();
    __resetChannels();
  });

  it('an idle window stops repeating itself: three quiet cycles leave one pool line, not three', async () => {
    const bed = makeBed();
    for (let i = 0; i < 3; i++) await runSweep(bed);
    const lines = poolLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\[IC-EXT] pool active=0\/\d+ run=\[0(,0)*] queued=\[0(,0)*]/);
    bed.provider.dispose();
  });

  it('a pool with work in it is reported every cycle, even when the snapshot is unchanged', async () => {
    const bed = makeBed();
    const pool = (bed.provider as unknown as { pool: WorkPool }).pool;
    // One occupant for the whole test, at a priority the poll never uses, so both cycles see the same string.
    const busy = pool.submit(() => new Promise<void>(r => setTimeout(r, 400)), { priority: Priority.EXPORT, key: 'pollnoise-blocker' });

    await runSweep(bed);
    await runSweep(bed);
    const lines = poolLines();
    expect(lines).toHaveLength(2);
    // Unchanged and still printed: silence must mean "idle", never "nothing happening that I bothered to say".
    expect(lines[0].split('] ').slice(1).join('] ')).toBe(lines[1].split('] ').slice(1).join('] '));
    expect(lines[0]).not.toContain('active=0/');

    await busy;
    bed.provider.dispose();
  });

  it('a cycle that finds a deletion still reports it after the quiet cycles went silent', async () => {
    const bed = makeBed();
    await runSweep(bed);
    await runSweep(bed);
    expect(poolLines()).toHaveLength(1);

    fs.rmSync(bed.files[1]);
    await runSweep(bed);
    // The poll's real signal is untouched by the pool-line gate.
    expect(__channelLines(CHANNEL).some(l => l.includes('poll delete detected'))).toBe(true);

    (bed.state as { disposed: boolean }).disposed = true; // the 500ms rename window must not outlive the test
    bed.provider.dispose();
  });
});
