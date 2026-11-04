import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { BrowserBackend, StorageManager, SyncConflict, parseManifest, safeRelativePath, sha256, type LocalBackend, type RemoteBackend } from '../src/lib/storage';

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
class MemoryFiles implements LocalBackend {
  files = new Map<string, Uint8Array>();
  async read(path: string) { const bytes = this.files.get(path); return bytes ? new Uint8Array(bytes) : null; }
  async write(path: string, bytes: Uint8Array) { this.files.set(path, new Uint8Array(bytes)); }
  async remove(path: string) { this.files.delete(path); }
  async list() { return [...this.files.keys()].filter(path => !path.startsWith('.') && /\.md$|^assets\/.+\.webp$/.test(path)).map(path => ({ path, updatedAt: Date.now() })); }
}
class MemoryRemote implements RemoteBackend {
  objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  fail = false;
  async get(path: string) { if (this.fail) throw new Error('offline'); return this.objects.get(path) ?? null; }
  async put(path: string, bytes: Uint8Array, condition?: string | null) {
    if (this.fail) throw new Error('offline');
    const etag = `"${await sha256(bytes)}"`;
    const current = this.objects.get(path);
    if ((condition === null && current) || (condition && current?.etag !== condition)) throw new SyncConflict();
    this.objects.set(path, { bytes: new Uint8Array(bytes), etag });
  }
}
async function setup(remote: RemoteBackend | null = null) {
  const backend = new MemoryFiles();
  const manager = new StorageManager(backend, remote);
  await manager.initialize();
  return { backend, manager };
}

