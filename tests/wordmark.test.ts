import { describe, expect, it } from 'vitest';
import { HATCH_SETTINGS, WORDMARK_GAP, WORDMARK_PALETTES, WORDMARK_WIDTH, WordmarkClock, WordmarkFrame, wordmarkBitmapSize } from '../src/lib/wordmark';

// 返された線分から輪郭を測り直す。レイアウト用の bounds 自体を比較するだけにしない。
function inkBounds(frame: WordmarkFrame, glyph: number): [number, number] {
  const count = frame.strokeCount / 4;
  let left = Infinity, right = -Infinity;
  for (let i = glyph * count; i < (glyph + 1) * count; i++) {
    const at = i * 4, lines = frame.segments;
    const x1 = lines[at], y1 = lines[at + 1], x2 = lines[at + 2], y2 = lines[at + 3];
    const radius = HATCH_SETTINGS.strokeWeight / 2 * Math.abs(y2 - y1) / Math.hypot(x2 - x1, y2 - y1);
    left = Math.min(left, Math.min(x1, x2) - radius);
    right = Math.max(right, Math.max(x1, x2) + radius);
  }
  return [left, right];
}

describe('動くワードマークの位置と描画', () => {
  it('動きの途中やノイズの切り替え後もPの左端と3つの文字間を揃える', () => {
    const frame = new WordmarkFrame();
    for (const time of [0, 0.25, 0.5, 0.999, 1, 1.25, 2, 4.3, 15]) {
      frame.update(time);
      const bounds = Array.from({ length: 4 }, (_, i) => inkBounds(frame, i));
      expect(bounds[0][0]).toBeCloseTo(0, 3);
      for (let i = 1; i < 4; i++) expect(bounds[i][0] - bounds[i - 1][1]).toBeCloseTo(WORDMARK_GAP, 3);
      expect(bounds[3][1]).toBeLessThan(WORDMARK_WIDTH);
      expect(frame.segments.every(Number.isFinite)).toBe(true);
      expect(frame.colors.every(index => WORDMARK_PALETTES.light[index] && WORDMARK_PALETTES.dark[index])).toBe(true);
    }
  });
  it('線分バッファを再利用し、ノイズの区間境界でも連続して動く', () => {
    const frame = new WordmarkFrame(), buffer = frame.segments;
    const before = frame.update(1 - 0.00001).segments.slice();
    frame.update(1 + 0.00001);
    expect(frame.segments).toBe(buffer);
    expect(Math.max(...frame.segments.map((value, i) => Math.abs(value - before[i])))).toBeLessThan(0.01);
    frame.update(1.5);
    expect(frame.segments.some((value, i) => Math.abs(value - before[i]) > 1)).toBe(true);
  });
  it('Retinaの解像度を保ち、非表示時は描画面の再確保を要求しない', () => {
    expect(wordmarkBitmapSize(184, 72.5, 1)).toEqual([184, 73]);
    expect(wordmarkBitmapSize(184, 72.5, 2)).toEqual([368, 145]);
    expect(wordmarkBitmapSize(184, 72.5, 3)).toEqual([552, 218]);
    expect(wordmarkBitmapSize(0, 0, 3)).toBeNull();
  });
});

describe('画面のリフレッシュレートに依存しないアニメーション', () => {
  it.each([30, 60, 120, 144])('%iHzの入力で30fps・同じ速度を保つ', hz => {
    const clock = new WordmarkClock(); clock.start(0);
    let paints = 0;
    for (let i = 1; i <= hz * 4; i++) if (clock.tick(i * 1000 / hz)) paints++;
    expect(paints).toBe(120);
    expect(clock.time).toBeCloseTo(4 * 60 * 0.012 * HATCH_SETTINGS.speed, 8);
  });
  it('停止からの復帰で時刻を飛ばさず、遅れたフレームを連続描画しない', () => {
    const clock = new WordmarkClock(); clock.start(0);
    clock.tick(1000 / 30);
    const before = clock.time;
    clock.start(60000); clock.tick(60000 + 1000 / 30);
    expect(clock.time).toBeCloseTo(before * 2, 8);
    expect(clock.tick(60500)).toBe(true);
    expect(clock.tick(60500)).toBe(false);
  });
  it.each([60, 120])('%iHzの時刻が1ms単位でもフレームを取りこぼさない', hz => {
    const clock = new WordmarkClock(); clock.start(0);
    let paints = 0;
    for (let i = 1; i <= hz * 4; i++) if (clock.tick(Math.floor(i * 1000 / hz))) paints++;
    expect(paints).toBe(120);
  });
});
