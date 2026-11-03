import { describe, expect, it } from 'vitest';
import { articleOutline } from '../src/lib/outline';

describe('記事内の目次', () => {
  it('コードやエスケープされた # を除き、実際の見出し位置と階層を返す', () => {
    const text = '# 題名\n\n```md\n## コードの例\n```\n\n\\# ただの文字\n\n## 日付\n### メモ\n';
    expect(articleOutline(text)).toEqual([
      { from: 0, level: 1, title: '題名' },
      { from: text.indexOf('## 日付'), level: 2, title: '日付' },
      { from: text.indexOf('### メモ'), level: 3, title: 'メモ' },
    ]);
  });
  it('空のタイトルは省き、見出し中のリンクやタグを表示名にする', () => {
    const text = '# \n\n## **資料** [https://example.com 読む] [仕事] ##\n';
    expect(articleOutline(text)).toEqual([{ from: 4, level: 2, title: '資料 読む 仕事' }]);
  });
  it('同名の見出しも別々の位置を保ち、Setext 見出しを扱う', () => {
    const text = '題名\n===\n\n## 同じ名前\n\n## 同じ名前\n';
    const headings = articleOutline(text);
    expect(headings.map(heading => heading.level)).toEqual([1, 2, 2]);
    expect(headings[1].from).not.toBe(headings[2].from);
    expect(headings.map(heading => text.slice(heading.from).split('\n')[0])).toEqual(['題名', '## 同じ名前', '## 同じ名前']);
  });
});
