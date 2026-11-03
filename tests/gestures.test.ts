import { expect, it } from 'vitest';
import { HistorySwipe, outlineScrollsArticle, wheelDistance } from '../src/lib/gestures';
const wheel = (deltaX: number, deltaY = 0) => ({ deltaX, deltaY, deltaMode: 0 });

it('左右のスワイプで一度だけ履歴移動し、慣性で再移動しない', () => {
  const swipe = new HistorySwipe();
  expect(swipe.feed(wheel(-40, 2), 0)).toMatchObject({ claim: true, direction: null });
  expect(swipe.feed(wheel(-70, 3), 16).direction).toBe(-1);
  for (let time = 32; time < 1000; time += 16) expect(swipe.feed(wheel(-10), time).direction).toBeNull();
  expect(swipe.feed(wheel(110), 1300).direction).toBe(1);
});

it('縦・斜めスクロールは後から横成分が増えても履歴を移動しない', () => {
  const swipe = new HistorySwipe();
  expect(swipe.feed(wheel(5, 20), 0).claim).toBe(false);
  expect(swipe.feed(wheel(200), 20)).toMatchObject({ claim: false, direction: null });
  expect(swipe.feed(wheel(110, 100), 400).claim).toBe(false);
});

it('ピンチ、修飾キー付き入力、マウスの行単位入力では動かない', () => {
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { deltaMode: 1 }]) {
    const swipe = new HistorySwipe();
    expect(swipe.feed({ ...wheel(150), ...modifiers }, 0)).toMatchObject({ claim: false, direction: null });
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

it('指を離さなくても逆方向へ十分に動かしたら進む・戻るを再判定する', () => {
  const swipe = new HistorySwipe();
  expect(swipe.feed(wheel(-120), 0).direction).toBe(-1);
  expect(swipe.feed(wheel(10), 16).direction).toBeNull();
  expect(swipe.feed(wheel(30), 32).direction).toBeNull();
  expect(swipe.feed(wheel(70), 48).direction).toBe(1);
  expect(swipe.feed(wheel(50), 64).direction).toBeNull();
  expect(swipe.feed(wheel(-110), 80).direction).toBe(-1);
});
it('ネイティブ入力の開始は待ち時間なしで再開し、慣性の逆振れは無視する', () => {
  const swipe = new HistorySwipe();
  expect(swipe.feed(wheel(-120), 0).direction).toBe(-1);
  expect(swipe.feed({ ...wheel(160), momentum: true }, 16).direction).toBeNull();
  expect(swipe.feed({ ...wheel(120), began: true }, 32).direction).toBe(1);
});
