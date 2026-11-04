import { invoke } from '@tauri-apps/api/core';
import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
import { mapImagePaths, fromMarkdown, extractTags, noteTitle } from './transformer';
import { noteId } from './note-filenames';
import { native, sha256, type StorageManager, type Note } from './storage';
import { publicationDocument, validRevision, type Publication } from './publication';

export interface PublishedArticle {
  id: string; title: string; tags: string[]; excerpt: string; updatedAt: number;
  markdownPath: string; assets: string[]; contentHash: string; revision: string;
}
export interface PublicIndex {
  version: 1;
  articles: PublishedArticle[];
  /** Only previously public IDs occur here. Withdrawals retain no title or body. */
  states: Record<string, { revision: string; visibility: 'public' | 'private' }>;
}
export const emptyPublicIndex = (): PublicIndex => ({ version: 1, articles: [], states: {} });
const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
export const targetKey = (repository: string, branch: string) => `${repository.toLowerCase()}@${branch}`;
export function validatePublishingTarget(repository: string, branch: string) {
  if (!/^[a-z\d](?:[a-z\d-]*[a-z\d])?\/[\w.-]+$/i.test(repository) || /\/(?:\.|\.\.)$/.test(repository) || !branch || /[\s~^:?*\[\\\u0000-\u001f]/.test(branch) || branch.includes('..') || branch.includes('@{') || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.lock')) throw new Error('GitHub の owner/repository と有効なブランチ名を入力してください。');
}
export function parsePublicIndex(text: string): PublicIndex {
  const index = JSON.parse(text) as PublicIndex;
  if (index.version !== 1 || !Array.isArray(index.articles) || !index.states || typeof index.states !== 'object' || Array.isArray(index.states)) throw new Error('公開リポジトリの index.json の形式が不正です。');
  const ids = new Set<string>();
  for (const [id, state] of Object.entries(index.states)) {
    if (!/^[a-f0-9]{32}$/.test(id) || !validRevision(state?.revision) || !['public', 'private'].includes(state?.visibility)) throw new Error('公開設定の履歴が不正です。');
  }
  for (const post of index.articles) {
    if (!/^[a-f0-9]{32}$/.test(post.id) || ids.has(post.id) || typeof post.title !== 'string' || !Array.isArray(post.tags) || post.tags.some(tag => typeof tag !== 'string') || typeof post.excerpt !== 'string' || !Number.isFinite(post.updatedAt) || !/^posts\/[^/\\]+\.md$/.test(post.markdownPath) || !Array.isArray(post.assets) || post.assets.some(path => !/^assets\/[a-f0-9]{64}\.webp$/.test(path)) || !/^[a-f0-9]{64}$/.test(post.contentHash) || index.states[post.id]?.revision !== post.revision || index.states[post.id]?.visibility !== 'public') throw new Error('公開記事の一覧が不正です。');
    ids.add(post.id);
  }
  return index;
}
export async function loadGithubToken() { return native ? invoke<string>('read_github_token') : ''; }
export async function saveGithubToken(value: string) {
  if (!native && value) throw new Error('GitHub 公開は Mac・iPhone アプリで利用できます。');
  if (native) await invoke('write_github_token', { value });
}
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(binary);
}
function unbase64(text: string): Uint8Array { return Uint8Array.from(atob(text.replace(/\s/g, '')), value => value.charCodeAt(0)); }
export class GitHubChanged extends Error { constructor() { super('GitHub が更新されました。もう一度公開同期してください。'); } }
type Fetch = typeof globalThis.fetch;
type Snapshot = { head: string; tree: string; files: Map<string, string>; index: PublicIndex };
type Change = { path: string; bytes: Uint8Array | null };

/** One ordinary fast-forward commit makes body, images and the feed visible together. */
export class GitHubRepository {
  constructor(readonly repository: string, readonly branch: string, private token: string, private fetcher: Fetch = nativeFetch as Fetch) { validatePublishingTarget(repository, branch); }
  private async request(path: string, method = 'GET', body?: unknown): Promise<any> {
    const response = await this.fetcher(`https://api.github.com/repos/${this.repository}${path ? `/${path}` : ''}`, {
      method, headers: { 'User-Agent': 'pure-editor', Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45_000),
    });
    if (response.status === 409 || response.status === 422 && method === 'PATCH') throw new GitHubChanged();
    if (!response.ok) throw new Error(`GitHub 公開に失敗しました（${response.status}）。リポジトリ・トークンの有効期限・Contents の書き込み権限を確認してください。`);
    return response.json();
  }
  async snapshot(): Promise<Snapshot> {
    const info = await this.request('');
    if (info.private !== false) throw new Error('公開記事専用の公開リポジトリを指定してください。');
    const ref = await this.request(`git/ref/heads/${this.branch.split('/').map(encodeURIComponent).join('/')}`);
    const commit = await this.request(`git/commits/${ref.object.sha}`);
    const tree = await this.request(`git/trees/${commit.tree.sha}?recursive=1`);
    if (tree.truncated) throw new Error('公開リポジトリのファイル数が多すぎます。記事専用リポジトリを使ってください。');
    const files = new Map<string, string>(tree.tree.filter((item: any) => item.type === 'blob').map((item: any) => [item.path, item.sha]));
    let index = emptyPublicIndex();
    if (files.has('index.json')) {
      const blob = await this.request(`git/blobs/${files.get('index.json')}`);
      if (blob.encoding !== 'base64') throw new Error('公開一覧を読み取れませんでした。');
      index = parsePublicIndex(decode(unbase64(blob.content)));
    } else if ([...files.keys()].some(path => path.startsWith('posts/') || path.startsWith('assets/'))) throw new Error('index.json がないため、既存の記事を上書きしませんでした。');
    return { head: ref.object.sha, tree: commit.tree.sha, files, index };
  }
  async commit(snapshot: Snapshot, changes: Change[], message: string, stillCurrent: () => Promise<boolean>) {
    if (!await stillCurrent()) throw new GitHubChanged();
    const tree: { path: string; mode: string; type: string; sha: string | null }[] = [];
    for (const change of changes) {
      if (!change.bytes && !snapshot.files.has(change.path)) continue;
      const blob = change.bytes ? await this.request('git/blobs', 'POST', { content: base64(change.bytes), encoding: 'base64' }) : null;
      tree.push({ path: change.path, mode: '100644', type: 'blob', sha: blob?.sha ?? null });
    }
    const created = await this.request('git/trees', 'POST', { base_tree: snapshot.tree, tree });
    const commit = await this.request('git/commits', 'POST', { message, tree: created.sha, parents: [snapshot.head] });
    if (!await stillCurrent()) throw new GitHubChanged();
    await this.request(`git/refs/heads/${this.branch.split('/').map(encodeURIComponent).join('/')}`, 'PATCH', { sha: commit.sha, force: false });
  }
}

export class ArticlePublisher {
  private running: Promise<void> = Promise.resolve();
  private active: Promise<void> | null = null;
  private again = false;
  constructor(readonly remote: GitHubRepository) {}
  wait() { return this.running; }
  async intent(storage: StorageManager, path: string, visibility: 'public' | 'private'): Promise<Publication> {
    const id = noteId(path);
    if (!id) throw new Error('Markdown の記事を選択してください。');
    await this.wait().catch(() => undefined);
    const snapshot = await this.remote.snapshot();
    return { repository: this.remote.repository.toLowerCase(), branch: this.remote.branch, visibility, revision: crypto.randomUUID(), parent: snapshot.index.states[id]?.revision ?? null };
  }
  sync(storage: StorageManager): Promise<void> {
    if (this.active) { this.again = true; return this.active; }
    const next = this.running.catch(() => undefined).then(async () => {
      do {
        this.again = false;
        const errors: string[] = [];
        const notes = (await storage.listNotes()).filter(note => note.publication && targetKey(note.publication.repository, note.publication.branch) === targetKey(this.remote.repository, this.remote.branch));
        if (!notes.length) return;
        let snapshot = await this.remote.snapshot();
        for (const note of notes) {
          const publication = note.publication;
          if (!publication || targetKey(publication.repository, publication.branch) !== targetKey(this.remote.repository, this.remote.branch)) continue;
          try { if (await this.publish(storage, note, publication, snapshot)) snapshot = await this.remote.snapshot(); }
          catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
        }
        if (errors.length) throw new Error([...new Set(errors)].join(' '));
      } while (this.again);
    }).finally(() => { this.active = null; });
    this.running = next; this.active = next; return next;
  }
  private async publish(storage: StorageManager, note: Note, publication: Publication, snapshot: Snapshot) {
    const id = noteId(note.path);
    if (!id) return;
    const original = await storage.backend.read(note.path);
    if (!original) return;
    const document = publicationDocument(decode(original));
    if (document.publication?.revision !== publication.revision) return;
    const state = snapshot.index.states[id];
    const prior = snapshot.index.articles.find(post => post.id === id);
    if (state && state.revision !== publication.revision && state.revision !== publication.parent || !state && publication.parent !== null) {
      // A stale device must never undo an explicit withdrawal (or a later re-publication).
      throw new Error(`「${note.title}」の公開設定は別の端末で変更されています。R2 を同期するか、非公開に戻してから公開し直してください。`);
    }
    const index = structuredClone(snapshot.index);
    const changes: Change[] = [];
    const assets = new Map<string, Uint8Array>();
    if (publication.visibility === 'public') {
      if (prior && prior.revision === publication.revision && prior.updatedAt > note.updatedAt) throw new Error(`「${note.title}」には新しい公開版があります。端末間の同期を確認してください。`);
      const paths = new Set<string>();
      mapImagePaths(document.body, path => { if (!/^https?:\/\//i.test(path)) paths.add(path); return path; });
      const mapped = new Map<string, string>();
      for (const path of paths) {
        let decoded: string; try { decoded = decodeURIComponent(path); } catch { throw new Error('画像パスを読み取れません。'); }
        if (!/^assets\/[^/\\]+\.webp$/i.test(decoded)) throw new Error('公開できないローカル画像があります。pure に貼り付け直してください。');
        const bytes = await storage.backend.read(decoded);
        if (!bytes) throw new Error(`公開する画像が見つかりません: ${decoded}`);
        const target = `assets/${await sha256(bytes)}.webp`;
        assets.set(target, bytes); mapped.set(path, `../${target}`);
      }
      const body = mapImagePaths(document.body, path => mapped.get(path) ?? path);
      const markdownPath = `posts/${note.path.split('/').at(-1)!}`;
      const editorBody = fromMarkdown(document.body);
      const post: PublishedArticle = { id, title: noteTitle(editorBody, note.title), tags: extractTags(editorBody), excerpt: fromMarkdown(document.body).replace(/^#+\s+/gm, '').replace(/\n/g, ' ').slice(0, 160), updatedAt: note.updatedAt, markdownPath, assets: [...assets.keys()].sort(), contentHash: await sha256(encode(body)), revision: publication.revision };
      if (prior && JSON.stringify(prior) === JSON.stringify(post)) return;
      index.articles = [...index.articles.filter(item => item.id !== id), post].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      changes.push({ path: markdownPath, bytes: encode(body) });
      for (const [path, bytes] of assets) if (!snapshot.files.has(path)) changes.push({ path, bytes });
      if (prior && prior.markdownPath !== markdownPath) changes.push({ path: prior.markdownPath, bytes: null });
    } else {
      if (state?.revision === publication.revision && state.visibility === 'private') return;
      index.articles = index.articles.filter(post => post.id !== id);
      if (prior) changes.push({ path: prior.markdownPath, bytes: null });
    }
    const used = new Set(index.articles.flatMap(post => post.assets));
    for (const path of prior?.assets ?? []) if (!used.has(path)) changes.push({ path, bytes: null });
    index.states[id] = { revision: publication.revision, visibility: publication.visibility };
    changes.push({ path: 'index.json', bytes: encode(JSON.stringify(index, null, 2) + '\n') });
    const hash = await sha256(original);
    await this.remote.commit(snapshot, changes, `pure: ${publication.visibility === 'public' ? 'publish' : 'withdraw'} ${id}`, async () => {
      const current = await storage.backend.read(note.path);
      return !!current && await sha256(current) === hash;
    });
    return true;
  }
}
