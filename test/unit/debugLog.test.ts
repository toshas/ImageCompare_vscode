// Layer 1 for the shared debug sink (src/debugLog.ts), imported for real through the vscode mock.
// The mock's OutputChannel records every appendLine, so "what a user sees in the ImageCompare output
// channel" is directly assertable; __setConfig + __fireConfigChange drive the real cached-flag refresh.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  debug,
  debugEnabled,
  debugVerbose,
  debugVerboseEnabled,
  debugWrite,
  configureDebugLog,
  diffTierStats,
  emptyTierStats,
  formatBytes,
  formatElapsed,
  formatTierStats,
  itemsPerSecond,
  resetDebugClock,
} from '../../src/debugLog';
import { disposeDebugLog, initDebugLog } from '../../src/debugChannel';
import {
  __channelLines,
  __disposedChannels,
  __fireConfigChange,
  __resetChannels,
  __resetConfig,
  __setConfig,
} from '../mocks/vscode';

const CHANNEL = 'ImageCompare';

function lines(): string[] {
  return __channelLines(CHANNEL);
}

describe('debugLog — the shared debug sink', () => {
  beforeEach(() => {
    __resetConfig();
    __resetChannels();
    disposeDebugLog();
  });

  afterEach(() => {
    disposeDebugLog();
    __resetConfig();
    __resetChannels();
  });

  describe('disabled path costs nothing', () => {
    it('debug off: the message thunk is never invoked and nothing reaches the channel', () => {
      __setConfig('debug', false);
      const sub = initDebugLog();
      let built = 0;
      debug('[IC-TEST]', () => { built++; return 'expensive'; });
      expect(built).toBe(0);
      expect(debugEnabled()).toBe(false);
      expect(lines()).toEqual([]);
      sub.dispose();
    });

    it('debug off: debugWrite ignores its args and writes nothing', () => {
      __setConfig('debug', false);
      const sub = initDebugLog();
      debugWrite('[IC-MATCH]', ['=== TUPLE MATCHING START ===']);
      expect(lines()).toEqual([]);
      sub.dispose();
    });

    it('verbose off while debug on: per-item thunks are not invoked, rollups still are', () => {
      __setConfig('debug', true);
      const sub = initDebugLog();
      let perItem = 0;
      debugVerbose('[IC-THUMB]', () => { perItem++; return 'per-item'; });
      debug('[IC-SWEEP]', () => 'rollup');
      expect(perItem).toBe(0);
      expect(debugVerboseEnabled()).toBe(false);
      expect(lines().map(l => l.replace(/^\+\d+ms /, ''))).toEqual(['[IC-SWEEP] rollup']);
      sub.dispose();
    });
  });

  describe('enabled path', () => {
    it('writes a tagged line to the ImageCompare channel with an elapsed prefix', () => {
      __setConfig('debug', true);
      const sub = initDebugLog();
      debug('[IC-SWEEP]', () => 'start slots=12');
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toMatch(/^\+\d+ms \[IC-SWEEP] start slots=12$/);
      sub.dispose();
    });

    it('debugWrite preserves the matcher line text, joining args with spaces', () => {
      __setConfig('debug', true);
      const sub = initDebugLog();
      debugWrite('[IC-MATCH]', ['Reference modality:', 'rgb', 'with', 4, 'files']);
      debugWrite('[IC-MATCH]', ['Modalities:', ['gt', 'ours']]);
      expect(lines()[0]).toMatch(/^\+\d+ms \[IC-MATCH] Reference modality: rgb with 4 files$/);
      expect(lines()[1]).toMatch(/^\+\d+ms \[IC-MATCH] Modalities: \["gt","ours"]$/);
      sub.dispose();
    });

    it('verbose on: per-item lines land too', () => {
      __setConfig('debug', true);
      __setConfig('debugVerbose', true);
      const sub = initDebugLog();
      debugVerbose('[IC-THUMB]', () => 'pack 3ms 4.3KB /a/b.png');
      expect(debugVerboseEnabled()).toBe(true);
      expect(lines()[0]).toContain('[IC-THUMB] pack 3ms 4.3KB /a/b.png');
      sub.dispose();
    });

    it('disposes the output channel when the extension subscription is disposed', () => {
      __setConfig('debug', true);
      const sub = initDebugLog();
      debug('[IC-EXT]', () => 'hello');
      sub.dispose();
      expect(__disposedChannels()).toContain(CHANNEL);
    });
  });

  describe('config changes are picked up', () => {
    it('turning debug on at runtime starts logging without re-activation', () => {
      __setConfig('debug', false);
      const sub = initDebugLog();
      debug('[IC-SWEEP]', () => 'before');
      __setConfig('debug', true);
      __fireConfigChange();
      debug('[IC-SWEEP]', () => 'after');
      expect(lines().map(l => l.replace(/^\+\d+ms /, ''))).toEqual(['[IC-SWEEP] after']);
      sub.dispose();
    });

    it('turning debug off at runtime stops the thunks again', () => {
      __setConfig('debug', true);
      const sub = initDebugLog();
      __setConfig('debug', false);
      __fireConfigChange();
      let built = 0;
      debug('[IC-SWEEP]', () => { built++; return 'x'; });
      expect(built).toBe(0);
      expect(debugEnabled()).toBe(false);
      sub.dispose();
    });
  });

  // The standalone build has no OutputChannel: it injects a console sink into the same shared module,
  // so this is the contract that keeps debugLog.ts free of any vscode coupling (docs/standalone.md).
  describe('a host-injected sink (the standalone path)', () => {
    it('receives the same formatted line, and stops receiving when reconfigured off', () => {
      const seen: string[] = [];
      resetDebugClock();
      configureDebugLog({ enabled: true, sink: line => seen.push(line) });
      debug('[IC-SWEEP]', () => 'start slots=3');
      configureDebugLog({ enabled: false });
      debug('[IC-SWEEP]', () => 'ignored');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatch(/^\+\d+ms \[IC-SWEEP] start slots=3$/);
      expect(lines()).toEqual([]);
    });
  });

  // A source-shape gate, not a copy: the matcher's logger is variadic, so an unguarded call site
  // evaluates its template literal even with debug off — 1.3 ms per open of discarded strings when
  // this regressed. Nothing observable distinguishes "built and dropped" from "never built" at
  // runtime, so the real file's shape is the only thing a test can hold.
  // (docs/loading-architecture.md: debug-off-costs-nothing)
  // What it pins is the CALL SITE, not zero work: hoisting an allocation above the gate keeps this
  // green while giving back half the saving (measured). Green here is necessary, never sufficient.
  describe('the matcher trace is gated at every call site', () => {
    it('no debugLog call in fileService.ts runs without a debugEnabled() guard', () => {
      const src = readFileSync(resolve(__dirname, '../../src/fileService.ts'), 'utf8');
      const offenders: string[] = [];
      let callSites = 0;
      let insideGate = 0;
      src.split('\n').forEach((line, i) => {
        if (insideGate > 0) {
          insideGate += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
        }
        if (/\bdebugLog\(/.test(line) && !/function debugLog/.test(line)) {
          callSites++;
          if (insideGate === 0 && !/if \(debugEnabled\(\)\) debugLog\(/.test(line)) {
            offenders.push(`${i + 1}: ${line.trim()}`);
          }
        }
        if (insideGate === 0 && /if \(debugEnabled\(\)\)\s*\{/.test(line)) insideGate = 1;
      });
      expect(callSites, 'the matcher trace still exists').toBeGreaterThanOrEqual(16);
      expect(offenders, 'ungated matcher log call sites').toEqual([]);
    });
  });

  describe('formatters', () => {
    it('formatElapsed stamps whole ms with a leading plus', () => {
      expect(formatElapsed(0)).toBe('+0ms');
      expect(formatElapsed(12345.4)).toBe('+12345ms');
      expect(formatElapsed(-5)).toBe('+0ms');
    });

    // Pinned against hand-computed values, not the implementation: 1536 = 1.5 KiB, 5MB = 5 * 1024^2.
    it('formatBytes switches units at 1024 and keeps one decimal', () => {
      expect(formatBytes(0)).toBe('0B');
      expect(formatBytes(1023)).toBe('1023B');
      expect(formatBytes(1024)).toBe('1.0KB');
      expect(formatBytes(1536)).toBe('1.5KB');
      expect(formatBytes(5 * 1024 * 1024)).toBe('5.0MB');
      expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0GB');
    });

    it('diffTierStats reports only what happened between two snapshots', () => {
      const before = emptyTierStats();
      before.pack = { count: 10, ms: 100, bytes: 4000 };
      const after = emptyTierStats();
      after.pack = { count: 14, ms: 160, bytes: 6000 };
      after.generated = { count: 2, ms: 400, bytes: 9000 };
      const delta = diffTierStats(before, after);
      expect(delta.pack).toEqual({ count: 4, ms: 60, bytes: 2000 });
      expect(delta.generated).toEqual({ count: 2, ms: 400, bytes: 9000 });
      expect(delta.memory).toEqual({ count: 0, ms: 0, bytes: 0 });
    });

    it('formatTierStats renders count/bytes/ms per tier, bare zeros for untouched tiers', () => {
      const stats = emptyTierStats();
      stats.pack = { count: 4, ms: 60, bytes: 2048 };
      expect(formatTierStats(stats)).toBe('memory=0 pack=4/2.0KB/60ms disk=0 generated=0');
    });

    it('itemsPerSecond divides items by seconds and never returns Infinity', () => {
      expect(itemsPerSecond(230, 35000)).toBe('6.6');
      expect(itemsPerSecond(5, 0)).toBe('0.0');
    });
  });
});