describe('ローカル保存と差分同期', () => {
  it('既存ファイルを整形した後は R2 も修正し、書式の変更だけで競合コピーを作らない', async () => {
    const remote = new MemoryRemote(); const a = await setup(remote);
    await a.backend.write('note.md', encode('# note\n\n- item\n2025.1')); await a.manager.refresh(); await a.manager.sync();
    const b = await setup(remote); await b.manager.sync();
    expect(await b.manager.migrateMarkdownLayout()).toBe(1); await b.manager.sync();
    expect(decode((await remote.get('note.md'))!.bytes)).toBe('# note\n\n- item\n\n2025.1');
    await a.manager.sync();
    expect((await a.manager.listNotes()).filter(note => note.path.includes('conflict'))).toHaveLength(0);
    expect(await a.manager.readNote('note.md')).toContain('- item\n\n2025.1');
  });
  it('標準 Markdown を保存し、リンクとタグを復元する', async () => {
    const { backend, manager } = await setup();
    const path = await manager.createNote('日記');
    await manager.saveNote(path, '[Page] [日々]');
    expect(decode((await backend.read(path))!)).toBe('[Page] [日々]');
    expect(await manager.readNote(path)).toBe('[Page] [日々]');
    expect((await manager.listNotes())[0].tags).toEqual(['Page', '日々']);
    expect(parseManifest((await backend.read('_sync.json'))!).files[path].sha256).toBe(await sha256((await backend.read(path))!));
  });
  it('別の端末に文章と画像を Pull する', async () => {
    const remote = new MemoryRemote();
    const a = await setup(remote);
    await a.manager.saveNote('note.md', 'hello #tag');
    const image = await a.manager.saveImage(new Uint8Array([1, 2, 3]));
    await a.manager.sync();
    const b = await setup(remote);
    await b.manager.sync();
    expect(await b.manager.readNote('note.md')).toBe('hello #tag');
    expect(await b.backend.read(image)).toEqual(new Uint8Array([1, 2, 3]));
  });
  it('両端末で編集された文章を競合ファイルに残す', async () => {
    const remote = new MemoryRemote();
    const a = await setup(remote);
    await a.manager.saveNote('note.md', 'base'); await a.manager.sync();
    const b = await setup(remote); await b.manager.sync();
    b.manager.setRemote(null);
    await b.manager.saveNote('note.md', 'B offline');
    await a.manager.saveNote('note.md', 'A online'); await a.manager.sync();
    b.manager.setRemote(remote); await b.manager.sync();
    expect(await b.manager.readNote('note.md')).toBe('A online');
    const conflict = (await b.manager.listNotes()).find(note => note.path.includes('(conflict '));
    expect(conflict).toBeDefined();
    expect(await b.manager.readNote(conflict!.path)).toBe('B offline');
    await a.manager.sync();
    expect((await a.manager.listNotes()).some(note => note.path === conflict!.path)).toBe(true);
  });
  it('ネットワーク障害でもローカルに保存し、復帰後に同期する', async () => {
    const remote = new MemoryRemote(); remote.fail = true;
    const { manager } = await setup(remote);
    await manager.saveNote('offline.md', 'still here'); await manager.sync();
    expect(await manager.readNote('offline.md')).toBe('still here');
    remote.fail = false; await manager.sync();
    expect(decode((await remote.get('offline.md'))!.bytes)).toBe('still here');
  });
  it('外部エディターからの変更を再索引し、再起動後も同期状態を保つ', async () => {
    const remote = new MemoryRemote();
    const { backend, manager } = await setup(remote);
    await manager.saveNote('note.md', 'one'); await manager.sync();
    await backend.write('note.md', encode('external [tag]'));
    await manager.refresh(); await manager.sync();
    const next = new StorageManager(backend, remote); await next.initialize();
    await next.sync();
    expect((await next.listNotes())[0].tags).toEqual(['tag']);
    expect((await next.listNotes()).length).toBe(1);
  });
  it('確定した不変コピーから、途中で上書きされた root ファイルを復元する', async () => {
    const remote = new MemoryRemote();
    const a = await setup(remote);
    await a.manager.saveNote('note.md', 'committed'); await a.manager.sync();
    await remote.put('note.md', encode('uncommitted'));
    const b = await setup(remote); await b.manager.sync();
    expect(await b.manager.readNote('note.md')).toBe('committed');
    expect(decode((await remote.get('note.md'))!.bytes)).toBe('committed');
  });
  it('入力中に Pull された文章も、保存時に競合ファイルへ残す', async () => {
    const { manager } = await setup();
    await manager.saveNote('note.md', 'remote change');
    await manager.saveNote('note.md', 'typing draft', 'old loaded text');
    expect(await manager.readNote('note.md')).toBe('typing draft');
    const conflict = (await manager.listNotes()).find(note => note.path.includes('(conflict '));
    expect(await manager.readNote(conflict!.path)).toBe('remote change');
  });
  it('2端末から同時に作成・同期しても両方の文章を残す', async () => {
    const remote = new MemoryRemote();
    const a = await setup(); const b = await setup();
    await a.manager.saveNote('same.md', 'device A');
    await b.manager.saveNote('same.md', 'device B');
    a.manager.setRemote(remote); b.manager.setRemote(remote);
    await Promise.all([a.manager.sync(), b.manager.sync()]);
    await a.manager.sync(); await b.manager.sync();
    const contents = await Promise.all((await a.manager.listNotes()).map(note => a.manager.readNote(note.path)));
    expect(contents).toContain('device A');
    expect(contents).toContain('device B');
  });
  it('同名の新規ノートを作っても既存の文章を上書きしない', async () => {
    const { manager } = await setup();
    await manager.saveNote('note.md', 'keep'); await manager.createNote('note');
    expect(await manager.readNote('note.md')).toBe('keep');
  });
  it('角括弧のタグをそのまま保存し、追記しても競合ファイルを作らない', async () => {
    const { backend, manager } = await setup();
    await manager.saveNote('untitled.md', '# 記事の題名\n本文');
    await manager.saveNote('source.md', '[記事の題名]');
    expect(decode((await backend.read('source.md'))!)).toBe('[記事の題名]');
    expect(await manager.readNote('source.md')).toBe('[記事の題名]');
    await manager.saveNote('source.md', '[記事の題名]\n追記', '[記事の題名]');
    expect((await manager.listNotes()).some(note => note.path.includes('(conflict '))).toBe(false);
  });
  it('記事を削除して再起動しても復活せず、元に戻すことができる', async () => {
    const { backend, manager } = await setup();
    await manager.saveNote('note.md', '# 題名\n本文');
    const backup = await manager.deleteNote('note.md');
    const next = new StorageManager(backend); await next.initialize();
    expect(await next.listNotes()).toHaveLength(0);
    expect(await next.readNote('note.md')).toBeNull();
    await next.restoreNote('note.md', backup);
    expect((await next.listNotes())[0].title).toBe('題名');
  });
  it('削除を別端末に伝え、オフラインの編集は競合ファイルに残す', async () => {
    const remote = new MemoryRemote();
    const a = await setup(remote); await a.manager.saveNote('note.md', 'base'); await a.manager.sync();
    const b = await setup(remote); await b.manager.sync(); b.manager.setRemote(null);
    await b.manager.saveNote('note.md', 'offline draft');
    await a.manager.deleteNote('note.md'); await a.manager.sync();
    b.manager.setRemote(remote); await b.manager.sync();
    expect(await b.manager.readNote('note.md')).toBeNull();
    const conflict = (await b.manager.listNotes()).find(note => note.path.includes('(conflict '));
    expect(await b.manager.readNote(conflict!.path)).toBe('offline draft');
  });
  it('IndexedDB の文章とバイナリが別インスタンスからも読める', async () => {
    const a = new BrowserBackend();
    await a.write('persistent.md', encode('persistent'));
    const b = new BrowserBackend();
    expect(decode((await b.read('persistent.md'))!)).toBe('persistent');
    expect((await b.list()).some(file => file.path === 'persistent.md')).toBe(true);
  });
  it('パストラバーサルと不正なマニフェストを拒否する', () => {
    expect(() => safeRelativePath('../secret')).toThrow();
    expect(() => parseManifest(encode('{"version":1,"files":{"../x.md":{"updatedAt":1,"sha256":"bad"}}}'))).toThrow();
    expect(() => parseManifest(encode('{"version":2,"files":{}}'))).toThrow();
  });
});

