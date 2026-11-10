import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Uri, __resetConfig, __setRemoteName, __setConfig } from '../mocks/vscode';
import { ImageCompareProvider } from '../../src/imageCompareProvider';
import { SWEEP_CHUNK } from '../../src/thumbnailPlan';
import { panelState, thumbnailServiceStub } from './providerRig';

// The host half of the centre-out sweep, on the REAL provider: it supplies the shared aim policy as the
// sweep's centre. The live re-aim on a settled `setCurrentTuple` is pinned in sweepCentreDwell.test.ts.
// (docs/loading-architecture.md: thumbnails-centre-out, sweep-dispatch-bounded)

const MODALITIES = ['gt', 'ours'];
const TUPLES = 30;
const OPEN_AT = 20;
/** Wide enough that every dispatched slot starts immediately, so what getThumbnail sees IS the dispatch order. */
const POOL_WIDTH = 64;

const tmpRoots: string[] = [];
const rigs: Rig[] = [];
afterAll(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});
// The work pool is process-wide: a rig that left reads hung would starve the next test of slots.
afterEach(async () => {
  for (const rig of rigs) {
    let guard = 0;
    while (rig.resolvers.length && guard++ < 500) {
      for (const r of rig.resolvers.splice(0)) r();
      await settle(3);
    }
  }
  rigs.length = 0;
  await settle(5);
  __resetConfig();
  __setRemoteName(undefined);
});

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

interface Rig {
  provider: any;
  state: any;
  /** Rows getThumbnail has been called for, in call order. */
  asked: number[];
  /** The same calls as `modality-row`, so the COLUMN the sweep aims at is visible too. */
  askedSlots: string[];
  resolvers: Array<() => void>;
  maxConcurrent: number;
}

function makeRig(): Rig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-sweep-centre-'));
  tmpRoots.push(root);
  __setConfig('maxConcurrentReads', POOL_WIDTH);
  const asked: number[] = [];
  const askedSlots: string[] = [];
  const resolvers: Array<() => void> = [];
  const rig: Rig = { provider: undefined, state: undefined, asked, askedSlots, resolvers, maxConcurrent: 0 };
  rigs.push(rig);
  let live = 0;

  const provider = new ImageCompareProvider({ globalStorageUri: Uri.file(root) } as any);
  (provider as any).thumbnailService = thumbnailServiceStub(resolvers, uri => {
    asked.push(Number(/frame(\d+)/.exec(uri.path)![1]));
    askedSlots.push(`${/imgs\/([^/]+)\//.exec(uri.path)![1]}-${/frame(\d+)/.exec(uri.path)![1]}`);
    live++;
    rig.maxConcurrent = Math.max(rig.maxConcurrent, live);
  }, () => { live--; });

  rig.provider = provider;
  rig.state = panelState({ modalities: MODALITIES, tuples: TUPLES, openAt: OPEN_AT, poolKeyPrefix: 'centre' });
  return rig;
}

describe('open-time sweep aims at the provider\'s live current tuple', () => {
  it('starts at the row the panel opened on and walks outward, forward first on a tie', async () => {
    const rig = makeRig();
    rig.provider.generateAllThumbnails(rig.state);
    await settle();
    // The tile the panel opened on and its row's other modality, then the rows either side of it in
    // that same column — not row 0, which scanline order would have taken.
    expect(rig.asked.slice(0, 6)).toEqual([20, 20, 21, 19, 22, 18]);
  });

  it('aims at the column the webview reports, translated out of display space', async () => {
    const rig = makeRig();
    // The strip as the user rearranged it: ['ours', 'gt'], with the user on display position 0 —
    // which is ORIGINAL modality 1. A host that passed the display index on would aim at 'gt'.
    await rig.provider.handlePanelMessage(rig.state, {
      type: 'tupleFullyLoaded',
      tupleIndex: OPEN_AT,
      modalityOrder: [1, 0],
      currentDisplayIndex: 0,
      hiddenModalities: []
    });
    rig.provider.generateAllThumbnails(rig.state);
    await settle();
    // The focused tile, its row's other column, then that same column in the rows either side.
    expect(rig.askedSlots.slice(0, 4)).toEqual([`ours-${OPEN_AT}`, `gt-${OPEN_AT}`, `ours-${OPEN_AT + 1}`, `ours-${OPEN_AT - 1}`]);
  });

  it('stops the cross at the screenful the webview reported, then fills row-major', async () => {
    const rig = makeRig();
    // A carousel one row tall: the cross may reach exactly one row either side of the focused tile.
    await rig.provider.handlePanelMessage(rig.state, {
      type: 'tupleFullyLoaded',
      tupleIndex: OPEN_AT,
      modalityOrder: [0, 1],
      currentDisplayIndex: 0,
      hiddenModalities: [],
      visibleRows: 1
    });
    rig.provider.generateAllThumbnails(rig.state);
    await settle();
    // Cross: the tile, its row's other modality, rows 21 and 19 in that column — and stop. Then
    // row-major centre-out: the rest of 21, the rest of 19, then rows 22 and 18 whole.
    expect(rig.asked.slice(0, 10)).toEqual([20, 20, 21, 19, 21, 19, 22, 22, 18, 18]);
  });

  it('keeps at most SWEEP_CHUNK slots in flight, not the whole grid', async () => {
    const rig = makeRig();
    rig.provider.generateAllThumbnails(rig.state);
    await settle();
    // 60 slots planned; the pool is wide enough for all of them, so the bound seen here is the sweep's own.
    expect(rig.asked.length).toBe(SWEEP_CHUNK);
    let guard = 0;
    while (rig.resolvers.length && guard++ < 500) {
      for (const r of rig.resolvers.splice(0)) r();
      await settle(3);
    }
    // Every wave stayed inside the bound: 60 slots swept, never more than 32 outstanding.
    expect(rig.asked.length).toBe(60);
    expect(rig.maxConcurrent).toBe(SWEEP_CHUNK);
  });
});
