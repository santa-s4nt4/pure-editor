import { expect, test, type Page } from '@playwright/test';

async function palette(page: Page, isMobile: boolean) {
  if (isMobile) await page.getByRole('button', { name: 'ノートを開く', exact: true }).click();
  else await page.keyboard.press('Meta+l');
  await expect(page.getByRole('combobox')).toBeVisible();
}
async function newNote(page: Page, isMobile: boolean, name: string) {
  await palette(page, isMobile);
  await page.getByRole('combobox').fill(name);
  await page.getByRole('combobox').press('Enter');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page).toHaveTitle(`${name} — pure`);
}
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.note-title').first()).toBeVisible();
  await expect(page.locator('.writing-surface')).toHaveAttribute('aria-busy', 'false');
});

test('検索、新規作成、2秒保存、再読み込み、タグ絞り込み', async ({ page, isMobile }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await newNote(page, isMobile, '今日のこと');
  const editor = page.getByRole('textbox', { name: 'ノート本文' });
  await editor.fill('# 今日のこと\n\n静かな朝。\n[https://example.com] [検証用]\n');
  await expect(page.locator('.cm-scrapbox-link')).toHaveText('https://example.com');
  await expect(page.locator('.cm-hashtag')).toHaveText('検証用');
  await page.waitForTimeout(2300);
  await page.reload();
  await page.getByRole('button', { name: '今日のこと', exact: true }).click();
  await expect(editor).toContainText('静かな朝。');
  await palette(page, isMobile);
  await page.getByRole('combobox').fill('[検証用]');
  await expect(page.getByRole('option', { name: /今日のこと/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /はじめに/ })).toHaveCount(0);
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  expect(errors).toEqual([]);
});

test('角括弧タグは同じタグの記事一覧へ移動し、履歴で戻る・進む', async ({ page, isMobile }) => {
  await newNote(page, isMobile, 'タグ記事A');
  const editor = page.getByRole('textbox', { name: 'ノート本文' });
  await editor.fill('# タグ記事A\n\n[共通タグ]\n');
  await page.locator('.cm-hashtag').click();
  await expect(editor).toBeVisible();
  await newNote(page, isMobile, 'タグ記事B');
  await editor.fill('# タグ記事B\n\n[共通タグ]\n');
  await page.locator('.cm-hashtag').click();
  await expect(page.locator('.home-heading h1')).toHaveText('共通タグ');
  await expect(page.locator('.note-title')).toHaveCount(2);
  await page.keyboard.press('Meta+ArrowLeft');
  await expect(page).toHaveTitle('タグ記事B — pure');
  await page.keyboard.press('Meta+ArrowRight');
  await expect(page.locator('.home-heading h1')).toHaveText('共通タグ');
});

