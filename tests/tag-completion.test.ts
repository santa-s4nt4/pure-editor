import { expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { matchingTags, tagCompletion, tagContext } from '../src/lib/tag-completion';

function contextAt(source: string) {
  const position = source.indexOf('|');
  return tagContext(source.replace('|', ''), position);
}

it('角括弧内の日本語と途中の編集位置を認識する', () => {
  expect(contextAt('[読|書]')).toEqual({ from: 1, to: 3, query: '読', closed: true });
  expect(contextAt('本文 [|]')).toMatchObject({ query: '', closed: true });
  expect(contextAt('[読|')).toMatchObject({ query: '読', closed: false });
  expect(contextAt('- [読|]')).toMatchObject({ query: '読' });
});

it('URL、コード、画像、Markdownリンク、タスク、角括弧の外には候補を出さない', () => {
  for (const source of ['[https://example.com|]', '[https://example.com label|]', '`[読|]`', '```\n[読|]\n```', '![読|](a.png)', '[読|](https://example.com)', '\\[読|]', '- [|]', '- [x|]', '- [ |]', '[読書] |', '[読\n書|]']) {
    expect(contextAt(source), source).toBeNull();
  }
});

it('前方一致を優先し、頻度と部分一致で絞り、既存の表記を保持する', () => {
  expect(matchingTags(['本の感想', '読書', '読書', '読書メモ', '本の感想'], '書')).toEqual(['読書', '読書メモ']);
  expect(matchingTags(['myBook', 'Book', 'Book'], 'bo')).toEqual(['Book', 'myBook']);
  expect(matchingTags(['読書', '読書', '音楽'], '')).toEqual([]);
  expect(matchingTags(['読書'], '   ')).toEqual([]);
  expect(matchingTags(Array.from({ length: 40 }, (_, i) => `タグ${i}`), 'タグ')).toHaveLength(30);
});

it('選択したタグは括弧内全体を置換し、閉じ括弧の外へカーソルを移す', async () => {
  for (const text of ['[読書]', '[読書']) {
    const state = EditorState.create({ doc: text, selection: { anchor: 2 } });
    const result = await tagCompletion(() => ['読書メモ'])(new CompletionContext(state, 2, false));
    expect(result?.options[0].label).toBe('読書メモ');
    const apply = result!.options[0].apply;
    if (typeof apply !== 'function') throw new Error('missing apply');
    let next = state;
    const view = { state, dispatch: (spec: Parameters<typeof state.update>[0]) => { next = state.update(spec).state; } };
    apply(view as never, result!.options[0], result!.from, result!.to!);
    expect(next.doc.toString()).toBe('[読書メモ]');
    expect(next.selection.main.head).toBe(6);
  }
});

it('空の括弧では明示的な補完操作でも候補を出さず、文字入力から始める', async () => {
  for (const explicit of [true, false]) {
    const state = EditorState.create({ doc: '[]', selection: { anchor: 1 } });
    expect(await tagCompletion(() => ['読書'])(new CompletionContext(state, 1, explicit))).toBeNull();
  }
});
