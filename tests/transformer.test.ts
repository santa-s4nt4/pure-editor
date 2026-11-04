import { describe, expect, it } from 'vitest';
import { extractTags, fromMarkdown, pagePath, scanReferences, toMarkdown, videoEmbed } from '../src/lib/transformer';

describe('Markdown と執筆テキストの往復', () => {
  it('日本語・空白・階層を持つページと URL を変換する', () => {
    const text = '[日々のこと] [folder/Day one] [https://example.com] #日記';
    const markdown = toMarkdown(text);
    expect(markdown).toBe('[日々のこと] [folder/Day one] [https://example.com](https://example.com) #日記');
    expect(fromMarkdown(markdown)).toBe(text);
    expect(fromMarkdown('[Page](./Page.md)')).toBe('[Page]');
  });
  it('別名・タイトル・画像・参照リンクを保持する', () => {
    const text = '[Alias](Other.md) [Page](Page.md "title") ![image](assets/image.webp) [ref]\n\n[ref]: https://example.com';
    expect(fromMarkdown(text)).toBe(text);
    expect(toMarkdown(text)).toBe(text);
  });
  it('コードフェンス、インラインコード、字下げコード、HTML は変換しない', () => {
    const text = '```md\n[Page] #hidden\n```\n\n~~~\n[Page](Page.md)\n~~~\n\n`[Page] #inline`\n\n    [Page] #indented\n\n<div>\n[Page] #html\n</div>\n\n[Real] #visible';
    const converted = toMarkdown(text);
    expect(converted).toBe(text);
    expect(extractTags(text)).toEqual(['Real']);
    expect(fromMarkdown(converted)).toBe(text);
  });
  it('エスケープとタスクのチェックボックスを守り、見出しとタグを区別する', () => {
    const text = '\\[Page] \\#escaped\n- [ ] task\n- [x] done\n# Heading\n#日本語 #work/ideas #日本語\n[日本語] [work/ideas] [日本語]';
    expect(toMarkdown(text)).toBe(text);
    expect(extractTags(text)).toEqual(['日本語', 'work/ideas']);
  });
  it('URL 内の # をタグにせず、装飾位置を保持する', () => {
    expect(scanReferences('[https://example.com/#part] #tag')).toEqual([
      { kind: 'url', value: 'https://example.com/#part', from: 0, to: 27, contentFrom: 1, contentTo: 26 },
    ]);
  });
  it('変換が繰り返されても二重にリンクを作らない', () => {
    const markdown = toMarkdown('[Page] #tag');
    expect(toMarkdown(markdown)).toBe(markdown);
    expect(fromMarkdown(fromMarkdown(markdown))).toBe('[Page] #tag');
  });
  it('括弧を含むファイル名と URL を標準 Markdown で往復する', () => {
    const text = '[Draft )] [https://example.com/a(b)]';
    expect(toMarkdown(text)).toBe('[Draft )] [https://example.com/a(b)](https://example.com/a%28b%29)');
    expect(fromMarkdown(toMarkdown(text))).toBe(text);
  });
  it('コード内の参照定義が本文の変換を妨げない', () => {
    const text = '```\n[Page]: https://example.com\n```\n\n[Page]';
    expect(toMarkdown(text)).toBe(text);
    expect(extractTags(text)).toEqual(['Page']);
  });
});

describe('入力の検証', () => {
  it('タグと名前付き URL を区別し、Markdown の名前付きリンクと往復する', () => {
    const text = '[読んだ本] [https://example.com 調べもの] [https://example.org]';
    expect(extractTags(text)).toEqual(['読んだ本']);
    expect(scanReferences(text)[1]).toMatchObject({ kind: 'url', value: 'https://example.com', label: '調べもの' });
    expect(toMarkdown(text)).toBe('[読んだ本] [調べもの](https://example.com) [https://example.org](https://example.org)');
    expect(fromMarkdown(toMarkdown(text))).toBe(text);
  });
  it.each([
    ['[https://example.com/hoge hoge]', 'hoge', 'https://example.com/hoge'],
    ['[hoge https://example.com/hoge]', 'hoge', 'https://example.com/hoge'],
    ['[  調べもの メモ\t https://example.com/a(b)#part  ]', '調べもの メモ', 'https://example.com/a(b)#part'],
    ['[📖 参考 HTTPS://example.com]', '📖 参考', 'HTTPS://example.com'],
  ])('URL と表示名のどちらを先に書いてもラベルだけをリンクにする: %s', (text, label, url) => {
    const [reference] = scanReferences(text);
    expect(reference).toMatchObject({ kind: 'url', label, value: url, from: 0, to: text.length });
    expect(text.slice(reference.contentFrom, reference.contentTo)).toBe(label);
    expect(extractTags(text)).toEqual([]);
    const markdown = toMarkdown(text);
    expect(markdown).toBe(`[${label}](${url.replaceAll('(', '%28').replaceAll(')', '%29')})`);
    expect(scanReferences(fromMarkdown(markdown))[0]).toMatchObject({ kind: 'url', label, value: url });
  });
  it('表示名が先にあるリンクもコード・画像・標準 Markdown の内部では変換しない', () => {
    const text = '`[表示名 https://example.com]`\n\n```\n[表示名 https://example.com]\n```\n\n![表示名 https://example.com](assets/image.webp) [表示名 https://example.com](https://other.example)';
    expect(scanReferences(text)).toEqual([]);
    expect(toMarkdown(text)).toBe(text);
  });
  it.each(['../secret', '/etc/passwd', 'a/../b', 'a\\b', 'a:b', 'a\0b', 'a//b', ''])('危険なパス %s を拒否する', value => expect(() => pagePath(value)).toThrow());
  it('拡張子を重複しない', () => expect(pagePath('note.md')).toBe('note.md'));
  it('正しい動画ホストと ID だけを埋め込む', () => {
    expect(videoEmbed('https://youtu.be/dQw4w9WgXcQ')?.src).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(videoEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ')?.src).toContain('dQw4w9WgXcQ');
    expect(videoEmbed('https://vimeo.com/123456/abc')?.src).toBe('https://player.vimeo.com/video/123456?h=abc');
    expect(videoEmbed('https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(videoEmbed('javascript:alert(1)')).toBeNull();
    expect(videoEmbed('https://youtu.be/invalid')).toBeNull();
  });
});
