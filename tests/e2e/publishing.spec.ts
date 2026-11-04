import { expect, test } from '@playwright/test';

test('既存記事は非公開で、公開設定のある記事だけを絞り込み、本文に内部設定を表示しない', async ({ page, isMobile }) => {
  await page.goto('/'); await expect(page.locator('.writing-surface')).toHaveAttribute('aria-busy', 'false');
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('pure-notes', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const encode = (text: string) => new TextEncoder().encode(text);
    const publication = { repository: 'santa-s4nt4/pure-notes', branch: 'main', visibility: 'public', revision: '11111111-1111-4111-8111-111111111111', parent: null };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite'); const store = tx.objectStore('files');
      store.put({ path: '公開確認--11111111111111111111111111111111.md', bytes: encode(`<!-- pure:publication ${JSON.stringify(publication)} -->\n\n# 公開確認\n\n[確認タグ]`), updatedAt: Date.now() });
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    }); db.close();
  });
  await page.reload(); await expect(page.getByRole('button', { name: '公開確認', exact: true })).toBeVisible();
  const filters = page.getByRole('group', { name: '記事の公開範囲' });
  await filters.getByRole('button', { name: '公開', exact: true }).click();
  await expect(page.locator('.note-title')).toHaveCount(1);
  await filters.getByRole('button', { name: '非公開', exact: true }).click();
  await expect(page.getByRole('button', { name: '公開確認', exact: true })).toHaveCount(0);
  await expect(page.locator('.note-title')).toHaveCount(1);
  await filters.getByRole('button', { name: 'すべて', exact: true }).click();
  await page.getByRole('button', { name: '公開確認', exact: true }).click();
  const body = page.getByRole('textbox', { name: 'ノート本文' });
  await expect(body).toContainText('確認タグ'); await expect(body).not.toContainText('pure:publication');
  if (isMobile) await page.getByRole('button', { name: 'ノートを開く', exact: true }).click();
  else await page.keyboard.press('Meta+l');
  await expect(page.getByRole('option', { name: /この記事を非公開にする/ })).toBeVisible();
});
