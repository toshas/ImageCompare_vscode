import * as fs from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { Uri } from '../mocks/vscode';
import { ImageCompareProvider } from '../../src/imageCompareProvider';
import { fakePanel, imageFixture, thumbnailServiceStub } from './providerRig';

// Driven through the REAL openCompare and the real ready handler: the init the tab receives is the
// one sendInitData builds. The webview's save and restore are pinned in
// test/webview/published-affordances.spec.ts; VS Code keeping the state is a manual check.
// (docs/session-files.md: view-lives-with-the-tab)

const tmpRoots: string[] = [];
afterAll(() => { for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true }); });

describe('a VS Code tab keeps its view (real provider)', () => {
  it('the init the extension sends states restoresView', async () => {
    const storage = imageFixture(tmpRoots, 'ic-view-');
    const provider = new ImageCompareProvider({
      globalStorageUri: Uri.file(storage),
      extensionUri: Uri.file(storage),
      extension: { packageJSON: { version: '9.9.9' } }
    } as any);
    // Only the pixels are stubbed, so the open-time sweep never reads the fixture after it is removed.
    (provider as unknown as { thumbnailService: unknown }).thumbnailService = thumbnailServiceStub([], () => undefined);
    const posted: unknown[] = [];
    const p = fakePanel(posted);
    await provider.openCompare([Uri.file(imageFixture(tmpRoots, 'ic-view-'))] as never, p.panel);
    await p.send({ type: 'ready' });
    const init = posted.find((m): m is { type: 'init'; capabilities: Record<string, unknown> } => (m as { type?: string }).type === 'init');
    expect(init, 'the ready handler posted an init').toBeDefined();
    expect(init!.capabilities.restoresView).toBe(true);
    provider.releasePanel(p.panel);
  });
});
