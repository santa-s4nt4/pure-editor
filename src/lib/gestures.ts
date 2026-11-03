/** Trackpad wheel sequences include momentum. Navigate at most once per sequence. */
export class HistorySwipe {
  private last = -Infinity;
  private axis: 'x' | 'y' | null = null;
  private x = 0;
  private y = 0;
  private fired = false;

  reset() { this.last = -Infinity; this.axis = null; this.x = this.y = 0; this.fired = false; }

  feed(event: { deltaX: number; deltaY: number; deltaMode: number; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }, now: number) {
    if (now - this.last > 220) this.reset();
    this.last = now;
    if (event.deltaMode !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) { this.axis = 'y'; return { claim: false, direction: null }; }
    this.x += event.deltaX; this.y += event.deltaY;
    if (!this.axis && Math.max(Math.abs(this.x), Math.abs(this.y)) >= 10) {
      this.axis = Math.abs(this.x) > Math.abs(this.y) * 1.7 ? 'x' : 'y';
    }
    let direction: -1 | 1 | null = null;
    if (this.axis === 'x' && !this.fired && Math.abs(this.x) >= 100) {
      this.fired = true; direction = this.x < 0 ? -1 : 1;
    }
    return { claim: this.axis === 'x', direction };
  }
}

export function outlineScrollsArticle(overPanel: boolean, panelHeight: number, contentHeight: number) {
  return !overPanel || contentHeight <= panelHeight + 1;
}

export function wheelDistance(delta: number, mode: number, lineHeight: number, pageHeight: number) {
  return delta * (mode === 1 ? lineHeight : mode === 2 ? pageHeight : 1);
}
