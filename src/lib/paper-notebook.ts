import type { LocalBackend, Note } from './storage';
import type { PaperClient, PaperExport } from './paper-client';
import { fromMarkdown, extractTags, noteTitle, toMarkdown } from './transformer';
import { workspaceLock } from './workspace';
interface PaperDocument { path: string; id: string; name: string; remotePath: string; markdown: string; revision: number; dirty: boolean; updatedAt: number }
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const indexPath = '.paper/documents.json';
export const isPaperPath = (path: string) => /^Paper\/[a-f0-9]{32}\/[^/]+\.paper$/i.test(path);
export class PaperNotebook {
  private documents = new Map<string, PaperDocument>();
  private queue: Promise<unknown> = Promise.resolve();
  private running: Promise<void> | null = null;
  constructor(private backend: LocalBackend, private client: Pick<PaperClient, 'connected' | 'export' | 'update'> | null, private changed: () => void = () => {}, private status: (message: string) => void = () => {}) {}
  private exclusive<T>(run: () => Promise<T>) {
    const key = this.backend.coordinationKey;
    const result = this.queue.then(() => workspaceLock(key ? `${key}:paper` : undefined, async () => {
      if (key) await this.initialize();
      return run();
    }));
    this.queue = result.catch(() => undefined); return result;
  }
  private persist() { return this.backend.write(indexPath, encoder.encode(JSON.stringify({ version: 1, documents: [...this.documents.values()] }))); }
  async initialize() {
    const bytes = await this.backend.read(indexPath);
    this.documents.clear();
    if (!bytes) return;
    const value = JSON.parse(decoder.decode(bytes));
    if (value?.version !== 1 || !Array.isArray(value.documents)) throw new Error('Paper のローカル保存情報が不正です。');
    for (const doc of value.documents) {
      if (!isPaperPath(doc.path) || typeof doc.id !== 'string' || !doc.id.startsWith('id:') || typeof doc.markdown !== 'string' || !Number.isSafeInteger(doc.revision) || doc.revision < 0 || typeof doc.name !== 'string' || typeof doc.dirty !== 'boolean' || !Number.isFinite(doc.updatedAt)) throw new Error('Paper の文書情報が不正です。');
      this.documents.set(doc.path, doc);
    }
  }
  async listNotes(): Promise<Note[]> {
    if (this.backend.coordinationKey) await this.exclusive(async () => {});
    await this.queue;
    return [...this.documents.values()].map(doc => {
      const text = fromMarkdown(doc.markdown);
      return { path: doc.path, title: noteTitle(text, doc.name.replace(/\.paper$/i, '')), tags: extractTags(text), excerpt: text.replace(/\n/g, ' ').slice(0, 100), updatedAt: doc.updatedAt };
    });
  }
  async readNote(path: string) { if (this.backend.coordinationKey) await this.exclusive(async () => {}); await this.queue; const doc = this.documents.get(path); return doc ? fromMarkdown(doc.markdown) : null; }
  async attach(exported: PaperExport, original?: { name: string; bytes: Uint8Array }) {
    const existing = [...this.documents.values()].find(doc => doc.id === exported.file.id);
    if (existing) {
      await this.exclusive(async () => {
        const current = this.documents.get(existing.path)!;
        if (current.dirty || exported.revision < current.revision) return;
        const next = { ...current, markdown: exported.markdown, revision: exported.revision, remotePath: exported.file.path_display ?? current.remotePath, updatedAt: Date.parse(exported.file.server_modified ?? '') || current.updatedAt };
        this.documents.set(existing.path, next);
        try { await this.persist(); } catch (error) { this.documents.set(existing.path, current); throw error; }
      });
      this.changed(); return existing.path;
    }
    const name = original?.name ?? exported.file.name;
    if (!/^[^<>:"/\\|?*\u0000-\u001f]+\.paper$/i.test(name) || name.startsWith('.')) throw new Error('Paper のファイル名が不正です。');
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(exported.file.id));
    const key = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
    let path = `Paper/${key}/${name}`;
    await this.exclusive(async () => {
      const attached = [...this.documents.values()].find(doc => doc.id === exported.file.id);
      if (attached) { path = attached.path; return; }
      if (original) await this.backend.write(path, original.bytes);
      this.documents.set(path, { path, id: exported.file.id, name, remotePath: exported.file.path_display ?? exported.file.id, markdown: exported.markdown, revision: exported.revision, dirty: false, updatedAt: Date.parse(exported.file.server_modified ?? '') || Date.now() });
      try { await this.persist(); } catch (error) { this.documents.delete(path); throw error; }
    });
    this.changed(); return path;
  }
  async saveNote(path: string, text: string, expectedText?: string) {
    await this.exclusive(async () => {
      const doc = this.documents.get(path);
      if (!doc) throw new Error('Paper の文書が見つかりません。');
      const markdown = toMarkdown(text);
      if (doc.markdown === markdown) { if (doc.dirty) await this.persist(); return; }
      if (expectedText !== undefined && toMarkdown(fromMarkdown(doc.markdown)) !== toMarkdown(expectedText)) await this.backend.write(`.paper/backups/${crypto.randomUUID()}.md`, encoder.encode(doc.markdown));
      this.documents.set(path, { ...doc, markdown, dirty: true, updatedAt: Date.now() });
      await this.persist();
    });
    this.changed();
    if (!this.client?.connected) this.status('ローカルに保存しました。Dropbox に接続してください。');
    void this.sync();
  }
  async refresh() {
    if (!this.client?.connected) return;
    await this.sync();
    for (const path of [...this.documents.keys()]) {
      await this.queue;
      if (this.documents.get(path)!.dirty) continue;
      const remote = await this.client.export(this.documents.get(path)!.id);
      await this.exclusive(async () => {
        const current = this.documents.get(path)!;
        if (current.dirty || remote.revision < current.revision) return;
        this.documents.set(path, { ...current, markdown: remote.markdown, revision: remote.revision, updatedAt: Date.parse(remote.file.server_modified ?? '') || current.updatedAt });
        await this.persist();
      });
    }
    this.changed();
  }
  async reloadRemote(path: string) {
    await this.running;
    if (!this.client?.connected) throw new Error('Dropbox に接続してください。');
    const doc = this.documents.get(path);
    if (!doc) throw new Error('Paper の文書が見つかりません。');
    const remote = await this.client.export(doc.id);
    await this.exclusive(async () => {
      const current = this.documents.get(path)!;
      await this.backend.write(`.paper/backups/${crypto.randomUUID()}.md`, encoder.encode(current.markdown));
      this.documents.set(path, { ...current, markdown: remote.markdown, revision: remote.revision, dirty: false, updatedAt: Date.now() });
      await this.persist();
    });
    this.changed();
  }
  sync(): Promise<void> {
    if (this.running) return this.running;
    if (!this.client?.connected) return Promise.resolve();
    this.running = workspaceLock(this.backend.coordinationKey ? `${this.backend.coordinationKey}:paper-sync` : undefined, async () => {
      try {
        if (this.backend.coordinationKey) await this.exclusive(async () => {});
        for (const path of [...this.documents.keys()]) {
          for (;;) {
            await this.queue;
            const snapshot = { ...this.documents.get(path)! };
            if (!snapshot.dirty) break;
            this.status('Dropbox Paper に反映しています');
            const revision = await this.client!.update(snapshot.id, snapshot.markdown, snapshot.revision);
            await this.exclusive(async () => {
              const current = this.documents.get(path)!;
              this.documents.set(path, { ...current, revision, dirty: current.markdown !== snapshot.markdown });
              await this.persist();
            });
          }
        }
        this.status('Dropbox Paper に反映済み');
      } catch (error) { this.status(error instanceof Error ? error.message : String(error)); }
    }).finally(() => { this.running = null; });
    return this.running;
  }
}
