import { expect, it } from 'vitest';
import { filenameTitle, namedNotePath, noteId, renameNoteLinks } from '../src/lib/note-filenames';
const id = '1234567890abcdef1234567890abcdef';
it('タイトルと固定IDで安全なファイル名を生成し、長い日本語をバイト数で制限する', () => {
  expect(namedNotePath('朝 / 夜: 記録?', id, 'folder/old.md')).toBe(`folder/朝 夜 記録--${id}.md`);
  expect(namedNotePath('...', id)).toBe(`無題--${id}.md`);
  expect(new TextEncoder().encode(namedNotePath('長'.repeat(200), id)).length).toBeLessThan(255);
  expect(noteId(namedNotePath('記事', id))).toBe(id);
  expect(filenameTitle(namedNotePath('記事', id))).toBe('記事');
});
it('相対リンクと参照定義の移行先を更新し、コード・画像・外部URLは保つ', () => {
  const moves = new Map([['notes/old.md', `notes/新記事--${id}.md`]]);
  const encoded = encodeURIComponent(`新記事--${id}.md`);
  const text = '[旧](old.md#heading)\n[旧](../notes/old.md?view=1#heading)\n\n[ref]: old.md\n\n`[旧](old.md)`\n[外](https://example.com/old.md)\n![](assets/p.webp)';
  const result = renameNoteLinks(text, 'notes/source.md', moves);
  expect(result).toContain(`[旧](${encoded}#heading)`);
  expect(result).toContain(`[旧](${encoded}?view=1#heading)`);
  expect(result).toContain(`[ref]: ${encoded}`);
  expect(result).toContain('`[旧](old.md)`');
  expect(result).toContain('[外](https://example.com/old.md)');
  expect(result).toContain('![](assets/p.webp)');
});
