import { createEffect, onCleanup, onMount } from 'solid-js';

// docs/pure_test.html のハッチ描画を移植。添付のパラメータを固定し、UIやCDN依存は持ち込まない。
const hatch = Object.freeze({
  bgGray: 255, strokeMin: 0, strokeMax: 180, density: 250, strokeWeight: 2,
  alpha: 53, span: 65, lengthMult: 1.25, crossHatch: true,
  noiseScale: 0.030, turbulence: 125, speed: 0.1, pThickness: 44, pBowlRatio: 1.20,
  seed: 1024,
});
type Point = { x: number; y: number; tx: number; ty: number };
const width = 2600, height = 1024, scale = height / 780;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

/** 連続する時刻の間も滑らかにつながる、seed固定の3次元value noise。 */
function noise(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const u = smooth(x - ix), v = smooth(y - iy), w = smooth(z - iz);
  const at = (a: number, b: number, c: number) => {
    let n = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ Math.imul(c, 1274126177) ^ hatch.seed;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  const layer = (k: number) => lerp(lerp(at(ix, iy, k), at(ix + 1, iy, k), u), lerp(at(ix, iy + 1, k), at(ix + 1, iy + 1, k), u), v);
  return lerp(layer(iz), layer(iz + 1), w);
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

const spines = letterSpines();
const rng = random(hatch.seed);
const nodes = spines.map(spine => Array.from({ length: hatch.density }, () => {
  const point = spine[Math.floor(rng() * spine.length)];
  return { nx: -point.ty, ny: point.tx, offset: (rng() * 2 - 1 + rng() * 2 - 1) / 2 };
}));

export default function AnimatedWordmark(props: { active: boolean }) {
  let canvas!: HTMLCanvasElement;
  let update = () => {};
  createEffect(() => { props.active; update(); });
  onMount(() => {
    const context = canvas.getContext('2d');
    if (!context) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const systemTheme = matchMedia('(prefers-color-scheme: dark)');
    let frame = 0, time = 0, previous = 0, inView = true, dark = false;
    let paper = '#fff';
    const draw = () => {
      context.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
      context.fillStyle = paper; context.fillRect(0, 0, width, height);
      context.lineWidth = hatch.strokeWeight;
      const thickness = hatch.pThickness * scale;
      const baseAngle = lerp(-Math.PI / 2, Math.PI / 2, (hatch.span - 15) / 145);
      const stroke = (x: number, y: number, angle: number, length: number, index: number, n: number, opacity: number) => {
        const tone = Math.max(0, Math.min(1, n * 0.7 + (index % 17) / 16 * 0.3));
        const gray = Math.round(lerp(hatch.strokeMin, hatch.strokeMax, tone));
        const channel = dark ? 255 - gray : gray;
        context.strokeStyle = `rgba(${channel},${channel},${channel},${hatch.alpha / 100 * opacity})`;
        const dx = Math.cos(angle) * length, dy = Math.sin(angle) * length;
        context.beginPath(); context.moveTo(x - dx, y - dy); context.lineTo(x + dx, y + dy); context.stroke();
      };
      for (let letter = 0; letter < spines.length; letter++) {
        const spine = spines[letter];
        for (let i = 0; i < hatch.density; i++) {
          const stride = spine.length % 7 === 0 ? 11 : 7;
          const point = spine[(i * stride) % spine.length], node = nodes[letter][i];
          const x = point.x + node.nx * node.offset * thickness * 0.85;
          const y = point.y + node.ny * node.offset * thickness * 0.85;
          const n = noise(x * hatch.noiseScale, y * hatch.noiseScale, time);
          const angle = baseAngle + (n - 0.5) * hatch.turbulence / 100 * Math.PI;
          const length = thickness * Math.sqrt(Math.max(0.1, 1 - node.offset * node.offset)) * (0.65 + n * 0.7) * hatch.lengthMult;
          stroke(x, y, angle, length, i, n, 1);
          if (hatch.crossHatch && i % 3 === 0) stroke(x, y, angle + Math.PI / 2 * 0.75, length * 0.6, i + 5, 1 - n, 0.55);
        }
      }
    };
    const paint = (now: number) => {
      frame = requestAnimationFrame(paint);
      if (now - previous < 1000 / 30) return;
      time += Math.min((now - previous) / 1000, 0.1) * 60 * 0.012 * hatch.speed;
      previous = now; draw();
    };
    const sync = () => {
      cancelAnimationFrame(frame); frame = 0;
      draw();
      if (props.active && inView && !document.hidden && !reduced.matches) { previous = performance.now(); frame = requestAnimationFrame(paint); }
    };
    const resize = () => {
      const bounds = canvas.getBoundingClientRect(), ratio = Math.min(devicePixelRatio || 1, 3);
      canvas.width = Math.max(1, Math.round(bounds.width * ratio));
      canvas.height = Math.max(1, Math.round(bounds.height * ratio));
      draw();
    };
    const theme = () => {
      const style = getComputedStyle(document.documentElement);
      paper = style.backgroundColor;
      dark = document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && systemTheme.matches);
      draw();
    };
    const colors = new MutationObserver(theme); colors.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const dimensions = new ResizeObserver(resize); dimensions.observe(canvas);
    const visibility = new IntersectionObserver(entries => { inView = entries[0].isIntersecting; sync(); }); visibility.observe(canvas);
    update = sync;
    theme(); resize(); sync();
    reduced.addEventListener('change', sync); systemTheme.addEventListener('change', theme);
    document.addEventListener('visibilitychange', sync); window.addEventListener('resize', resize);
    onCleanup(() => {
      update = () => {}; cancelAnimationFrame(frame); colors.disconnect(); dimensions.disconnect(); visibility.disconnect();
      reduced.removeEventListener('change', sync); systemTheme.removeEventListener('change', theme);
      document.removeEventListener('visibilitychange', sync); window.removeEventListener('resize', resize);
    });
  });
  return <span class="home-wordmark"><span class="visually-hidden">pure</span><canvas ref={canvas} width="520" height="205" aria-hidden="true" /></span>;
}