test('動画ペーストと画像の WebP 圧縮、Live Preview', async ({ page, isMobile }) => {
  await newNote(page, isMobile, 'メディア');
  const editor = page.getByRole('textbox', { name: 'ノート本文' });
  await editor.focus();
  await editor.evaluate(element => {
    const data = new DataTransfer(); data.setData('text/plain', 'https://youtu.be/dQw4w9WgXcQ');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.cm-embed-video iframe')).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  await editor.fill('');
  await editor.evaluate(async element => {
    const canvas = document.createElement('canvas'); canvas.width = 2400; canvas.height = 1200;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#c8ccb6'; ctx.fillRect(0, 0, 2400, 1200);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
    const data = new DataTransfer(); data.items.add(new File([blob], 'image.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const image = page.locator('.cm-embed-image img');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1600);
  await expect(editor).not.toContainText('![]');
  await page.waitForTimeout(2300);
  await page.reload();
  await page.getByRole('button', { name: 'メディア', exact: true }).click();
  await expect(page.locator('.cm-embed-image img')).toBeVisible();
});

test('設定の開閉と自動ダークモード、画面の横溢れがない', async ({ page, isMobile }) => {
  await palette(page, isMobile);
  await page.getByRole('option', { name: /^設定/ }).click();
  await expect(page.getByText('書く場所を、整える。')).toHaveCount(0);
  await expect(page.getByText('Markdown の保存先', { exact: true })).toBeVisible();
  await expect(page.getByText('このブラウザの保存領域').first()).toBeVisible();
  await page.getByRole('button', { name: '設定を保存' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const color = await page.locator('html').evaluate(element => getComputedStyle(element).backgroundColor);
  expect(color).toBe('rgb(70, 71, 75)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/pure-${isMobile ? 'mobile' : 'desktop'}-home.png`, fullPage: true });
});

test('終了直前の文章を回復用ジャーナルから戻す', async ({ page, isMobile }) => {
  await newNote(page, isMobile, '回復');
  const editor = page.getByRole('textbox', { name: 'ノート本文' });
  await editor.fill('保存の直前にも、残っている。');
  await page.reload();
  await page.getByRole('button', { name: '回復', exact: true }).click();
  await expect(editor).toContainText('保存の直前にも、残っている。');
});

test('先頭の見出しがタイトルになり、# を隠して一覧へ更新する', async ({ page, isMobile }) => {
  await newNote(page, isMobile, 'もとの名前');
  const editor = page.getByRole('textbox', { name: 'ノート本文' });
  await editor.fill('# 新しいタイトル\n\n## 小見出し\n本文 [記録]');
  await expect(page).toHaveTitle('新しいタイトル — pure');
  await expect(editor).not.toContainText('# 新しいタイトル');
  await expect(page.locator('.cm-heading-level-1')).toHaveText('新しいタイトル');
  await page.screenshot({ path: `test-results/pure-${isMobile ? 'mobile' : 'desktop'}-writing.png`, fullPage: true });
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await expect(page.locator('.note-title').first()).toHaveText('新しいタイトル');
  await expect(page.locator('.note-card').first().getByRole('button', { name: '記録', exact: true })).toBeVisible();
});

test('Cmd N ですぐに新規記事、Cmd Shift Delete で削除して復元できる', async ({ page }) => {
  await page.keyboard.press('Meta+n');
  const editor = page.getByRole('textbox', { name: 'ノート本文' });
  await expect(editor).toBeVisible();
  await page.keyboard.insertText('すぐに書く');
  await expect(page).toHaveTitle('すぐに書く — pure');
  await page.keyboard.press('Meta+Shift+Backspace');
  await expect(page.getByRole('region', { name: '記事一覧' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'すぐに書く', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '元に戻す' }).click();
  await expect(page).toHaveTitle('すぐに書く — pure');
  await expect(editor).toContainText('すぐに書く');
});

test('箇条書きの YouTube と Vimeo は URL を隠し、カーソル移動で表示する', async ({ page, isMobile }) => {
  await newNote(page, isMobile, '動画のリスト');
  const editor = page.getByRole('textbox', { name: 'ノート本文' });
  await editor.fill('- [https://youtu.be/M7lc1UVf-VE]\n- [https://vimeo.com/123456]\n\n本文');
  await editor.press('Meta+ArrowDown');
  await expect(page.locator('.cm-embed-video.is-list')).toHaveCount(2);
  await expect(editor).not.toContainText('https://');
  await editor.press('Meta+ArrowUp');
  await expect(editor).toContainText('https://youtu.be/M7lc1UVf-VE');
  await editor.press('Meta+ArrowDown');
  await expect(editor).not.toContainText('https://');
});

test('画像 items と HTML data URL の貼り付けに対応する', async ({ page, isMobile }) => {
  await newNote(page, isMobile, '画像の貼り付け');
  const editor = page.getByRole('textbox', { name: 'ノート本文' });
  await editor.fill('');
  await editor.evaluate(element => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
    const data = new DataTransfer(); data.setData('text/html', `<img src="${canvas.toDataURL('image/png')}">`);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.cm-embed-image img')).toBeVisible();
  await editor.evaluate(async element => {
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
    const data = new DataTransfer(); data.items.add(new File([blob], 'clipboard.png', { type: 'image/png' }));
    Object.defineProperty(data, 'files', { value: [] });
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.cm-embed-image img')).toHaveCount(2);
});

test('ドラッグで文字を選択でき、スクロールで本文の横位置が変わらない', async ({ page, isMobile }) => {
  test.skip(isMobile, 'マウス操作をデスクトップで検証');
  await newNote(page, false, '選択とスクロール');
  const editor = page.getByRole('textbox', { name: 'ノート本文' });
  await editor.fill('ドラッグして文字を選択する。\n\n' + Array.from({ length: 100 }, (_, i) => `文章の行 ${i}`).join('\n'));
  await editor.press('Meta+ArrowUp');
  await expect(page.locator('.cm-line').first()).toContainText('ドラッグして文字を選択する。');
  await page.locator('.cm-scroller').evaluate(element => { element.scrollTop = 0; });
  await expect.poll(() => page.locator('.cm-scroller').evaluate(element => element.scrollTop)).toBe(0);
  const line = page.locator('.cm-line').first();
  const box = (await line.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 12 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().length)).toBeGreaterThan(1);
  await page.mouse.click(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(({ x, y }) => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, buttons: 0, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, button: 0, bubbles: true }));
  }, { x: box.x + 120, y: box.y + box.height / 2 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().length)).toBeGreaterThan(1);
  const before = await page.locator('.cm-content').boundingBox();
  await page.mouse.wheel(0, 500);
  const after = await page.locator('.cm-content').boundingBox();
  expect(after?.x).toBe(before?.x);
  expect(after?.width).toBe(before?.width);
  await expect(page.locator('.cm-editor .scroll-indicator')).toHaveClass(/is-scrolling/);
  await expect(page.locator('.cm-editor .scroll-indicator')).not.toHaveClass(/is-scrolling/);
});

test('Tab のインデント、横線、チェックボックスと完了表示', async ({ page, isMobile }) => {
  await newNote(page, isMobile, '書式');
  const editor = page.getByRole('textbox', { name: 'ノート本文' });
  await editor.fill('- 箇条書き');
  await editor.press('Tab'); await expect(editor).toHaveText('   箇条書き');
  await editor.press('Shift+Tab'); await expect(editor).toHaveText('箇条書き');
  await editor.fill('');
  await editor.pressSequentially('--- ');
  await expect(page.getByRole('separator')).toHaveCount(1);
  await editor.pressSequentially('[] task');
  await page.getByRole('checkbox', { name: '完了にする' }).click();
  await expect(page.locator('.cm-task-done')).toContainText('task');
  expect(await page.locator('.cm-task-done').evaluate(element => getComputedStyle(element).color)).toBe('rgb(170, 170, 170)');
  expect(await page.locator('.cm-task-done').evaluate(element => getComputedStyle(element).textDecorationLine)).toContain('line-through');
  await editor.fill('[] '); await editor.press('Meta+ArrowDown'); await editor.dispatchEvent('compositionend', { data: '[] ' });
  await expect(page.getByRole('checkbox', { name: '完了にする' })).toBeVisible();
});

test('角括弧の自動補完と、タグ・URL の灰色表示、最大3タグ', async ({ page, isMobile }) => {
  await expect(page.getByRole('button', { name: '新しい記事', exact: true })).toHaveCount(0);
  await newNote(page, isMobile, '表示');
  const editor = page.getByRole('textbox', { name: 'ノート本文' });
  await editor.fill(''); await editor.pressSequentially('[tag');
  await expect(editor).toHaveText('[tag]');
  await editor.press(']'); await editor.pressSequentially(' end');
  await expect(editor).toContainText('[tag] end');
  await editor.fill('# 表示\n\n[tag] [two] [three] [four] [https://example.com hoge]\n');
  await expect(page.locator('.cm-scrapbox-link')).toHaveText('hoge');
  expect(await page.locator('.cm-scrapbox-link').evaluate(element => getComputedStyle(element).textDecorationLine)).toBe('none');
  expect(await page.locator('.cm-scrapbox-link').evaluate(element => getComputedStyle(element).color)).toBe('rgb(170, 170, 170)');
  const popup = page.waitForEvent('popup'); await page.locator('.cm-scrapbox-link').click();
  const external = await popup; await external.close();
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  const card = page.locator('.note-card').filter({ has: page.getByRole('button', { name: '表示', exact: true }) });
  await expect(card.locator('.note-tags button')).toHaveCount(3); await expect(card.locator('.tags-more')).toHaveText('…');
});

test('埋め込みを挟んだ本文を、リサイズ後もクリックした位置から編集できる', async ({ page, isMobile }) => {
  await newNote(page, isMobile, '埋め込みと座標');
  const editor = page.getByRole('textbox', { name: 'ノート本文' });
  await editor.fill('# 埋め込みと座標\n\n[https://youtu.be/M7lc1UVf-VE]\n\n[https://vimeo.com/123456]\n\nここをクリック');
  await editor.press('Meta+ArrowDown');
  if (!isMobile) await page.setViewportSize({ width: 900, height: 1000 });
  const line = page.locator('.cm-line').filter({ hasText: /^ここをクリック$/ });
  await line.scrollIntoViewIfNeeded();
  const box = (await line.boundingBox())!;
  await page.mouse.click(box.x + 1, box.y + box.height / 2);
  await page.keyboard.insertText('✓');
  await expect(page.locator('.cm-line').filter({ hasText: /^✓ここをクリック$/ })).toBeVisible();
});

test('ライト・ダーク・自動を切り替え、設定を保存して再起動できる', async ({ page, isMobile }) => {
  await palette(page, isMobile); await page.getByRole('option', { name: /^設定/ }).click();
  await page.getByRole('radio', { name: 'ダーク', exact: true }).check();
  await expect.poll(() => page.locator('html').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(70, 71, 75)');
  await page.getByRole('button', { name: '設定を保存' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => page.locator('html').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(70, 71, 75)');
  await palette(page, isMobile); await page.getByRole('option', { name: /^設定/ }).click();
  await page.getByRole('radio', { name: 'ライト', exact: true }).check();
  await expect.poll(() => page.locator('html').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)');
  await page.getByRole('radio', { name: '自動', exact: true }).check();
  await page.getByRole('button', { name: '設定を保存' }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => page.locator('html').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(70, 71, 75)');
  await page.screenshot({ path: `test-results/pure-${isMobile ? 'mobile' : 'desktop'}-dark.png` });
});

test('上下キーと行選択でリンク・タグ・埋め込みのソースに入れる', async ({ page, isMobile }) => {
  await newNote(page, isMobile, 'ソース編集');
  const editor = page.getByRole('textbox', { name: 'ノート本文' });
  await editor.fill('# ソース編集\n\n前の行\n[https://example.com 表示名]\n[タグ]\n[https://youtu.be/M7lc1UVf-VE]\n[https://vimeo.com/123456]\n後ろの行');
  await editor.press('Meta+ArrowDown');
  await expect(editor).not.toContainText('[https://');
  await editor.press('ArrowUp'); await expect(editor).toContainText('[https://vimeo.com/123456]');
  await editor.press('ArrowUp'); await expect(editor).toContainText('[https://youtu.be/M7lc1UVf-VE]');
  await expect(editor).not.toContainText('[https://vimeo.com/123456]');
  await editor.press('ArrowUp'); await expect(editor).toContainText('[タグ]');
  await editor.press('ArrowUp'); await expect(editor).toContainText('[https://example.com 表示名]');
  await editor.press('ArrowUp'); await expect(editor).not.toContainText('[https://');
  await editor.press('ArrowDown'); await expect(editor).toContainText('[https://example.com 表示名]');
  await editor.press('ArrowDown'); await editor.press('ArrowDown');
  await expect(editor).toContainText('[https://youtu.be/M7lc1UVf-VE]');
  await editor.press('ArrowDown'); await expect(editor).toContainText('[https://vimeo.com/123456]');
  await editor.press('Meta+a');
  await expect(editor).toContainText('[https://example.com 表示名]');
  await expect(editor).toContainText('[タグ]');
  await expect(editor).toContainText('[https://youtu.be/M7lc1UVf-VE]');
  await expect(editor).toContainText('[https://vimeo.com/123456]');
});

test('URL 行の余白やドラッグでは開かず、表示文字だけでブラウザを開く', async ({ page, isMobile }) => {
  test.skip(isMobile, 'マウスの当たり判定をデスクトップで検証');
  await newNote(page, false, 'クリック範囲');
  const editor = page.getByRole('textbox', { name: 'ノート本文' });
  await editor.fill('# クリック範囲\n\n[https://example.com 短いリンク]\n次の行\n');
  let popups = 0; page.on('popup', () => popups++);
  const label = page.locator('.cm-scrapbox-link');
  const box = (await label.boundingBox())!;
  await page.mouse.click(box.x + box.width + 50, box.y + box.height / 2);
  await expect(editor).toContainText('[https://example.com 短いリンク]');
  expect(popups).toBe(0);
  await editor.press('Meta+ArrowDown');
  const target = (await label.boundingBox())!;
  await page.mouse.move(target.x + 5, target.y + target.height / 2);
  await page.mouse.down(); await page.mouse.move(target.x + 150, target.y + target.height / 2, { steps: 10 }); await page.mouse.up();
  await expect(editor).toContainText('[https://example.com 短いリンク]');
  expect(popups).toBe(0);
  await editor.press('Meta+ArrowDown');
  const popup = page.waitForEvent('popup'); await label.click();
  const external = await popup; await external.close(); expect(popups).toBe(1);
});

test('箇条書きに画像を貼り付け、点とチェックを行の中央に揃える', async ({ page, isMobile }) => {
  await newNote(page, isMobile, 'リストの画像');
  const editor = page.getByRole('textbox', { name: 'ノート本文' });
  await editor.fill('# リストの画像\n\n- 一行目\n- 二行目\n- [ ] タスク\n- [x] 完了\n- ');
  await editor.press('Meta+ArrowDown');
  await editor.evaluate(element => {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 32;
    const data = new DataTransfer(); data.setData('text/html', `<img src="${canvas.toDataURL('image/png')}">`);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.cm-embed-image.is-list img')).toBeVisible();
  const alignment = await page.locator('.cm-task-checkbox').evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect(), line = element.closest('.cm-line')!.getBoundingClientRect();
    return Math.abs(box.y + box.height / 2 - line.y - line.height / 2);
  }));
  alignment.forEach(delta => expect(delta).toBeLessThan(0.6));
  const markers = await page.locator('.cm-list-marker').evaluateAll(elements => elements.map(element => {
    const marker = element.getBoundingClientRect(), line = element.closest('.cm-line')!.getBoundingClientRect();
    const dot = getComputedStyle(element, '::before');
    return { delta: Math.abs(marker.y + parseFloat(dot.top) + parseFloat(dot.height) / 2 - line.y - line.height / 2), size: dot.width, color: dot.backgroundColor };
  }));
  markers.forEach(marker => { expect(marker.delta).toBeLessThan(0.6); expect(marker.size).toBe(markers[0].size); expect(marker.color).toBe('rgb(170, 170, 170)'); });
  expect(await page.locator('.cm-embed-image.is-list').evaluate(element => getComputedStyle(element, '::before').width)).toBe(markers[0].size);
  await page.keyboard.press('Meta+s');
  await page.reload(); await page.getByRole('button', { name: 'リストの画像', exact: true }).click();
  await expect(page.locator('.cm-embed-image.is-list img')).toBeVisible();
});

test('先頭だけにタイトルの仮表示があり、本文幅と見出しの大きさが適切に変わる', async ({ page, isMobile }) => {
  await page.keyboard.press('Meta+n');
  const editor = page.getByRole('textbox', { name: 'ノート本文' });
  await expect(page.locator('.cm-line').first()).toHaveAttribute('data-empty-title', 'true');
  await editor.fill('# 題名\n\n# \n## 小見出し\n本文 #タグではない');
  await expect(page.locator('[data-empty-title]')).toHaveCount(0);
  const sizes = await page.locator('.cm-heading-line').evaluateAll(elements => elements.map(element => parseFloat(getComputedStyle(element).fontSize)));
  expect(sizes[0]).toBeGreaterThan(sizes[2]); expect(sizes[2]).toBeGreaterThan(17);
  await expect(page.locator('.cm-hashtag')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '記事一覧へ戻る' })).toHaveCount(0);
  if (!isMobile) {
    await page.setViewportSize({ width: 1060, height: 850 });
    const narrow = (await page.locator('.cm-content').boundingBox())!.width;
    await page.setViewportSize({ width: 1800, height: 1000 });
    const wide = (await page.locator('.cm-content').boundingBox())!.width;
    expect(wide).toBeGreaterThan(narrow * 1.7);
  }
  await page.keyboard.press('Escape'); await expect(editor).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('region', { name: '記事一覧' })).toBeVisible();
  await expect(page.locator('.note-card').first().locator('.note-tags button')).toHaveCount(0);
});

test('動画の余白からソース行に入り、Shift 上でも隠れた行を選択できる', async ({ page, isMobile }) => {
  await newNote(page, isMobile, '動画行の選択');
  const editor = page.getByRole('textbox', { name: 'ノート本文' });
  await editor.fill('# 動画行の選択\n\n[https://youtu.be/M7lc1UVf-VE]\n後の行');
  const media = (await page.locator('.cm-embed-video').boundingBox())!;
  await page.mouse.click(media.x + media.width / 2, media.y + 3);
  await expect(editor).toContainText('[https://youtu.be/M7lc1UVf-VE]');
  await editor.press('Meta+ArrowDown'); await editor.press('Shift+ArrowUp');
  await expect(editor).toContainText('[https://youtu.be/M7lc1UVf-VE]');
});

test('箇条書きの先頭に画像をドロップし、順序とリストを保つ', async ({ page, isMobile }) => {
  await newNote(page, isMobile, '画像ドロップ');
  const editor = page.getByRole('textbox', { name: 'ノート本文' });
  await editor.fill('# 画像ドロップ\n\n- ');
  const line = page.locator('.cm-line').last(); const box = (await line.boundingBox())!;
  await editor.evaluate(async (element, point) => {
    const data = new DataTransfer();
    for (const width of [24, 48]) {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = 16;
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
      data.items.add(new File([blob], `${width}.png`, { type: 'image/png' }));
    }
    element.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true, clientX: point.x, clientY: point.y }));
  }, { x: box.x + 1, y: box.y + box.height / 2 });
  await expect(page.locator('.cm-embed-image.is-list img')).toHaveCount(2);
  await expect.poll(() => page.locator('.cm-embed-image img').evaluateAll(elements => elements.map(element => (element as HTMLImageElement).naturalWidth))).toEqual([24, 48]);
});

test('ダブルクリックでトップを残したまま閲覧ウィンドウを開く', async ({ page, context, isMobile }) => {
  test.skip(isMobile, 'Mac の複数ウィンドウ操作');
  await newNote(page, isMobile, '別窓テスト');
  const editor = page.getByRole('textbox', { name: 'ノート本文' });
  await editor.fill('# 改名した記事\n\n別ウィンドウの本文です。');
  await page.waitForTimeout(2300);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  const childPromise = context.waitForEvent('page');
  await page.getByRole('button', { name: '改名した記事', exact: true }).dblclick();
  const child = await childPromise;
  await expect(child.getByRole('main', { name: '記事の閲覧' })).toBeVisible();
  await expect(child.locator('.cm-content')).toContainText('別ウィンドウの本文です。');
  await expect(child.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await expect(page.getByRole('region', { name: '記事一覧' })).toBeVisible();
  await child.close();
});

test('同じ位置からの往復スワイプと小さな矢印表示', async ({ page, isMobile }) => {
  test.skip(isMobile, 'トラックパッド操作');
  await newNote(page, isMobile, 'スワイプテスト');
  await page.locator('main.paper').dispatchEvent('wheel', { deltaX: -120, deltaY: 0, deltaMode: 0 });
  await expect(page.getByRole('region', { name: '記事一覧' })).toBeVisible();
  await expect(page.locator('.history-swipe')).toHaveClass(/is-visible/);
  await page.locator('main.paper').dispatchEvent('wheel', { deltaX: 120, deltaY: 0, deltaMode: 0 });
  await expect(page).toHaveTitle('スワイプテスト — pure');
  await expect(page.locator('.history-swipe')).toHaveClass(/is-forward/);
});

test('Paper のオフライン編集でも元のファイル名と参照ファイルを維持する', async ({ page }) => {
  const path = `Paper/${'a'.repeat(32)}/既存の名前.paper`;
  await page.evaluate(async path => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('pure-notes', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('files', 'readwrite'); const store = transaction.objectStore('files');
      const data = { version: 1, documents: [{ path, id: 'id:fixture', name: '既存の名前.paper', remotePath: '/企業/既存の名前.paper', markdown: '# Paper の記事\n\n本文', revision: 3, dirty: false, updatedAt: Date.now() }] };
      store.put({ path: '.paper/documents.json', bytes: new TextEncoder().encode(JSON.stringify(data)), updatedAt: Date.now() });
      store.put({ path, bytes: new TextEncoder().encode('original reference'), updatedAt: Date.now() });
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
    }); db.close();
  }, path);
  await page.reload();
  await expect(page.locator('.writing-surface')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Paper の記事', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'ノート本文' });
  await editor.fill('# 編集した Paper\n\nオフラインの変更');
  await page.waitForTimeout(2300);
  await page.reload();
  await page.getByRole('button', { name: '編集した Paper', exact: true }).click();
  await expect(editor).toContainText('オフラインの変更');
  const result = await page.evaluate(async path => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('pure-notes', 1); request.onsuccess = () => resolve(request.result); });
    const get = (path: string) => new Promise<any>(resolve => { const request = db.transaction('files').objectStore('files').get(path); request.onsuccess = () => resolve(request.result); });
    const cache = JSON.parse(new TextDecoder().decode((await get('.paper/documents.json')).bytes));
    const original = new TextDecoder().decode((await get(path)).bytes);
    db.close(); return { path: cache.documents[0].path, dirty: cache.documents[0].dirty, original };
  }, path);
  expect(result).toEqual({ path, dirty: true, original: 'original reference' });
});
