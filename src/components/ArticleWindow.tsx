import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { createEditor } from '../lib/editor';
import { PaperNotebook, isPaperPath } from '../lib/paper-notebook';
import { filenameTitle } from '../lib/note-filenames';
import { createBackend, loadSettings, native, safeRelativePath, StorageManager } from '../lib/storage';
import { fromMarkdown, isExternalUrl, noteTitle } from '../lib/transformer';

/** A reading window never initializes an index, saves a document, or starts R2 sync. */
export default function ArticleWindow() {
  let host!: HTMLDivElement;
  let editor: ReturnType<typeof createEditor> | undefined;
  let disposed = false;
  const [error, setError] = createSignal('');
  onMount(() => {
    void (async () => {
      try {
        let path = safeRelativePath(new URLSearchParams(location.search).get('article') ?? '');
        if (!/\.md$/i.test(path) && !isPaperPath(path)) throw new Error('記事のパスが不正です。');
        const settings = await loadSettings();
        const backend = await createBackend(settings);
        const aliases = await backend.read('_note-renames.json');
        if (aliases) {
          const moves: Record<string, string> = JSON.parse(new TextDecoder().decode(aliases));
          const seen = new Set<string>();
          while (moves[path] && !seen.has(path)) { seen.add(path); path = safeRelativePath(moves[path]); }
        }
        let text: string;
        if (isPaperPath(path)) {
          const notebook = new PaperNotebook(backend, null); await notebook.initialize();
          const content = await notebook.readNote(path);
          if (content === null) throw new Error('Paper がローカルに保存されていません。');
          text = content;
        } else {
          const bytes = await backend.read(path);
          if (!bytes) throw new Error('記事が見つかりません。');
          text = fromMarkdown(new TextDecoder().decode(bytes));
        }
        if (disposed) return;
        const title = noteTitle(text, filenameTitle(path));
        document.title = `${title} — pure`;
        document.documentElement.dataset.theme = settings.theme ?? 'auto';
        editor = createEditor({ parent: host, text, readOnly: true, storage: new StorageManager(backend), tags: () => [], onChange: () => {}, onSave: () => {}, onError: setError,
          onReference: reference => {
            if (reference.kind !== 'url' || !isExternalUrl(reference.value)) return;
            if (native) void openUrl(reference.value).catch(error => setError(String(error)));
            else window.open(reference.value, '_blank', 'noopener,noreferrer');
          },
        });
        if (native) {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          if (disposed) return;
          const win = getCurrentWindow();
          await win.setTitle(title);
          await win.setTheme(settings.theme === 'auto' || !settings.theme ? null : settings.theme);
          await invoke('refresh_display');
        }
      } catch (error) { if (!disposed) setError(String(error)); }
    })();
  });
  onCleanup(() => { disposed = true; editor?.destroy(); });
  return <main class="paper article-window" aria-label="記事の閲覧">
    <Show when={native}><div class="native-title-region" data-tauri-drag-region /></Show>
    <div class="writing-surface" ref={host} />
    <Show when={error()}><div class="startup-message" role="alert">{error()}</div></Show>
  </main>;
}
