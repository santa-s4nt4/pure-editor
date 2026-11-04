import { describe, expect, it } from 'vitest';
import { StorageManager, parseManifest, type LocalBackend } from '../src/lib/storage';
import { PaperNotebook } from '../src/lib/paper-notebook';

class SharedFiles implements LocalBackend {
  constructor(readonly coordinationKey: string, readonly files: Map<string, Uint8Array>) {}
  async read(path: string) { return this.files.get(path)?.slice() ?? null; }
  async write(path: string, bytes: Uint8Array) { await Promise.resolve(); this.files.set(path, bytes.slice()); }
  async remove(path: string) { this.files.delete(path); }
  async list() { return [...this.files.keys()].filter(path => !path.startsWith('.') && /\.md$|^assets\/.+\.webp$/.test(path)).map(path => ({ path, updatedAt: Date.now() })); }
}
async function windows() {
  const files = new Map<string, Uint8Array>(); const key = crypto.randomUUID();
  const a = new StorageManager(new SharedFiles(key, files));
  const b = new StorageManager(new SharedFiles(key, files));
  await Promise.all([a.initialize(), b.initialize()]);
  return { a, b, files };
}

describe('複数ウィンドウの保存', () => {
  it('別の記事を同時に保存しても同期インデックスから記事を落とさない', async () => {
    const { a, b, files } = await windows();
    const [first, second] = await Promise.all([a.createNote('A'), b.createNote('B')]);
    const paths = await Promise.all([a.saveNamedNote(first, '# A\n\n本文A'), b.saveNamedNote(second, '# B\n\n本文B')]);
    const manifest = parseManifest(files.get('_sync.json')!);
    expect(paths.every(path => manifest.files[path] && !manifest.files[path].deleted)).toBe(true);
    await a.reloadSharedState();
    expect((await a.listNotes()).map(note => note.title).sort()).toEqual(['A', 'B']);
  });

  it('他方で改名した記事を古いパスから編集しても、同じ記事を保存し両方の本文を残す', async () => {
    const { a, b } = await windows();
    const path = await a.createNote('記事'); const base = '# 記事\n\n初期本文';
    await a.saveNamedNote(path, base); await b.readNote(path);
    const renamed = await a.saveNamedNote(path, '# 変更後\n\n本文A', base);
    const saved = await b.saveNamedNote(path, '# 記事\n\n本文B', base);
    expect(await a.readNote(renamed)).toBe('# 記事\n\n本文B');
    expect(saved.match(/--([a-f0-9]{32})\.md$/)?.[1]).toBe(path.match(/--([a-f0-9]{32})\.md$/)?.[1]);
    const notes = await a.listNotes();
    const contents = await Promise.all(notes.map(note => a.readNote(note.path)));
    expect(contents.some(text => text?.includes('本文A'))).toBe(true);
    expect(contents.some(text => text?.includes('本文B'))).toBe(true);
  });

  it('同じ記事への同時編集では片方の本文を競合コピーに残す', async () => {
    const { a, b } = await windows(); const path = await a.createNote('記事'); const base = '# 記事\n\n元';
    await a.saveNamedNote(path, base); await b.readNote(path);
    await Promise.all([a.saveNamedNote(path, '# 記事\n\n窓A', base), b.saveNamedNote(path, '# 記事\n\n窓B', base)]);
    await a.reloadSharedState();
    const contents = await Promise.all((await a.listNotes()).map(note => a.readNote(note.path)));
    expect(contents.some(text => text?.includes('窓A'))).toBe(true);
    expect(contents.some(text => text?.includes('窓B'))).toBe(true);
  });

  it('他方で削除した記事を、古い編集画面から自動的に復活させない', async () => {
    const { a, b, files } = await windows(); const path = await a.createNote('記事');
    await a.saveNamedNote(path, '# 記事\n\n元'); await b.readNote(path); await a.deleteNote(path);
    await expect(b.saveNamedNote(path, '# 記事\n\n未保存の編集', '# 記事\n\n元')).rejects.toThrow('削除');
    expect(files.has(path)).toBe(false);
    expect(parseManifest(files.get('_sync.json')!).files[path].deleted).toBe(true);
  });

  it('Paper も他方の編集を読み直して、元の名前と競合前の本文を保持する', async () => {
    const { a, b, files } = await windows(); const first = new PaperNotebook(a.backend, null); const second = new PaperNotebook(b.backend, null);
    const path = await first.attach({ file: { id: 'id:doc', name: '会議.paper' }, revision: 1, markdown: '# 会議\n\n元' });
    await second.initialize(); await first.saveNote(path, '# 会議\n\n窓A');
    await second.saveNote(path, '# 会議\n\n窓B', '# 会議\n\n元');
    expect(await first.readNote(path)).toContain('窓B');
    expect(path).toMatch(/\/会議\.paper$/);
    expect([...files.entries()].some(([name, bytes]) => name.startsWith('.paper/backups/') && new TextDecoder().decode(bytes).includes('窓A'))).toBe(true);
  });
});
