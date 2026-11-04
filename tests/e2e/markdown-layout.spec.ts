import { expect, test, type Page } from '@playwright/test';

async function files(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('pure-notes', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const rows = await new Promise<{ path: string; bytes: Uint8Array }[]>((resolve, reject) => { const tx = db.transaction('files', 'readonly'); const r = tx.objectStore('files').getAll(); tx.oncomplete = () => resolve(r.result); tx.onerror = () => reject(tx.error); });
    db.close(); return rows.map(row => ({ path: row.path, text: new TextDecoder().decode(row.bytes) }));
  });
}

test('保存する Markdown にリスト境界を補い、続けて編集しても競合を誤検出しない', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('.writing-surface')).toHaveAttribute('aria-busy', 'false');
  await page.keyboard.press('Meta+n'); const editor = page.getByRole('textbox', { name: 'ノート本文' });
  const text = '# 書式の保存\n\n2026.4\n- Creative\n2025.4\n- Researcher\n  - Project\n2024.12\n- Award';
  await editor.fill(text); await editor.press('Meta+s');
  await expect.poll(async () => (await files(page)).find(file => file.path.startsWith('書式の保存--'))?.text).toContain('- Creative\n\n2025.4');
  await editor.fill(text + '\n次の本文'); await editor.press('Meta+s');
  await expect.poll(async () => (await files(page)).find(file => file.path.startsWith('書式の保存--'))?.text).toContain('- Award\n\n次の本文');
  expect((await files(page)).filter(file => file.path.endsWith('.md') && !file.path.startsWith('.') && file.path.includes('conflict'))).toHaveLength(0);
});

test('既存 Markdown は起動時に原本を残して修正し、コードと編集日時は保つ', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('.writing-surface')).toHaveAttribute('aria-busy', 'false');
  const path = '既存--11111111111111111111111111111111.md';
  const codePath = 'コード--22222222222222222222222222222222.md';
  const original = '# 既存\n\n- parent\n  - child\n2025.1';
  const code = '# コード\n\n```md\n- sample\n2024.1\n```'; const updatedAt = 1_600_000_000_000;
  await page.evaluate(async ({ path, codePath, original, code, updatedAt }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('pure-notes', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('files', 'readwrite'); const store = tx.objectStore('files'); for (const [filePath, text] of [[path, original], [codePath, code]]) store.put({ path: filePath, bytes: new TextEncoder().encode(text), updatedAt }); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
  }, { path, codePath, original, code, updatedAt });
  await page.reload(); await expect(page.locator('.writing-surface')).toHaveAttribute('aria-busy', 'false');
  const rows = await files(page);
  expect(rows.find(file => file.path === path)?.text).toBe('# 既存\n\n- parent\n  - child\n\n2025.1');
  expect(rows.find(file => file.path === codePath)?.text).toBe(code);
  const backups = rows.filter(file => file.path.startsWith('.trash/markdown-layout-'));
  expect(backups).toHaveLength(1); expect(backups[0].text).toBe(original);
  expect(JSON.parse(rows.find(file => file.path === '_sync.json')!.text).files[path].updatedAt).toBe(updatedAt);
  await page.reload(); await expect(page.locator('.writing-surface')).toHaveAttribute('aria-busy', 'false');
  expect((await files(page)).filter(file => file.path.startsWith('.trash/markdown-layout-'))).toHaveLength(1);
});
