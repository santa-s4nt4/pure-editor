import { isTauri, invoke } from '@tauri-apps/api/core';
import { appConfigDir, appDataDir, join } from '@tauri-apps/api/path';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import * as fs from '@tauri-apps/plugin-fs';
import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
import { AwsClient } from 'aws4fetch';
import { extractTags, fromMarkdown, noteTitle, pagePath, toMarkdown } from './transformer';
import { diskImagePaths } from './image-paths';

export interface Settings {
  folder: string;
  imagesFolder?: string;
  theme?: 'light' | 'dark' | 'auto';
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  syncEnabled: boolean;
  lastFile: string;
}
export interface Note { path: string; title: string; tags: string[]; excerpt: string; updatedAt: number }
export interface SyncEntry { updatedAt: number; sha256: string; deleted?: boolean }
export interface Manifest { version: 1; files: Record<string, SyncEntry> }
export interface LocalBackend {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  list(): Promise<{ path: string; updatedAt: number }[]>;
}
export interface RemoteBackend {
  get(path: string): Promise<{ bytes: Uint8Array; etag: string } | null>;
  put(path: string, bytes: Uint8Array, condition?: string | null): Promise<void>;
}
export type StorageEvent = { type: 'files' } | { type: 'sync'; state: 'idle' | 'syncing' | 'offline' | 'error'; message?: string };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const defaults: Settings = { folder: '', imagesFolder: '', theme: 'auto', endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '', syncEnabled: false, lastFile: '' };
const fingerprint = (entry: SyncEntry | undefined) => entry ? `${entry.deleted ? 'deleted:' : ''}${entry.sha256}` : '';
const emptyManifest = (): Manifest => ({ version: 1, files: Object.create(null) });
export const native = isTauri();
export const mobile = /iPhone|iPad|iPod|Android/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function safeRelativePath(path: string): string {
  if (!path || path.startsWith('/') || /[\\\u0000-\u001f:]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('不正なファイルパスです。');
  return path;
}
function syncable(path: string): boolean {
  return !path.split('/').some(p => p.startsWith('.')) && (/\.md$/i.test(path) || /^assets\/[^/]+\.webp$/i.test(path));
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function parseManifest(bytes: Uint8Array): Manifest {
  const value = JSON.parse(decoder.decode(bytes));
  if (value?.version !== 1 || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) throw new Error('同期インデックスの形式が不正です。');
  const result = emptyManifest();
  for (const [path, raw] of Object.entries(value.files)) {
    const entry = raw as SyncEntry;
    safeRelativePath(path);
    if (!syncable(path) || !entry || !Number.isFinite(entry.updatedAt) || entry.updatedAt < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('同期インデックスに不正な項目があります。');
    if (entry.deleted !== undefined && typeof entry.deleted !== 'boolean') throw new Error('削除履歴が不正です。');
    result.files[path] = { updatedAt: entry.updatedAt, sha256: entry.sha256, ...(entry.deleted ? { deleted: true } : {}) };
  }
  return result;
}

class NativeBackend implements LocalBackend {
  constructor(private root: string, private images: string) {}
  private async full(path: string) {
    safeRelativePath(path);
    return path.startsWith('assets/') ? join(this.images, path.slice(7)) : join(this.root, path);
  }
  async read(path: string) {
    const full = await this.full(path);
    if (!await fs.exists(full)) return null;
    const bytes = await fs.readFile(full);
    return path.endsWith('.md') ? encoder.encode(diskImagePaths(decoder.decode(bytes), path, this.root, this.images, false)) : bytes;
  }
  async write(path: string, bytes: Uint8Array) {
    const full = await this.full(path);
    const parts = path.split('/');
    if (path.startsWith('assets/')) await fs.mkdir(this.images, { recursive: true });
    else if (parts.length > 1) await fs.mkdir(await join(this.root, ...parts.slice(0, -1)), { recursive: true });
    const temporary = `${full}.${crypto.randomUUID()}.tmp`;
    const output = path.endsWith('.md') ? encoder.encode(diskImagePaths(decoder.decode(bytes), path, this.root, this.images, true)) : bytes;
    await fs.writeFile(temporary, output);
    try { await fs.rename(temporary, full); }
    catch (error) { await fs.remove(temporary).catch(() => undefined); throw error; }
  }
  async remove(path: string) { const full = await this.full(path); if (await fs.exists(full)) await fs.remove(full); }
  async list() {
    const result: { path: string; updatedAt: number }[] = [];
    const walk = async (relative: string) => {
      for (const entry of await fs.readDir(relative ? await this.full(relative) : this.root)) {
        if (entry.name.startsWith('.') || entry.isSymlink) continue;
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory && path !== 'assets' && await join(this.root, path) !== this.images) await walk(path);
        else if (entry.isFile && /\.md$/i.test(path)) {
          const info = await fs.stat(await this.full(path));
          result.push({ path, updatedAt: info.mtime?.getTime() ?? Date.now() });
        }
      }
    };
    await walk('');
    for (const entry of await fs.readDir(this.images)) {
      if (entry.isFile && !entry.isSymlink && /\.webp$/i.test(entry.name)) {
        const path = `assets/${entry.name}`;
        const info = await fs.stat(await this.full(path));
        result.push({ path, updatedAt: info.mtime?.getTime() ?? Date.now() });
      }
    }
    return result;
  }
}

/** Web プレビューも再読み込みで失われない。実機では必ず Tauri FS を使う。 */
export class BrowserBackend implements LocalBackend {
  private database: Promise<IDBDatabase>;
  constructor() {
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open('pure-notes', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'path' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  private async transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', mode);
      const request = run(tx.objectStore('files'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('保存が中断されました。'));
    });
  }
  async read(path: string) {
    safeRelativePath(path);
    const row = await this.transaction('readonly', store => store.get(path));
    return row ? new Uint8Array(row.bytes) : null;
  }
  async write(path: string, bytes: Uint8Array) {
    safeRelativePath(path);
    await this.transaction('readwrite', store => store.put({ path, bytes, updatedAt: Date.now() }));
  }
  async remove(path: string) { safeRelativePath(path); await this.transaction('readwrite', store => store.delete(path)); }
  async list() {
    const rows = await this.transaction('readonly', store => store.getAll());
    return rows.filter(row => syncable(row.path)).map(row => ({ path: row.path as string, updatedAt: row.updatedAt as number }));
  }
}

export function validateR2(settings: Settings) {
  const url = new URL(settings.endpoint);
  if (url.protocol !== 'https:' || !/^(?:[a-z0-9-]+\.)*r2\.cloudflarestorage\.com$/.test(url.hostname) || url.port || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('R2 の S3 API エンドポイントを入力してください。');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(settings.bucket) || !settings.accessKeyId.trim() || !settings.secretAccessKey.trim()) throw new Error('バケット名とアクセスキーを入力してください。');
}

export class R2Backend implements RemoteBackend {
  private client: AwsClient;
  constructor(private settings: Settings) {
    validateR2(settings);
    this.client = new AwsClient({ accessKeyId: settings.accessKeyId.trim(), secretAccessKey: settings.secretAccessKey.trim(), service: 's3', region: 'auto' });
  }
  private async request(path: string, method: string, bytes?: Uint8Array, condition?: string | null) {
    safeRelativePath(path);
    const url = `${this.settings.endpoint.replace(/\/$/, '')}/${this.settings.bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const headers = new Headers();
    if (bytes) headers.set('Content-Type', path.endsWith('.webp') ? 'image/webp' : path.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'application/json');
    if (condition === null) headers.set('If-None-Match', '*');
    else if (condition) headers.set('If-Match', condition);
    const body = bytes ? new Uint8Array(bytes) : undefined;
    const signed = await this.client.sign(url, { method, headers, body });
    return nativeFetch(signed.url, { method, headers: signed.headers, body, connectTimeout: 15_000, signal: AbortSignal.timeout(45_000) });
  }
  async get(path: string) {
    const response = await this.request(path, 'GET');
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`R2 の取得に失敗しました（${response.status}）。`);
    const etag = response.headers.get('etag');
    if (!etag) throw new Error('R2 が ETag を返しませんでした。');
    return { bytes: new Uint8Array(await response.arrayBuffer()), etag };
  }
  async put(path: string, bytes: Uint8Array, condition?: string | null) {
    const response = await this.request(path, 'PUT', bytes, condition);
    if (response.status === 412 || response.status === 409) throw new SyncConflict();
    if (!response.ok) throw new Error(`R2 の保存に失敗しました（${response.status}）。`);
  }
}
export class SyncConflict extends Error { constructor() { super('ほかの端末の変更を確認しています。'); } }

export async function loadSettings(): Promise<Settings> {
  if (!native) {
    try { return { ...defaults, ...JSON.parse(localStorage.getItem('pure-settings') || '{}'), syncEnabled: false }; }
    catch { return { ...defaults }; }
  }
  const configDir = await appConfigDir();
  await fs.mkdir(configDir, { recursive: true });
  const path = await join(configDir, 'settings.json');
  const settings = { ...defaults, ...(await fs.exists(path) ? JSON.parse(await fs.readTextFile(path)) : {}) };
  settings.secretAccessKey = await invoke<string>('read_secret');
  if (!settings.folder || mobile) settings.folder = await join(await appDataDir(), 'Documents', 'Notes');
  if (!settings.imagesFolder || mobile) settings.imagesFolder = await join(settings.folder, 'assets');
  return settings;
}
export async function persistSettings(settings: Settings) {
  if (!native) {
    localStorage.setItem('pure-settings', JSON.stringify({ ...settings, secretAccessKey: '', syncEnabled: false }));
    return;
  }
  await invoke('write_secret', { secret: settings.secretAccessKey });
  const directory = await appConfigDir();
  const path = await join(directory, 'settings.json');
  await fs.writeTextFile(`${path}.tmp`, JSON.stringify({ ...settings, secretAccessKey: '' }, null, 2));
  await fs.rename(`${path}.tmp`, path);
}
export async function chooseFolder(kind: 'notes' | 'images' = 'notes'): Promise<string | null> {
  if (!native || mobile) return null;
  return openDialog({ directory: true, recursive: true, multiple: false, title: kind === 'images' ? 'pure — 画像の保存先' : 'pure — Markdown の保存先' });
}
export async function createBackend(settings: Settings): Promise<LocalBackend> {
  if (!native) return new BrowserBackend();
  await fs.mkdir(settings.folder, { recursive: true });
  const images = settings.imagesFolder || await join(settings.folder, 'assets');
  await fs.mkdir(images, { recursive: true });
  return new NativeBackend(settings.folder, images);
}

export async function relocateImages(previous: Settings, next: Settings) {
  if (!native || previous.folder !== next.folder || previous.imagesFolder === next.imagesFolder) return;
  const source = await createBackend(previous);
  const target = await createBackend(next);
  const notes: { path: string; bytes: Uint8Array }[] = [];
  for (const file of await source.list()) {
    const bytes = await source.read(file.path);
    if (!bytes) continue;
    if (file.path.startsWith('assets/')) {
      const existing = await target.read(file.path);
      if (existing && await sha256(existing) !== await sha256(bytes)) throw new Error('移動先に同名の別の画像があります。');
      await target.write(file.path, bytes);
    } else notes.push({ path: file.path, bytes });
  }
  try { for (const note of notes) await target.write(note.path, note.bytes); }
  catch (error) { for (const note of notes) await source.write(note.path, note.bytes); throw error; }
}

/** ローカル書込みは直列化。ネットワークの待機中も入力・保存を止めない。 */
export class StorageManager {
  private manifest = emptyManifest();
  private bases: Record<string, string> = Object.create(null);
  private queue: Promise<unknown> = Promise.resolve();
  private running: Promise<void> | null = null;
  private syncAgain = false;
  private listeners = new Set<(event: StorageEvent) => void>();
  private titlePaths = new Map<string, string>();
  private noteCache = new Map<string, { hash: string; note: Note }>();
  constructor(readonly backend: LocalBackend, private remote: RemoteBackend | null = null) {}
  get hasHistory() { return Object.keys(this.manifest.files).length > 0; }
  onChange(listener: (event: StorageEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: StorageEvent) { for (const listener of this.listeners) listener(event); }
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private async persistIndex() {
    await this.backend.write('_sync.json', encoder.encode(JSON.stringify(this.manifest, null, 2)));
    await this.backend.write('_sync-state.json', encoder.encode(JSON.stringify(this.bases)));
  }
  async initialize() {
    const existing = await this.backend.read('_sync.json');
    if (existing) this.manifest = parseManifest(existing);
    const state = await this.backend.read('_sync-state.json');
    if (state) {
      const parsed = JSON.parse(decoder.decode(state));
      for (const [path, hash] of Object.entries(parsed)) if (typeof hash === 'string' && /^(?:deleted:)?[a-f0-9]{64}$/.test(hash)) this.bases[safeRelativePath(path)] = hash;
    }
    await this.refresh();
  }
  async refresh() {
    await this.exclusive(async () => {
      const next = emptyManifest();
      for (const [path, entry] of Object.entries(this.manifest.files)) if (entry.deleted) next.files[path] = entry;
      for (const file of await this.backend.list()) {
        const bytes = await this.backend.read(file.path);
        if (!bytes) continue;
        const hash = await sha256(bytes);
        const previous = this.manifest.files[file.path];
        next.files[file.path] = { sha256: hash, updatedAt: previous?.sha256 === hash && !previous.deleted ? previous.updatedAt : file.updatedAt };
      }
      this.manifest = next;
      await this.persistIndex();
    });
    this.emit({ type: 'files' });
  }
  async listNotes(): Promise<Note[]> {
    await this.queue;
    const notes: Note[] = [];
    for (const [path, entry] of Object.entries(this.manifest.files)) {
      if (!path.endsWith('.md') || entry.deleted) continue;
      const cached = this.noteCache.get(path);
      if (cached?.hash === entry.sha256 && cached.note.updatedAt === entry.updatedAt) { notes.push(cached.note); continue; }
      const bytes = await this.backend.read(path);
      if (!bytes) continue;
      const text = fromMarkdown(decoder.decode(bytes));
      const note = { path, title: noteTitle(text, path.replace(/\.md$/, '')), tags: extractTags(text), excerpt: text.replace(/^#+\s+/gm, '').replace(/\n/g, ' ').slice(0, 100), updatedAt: entry.updatedAt };
      this.noteCache.set(path, { hash: entry.sha256, note }); notes.push(note);
    }
    notes.sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path, 'ja'));
    this.titlePaths = new Map([...notes].reverse().map(note => [note.title, note.path]));
    return notes;
  }
  private editorText(text: string) { return fromMarkdown(text, (label, path) => this.titlePaths.get(label) === path); }
  async readNote(path: string) {
    await this.queue;
    await this.listNotes();
    const bytes = await this.backend.read(safeRelativePath(path));
    return bytes ? this.editorText(decoder.decode(bytes)) : null;
  }
  async deleteNote(path: string): Promise<string> {
    safeRelativePath(path);
    if (!path.endsWith('.md')) throw new Error('記事を選択してください。');
    const backup = `.trash/${Date.now()}-${crypto.randomUUID()}/${path}`;
    await this.exclusive(async () => {
      const bytes = await this.backend.read(path);
      if (!bytes) return;
      await this.backend.write(backup, bytes);
      await this.backend.remove(path);
      this.manifest.files[path] = { sha256: await sha256(bytes), updatedAt: Date.now(), deleted: true };
      await this.persistIndex();
    });
    this.emit({ type: 'files' }); void this.sync(); return backup;
  }
  async restoreNote(path: string, backup: string) {
    const bytes = await this.backend.read(backup);
    if (!bytes) throw new Error('復元する記事が見つかりません。');
    if (await this.backend.read(path)) throw new Error('同名の記事があるため復元できません。');
    await this.saveBytes(path, bytes);
  }
  async saveNote(path: string, text: string, expectedText?: string) {
    safeRelativePath(path);
    await this.listNotes();
    const currentTitle = noteTitle(text, path.replace(/\.md$/, ''));
    await this.saveBytes(path, encoder.encode(toMarkdown(text, name => name === currentTitle ? path : this.titlePaths.get(name) ?? pagePath(name))), expectedText);
  }
  async createNote(name: string): Promise<string> {
    const path = pagePath(name);
    await this.exclusive(async () => {
      if (await this.backend.read(path)) return;
      await this.writeIndexed(path, encoder.encode(''));
      await this.persistIndex();
    });
    this.emit({ type: 'files' });
    void this.sync();
    return path;
  }
  private async writeIndexed(path: string, bytes: Uint8Array, entry?: SyncEntry) {
    await this.backend.write(path, bytes);
    this.manifest.files[path] = entry ?? { sha256: await sha256(bytes), updatedAt: Date.now() };
  }
  private async saveBytes(path: string, bytes: Uint8Array, expectedText?: string) {
    await this.exclusive(async () => {
      const hash = await sha256(bytes);
      if (this.manifest.files[path]?.sha256 !== hash || this.manifest.files[path]?.deleted) {
        if (expectedText !== undefined) {
          const existing = await this.backend.read(path);
          if (existing && this.editorText(decoder.decode(existing)) !== expectedText) {
            const conflict = `${path.slice(0, -3)} (conflict ${Date.now()}-${crypto.randomUUID().slice(0, 6)}).md`;
            await this.writeIndexed(conflict, existing);
          }
        }
        await this.writeIndexed(path, bytes, { sha256: hash, updatedAt: Date.now() });
        await this.persistIndex();
      }
    });
    this.emit({ type: 'files' });
    void this.sync();
  }
  async saveImage(bytes: Uint8Array): Promise<string> {
    const hash = await sha256(bytes);
    const path = `assets/img_${Date.now()}_${hash.slice(0, 10)}.webp`;
    await this.saveBytes(path, bytes);
    return path;
  }
  async imageUrl(path: string): Promise<string> {
    if (!/^assets\/[^/]+\.webp$/i.test(safeRelativePath(path))) throw new Error('画像パスが不正です。');
    const bytes = await this.backend.read(path);
    if (!bytes) throw new Error('画像が見つかりません。');
    return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/webp' }));
  }
  setRemote(remote: RemoteBackend | null) { this.remote = remote; }
  async waitForSync() { await this.running; }
  sync(): Promise<void> {
    if (!this.remote) return Promise.resolve();
    if (this.running) { this.syncAgain = true; return this.running; }
    this.emit({ type: 'sync', state: 'syncing' });
    this.running = (async () => {
      try {
        let attempts = 0;
        do {
          this.syncAgain = false;
          try { await this.reconcile(this.remote!); attempts = 0; }
          catch (error) {
            if (error instanceof SyncConflict && ++attempts < 4) { this.syncAgain = true; continue; }
            throw error;
          }
        } while (this.syncAgain && this.remote);
        this.emit({ type: 'sync', state: 'idle' });
      } catch (error) {
        this.emit({ type: 'sync', state: navigator.onLine ? 'error' : 'offline', message: error instanceof Error ? error.message : '同期を完了できませんでした。' });
      } finally { this.running = null; }
    })();
    return this.running;
  }
  private async reconcile(remote: RemoteBackend) {
    const index = await remote.get('_sync.json');
    const remoteManifest = index ? parseManifest(index.bytes) : emptyManifest();
    const pulled = new Set<string>();
    // まず Pull。両方で変わった場合はローカル版を別ファイルとして残す。
    for (const [path, entry] of Object.entries(remoteManifest.files)) {
      await this.queue;
      const local = this.manifest.files[path];
      if (fingerprint(local) === fingerprint(entry) || (local && this.bases[path] === fingerprint(entry))) continue;
      if (entry.deleted) {
        await this.exclusive(async () => {
          const current = this.manifest.files[path];
          const bytes = await this.backend.read(path);
          if (bytes && current && fingerprint(current) !== this.bases[path]) {
            await this.writeIndexed(`${path.slice(0, -3)} (conflict ${Date.now()}-${crypto.randomUUID().slice(0, 6)}).md`, bytes);
          }
          if (bytes) {
            await this.backend.write(`.trash/${Date.now()}-${crypto.randomUUID()}/${path}`, bytes);
            await this.backend.remove(path);
          }
          this.manifest.files[path] = entry; this.bases[path] = fingerprint(entry); await this.persistIndex();
        });
        continue;
      }
      const object = await remote.get(`_pure/objects/${entry.sha256}`) ?? await remote.get(path);
      if (!object || await sha256(object.bytes) !== entry.sha256) throw new SyncConflict();
      await this.exclusive(async () => {
        const current = this.manifest.files[path];
        if (fingerprint(current) === fingerprint(entry)) return;
        if (current && !current.deleted && fingerprint(current) !== this.bases[path]) {
          const bytes = await this.backend.read(path);
          if (bytes) {
            const extension = path.endsWith('.md') ? '.md' : '.webp';
            const conflict = `${path.slice(0, -extension.length)} (conflict ${Date.now()}-${crypto.randomUUID().slice(0, 6)})${extension}`;
            await this.writeIndexed(conflict, bytes);
          }
        }
        await this.writeIndexed(path, object.bytes, entry);
        pulled.add(path);
        this.bases[path] = fingerprint(entry);
        await this.persistIndex();
      });
    }
    await this.queue;
    const snapshot: Manifest = structuredClone(this.manifest);
    const merged: Manifest = { version: 1, files: { ...remoteManifest.files } };
    // 各オブジェクトにも条件付き PUT を行い、他端末の文章の上書きを防ぐ。
    for (const [path, entry] of Object.entries(snapshot.files)) {
      if (entry.deleted) { merged.files[path] = entry; continue; }
      if (fingerprint(remoteManifest.files[path]) !== fingerprint(entry) || pulled.has(path)) {
        const bytes = await this.backend.read(path);
        if (!bytes || await sha256(bytes) !== entry.sha256) { this.syncAgain = true; continue; }
        // 不変の内容を先に置くことで、文章 PUT とインデックス PUT の間の
        // 終了・並行書込みでも、確定したインデックスの内容を必ず取得できる。
        const revision = `_pure/objects/${entry.sha256}`;
        const archived = await remote.get(revision);
        if (!archived) {
          try { await remote.put(revision, bytes, null); }
          catch (error) { if (!(error instanceof SyncConflict)) throw error; }
        } else if (await sha256(archived.bytes) !== entry.sha256) throw new Error('R2 の保存内容を検証できませんでした。');
        const previous = await remote.get(path);
        await remote.put(path, bytes, previous?.etag ?? null);
      }
      merged.files[path] = entry;
    }
    if (JSON.stringify(merged.files) !== JSON.stringify(remoteManifest.files)) await remote.put('_sync.json', encoder.encode(JSON.stringify(merged, null, 2)), index?.etag ?? null);
    await this.exclusive(async () => {
      for (const [path, entry] of Object.entries(merged.files)) this.bases[path] = fingerprint(entry);
      await this.persistIndex();
    });
    this.emit({ type: 'files' });
  }
}
