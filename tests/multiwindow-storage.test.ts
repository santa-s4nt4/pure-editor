import { describe, expect, it } from 'vitest';
import { StorageManager, parseManifest, sha256, type LocalBackend } from '../src/lib/storage';
import { PaperNotebook } from '../src/lib/paper-notebook';
import { publicationDocument, withPublication } from '../src/lib/publication';

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

  it('Paper の再読み込み中に共有状態を更新しても、同じ文書を繰り返し取得しない', async () => {
    const { a } = await windows();
    const original = { file: { id: 'id:doc', name: '会議.paper' }, revision: 1, markdown: '# 会議\n\n元' };
    let exports = 0;
    const book = new PaperNotebook(a.backend, {
      connected: true,
      export: async () => { if (++exports > 2) throw new Error('同じ文書を繰り返しています'); return { ...original, revision: 2, markdown: '# 会議\n\n更新済み' }; },
      update: async () => 2,
    });
    const path = await book.attach(original);
    await book.refresh();
    expect(exports).toBe(1);
    expect(await book.readNote(path)).toContain('更新済み');
  });

  it('既存 Markdown を一括修正し、原本・名前・編集日時・公開設定を維持する', async () => {
    const { a, b, files } = await windows(); const encode = (value: string) => new TextEncoder().encode(value);
    const publication = { repository: 'test/notes', branch: 'main', visibility: 'public' as const, revision: '11111111-1111-4111-8111-111111111111', parent: null };
    const first = await a.createNote('A'); const second = await a.createNote('B');
    const original = withPublication('# A\n\n- item\n2025.1', publication);
    files.set(first, encode(original)); files.set(second, encode('# B\n\n- parent\n  - child\n2024.1'));
    await a.refresh();
    const before = parseManifest(files.get('_sync.json')!).files[first];
    expect(await a.migrateMarkdownLayout()).toBe(2);
    const fixed = files.get(first)!; const document = publicationDocument(new TextDecoder().decode(fixed));
    expect(document.body).toBe('# A\n\n- item\n\n2025.1'); expect(document.publication).toEqual(publication);
    const entry = parseManifest(files.get('_sync.json')!).files[first];
    expect(entry.updatedAt).toBe(before.updatedAt); expect(entry.sha256).toBe(await sha256(fixed));
    expect([...files.entries()].some(([path, bytes]) => path.startsWith('.trash/markdown-layout-') && new TextDecoder().decode(bytes) === original)).toBe(true);
    const backups = [...files.keys()].filter(path => path.startsWith('.trash/markdown-layout-')).length;
    expect(await a.migrateMarkdownLayout()).toBe(0); expect(await b.migrateMarkdownLayout()).toBe(0);
    expect([...files.keys()].filter(path => path.startsWith('.trash/markdown-layout-')).length).toBe(backups);
    expect((await a.listNotes()).map(note => note.path).sort()).toEqual([first, second].sort());
  });

  it('空行の補完だけでは、次の保存で誤った競合コピーを作らない', async () => {
    const { a } = await windows(); const path = await a.createNote('記事'); const original = '# 記事\n\n- item\n2025.1';
    await a.saveNamedNote(path, original);
    await a.saveNamedNote(path, original + '\n追記', original);
    expect((await a.listNotes()).filter(note => note.path.includes('conflict'))).toHaveLength(0);
    expect(await a.readNote(path)).toContain('- item\n\n2025.1\n追記');
  });

  it('一括修正の途中で保存に失敗しても元の本文と索引に戻し、原本も残す', async () => {
    const { a, files } = await windows(); const encode = (value: string) => new TextEncoder().encode(value);
    const first = await a.createNote('A'); const second = await a.createNote('B');
    files.set(first, encode('# A\n\n- item\n2025')); files.set(second, encode('# B\n\n- item\n2024')); await a.refresh();
    const before = new Map([...files].map(([path, bytes]) => [path, bytes.slice()]));
    const write = a.backend.write.bind(a.backend); let failed = false;
    a.backend.write = async (path, bytes) => { if (path === second && !failed) { failed = true; throw new Error('保存失敗'); } await write(path, bytes); };
    await expect(a.migrateMarkdownLayout()).rejects.toThrow('保存失敗');
    expect(files.get(first)).toEqual(before.get(first)); expect(files.get(second)).toEqual(before.get(second));
    expect(parseManifest(files.get('_sync.json')!)).toEqual(parseManifest(before.get('_sync.json')!));
    expect([...files.keys()].filter(path => path.startsWith('.trash/markdown-layout-'))).toHaveLength(2);
  });
});
