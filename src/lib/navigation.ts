export interface Visit { kind: 'home' | 'note'; path?: string; tag?: string; query?: string; anchor?: number; head?: number; scroll?: number }
const key = (visit: Visit) => `${visit.kind}:${visit.path ?? ''}:${visit.tag ?? ''}`;

export class NavigationHistory {
  private entries: Visit[] = [{ kind: 'home' }];
  private index = 0;
  push(next: Visit, current: Visit) {
    this.entries[this.index] = { ...current };
    if (key(next) === key(current)) return;
    this.entries.splice(this.index + 1);
    this.entries.push({ ...next }); this.index++;
  }
  move(direction: number, current: Visit, available: (visit: Visit) => boolean = () => true): Visit | null {
    this.entries[this.index] = { ...current };
    for (let index = this.index + direction; index >= 0 && index < this.entries.length; index += direction) {
      if (available(this.entries[index])) { this.index = index; return { ...this.entries[index] }; }
    }
    return null;
  }
  canMove(direction: number, available: (visit: Visit) => boolean = () => true) {
    for (let index = this.index + direction; index >= 0 && index < this.entries.length; index += direction) if (available(this.entries[index])) return true;
    return false;
  }
  renamePaths(resolve: (path: string) => string) {
    this.entries = this.entries.map(visit => visit.path ? { ...visit, path: resolve(visit.path) } : visit);
  }
  reset() { this.entries = [{ kind: 'home' }]; this.index = 0; }
}
