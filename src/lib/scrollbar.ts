/** 常にレイアウト幅を変えず、スクロール中だけ細いインジケーターを重ねる。 */
export function scrollIndicator(scroller: HTMLElement, parent: HTMLElement): () => void {
  const track = document.createElement('div');
  const thumb = document.createElement('div');
  track.className = 'scroll-indicator'; thumb.className = 'scroll-indicator-thumb';
  track.setAttribute('aria-hidden', 'true'); track.append(thumb); parent.append(track);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    const total = scroller.scrollHeight;
    const visible = scroller.clientHeight;
    track.hidden = total <= visible + 1;
    const height = Math.max(24, visible * visible / total);
    thumb.style.blockSize = `${height}px`;
    thumb.style.transform = `translateY(${(visible - height) * scroller.scrollTop / Math.max(1, total - visible)}px)`;
  };
  const scroll = () => {
    update(); track.classList.add('is-scrolling'); clearTimeout(timer);
    timer = setTimeout(() => track.classList.remove('is-scrolling'), 650);
  };
  const observer = new ResizeObserver(update); observer.observe(scroller);
  const mutation = new MutationObserver(update); mutation.observe(scroller, { childList: true, subtree: true });
  scroller.addEventListener('scroll', scroll, { passive: true }); update();
  return () => { clearTimeout(timer); observer.disconnect(); mutation.disconnect(); scroller.removeEventListener('scroll', scroll); track.remove(); };
}
