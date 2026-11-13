import { describe, expect, it, vi } from 'vitest';
import { ArticlePublisher, GitHubChanged, GitHubRepository, emptyPublicIndex, parsePublicIndex, validatePublishingTarget } from '../src/lib/github-publisher';
import { StorageManager, SyncConflict, sha256, type LocalBackend, type RemoteBackend } from '../src/lib/storage';
import { noteId } from '../src/lib/note-filenames';
import { publicationDocument } from '../src/lib/publication';
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
class Files implements LocalBackend {
  files = new Map<string, Uint8Array>();
  async read(path: string) { return this.files.get(path) ?? null; }
  async write(path: string, bytes: Uint8Array) { this.files.set(path, bytes); }
  async remove(path: string) { this.files.delete(path); }
  async list() { return [...this.files.keys()].filter(path => !path.startsWith('.') && /\.md$|^assets\//.test(path)).map(path => ({ path, updatedAt: Date.now() })); }
}
class SyncRemote implements RemoteBackend {
  objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  async get(path: string) { return this.objects.get(path) ?? null; }
  async put(path: string, bytes: Uint8Array, condition?: string | null) {
    const current = this.objects.get(path);
    if (condition === null && current || condition && current?.etag !== condition) throw new SyncConflict();
    this.objects.set(path, { bytes: bytes.slice(), etag: await sha256(bytes) });
  }
}
class Repository extends GitHubRepository {
  index = emptyPublicIndex(); files = new Map<string, Uint8Array>(); commits: string[][] = []; beforeCommit: (() => Promise<void>) | undefined;
  constructor() { super('santa-s4nt4/pure-notes', 'main', 'test'); }
  async snapshot() { return { head: String(this.commits.length), tree: 'tree', files: new Map([...this.files.keys()].map(path => [path, 'blob'])), index: structuredClone(this.index) }; }
  async commit(snapshot: Awaited<ReturnType<GitHubRepository['snapshot']>>, changes: Parameters<GitHubRepository['commit']>[1], _message: string, stillCurrent: () => Promise<boolean>) {
    await this.beforeCommit?.(); this.beforeCommit = undefined;
    if (!await stillCurrent() || snapshot.head !== String(this.commits.length)) throw new GitHubChanged();
    for (const { path, bytes } of changes) if (bytes) this.files.set(path, bytes); else this.files.delete(path);
    this.index = parsePublicIndex(decode(this.files.get('index.json')!)); this.commits.push(changes.map(change => change.path));
  }
}
async function setup() {
  const storage = new StorageManager(new Files()); await storage.initialize();
  const remote = new Repository(); const publisher = new ArticlePublisher(remote);
  const path = await storage.createNote('公開する記事'); await storage.saveNote(path, '# 公開する記事\n\n[tag] [https://example.com 名前]');
  const visibility = async (value: 'public' | 'private') => { await storage.setPublication(path, await publisher.intent(storage, path, value)); await publisher.sync(storage); };
  return { storage, remote, publisher, path, visibility };
}

describe('GitHub 記事公開', () => {
  it('古い保存形式の記事でも、公開 Markdown では日付を前のリストに混ぜない', async () => {
    const { storage, remote, path, visibility } = await setup();
    await storage.backend.write(path, encode('# 公開する記事\n\n- parent\n  - child\n2025.1\n- next'));
    await storage.refresh(); await visibility('public');
    expect(decode(remote.files.get(remote.index.articles[0].markdownPath)!)).toContain('  - child\n\n2025.1');
  });
  it('初期状態は何も送らず、選択した記事と実際に参照する画像だけを同じコミットへ保存する', async () => {
    const { storage, remote, publisher, path, visibility } = await setup();
    const secret = await storage.createNote('秘密の記事'); await storage.saveNote(secret, '# 秘密の記事\n\n秘密の本文');
    const used = await storage.saveImage(new Uint8Array([1, 2, 3])); await storage.saveImage(new Uint8Array([4, 5, 6]));
    await storage.saveNote(path, `# 公開する記事\n\n[tag]\n![写真](${used})\n\n\`![コード](assets/absent.webp)\``);
    await publisher.sync(storage); expect(remote.commits).toHaveLength(0);
    await visibility('public');
    expect(remote.index.articles).toHaveLength(1); const post = remote.index.articles[0];
    expect(post.tags).toEqual(['tag']); expect(post.assets).toHaveLength(1);
    expect([...remote.files.keys()].sort()).toEqual(['index.json', post.markdownPath, ...post.assets].sort());
    const body = decode(remote.files.get(post.markdownPath)!);
    expect(body).toContain(`../${post.assets[0]}`); expect(body).not.toContain('pure:publication');
    expect([...remote.files.values()].map(decode).join()).not.toContain('秘密の記事');
    expect(remote.commits[0]).toContain('index.json'); expect(remote.commits[0]).toContain(post.markdownPath);
  });
  it('以前保存した表示名が先のリンクも、公開 Markdown では通常のリンクに変換する', async () => {
    const { storage, remote, path, visibility } = await setup();
    await storage.backend.write(path, encode('# 公開する記事\n\n[後ろにURL https://example.com/after] [https://example.com/before 先にURL] [tag]'));
    await storage.refresh(); await visibility('public');
    const post = remote.index.articles[0]; const body = decode(remote.files.get(post.markdownPath)!);
    expect(body).toContain('[後ろにURL](https://example.com/after)'); expect(body).toContain('[先にURL](https://example.com/before)');
    expect(post.tags).toEqual(['tag']);
  });
  it('公開記事の編集と改名を反映し、同じ内容の再同期ではコミットを作らない', async () => {
    const { storage, remote, publisher, path, visibility } = await setup(); await visibility('public');
    await publisher.sync(storage); expect(remote.commits).toHaveLength(1);
    const old = remote.index.articles[0].markdownPath;
    const renamed = await storage.saveNamedNote(path, '# 変更したタイトル\n\n本文'); await publisher.sync(storage);
    expect(remote.index.articles[0].id).toBe(noteId(path)); expect(remote.index.articles[0].title).toBe('変更したタイトル');
    expect(remote.index.articles[0].markdownPath).toContain(renamed); expect(remote.files.has(old)).toBe(false);
  });
  it('公開内容が同じなら、公開側の日時が新しくてもエラーや追加コミットにしない', async () => {
    const { storage, remote, publisher, visibility } = await setup(); await visibility('public');
    remote.index.articles[0].updatedAt += 60_000;
    await publisher.sync(storage); expect(remote.commits).toHaveLength(1);
  });
  it('本文が異なる古い記事では、新しい公開版の上書きを防ぐ', async () => {
    const { storage, remote, publisher, path, visibility } = await setup(); await visibility('public');
    remote.index.articles[0].updatedAt += 60_000;
    await storage.saveNote(path, '# 古い端末の本文');
    await expect(publisher.sync(storage)).rejects.toThrow('新しい公開版'); expect(remote.commits).toHaveLength(1);
  });
  it('公開先を更新する前にR2の新しい本文を取り込む', async () => {
    const { storage, remote, publisher, path, visibility } = await setup(); await visibility('public');
    const r2 = new SyncRemote(); storage.setRemote(r2); await storage.sync();
    const other = new StorageManager(new Files(), r2); await other.initialize(); await other.sync(); other.setRemote(null);
    await other.saveNote(path, '# 別端末の新しい本文'); other.setRemote(r2); await other.sync();
    await publisher.sync(other); const count = remote.commits.length;
    await publisher.sync(storage);
    expect(await storage.readNote(path)).toBe('# 別端末の新しい本文'); expect(remote.commits).toHaveLength(count);
  });
  it('R2の同期に失敗したら公開を待ち、接続復帰後に再試行する', async () => {
    const { storage, remote, publisher, path } = await setup();
    await storage.setPublication(path, await publisher.intent(storage, path, 'public'));
    const r2 = new SyncRemote(); const get = r2.get.bind(r2);
    r2.get = async () => { throw new Error('offline'); }; storage.setRemote(r2);
    await expect(publisher.sync(storage)).rejects.toThrow('端末間の同期'); expect(remote.commits).toHaveLength(0);
    r2.get = get; await publisher.sync(storage); expect(remote.commits).toHaveLength(1);
  });
  it('R2から別端末の取り下げを先に取り込み、古い公開希望でエラーや再公開にしない', async () => {
    const { storage, remote, publisher, path, visibility } = await setup(); await visibility('public');
    const r2 = new SyncRemote(); storage.setRemote(r2); await storage.sync();
    const other = new StorageManager(new Files(), r2); await other.initialize(); await other.sync();
    await other.setPublication(path, await publisher.intent(other, path, 'private')); await publisher.sync(other);
    await publisher.sync(storage);
    expect((await storage.listNotes())[0].publication?.visibility).toBe('private');
    expect(remote.index.articles).toHaveLength(0); expect(remote.commits).toHaveLength(2);
  });
  it('タイトル中の連続したピリオドも通常のファイル名として公開・取り下げできる', async () => {
    const { storage, remote, publisher, path } = await setup();
    const renamed = await storage.saveNamedNote(path, '# foo..bar');
    await storage.setPublication(renamed, await publisher.intent(storage, renamed, 'public')); await publisher.sync(storage);
    expect(remote.index.articles[0].markdownPath).toContain('foo..bar');
    expect(() => parsePublicIndex(JSON.stringify(remote.index))).not.toThrow();
    await storage.setPublication(renamed, await publisher.intent(storage, renamed, 'private')); await publisher.sync(storage);
    expect(remote.index.articles).toHaveLength(0);
  });
  it('取り下げた記事の本文・タイトルと未使用画像を現在の公開データから消す', async () => {
    const { storage, remote, path, visibility } = await setup(); const image = await storage.saveImage(new Uint8Array([1]));
    await storage.saveNote(path, `# 公開する記事\n![image](${image})`); await visibility('public'); await visibility('private');
    expect([...remote.files.keys()]).toEqual(['index.json']);
    expect(remote.index.articles).toEqual([]); expect(remote.index.states[noteId(path)!].visibility).toBe('private');
    expect(decode(remote.files.get('index.json')!)).not.toContain('公開する記事'); expect(await storage.readNote(path)).toContain('公開する記事');
  });
  it('別の公開記事も参照する画像は取り下げで消さない', async () => {
    const { storage, remote, publisher, path, visibility } = await setup(); const image = await storage.saveImage(new Uint8Array([1]));
    const second = await storage.createNote('second');
    for (const target of [path, second]) {
      await storage.saveNote(target, `# shared\n![image](${image})`);
      await storage.setPublication(target, await publisher.intent(storage, target, 'public')); await publisher.sync(storage);
    }
    const asset = remote.index.articles[0].assets[0]; await visibility('private');
    expect(remote.files.has(asset)).toBe(true); expect(remote.index.articles).toHaveLength(1);
  });
  it('別端末が取り下げた記事を古い公開設定で再公開しない', async () => {
    const { storage, remote, publisher, path, visibility } = await setup(); await visibility('public');
    const stale = (await storage.listNotes())[0].publication!; await visibility('private');
    await storage.setPublication(path, stale); await storage.saveNote(path, '# 古い端末で編集');
    await expect(publisher.sync(storage)).rejects.toThrow('別の端末');
    expect(remote.index.articles).toHaveLength(0); expect(remote.commits).toHaveLength(2);
    // A deliberate new publication creates a child of the current remote state.
    await visibility('private'); await visibility('public'); expect(remote.index.articles).toHaveLength(1);
  });
  it('アップロード中に非公開へ変更されたら公開コミットを中止する', async () => {
    const { storage, remote, publisher, path } = await setup(); const intent = await publisher.intent(storage, path, 'public'); await storage.setPublication(path, intent);
    remote.beforeCommit = () => storage.setPublication(path, { ...intent, visibility: 'private', parent: intent.revision, revision: crypto.randomUUID() });
    await expect(publisher.sync(storage)).rejects.toThrow('GitHub が更新'); expect(remote.commits).toHaveLength(0);
  });
  it('必要な画像がない場合には記事の一部分も公開しない', async () => {
    const { storage, remote, publisher, path } = await setup(); await storage.saveNote(path, '# title\n![image](assets/missing.webp)');
    await storage.setPublication(path, await publisher.intent(storage, path, 'public'));
    await expect(publisher.sync(storage)).rejects.toThrow('画像が見つかりません'); expect(remote.commits).toHaveLength(0);
  });
  it('ネットワーク失敗でも本文と公開希望はローカルに残り、再接続後に送れる', async () => {
    const { storage, remote, publisher, path } = await setup(); await storage.setPublication(path, await publisher.intent(storage, path, 'public'));
    const original = remote.snapshot.bind(remote); remote.snapshot = async () => { throw new Error('offline'); };
    await expect(publisher.sync(storage)).rejects.toThrow('offline');
    expect(publicationDocument(decode((await storage.backend.read(path))!)).publication?.visibility).toBe('public');
    expect(await storage.readNote(path)).toContain('公開する記事'); remote.snapshot = original;
    await publisher.sync(storage); expect(remote.index.articles).toHaveLength(1);
  });
  it('リポジトリから指定外のパスを削除させない', () => {
    expect(() => validatePublishingTarget('https://github.com/a/b', 'main')).toThrow();
    expect(() => validatePublishingTarget('a/b', '../main')).toThrow();
    const index = emptyPublicIndex(); index.states['a'.repeat(32)] = { revision: crypto.randomUUID(), visibility: 'public' };
    index.articles.push({ id: 'a'.repeat(32), title: 'x', tags: [], excerpt: '', updatedAt: 1, markdownPath: '../README.md', assets: [], contentHash: 'b'.repeat(64), revision: index.states['a'.repeat(32)].revision });
    expect(() => parsePublicIndex(JSON.stringify(index))).toThrow();
  });
  it('Git Database API を使い、force:false で本文と一覧を一括コミットする', async () => {
    const calls: { path: string; method: string; body: any }[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/a/b/') return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      const path = url === 'https://api.github.com/repos/a/b' ? '' : url.replace('https://api.github.com/repos/a/b/', ''); const method = init?.method || 'GET'; const body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ path, method, body });
      expect((init?.headers as any).Authorization).toBe('Bearer fake-token');
      const data = path === '' ? { private: false } : path.startsWith('git/ref/') ? { object: { sha: 'old' } } : path === 'git/commits/old' ? { tree: { sha: 'base' } } : path.startsWith('git/trees/base') ? { tree: [], truncated: false } : { sha: method === 'PATCH' ? 'done' : path };
      return new Response(JSON.stringify(data));
    });
    const remote = new GitHubRepository('a/b', 'main', 'fake-token', fetcher as typeof fetch);
    const snapshot = await remote.snapshot(); await remote.commit(snapshot, [{ path: 'posts/test.md', bytes: encode('# test') }, { path: 'index.json', bytes: encode('{}') }], 'publish', async () => true);
    expect(fetcher.mock.calls[0][0]).toBe('https://api.github.com/repos/a/b');
    expect(calls.filter(call => call.path === 'git/blobs')).toHaveLength(2);
    const tree = calls.find(call => call.path === 'git/trees')!.body; expect(tree.base_tree).toBe('base'); expect(tree.tree.map((entry: any) => entry.path)).toEqual(['posts/test.md', 'index.json']);
    expect(calls.at(-1)).toMatchObject({ path: 'git/refs/heads/main', method: 'PATCH', body: { force: false } });
  });
});
