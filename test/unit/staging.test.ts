import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stageForUniqueNames } from '../../src/clipboardFiles';

function mk(dir: string, name: string): string {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, name);
  return p;
}

describe('stageForUniqueNames', () => {
  it('returns the originals untouched when all basenames are unique', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-stage-'));
    const a = mk(root, 'A/img1.png');
    const b = mk(root, 'B/img2.png');
    expect(stageForUniqueNames([{ path: a, label: 'A' }, { path: b, label: 'B' }])).toEqual([a, b]);
  });

  it('stages same-named files with disambiguated, all-unique names', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-stage-'));
    // Same basename in two modalities — the case that made Finder/Slack drop one.
    const a = mk(root, 'GT/scene.png');
    const b = mk(root, 'PRED/scene.png');
    const out = stageForUniqueNames([{ path: a, label: 'GT' }, { path: b, label: 'PRED' }]);

    expect(out.length).toBe(2);
    const names = out.map((p) => path.basename(p));
    expect(new Set(names).size).toBe(2); // unique names → both paste
    expect(names).toEqual(['scene__GT.png', 'scene__PRED.png']);
    for (const p of out) expect(fs.existsSync(p)).toBe(true); // real staged copies
  });

  it('keeps unique-named files as-is but disambiguates the colliding ones', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-stage-'));
    const a = mk(root, 'GT/scene.png');
    const b = mk(root, 'PRED/scene.png');
    const c = mk(root, 'GT/unique.png');
    const out = stageForUniqueNames([
      { path: a, label: 'GT' },
      { path: b, label: 'PRED' },
      { path: c, label: 'GT' },
    ]);
    const names = out.map((p) => path.basename(p));
    expect(new Set(names).size).toBe(3);
    expect(names).toContain('unique.png');
  });
});
