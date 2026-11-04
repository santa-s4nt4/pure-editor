export interface TouchPoint { x: number; y: number; time: number }
/** Lock intent once so scrolling and long-press selection never turn into a swipe. */
export class TouchSwipe {
  private axis: 'x' | 'y' | null = null;
  private cancelled = false;
  constructor(private origin: TouchPoint) {}
  move(point: TouchPoint) {
    const dx = point.x - this.origin.x; const dy = point.y - this.origin.y;
    if (!this.axis && point.time - this.origin.time > 450) this.cancelled = true;
    if (!this.cancelled && !this.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= 10) this.axis = Math.abs(dx) > Math.abs(dy) * 1.5 ? 'x' : 'y';
    return { dx, dy, claimed: !this.cancelled && this.axis === 'x', cancelled: this.cancelled || this.axis === 'y' };
  }
}
export const rowActionWidth = 76;
export function rowSwipeOffset(dx: number, initial: number, width: number) {
  const offset = Math.max(-width, Math.min(0, initial + dx));
  return { offset, full: -offset >= Math.max(160, width * .6), open: -offset >= rowActionWidth / 2 };
}
export function touchHistoryProgress(dx: number, width: number) {
  const threshold = Math.min(96, Math.max(64, width * .22));
  return { progress: Math.min(1, Math.abs(dx) / threshold), complete: Math.abs(dx) >= threshold };
}
