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
  await expect(page.getByRole('switch', { name: 'この記事を公開' })).toHaveAttribute('aria-checked', 'true');
});

test('⋯はMacの左上・iPhoneの右下にあり、記事の公開スイッチと削除を操作できる', async ({ page, isMobile }) => {
  await page.goto('/'); await expect(page.locator('.writing-surface')).toHaveAttribute('aria-busy', 'false');
  const trigger = page.getByRole('button', { name: 'ノートを開く', exact: true });
  const bounds = await trigger.boundingBox();
  if (isMobile) { const size = page.viewportSize()!; expect(size.width - bounds!.x - bounds!.width).toBeLessThanOrEqual(20); expect(size.height - bounds!.y - bounds!.height).toBeLessThanOrEqual(20); }
  else { expect(bounds!.x).toBeLessThan(120); expect(bounds!.y).toBeLessThan(40); }
  await trigger.click();
  await expect(page.getByRole('switch', { name: 'この記事を公開' })).toHaveCount(0);
  await page.getByRole('combobox').fill('メニューで操作'); await page.getByRole('combobox').press('Enter');
  await expect(page).toHaveTitle('メニューで操作 — pure');
  await trigger.click(); const visibility = page.getByRole('switch', { name: 'この記事を公開' });
  await expect(visibility).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('button', { name: 'この記事を削除', exact: true })).toBeVisible();
  await visibility.click();
  await expect(page.getByRole('group', { name: 'GitHub に公開', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '閉じる', exact: true }).click(); await trigger.click();
  await expect(visibility).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('button', { name: 'この記事を削除', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'メニューで操作', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(page).toHaveTitle('メニューで操作 — pure');
});

test('GitHubの入力欄は縦に分かれ、ラベルと入力領域が重ならない', async ({ page, isMobile }) => {
  await page.goto('/'); await expect(page.locator('.writing-surface')).toHaveAttribute('aria-busy', 'false');
  if (isMobile) { await page.getByRole('button', { name: 'ノートを開く', exact: true }).click(); await page.getByRole('option', { name: /設定 保存する場所/ }).click(); }
  else await page.keyboard.press('Meta+,');
  const fields = page.locator('.github-fields');
  await fields.scrollIntoViewIfNeeded();
  const geometry = await fields.evaluate(element => {
    return [...element.querySelectorAll('label')].map(label => {
      const input = label.querySelector('input')!; const labelBox = label.getBoundingClientRect(); const inputBox = input.getBoundingClientRect();
      return { labelTop: labelBox.top, inputTop: inputBox.top, bottom: labelBox.bottom, inputWidth: inputBox.width, labelWidth: labelBox.width, background: getComputedStyle(input).backgroundColor, fontSize: parseFloat(getComputedStyle(input).fontSize) };
    });
  });
  expect(geometry).toHaveLength(3);
  for (const [index, row] of geometry.entries()) {
    expect(row.inputTop - row.labelTop).toBeGreaterThan(15); expect(row.inputWidth).toBeCloseTo(row.labelWidth, 0);
    expect(row.inputWidth).toBeGreaterThan(250); expect(row.fontSize).toBeGreaterThanOrEqual(16); expect(row.background).not.toBe('rgba(0, 0, 0, 0)');
    if (index) expect(row.labelTop).toBeGreaterThan(geometry[index - 1].bottom);
  }
  const overflow = await page.locator('.settings').evaluate(element => element.scrollWidth - element.clientWidth); expect(overflow).toBeLessThanOrEqual(1);
});
