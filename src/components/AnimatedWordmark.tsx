import { createEffect, onCleanup, onMount } from 'solid-js';
import { HATCH_SETTINGS, WORDMARK_HEIGHT, WORDMARK_PALETTES, WORDMARK_WIDTH, WordmarkClock, WordmarkFrame, wordmarkBitmapSize } from '../lib/wordmark';

export default function AnimatedWordmark(props: { active: boolean }) {
  let canvas!: HTMLCanvasElement;
  let update = () => {};
  createEffect(() => { props.active; update(); });
  onMount(() => {
    // 背景は常に紙の色で塗るので、iOSでも透明な描画面を合成する必要はない。
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const systemTheme = matchMedia('(prefers-color-scheme: dark)');
    const geometry = new WordmarkFrame(), clock = new WordmarkClock();
    let frame = 0, inView = true, dark = false, sized = false;
    let paper = '#fff';
    const draw = () => {
      geometry.update(clock.time);
      context.fillStyle = paper; context.fillRect(0, 0, WORDMARK_WIDTH, WORDMARK_HEIGHT);
      const palette = dark ? WORDMARK_PALETTES.dark : WORDMARK_PALETTES.light;
      const segments = geometry.segments;
      for (let i = 0; i < geometry.strokeCount; i++) {
        const at = i * 4;
        context.strokeStyle = palette[geometry.colors[i]];
        context.beginPath(); context.moveTo(segments[at], segments[at + 1]);
        context.lineTo(segments[at + 2], segments[at + 3]); context.stroke();
      }
    };
    const paint = (now: number) => {
      frame = requestAnimationFrame(paint);
      if (clock.tick(now)) draw();
    };
    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const size = wordmarkBitmapSize(bounds.width, bounds.height, devicePixelRatio);
      // 非表示中の0サイズで1pxに縮めない。復帰直後のぼやけと不要な再確保を防ぐ。
      if (!size) return 0;
      if (!sized || canvas.width !== size[0] || canvas.height !== size[1]) {
        canvas.width = size[0]; canvas.height = size[1];
        context.setTransform(canvas.width / WORDMARK_WIDTH, 0, 0, canvas.height / WORDMARK_HEIGHT, 0, 0);
        context.lineWidth = HATCH_SETTINGS.strokeWeight;
        context.lineCap = 'butt';
        sized = true;
        return 2;
      }
      return 1;
    };
    const sync = () => {
      const size = resize();
      if (!size || !props.active || !inView || document.hidden || reduced.matches) {
        cancelAnimationFrame(frame); frame = 0;
        if (size) draw();
      } else if (!frame) {
        draw();
        clock.start(performance.now()); frame = requestAnimationFrame(paint);
      } else if (size === 2) {
        draw();
      }
      // キーボードや画面サイズが変わっても、実行中の時計は巻き戻さない。
    };
    const theme = () => {
      paper = getComputedStyle(document.documentElement).backgroundColor;
      dark = document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && systemTheme.matches);
      if (resize()) draw();
    };
    const colors = new MutationObserver(theme); colors.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const dimensions = new ResizeObserver(sync); dimensions.observe(canvas);
    const visibility = new IntersectionObserver(entries => { inView = entries[0].isIntersecting; sync(); }); visibility.observe(canvas);
    update = sync;
    theme(); sync();
    reduced.addEventListener('change', sync); systemTheme.addEventListener('change', theme);
    document.addEventListener('visibilitychange', sync); window.addEventListener('resize', sync);
    onCleanup(() => {
      update = () => {}; cancelAnimationFrame(frame); colors.disconnect(); dimensions.disconnect(); visibility.disconnect();
      reduced.removeEventListener('change', sync); systemTheme.removeEventListener('change', theme);
      document.removeEventListener('visibilitychange', sync); window.removeEventListener('resize', sync);
    });
  });
  return <span class="home-wordmark"><span class="visually-hidden">pure</span><canvas ref={canvas} width="520" height="205" aria-hidden="true" /></span>;
}
