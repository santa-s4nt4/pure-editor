/** Preserve momentum suppression while allowing a deliberate direction reversal. */
export class HistorySwipe {
  private last = -Infinity;
  private axis: 'x' | 'y' | null = null;
  private x = 0;
  private y = 0;
  private fired = false;
  private firedSign = 0;
  private reversal = 0;

  reset() { this.last = -Infinity; this.axis = null; this.x = this.y = 0; this.fired = false; this.firedSign = this.reversal = 0; }

  feed(event: { deltaX: number; deltaY: number; deltaMode: number; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; began?: boolean; momentum?: boolean }, now: number) {
    if (event.began || now - this.last > 220) this.reset();
    this.last = now;
    if (event.deltaMode !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) { this.axis = 'y'; return this.result(null); }
    // A reversal is a new intent, even when no finger lift/idle event reaches the DOM.
    if (this.fired) {
      if (event.momentum) return this.result(null);
      if (Math.sign(event.deltaX) === -this.firedSign && Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.7) this.reversal += Math.abs(event.deltaX);
      else if (Math.sign(event.deltaX) === this.firedSign) this.reversal = 0;
      if (this.reversal >= 24) { this.x = -this.firedSign * this.reversal; this.y = 0; this.fired = false; this.reversal = 0; }
      else return this.result(null);
    } else { this.x += event.deltaX; this.y += event.deltaY; }
    if (!this.axis && Math.max(Math.abs(this.x), Math.abs(this.y)) >= 10) {
      this.axis = Math.abs(this.x) > Math.abs(this.y) * 1.7 ? 'x' : 'y';
    }
    let direction: -1 | 1 | null = null;
    if (this.axis === 'x' && !this.fired && Math.abs(this.x) >= 100) {
      this.fired = true; this.firedSign = Math.sign(this.x); direction = this.x < 0 ? -1 : 1;
    }
    return this.result(direction);
  }
  private result(direction: -1 | 1 | null) {
    return { claim: this.axis === 'x', direction, side: this.axis === 'x' && this.x ? (this.x < 0 ? -1 : 1) as -1 | 1 : null, progress: this.axis === 'x' ? Math.min(1, Math.abs(this.x) / 100) : 0 };
  }
}

export function outlineScrollsArticle(overPanel: boolean, panelHeight: number, contentHeight: number) {
  return !overPanel || contentHeight <= panelHeight + 1;
}

export function wheelDistance(delta: number, mode: number, lineHeight: number, pageHeight: number) {
  return delta * (mode === 1 ? lineHeight : mode === 2 ? pageHeight : 1);
}
