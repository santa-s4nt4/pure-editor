// Web Locks serialize access across webviews. The fallback keeps single-window
// operation working in environments without Web Locks (including unit tests).
const queues = new Map<string, Promise<unknown>>();
export async function workspaceLock<T>(key: string | undefined, task: () => Promise<T>): Promise<T> {
  if (!key) return task();
  if (navigator.locks) return navigator.locks.request(key, task);
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(task);
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => undefined);
  return next;
}

export type WorkspaceChange = { kind: 'files' | 'settings'; folder: string };
export function workspaceChannel(receive: (change: WorkspaceChange) => void) {
  const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('pure-workspace');
  if (channel) channel.onmessage = event => {
    const change = event.data;
    if (change && (change.kind === 'files' || change.kind === 'settings') && typeof change.folder === 'string') receive(change);
  };
  return {
    post: (kind: WorkspaceChange['kind'], folder: string) => channel?.postMessage({ kind, folder }),
    close: () => channel?.close(),
  };
}
