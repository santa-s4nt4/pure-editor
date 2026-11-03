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