it('同じ題名で作成しても別ファイルになり、保存時のタイトル変更でIDは維持する', async () => {
  const { manager, backend } = await setup();
  const a = await manager.createNote('無題'); const b = await manager.createNote('無題');
  expect(a).not.toBe(b);
  const renamed = await manager.saveNamedNote(a, '# 朝の記録\n本文');
  expect(renamed).toMatch(/^朝の記録--[a-f0-9]{32}\.md$/);
  expect(renamed.slice(-35)).toBe(a.slice(-35));
  expect(await backend.read(a)).toBeNull();
  expect(await manager.readNote(a)).toBe('# 朝の記録\n本文');
  const back = await manager.saveNamedNote(renamed, '# 無題\n続き', '# 朝の記録\n本文');
  expect(back).toBe(a);
  expect(await manager.readNote(renamed)).toBe('# 無題\n続き');
  expect((await manager.listNotes()).length).toBe(2);
});
it('既存記事はバックアップと更新日を保って移行し、リンク・画像・同期先も移す', async () => {
  const remote = new MemoryRemote();
  const { manager, backend } = await setup();
  await manager.saveNote('old.md', '# 記事\n![](assets/photo.webp)');
  await manager.saveNote('source.md', '# 参照元\n[記事](old.md)');
  const before = (await manager.listNotes()).find(note => note.path === 'old.md')!.updatedAt;
  await manager.migrateNoteNames();
  const notes = await manager.listNotes();
  const target = notes.find(note => note.title === '記事')!;
  expect(target.path).toMatch(/^記事--[a-f0-9]{32}\.md$/);
  expect(target.updatedAt).toBe(before);
  expect(await backend.read('old.md')).toBeNull();
  expect([...backend.files.keys()].some(path => path.startsWith('.trash/renamed-') && path.endsWith('/old.md'))).toBe(true);
  const source = notes.find(note => note.title === '参照元')!;
  expect(decode((await backend.read(source.path))!)).toContain(encodeURIComponent(target.path));
  expect(await manager.readNote('old.md')).toContain('![](assets/photo.webp)');
  await manager.migrateNoteNames(); expect(await manager.listNotes()).toEqual(notes);
  manager.setRemote(remote); await manager.sync();
  const other = await setup(remote); await other.manager.sync();
  expect((await other.manager.listNotes()).map(note => note.path).sort()).toEqual(notes.map(note => note.path).sort());
  const restarted = new StorageManager(backend); await restarted.initialize();
  expect(await restarted.readNote('old.md')).toContain('# 記事');
});
it('両端末の同じ旧パスは同じ移行先を使い、異なる移行先があると上書きしない', async () => {
  const a = await setup(); const b = await setup();
  await a.manager.saveNote('old.md', '# 題名'); await b.manager.saveNote('old.md', '# 題名');
  await a.manager.migrateNoteNames(); await b.manager.migrateNoteNames();
  expect((await a.manager.listNotes())[0].path).toBe((await b.manager.listNotes())[0].path);
  const c = await setup();
  await c.manager.saveNote('old.md', '# 題名');
  const target = (await a.manager.listNotes())[0].path;
  await c.manager.saveNote(target, '既存の別の文章');
  await expect(c.manager.migrateNoteNames()).rejects.toThrow('移行先');
  expect(await c.manager.readNote('old.md')).toBe('# 題名');
  expect(await c.manager.readNote(target)).toBe('既存の別の文章');
});
it('移行途中の書き込み失敗では原本を残し、次回の移行で完了できる', async () => {
  const { manager, backend } = await setup();
  await manager.saveNote('old.md', '# 題名');
  const write = backend.write.bind(backend); let fail = true;
  backend.write = async (path, bytes) => { if (fail && path === '_note-renames.json') { fail = false; throw new Error('disk full'); } await write(path, bytes); };
  await expect(manager.migrateNoteNames()).rejects.toThrow('disk full');
  expect(await backend.read('old.md')).not.toBeNull();
  await manager.migrateNoteNames();
  expect(await manager.listNotes()).toHaveLength(1);
  expect(await manager.readNote('old.md')).toBe('# 題名');
});
it('大文字小文字だけの変更でAPFS上の同じファイルを削除しない', async () => {
  const { manager, backend } = await setup();
  const path = await manager.createNote('Title');
  await manager.saveNote(path, '# Title');
  expect(await manager.saveNamedNote(path, '# title', '# Title')).toBe(path);
  expect(await backend.read(path)).not.toBeNull();
  expect(await manager.readNote(path)).toBe('# title');
});
it('Paperは自動改名やR2へ送らず、同じ.paperの名前のまま読み書きする', async () => {
  const { manager, backend } = await setup();
  const { PaperNotebook } = await import('../src/lib/paper-notebook');
  const notebook = new PaperNotebook(backend, null);
  manager.setPaperNotebook(notebook);
  const path = await notebook.attach({ file: { id: 'id:work-doc', name: '決まった名前.paper' }, revision: 3, markdown: '# 題名' });
  expect(await manager.saveNamedNote(path, '# 新しい題名', '# 題名')).toBe(path);
  await manager.migrateNoteNames();
  expect((await manager.listNotes())[0].path).toBe(path);
  expect(await manager.readNote(path)).toBe('# 新しい題名');
  await expect(manager.deleteNote(path)).rejects.toThrow('Dropbox 側');
  const remote = new MemoryRemote(); manager.setRemote(remote); await manager.sync();
  expect([...remote.objects.keys()].some(key => key.includes('.paper') || key.includes('新しい題名'))).toBe(false);
});

