import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as actual from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/path', () => ({ join: async (...parts: string[]) => (await import('node:path')).join(...parts), appDataDir: async () => '/unused', appConfigDir: async () => '/unused' }));
vi.mock('@tauri-apps/plugin-fs', async () => {
  const fs = await import('node:fs/promises');
  return {
    exists: async (path: string) => fs.access(path).then(() => true, () => false),
    mkdir: fs.mkdir, readFile: fs.readFile, writeFile: fs.writeFile, rename: fs.rename, remove: fs.unlink, stat: fs.stat,
    readDir: async (path: string) => (await fs.readdir(path, { withFileTypes: true })).map(entry => ({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory(), isSymlink: entry.isSymbolicLink() })),
  };
});
import { createBackend, relocateImages, StorageManager, type Settings } from '../src/lib/storage';

let root: string;
beforeEach(async () => { root = await actual.mkdtemp(join(tmpdir(), 'pure-storage-test-')); });
afterEach(async () => { await actual.rm(root, { recursive: true, force: true }); });
const config = (images: string): Settings => ({ folder: join(root, 'Notes'), imagesFolder: join(root, images), endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '', syncEnabled: false, lastFile: '' });

describe('ネイティブ FS アダプターの保存先', () => {
  it('別フォルダの画像を実ファイルに保存し、.md に相対パスを書く', async () => {
    const settings = config('My Pictures');
    const manager = new StorageManager(await createBackend(settings)); await manager.initialize();
    const image = await manager.saveImage(new Uint8Array([1, 2, 3]));
    await manager.saveNote('folder/note.md', `# 題名\n![](${image})`);
    const disk = await actual.readFile(join(settings.folder, 'folder/note.md'), 'utf8');
    expect(disk).toContain(`![](../../My%20Pictures/${image.slice(7)})`);
    expect(await manager.readNote('folder/note.md')).toBe(`# 題名\n![](${image})`);
    expect(await actual.readFile(join(settings.imagesFolder!, image.slice(7)))).toEqual(Buffer.from([1, 2, 3]));
  });
  it('画像フォルダを変更するとコピーと参照更新を行い、同期ハッシュを維持する', async () => {
    const previous = config('Before'); const next = config('After');
    const manager = new StorageManager(await createBackend(previous)); await manager.initialize();
    const image = await manager.saveImage(new Uint8Array([4, 5, 6]));
    await manager.saveNote('note.md', `# 題名\n![](${image})`);
    const oldIndex = JSON.parse(await actual.readFile(join(previous.folder, '_sync.json'), 'utf8'));
    await relocateImages(previous, next);
    expect(await actual.readFile(join(next.folder, 'note.md'), 'utf8')).toContain(`../After/${image.slice(7)}`);
    const restarted = new StorageManager(await createBackend(next)); await restarted.initialize();
    const nextIndex = JSON.parse(await actual.readFile(join(next.folder, '_sync.json'), 'utf8'));
    expect(nextIndex.files['note.md']).toEqual(oldIndex.files['note.md']);
    expect(await restarted.readNote('note.md')).toBe(`# 題名\n![](${image})`);
  });
});
