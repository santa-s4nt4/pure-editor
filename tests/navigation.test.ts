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
it('改名後も履歴と選択位置を保持し、移動可能な向きを調べる', () => {
  const history = new NavigationHistory();
  history.push({ kind: 'note', path: 'old.md', anchor: 12 }, { kind: 'home' });
  history.renamePaths(path => path === 'old.md' ? 'new.md' : path);
  expect(history.canMove(-1)).toBe(true);
  expect(history.canMove(1)).toBe(false);
  history.move(-1, { kind: 'note', path: 'new.md', anchor: 12 });
  expect(history.canMove(1, visit => visit.path !== 'new.md')).toBe(false);
  expect(history.move(1, { kind: 'home' })).toMatchObject({ path: 'new.md', anchor: 12 });
});
