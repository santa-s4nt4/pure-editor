import { describe, expect, it } from 'vitest';
import { diskImagePaths } from '../src/lib/image-paths';
import { mediaLine } from '../src/lib/media';
import { noteTitle } from '../src/lib/transformer';

describe('記事の見出しとメディア', () => {
  it('コードを除いた最初の H1 をタイトルにする', () => {
    expect(noteTitle('```\n# code\n```\n\n# 記事の題名\n# 次の見出し', 'fallback')).toBe('記事の題名');
    expect(noteTitle('# \n\n本文', '無題')).toBe('無題');
    expect(noteTitle('## 小見出し\n本文', 'fallback')).toBe('fallback');
  });
  it('動画 URL とリンク、ネストした箇条書きの動画を認識する', () => {
    expect(mediaLine('- [https://youtu.be/M7lc1UVf-VE]')?.video?.title).toBe('YouTube 動画');
    expect(mediaLine('  - https://vimeo.com/123456')?.video?.title).toBe('Vimeo 動画');
    expect(mediaLine('[動画](https://vimeo.com/123456)')?.video?.title).toBe('Vimeo 動画');
    expect(mediaLine('普通の文章 https://vimeo.com/123456')).toBeNull();
  });
});
describe('別々の Markdown・画像フォルダ', () => {
  it('画像の相対パスを通常の Markdown として書き出し、共通キーに戻す', () => {
    const text = '![](assets/img.webp)';
    const disk = diskImagePaths(text, 'note.md', '/Notes', '/Pictures/pure', true);
    expect(disk).toBe('![](../Pictures/pure/img.webp)');
    expect(diskImagePaths(disk, 'note.md', '/Notes', '/Pictures/pure', false)).toBe(text);
  });
  it('階層と空白を含む保存先、コード内の記法を扱う', () => {
    const text = '![](assets/img.webp)\n`![](assets/img.webp)`';
    const disk = diskImagePaths(text, 'folder/note.md', '/Notes', '/My Pictures', true);
    expect(disk).toBe('![](../../My%20Pictures/img.webp)\n`![](assets/img.webp)`');
    expect(diskImagePaths(disk, 'folder/note.md', '/Notes', '/My Pictures', false)).toBe(text);
  });
});
