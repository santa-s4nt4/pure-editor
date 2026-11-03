// docs/pure_test.html のハッチ描画を移植。添付のパラメータを固定し、UIやCDN依存は持ち込まない。
export const HATCH_SETTINGS = Object.freeze({
  bgGray: 255, strokeMin: 0, strokeMax: 180, density: 250, strokeWeight: 2,
  alpha: 53, span: 65, lengthMult: 1.25, crossHatch: true,
  noiseScale: 0.030, turbulence: 125, speed: 0.1, pThickness: 44, pBowlRatio: 1.20,
  seed: 1024,
});
const hatch = HATCH_SETTINGS;
type Point = { x: number; y: number; tx: number; ty: number };
export const WORDMARK_WIDTH = 2600;
export const WORDMARK_HEIGHT = 1024;
export const WORDMARK_GAP = 80;
const height = WORDMARK_HEIGHT, scale = height / 780;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

function letterSpines(): Point[][] {
  const stemX = 512 - 95 * scale, topY = 512 - 230 * scale, midY = 512 + 15 * scale;
  const bottomY = 512 + 230 * scale;
  const letters: Point[][] = [];
  const path = (offset: number) => {
    const points: Point[] = []; letters.push(points);
    const sample = (steps: number, fn: (t: number) => [number, number]) => {
      for (let i = 0; i <= steps; i++) {
        const t = i / steps, [x, y] = fn(t);
        const [ax, ay] = fn(Math.max(0, t - 0.001)), [bx, by] = fn(Math.min(1, t + 0.001));
        const length = Math.hypot(bx - ax, by - ay) || 1;
        points.push({ x: x + offset, y, tx: (bx - ax) / length, ty: (by - ay) / length });
      }
    };
    return {
      sample,
      line: (x1: number, y1: number, x2: number, y2: number, steps = 60) => sample(steps, t => [lerp(x1, x2, t), lerp(y1, y2, t)]),
    };
  };
  // p の芯線は参照ツールと同じ。残りの文字も芯線から同じハッチを描く。
  const p = path(0), flat = 45 * scale * hatch.pBowlRatio;
  p.line(stemX, bottomY, stemX, topY, 75);
  p.line(stemX, topY, stemX + flat, topY, 20);
  p.sample(70, t => {
    const angle = lerp(-Math.PI / 2, Math.PI / 2, t);
    return [stemX + flat + Math.cos(angle) * 135 * scale * hatch.pBowlRatio, (topY + midY) / 2 + Math.sin(angle) * (midY - topY) / 2];
  });
  p.line(stemX + flat, midY, stemX, midY, 20);
  const u = path(650), radius = 110 * scale, base = midY - radius;
  u.line(stemX, topY, stemX, base);
  u.sample(70, t => [stemX + radius + Math.cos(Math.PI * (1 - t)) * radius, base + Math.sin(Math.PI * (1 - t)) * radius]);
  u.line(stemX + 2 * radius, midY, stemX + 2 * radius, topY);
  const r = path(1250);
  r.line(stemX, midY, stemX, topY);
  r.sample(70, t => {
    const a = 1 - t;
    return [stemX + (3 * a * t * t + t * t * t) * 195 * scale,
      a * a * a * (topY + 125 * scale) + 3 * a * a * t * (topY - 35 * scale) + 3 * a * t * t * (topY - 35 * scale) + t * t * t * (topY + 65 * scale)];
  });
  const e = path(1720), rx = 120 * scale, ry = (midY - topY) / 2, center = (midY + topY) / 2;
  e.line(stemX, center, stemX + 2 * rx, center);
  e.sample(150, t => { const angle = -1.75 * Math.PI * t; return [stemX + rx + Math.cos(angle) * rx, center + Math.sin(angle) * ry]; });
  return letters;
}

const thickness = hatch.pThickness * scale;
const baseAngle = lerp(-Math.PI / 2, Math.PI / 2, (hatch.span - 15) / 145);
const turbulence = hatch.turbulence / 100 * Math.PI;
const crossCos = Math.cos(Math.PI / 2 * 0.75), crossSin = Math.sin(Math.PI / 2 * 0.75);
const smooth = (t: number) => t * t * (3 - 2 * t);
function hash(x: number, y: number, z: number): number {
  let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177) ^ hatch.seed;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

const rng = random(hatch.seed);
// 芯線・線長の固定部分・ノイズのXY補間係数は、毎フレーム計算し直さない。
const glyphs = letterSpines().map(spine => {
  const stride = spine.length % 7 === 0 ? 11 : 7;
  return Array.from({ length: hatch.density }, (_, i) => {
    const source = spine[Math.floor(rng() * spine.length)];
    const offset = (rng() * 2 - 1 + rng() * 2 - 1) / 2;
    const point = spine[(i * stride) % spine.length];
    const x = point.x - source.ty * offset * thickness * 0.85;
    const y = point.y + source.tx * offset * thickness * 0.85;
    const nx = x * hatch.noiseScale, ny = y * hatch.noiseScale;
    return {
      x, y, ix: Math.floor(nx), iy: Math.floor(ny),
      u: smooth(nx - Math.floor(nx)), v: smooth(ny - Math.floor(ny)),
      length: thickness * Math.sqrt(Math.max(0.1, 1 - offset * offset)) * hatch.lengthMult,
      tone: (i % 17) / 16 * 0.3, crossTone: ((i + 5) % 17) / 16 * 0.3,
      cross: hatch.crossHatch && i % 3 === 0,
    };
  });
});
const features = glyphs.flat();
const strokesPerGlyph = hatch.density + Math.ceil(hatch.density / 3);
const shadeCount = hatch.strokeMax + 1;
const palette = (dark: boolean) => Array.from({ length: shadeCount * 2 }, (_, i) => {
  const gray = i % shadeCount, channel = dark ? 255 - gray : gray;
  return `rgba(${channel},${channel},${channel},${hatch.alpha / 100 * (i >= shadeCount ? 0.55 : 1)})`;
});
export const WORDMARK_PALETTES = Object.freeze({ light: palette(false), dark: palette(true) });

