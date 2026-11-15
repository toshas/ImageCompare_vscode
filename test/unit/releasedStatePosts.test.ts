import * as fs from 'node:fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Uri, workspace } from '../mocks/vscode';
import { ImageCompareProvider } from '../../src/imageCompareProvider';
import { fakePanel, imageFixture } from './providerRig';

// Driven through the REAL openCompare and releasePanel.
// (docs/session-files.md: released-state-never-posts)

const tmpRoots: string[] = [];
afterAll(() => { for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); });

const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };

describe('a released comparison state never posts to its panel (real provider)', () => {
  it('a slot delete that finishes after the release posts nothing', async () => {
    const storage = imageFixture(tmpRoots, 'ic-released-');
    const provider = new ImageCompareProvider({ globalStorageUri: Uri.file(storage), extensionUri: Uri.file(storage) } as any);
    const posted: unknown[] = [];
    const p = fakePanel(posted);
    await provider.openCompare([Uri.file(imageFixture(tmpRoots, 'ic-released-'))] as never, p.panel);
    // The open bound a state, so the release below has one to release; a failed open renders an error page instead.
    expect(p.panel.webview.html).toContain('webview.js');

    // The disk delete is in progress when the reload releases the state.
    let finishDelete!: () => void;
    vi.spyOn(workspace.fs, 'delete').mockImplementation(() => new Promise<void>(r => { finishDelete = r; }));
    const deleting = p.send({ type: 'deleteImage', tupleIndex: 0, modalityIndex: 0 });
    await settle();
    expect(finishDelete, 'the delete reached the disk').toBeTypeOf('function');

    provider.releasePanel(p.panel);
    const atRelease = posted.length;
    finishDelete();
    await deleting;
    await settle();

    expect(posted.slice(atRelease)).toEqual([]);
  });
});
