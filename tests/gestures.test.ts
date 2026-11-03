import { expect, it } from 'vitest';
import { HistorySwipe, outlineScrollsArticle, wheelDistance } from '../src/lib/gestures';
const wheel = (deltaX: number, deltaY = 0) => ({ deltaX, deltaY, deltaMode: 0 });

it('左右のスワイプで一度だけ履歴移動し、慣性で再移動しない', () => {
  const swipe = new HistorySwipe();
  expect(swipe.feed(wheel(-40, 2), 0)).toEqual({ claim: true, direction: null });
  expect(swipe.feed(wheel(-70, 3), 16).direction).toBe(-1);
  for (let time = 32; time < 1000; time += 16) expect(swipe.feed(wheel(-10), time).direction).toBeNull();
  expect(swipe.feed(wheel(110), 1300).direction).toBe(1);
});

it('縦・斜めスクロールは後から横成分が増えても履歴を移動しない', () => {
  const swipe = new HistorySwipe();
  expect(swipe.feed(wheel(5, 20), 0).claim).toBe(false);
  expect(swipe.feed(wheel(200), 20)).toEqual({ claim: false, direction: null });
  expect(swipe.feed(wheel(110, 100), 400).claim).toBe(false);
});

it('ピンチ、修飾キー付き入力、マウスの行単位入力では動かない', () => {
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { deltaMode: 1 }]) {
    const swipe = new HistorySwipe();
    expect(swipe.feed({ ...wheel(150), ...modifiers }, 0)).toEqual({ claim: false, direction: null });
    expect(swipe.feed(wheel(150), 20).direction).toBeNull();
  }
});

it('長い目次の上だけ目次をスクロールし、余白や短い目次では本文へ送る', () => {
  expect(outlineScrollsArticle(true, 500, 500)).toBe(true);
  expect(outlineScrollsArticle(true, 500, 900)).toBe(false);
  expect(outlineScrollsArticle(false, 500, 900)).toBe(true);
  expect(wheelDistance(3, 1, 30, 600)).toBe(90);
  expect(wheelDistance(1, 2, 30, 600)).toBe(600);
  expect(wheelDistance(120, 0, 30, 600)).toBe(120);
});