/** Canvasへ渡す線分を再利用する。生成中にオブジェクトや色文字列を増やさない。 */
export class WordmarkFrame {
  readonly strokeCount = strokesPerGlyph * glyphs.length;
  readonly segments = new Float32Array(this.strokeCount * 4);
  readonly colors = new Uint16Array(this.strokeCount);
  /** 各文字の線の輪郭の左右端。Canvas 内部の余白ではなく、この輪郭を揃える。 */
  readonly bounds = new Float64Array(glyphs.length * 2);
  private readonly low = new Float64Array(features.length);
  private readonly high = new Float64Array(features.length);
  private band = Number.NaN;
  private stroke = 0;
  private min = Infinity;
  private max = -Infinity;

  private sampleBand(band: number) {
    if (this.band === band) return;
    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      for (let k = 0; k <= 1; k++) {
        const z = band + k;
        const value = lerp(lerp(hash(f.ix, f.iy, z), hash(f.ix + 1, f.iy, z), f.u), lerp(hash(f.ix, f.iy + 1, z), hash(f.ix + 1, f.iy + 1, z), f.u), f.v);
        (k === 0 ? this.low : this.high)[i] = value;
      }
    }
    this.band = band;
  }

  private segment(x: number, y: number, dx: number, dy: number, length: number, color: number) {
    const index = this.stroke * 4;
    this.segments[index] = x - dx; this.segments[index + 1] = y - dy;
    this.segments[index + 2] = x + dx; this.segments[index + 3] = y + dy;
    this.colors[this.stroke++] = color;
    // butt cap の線幅も含めた実際の輪郭。端を切らず、Pの左端を0へ揃える。
    const radius = Math.abs(dx) + hatch.strokeWeight / 2 * Math.abs(dy) / length;
    this.min = Math.min(this.min, x - radius); this.max = Math.max(this.max, x + radius);
  }

  update(time: number): this {
    const band = Math.floor(time), phase = smooth(time - band);
    this.sampleBand(band);
    this.stroke = 0;
    let feature = 0, left = 0;
    for (let glyph = 0; glyph < glyphs.length; glyph++) {
      const firstStroke = this.stroke;
      this.min = Infinity; this.max = -Infinity;
      const strokes = glyphs[glyph];
      for (let i = 0; i < strokes.length; i++) {
        const f = strokes[i];
        const n = lerp(this.low[feature], this.high[feature], phase); feature++;
        const angle = baseAngle + (n - 0.5) * turbulence;
        const length = f.length * (0.65 + n * 0.7);
        const dx = Math.cos(angle) * length, dy = Math.sin(angle) * length;
        this.segment(f.x, f.y, dx, dy, length, Math.round(lerp(hatch.strokeMin, hatch.strokeMax, Math.min(1, n * 0.7 + f.tone))));
        if (f.cross) this.segment(f.x, f.y, (dx * crossCos - dy * crossSin) * 0.6, (dx * crossSin + dy * crossCos) * 0.6, length * 0.6,
          shadeCount + Math.round(lerp(hatch.strokeMin, hatch.strokeMax, Math.min(1, (1 - n) * 0.7 + f.crossTone))));
      }
      const offset = left - this.min;
      for (let i = firstStroke; i < this.stroke; i++) { this.segments[i * 4] += offset; this.segments[i * 4 + 2] += offset; }
      this.bounds[glyph * 2] = left;
      this.bounds[glyph * 2 + 1] = left + this.max - this.min;
      left = this.bounds[glyph * 2 + 1] + WORDMARK_GAP;
    }
    return this;
  }
}

/** 60/120Hzでも端数を蓄積させず30fpsを保つ。動きの速度は経過時間から求める。 */
export class WordmarkClock {
  time = 0;
  private previous = 0;
  private next = 0;
  private readonly interval = 1000 / 30;
  private readonly tolerance = 1; // 丸められた1ms単位のフレーム時刻にも対応する。
  start(now: number) { this.previous = now; this.next = now + this.interval; }
  tick(now: number): boolean {
    if (now + this.tolerance < this.next) return false;
    this.time += Math.max(0, now - this.previous) / 1000 * 60 * 0.012 * hatch.speed;
    this.previous = now;
    this.next += this.interval * Math.max(1, Math.floor((now + this.tolerance - this.next) / this.interval) + 1);
    return true;
  }
}

export function wordmarkBitmapSize(width: number, height: number, deviceRatio: number): [number, number] | null {
  if (!(width > 0 && height > 0)) return null;
  const ratio = Math.min(3, Math.max(1, deviceRatio || 1));
  return [Math.ceil(width * ratio), Math.ceil(height * ratio)];
}