describe('記事の公開設定', () => {
  const publication = { repository: 'santa-s4nt4/pure-notes', branch: 'main', visibility: 'public' as const, revision: '11111111-1111-4111-8111-111111111111', parent: null };
  it('既存記事は非公開で、公開設定は本文に表示せず保存・名前変更・R2 同期する', async () => {
    const remote = new MemoryRemote(); const a = await setup(remote);
    const path = await a.manager.createNote('公開テスト'); await a.manager.saveNote(path, '# 公開テスト\n\n[tag]');
    expect((await a.manager.listNotes())[0].publication).toBeUndefined();
    await a.manager.setPublication(path, publication);
    expect(await a.manager.readNote(path)).toBe('# 公開テスト\n\n[tag]');
    const renamed = await a.manager.saveNamedNote(path, '# 新しい名前\n\n[tag]');
    await a.manager.sync(); const b = await setup(remote); await b.manager.sync();
    const note = (await b.manager.listNotes()).find(note => note.path === renamed)!;
    expect(note.publication).toEqual(publication); expect(note.tags).toEqual(['tag']);
    expect(await b.manager.readNote(renamed)).toBe('# 新しい名前\n\n[tag]');
  });
  it('古い編集内容の保存でも最新の非公開設定を維持し、競合コピーを公開しない', async () => {
    const a = await setup(); const path = await a.manager.createNote('test');
    await a.manager.saveNote(path, 'original'); await a.manager.setPublication(path, publication);
    await a.manager.setPublication(path, { ...publication, visibility: 'private', revision: '22222222-2222-4222-8222-222222222222', parent: publication.revision });
    await a.manager.saveNote(path, 'other'); await a.manager.saveNote(path, 'edit', 'original');
    const notes = await a.manager.listNotes();
    expect(notes.find(note => note.path === path)?.publication?.visibility).toBe('private');
    expect(notes.find(note => note.path !== path)?.publication).toBeUndefined();
  });
  it('公開記事を削除して復元しても、自動で公開に戻らない', async () => {
    const a = await setup(); const path = await a.manager.createNote('test'); await a.manager.saveNote(path, 'text');
    await a.manager.setPublication(path, publication);
    const backup = await a.manager.deleteNote(path); await a.manager.restoreNote(path, backup);
    expect((await a.manager.listNotes())[0].publication?.visibility).toBe('private');
    expect(await a.manager.readNote(path)).toBe('text');
  });
});
