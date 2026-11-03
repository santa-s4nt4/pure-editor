import { expect, it } from 'vitest';
import { NavigationHistory } from '../src/lib/navigation';

it('記事とタグ一覧の履歴、選択とスクロール位置を保持する', () => {
  const history = new NavigationHistory();
  history.push({ kind: 'note', path: 'a.md' }, { kind: 'home', scroll: 100 });
  history.push({ kind: 'home', tag: '本' }, { kind: 'note', path: 'a.md', anchor: 20, head: 24, scroll: 240 });
  expect(history.move(-1, { kind: 'home', tag: '本' })).toMatchObject({ path: 'a.md', anchor: 20, head: 24, scroll: 240 });
  expect(history.move(-1, { kind: 'note', path: 'a.md' })).toMatchObject({ kind: 'home', scroll: 100 });
  expect(history.move(-1, { kind: 'home' })).toBeNull();
  expect(history.move(1, { kind: 'home' })).toMatchObject({ path: 'a.md' });
});
it('戻った先で別の記事へ移動すると、古い進む履歴を破棄する', () => {
  const history = new NavigationHistory();
  history.push({ kind: 'note', path: 'a.md' }, { kind: 'home' });
  history.move(-1, { kind: 'note', path: 'a.md' });
  history.push({ kind: 'note', path: 'b.md' }, { kind: 'home' });
  expect(history.move(1, { kind: 'note', path: 'b.md' })).toBeNull();
});
