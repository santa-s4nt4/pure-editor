import { expect, it } from 'vitest';
import type { LocalBackend } from '../src/lib/storage';
import { PaperConflict } from '../src/lib/paper-client';
import { PaperNotebook } from '../src/lib/paper-notebook';
class Files implements LocalBackend {
  files = new Map<string, Uint8Array>();
  async read(path: string) { return this.files.get(path) ?? null; }
  async write(path: string, bytes: Uint8Array) { this.files.set(path, bytes); }
  async remove(path: string) { this.files.delete(path); }
  async list() { return []; }
}
const exported = { file: { id: 'id:doc', name: '会議.paper', path_display: '/部署/会議.paper' }, revision: 7, markdown: '# 会議\n\n本文' };
const encode = (text: string) => new TextEncoder().encode(text);
it('元の.paperをそのまま保ち、タイトルを変更してもパスを変えず同じ文書に反映する', async () => {
  const files = new Files(); let saved = ''; let revision = 0;
  const notebook = new PaperNotebook(files, { connected: true, export: async () => exported, update: async (id, markdown, rev) => { expect(id).toBe('id:doc'); saved = markdown; revision = rev; return 8; } });
  const original = encode('{"url":"https://www.dropbox.com/cloud_docs/view/example"}');
  const path = await notebook.attach(exported, { name: '会議.paper', bytes: original });
  expect(path).toMatch(/^Paper\/[a-f0-9]{32}\/会議\.paper$/);
  await notebook.saveNote(path, '# タイトル変更\n\n追記', '# 会議\n\n本文'); await notebook.sync();
  expect(saved).toBe('# タイトル変更\n\n追記'); expect(revision).toBe(7);
  expect(await files.read(path)).toEqual(original);
  expect((await notebook.listNotes())[0].path).toBe(path);
  const restart = new PaperNotebook(files, null); await restart.initialize();
  expect(await restart.readNote(path)).toBe('# タイトル変更\n\n追記');
});
it('オフラインの編集を再起動後に反映し、競合時にはローカル版を失わない', async () => {
  const files = new Files(); let connected = false; let fail = true; const statuses: string[] = [];
  const client = { get connected() { return connected; }, export: async () => exported, update: async () => { if (fail) throw new PaperConflict(); return 8; } };
  const book = new PaperNotebook(files, client, () => {}, text => statuses.push(text));
  const path = await book.attach(exported); await book.saveNote(path, '# 会議\n\nオフラインの変更');
  const restart = new PaperNotebook(files, client, () => {}, text => statuses.push(text)); await restart.initialize(); connected = true;
  await restart.sync(); expect(statuses.at(-1)).toContain('変更があります');
  expect(await restart.readNote(path)).toContain('オフラインの変更');
  fail = false; await restart.sync(); expect(statuses.at(-1)).toContain('反映済み');
});
it('書き戻し中の追加入力を失わず、新しい更新番号で続けて反映する', async () => {
  const files = new Files(); let release!: (revision: number) => void; const calls: { text: string; revision: number }[] = [];
  const book = new PaperNotebook(files, { connected: true, export: async () => exported, update: async (_id, text, revision) => { calls.push({ text, revision }); if (calls.length === 1) return new Promise<number>(resolve => { release = resolve; }); return 9; } });
  const path = await book.attach(exported);
  await book.saveNote(path, 'first');
  await Promise.resolve(); await Promise.resolve();
  await book.saveNote(path, 'second'); release(8); await book.sync();
  expect(calls).toEqual([{ text: 'first', revision: 7 }, { text: 'second', revision: 8 }]);
  expect(await book.readNote(path)).toBe('second');
});
it('Paperの再読込時はローカルの原本をバックアップする', async () => {
  const files = new Files();
  const book = new PaperNotebook(files, { connected: true, export: async () => exported, update: async () => { throw new PaperConflict(); } });
  const path = await book.attach(exported); await book.saveNote(path, 'local'); await book.reloadRemote(path);
  expect(await book.readNote(path)).toBe('# 会議\n\n本文');
  expect([...files.files.entries()].some(([path, bytes]) => path.startsWith('.paper/backups/') && new TextDecoder().decode(bytes) === 'local')).toBe(true);
});
it('同じPaperを再度開くと最新を読み、未反映の編集や新しい更新番号は巻き戻さない', async () => {
  const files = new Files(); const book = new PaperNotebook(files, null);
  const path = await book.attach(exported);
  expect(await book.attach({ ...exported, revision: 8, markdown: 'updated' })).toBe(path);
  expect(await book.readNote(path)).toBe('updated');
  await book.attach(exported); expect(await book.readNote(path)).toBe('updated');
  await book.saveNote(path, 'draft');
  await book.attach({ ...exported, revision: 9, markdown: 'remote' });
  expect(await book.readNote(path)).toBe('draft');
});
it('ローカル保存が失敗した場合はDropboxへ送らず、保存の再試行後に反映する', async () => {
  const files = new Files(); let writes = 0;
  const book = new PaperNotebook(files, { connected: true, export: async () => exported, update: async () => { writes++; return 8; } });
  const path = await book.attach(exported); const write = files.write.bind(files); let fail = true;
  files.write = async (path, bytes) => { if (fail) { fail = false; throw new Error('disk full'); } await write(path, bytes); };
  await expect(book.saveNote(path, 'draft')).rejects.toThrow('disk full'); expect(writes).toBe(0);
  await book.saveNote(path, 'draft'); await book.sync(); expect(writes).toBe(1);
  const restarted = new PaperNotebook(files, null); await restarted.initialize(); expect(await restarted.readNote(path)).toBe('draft');
});
