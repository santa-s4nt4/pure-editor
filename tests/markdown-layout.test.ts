import { describe, expect, it } from 'vitest';
import { parser } from '@lezer/markdown';
import { normalizeMarkdownLayout } from '../src/lib/markdown-layout';
import { toMarkdown } from '../src/lib/transformer';

describe('Markdown のリスト境界', () => {
  it('箇条書きの後の日付を、直前の項目や子リストへ取り込ませない', () => {
    const source = '## Work Experience\n2026.4 - Current\n- Creative\n2025.4 - 2026.3\n- Researcher\n  - Project\n2024.12\n- Award';
    const result = normalizeMarkdownLayout(source);
    expect(result).toBe('## Work Experience\n2026.4 - Current\n- Creative\n\n2025.4 - 2026.3\n- Researcher\n  - Project\n\n2024.12\n- Award');
    const paragraphs: string[] = [];
    parser.parse(result).iterate({ enter(node) {
      if (node.name === 'Paragraph' && node.node.parent?.name === 'Document') paragraphs.push(result.slice(node.from, node.to));
    } });
    expect(paragraphs).toEqual(['2026.4 - Current', '2025.4 - 2026.3', '2024.12']);
    expect(normalizeMarkdownLayout(result)).toBe(result);
  });

  it('正しく字下げされた継続行・子リスト・空行をそのまま保つ', () => {
    const text = '- parent\n  continuation\n  - child\n    child continuation\n\n  another paragraph\n\noutside\n';
    expect(normalizeMarkdownLayout(text)).toBe(text);
    expect(normalizeMarkdownLayout('- parent\n   - child\n      continuation\nparent paragraph')).toBe('- parent\n   - child\n      continuation\n\nparent paragraph');
    expect(normalizeMarkdownLayout('- parent\n  - child\n  parent continuation')).toBe('- parent\n  - child\n\n  parent continuation');
  });

  it('コード・HTML の内容やリストの画像・チェックボックスを壊さない', () => {
    const literals = '```md\n- sample\n2024.1\n```\n\n    - code\n    2025.1\n\n<div>\n- html\n2026.1\n</div>\n';
    expect(normalizeMarkdownLayout(literals)).toBe(literals);
    const source = `${literals}\n- [ ] task\n  - ![photo](assets/photo.webp)\n2027.1`;
    expect(normalizeMarkdownLayout(source)).toBe(`${literals}\n- [ ] task\n  - ![photo](assets/photo.webp)\n\n2027.1`);
    expect(normalizeMarkdownLayout('- item\n# heading\n\n---\n')).toBe('- item\n# heading\n\n---\n');
  });

  it('番号付きリストの開始番号を保ち、段落との境界を明示する', () => {
    expect(normalizeMarkdownLayout('date\n2. first\n3. second\nnext')).toBe('date\n\n2. first\n3. second\n\nnext');
    expect(normalizeMarkdownLayout('- parent\n  2. child\n  3. next')).toBe('- parent\n\n  2. child\n  3. next');
  });

  it('改行コードと末尾改行を維持し、URL 変換と一緒に保存する', () => {
    expect(normalizeMarkdownLayout('- item\r\n2025.1\r\n')).toBe('- item\r\n\r\n2025.1\r\n');
    expect(toMarkdown('- [https://example.com label]\n2025.1')).toBe('- [label](https://example.com)\n\n2025.1');
    expect(normalizeMarkdownLayout('a\nb')).toBe('a\nb');
  });
});
