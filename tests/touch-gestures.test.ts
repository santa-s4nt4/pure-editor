import { expect, it } from 'vitest';
import { TouchSwipe, rowSwipeOffset, touchHistoryProgress } from '../src/lib/touch-gestures';
const start = { x: 100, y: 100, time: 0 };
it('縦スクロールの後で横へ動かしてもスワイプに切り替えない', () => {
  const swipe = new TouchSwipe(start);
  expect(swipe.move({ x: 105, y: 125, time: 20 })).toMatchObject({ claimed: false, cancelled: true });
  expect(swipe.move({ x: 250, y: 125, time: 40 }).claimed).toBe(false);
});
it('長押しによる文字選択は履歴移動や削除にしない', () => {
  const swipe = new TouchSwipe(start);
  expect(swipe.move({ x: 102, y: 100, time: 500 }).cancelled).toBe(true);
  expect(swipe.move({ x: 260, y: 100, time: 600 }).claimed).toBe(false);
});
it('横スワイプは小さい揺れを無視し、端の移動距離で履歴を確定する', () => {
  const swipe = new TouchSwipe(start);
  expect(swipe.move({ x: 104, y: 101, time: 10 }).claimed).toBe(false);
  expect(swipe.move({ x: 140, y: 104, time: 40 }).claimed).toBe(true);
  expect(touchHistoryProgress(40, 390).complete).toBe(false);
  expect(touchHistoryProgress(-100, 390)).toEqual({ complete: true, progress: 1 });
});
it('短いスワイプで削除ボタンを開き、深いスワイプだけ削除を確定する', () => {
  expect(rowSwipeOffset(-25, 0, 340)).toMatchObject({ open: false, full: false });
  expect(rowSwipeOffset(-90, 0, 340)).toMatchObject({ open: true, full: false });
  expect(rowSwipeOffset(-230, 0, 340)).toMatchObject({ open: true, full: true });
  expect(rowSwipeOffset(60, -76, 340)).toMatchObject({ open: false, full: false });
  expect(rowSwipeOffset(40, 0, 340).offset).toBe(0);
});
