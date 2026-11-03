import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { EditorView } from '@codemirror/view';
import { createEditor } from './lib/editor';
import { isExternalUrl, noteTitle, pagePath, type Reference } from './lib/transformer';
import { StorageManager, R2Backend, chooseFolder, createBackend, loadSettings, persistSettings, relocateImages, validateR2, mobile, native, type Note, type Settings } from './lib/storage';
import { scrollIndicator } from './lib/scrollbar';
import { NavigationHistory, type Visit } from './lib/navigation';
import { filenameTitle } from './lib/note-filenames';
import { articleOutline, type OutlineHeading } from './lib/outline';
import { HistorySwipe, outlineScrollsArticle, wheelDistance } from './lib/gestures';
import AnimatedWordmark from './components/AnimatedWordmark';

type PaletteAction = { id: string; label: string; detail: string; kind: 'note' | 'action'; run(): void | Promise<void> };
const introduction = '# 余白から、はじめる。\n\n考えていることを、ひとつずつ。\n言葉にすると、少しだけ輪郭が見えてくる。\n\npure は、書くための静かな場所です。\n\n⌘ L でノートを探す。⌘ N で新しく書く。\n[思いついたこと] のように囲めば、タグになります。\n同じタグの文章を、まとめて見返せます。\n\n画像を置く。動画の URL を貼る。\n書いたものは、ふつうの Markdown として残ります。\n';

export default function App() {
  const [ready, setReady] = createSignal(false);
  const [notes, setNotes] = createSignal<Note[]>([]);
  const [activePath, setActivePath] = createSignal('');
  const [home, setHome] = createSignal(true);
  const [homeQuery, setHomeQuery] = createSignal('');
  const [homeTag, setHomeTag] = createSignal('');
  const [activeTitle, setActiveTitle] = createSignal('');
  const [deleted, setDeleted] = createSignal<{ path: string; backup: string } | null>(null);
  const [palette, setPalette] = createSignal(false);
  const [screen, setScreen] = createSignal<'notes' | 'settings'>('notes');
  const [query, setQuery] = createSignal('');
  const [selected, setSelected] = createSignal(0);
  const [settings, setSettings] = createSignal<Settings | null>(null);
  const [draft, setDraft] = createSignal<Settings | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [syncStatus, setSyncStatus] = createSignal('同期はオフです');
  const [settingsError, setSettingsError] = createSignal('');
  const [startupError, setStartupError] = createSignal('');
  const [outline, setOutline] = createSignal<OutlineHeading[]>([]);
  const [outlineCurrent, setOutlineCurrent] = createSignal<number | null>(null);
  const [outlineGutter, setOutlineGutter] = createSignal(0);
  const outlineLevel = createMemo(() => Math.min(6, ...outline().map(heading => heading.level)));
  const existingTags = createMemo(() => notes().flatMap(note => note.tags));
  let paper!: HTMLElement;
  let host!: HTMLDivElement;
  let homeScroller!: HTMLDivElement;
  let dialog!: HTMLDialogElement;
  let searchInput: HTMLInputElement | undefined;
  let editor: ReturnType<typeof createEditor> | undefined;
  let storage: StorageManager;
  let unlistenStorage: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let saveTask: Promise<void> = Promise.resolve();
  let navigationTask: Promise<void> = Promise.resolve();
  let dirty = false;
  let loadedVersion = { text: '' };
  let disposed = false;
  let refreshing = false;
  let touchStart: { x: number; y: number } | null = null;
  let creating = false;
  let clearOutline: (() => void) | undefined;
  let measureOutline = () => {};
  const history = new NavigationHistory();
  let navigatingHistory = false;
  let clickTimer: ReturnType<typeof setTimeout> | undefined;
  let doubleClickDelay = 500;
  createEffect(() => {
    const theme = (palette() && screen() === 'settings' ? draft()?.theme : settings()?.theme) ?? 'auto';
    document.documentElement.dataset.theme = theme;
    if (native && !mobile) void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setTheme(theme === 'auto' ? null : theme)).catch(error => report(String(error)));
  });

  function currentVisit(): Visit {
    const selection = editor?.view.state.selection.main;
    return home() ? { kind: 'home', tag: homeTag(), query: homeQuery(), scroll: homeScroller.scrollTop } : { kind: 'note', path: activePath(), anchor: selection?.anchor, head: selection?.head, scroll: editor?.view.scrollDOM.scrollTop };
  }
  async function travel(direction: number) {
    if (navigatingHistory) return;
    navigatingHistory = true;
    try {
      await navigationTask; await flush();
      const visit = history.move(direction, currentVisit(), visit => visit.kind === 'home' || notes().some(note => note.path === visit.path));
      if (!visit) return;
      if (visit.kind === 'home') await goHome(visit.tag ?? '', visit);
      else await openNote(visit.path!, visit);
    } catch (error) { report(String(error)); }
    finally { navigatingHistory = false; }
  }

  const report = (text: string) => {
    setMessage(text);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setMessage(''), 7000);
  };
  const journalKey = (path: string) => `pure-recovery:${settings()?.folder || 'browser'}:${path}`;
  const remember = (text: string) => {
    try { localStorage.setItem(journalKey(activePath()), text); }
    catch { report('一時保存領域がいっぱいです。⌘ S で保存してください。'); }
  };
  async function reloadNotes() { if (!disposed) setNotes(await storage.listNotes()); }
  function bindStorage(manager: StorageManager) {
    unlistenStorage?.();
    storage = manager;
    unlistenStorage = storage.onChange(event => {
      if (event.type === 'files') void reloadNotes().catch(error => report(String(error)));
      else {
        setSyncStatus({ idle: '同期済み', syncing: '同期しています', offline: '接続が戻ると再同期します', error: '同期を完了できませんでした' }[event.state]);
        if (event.message) report(`${event.message} ローカルの文章は保存されています。`);
        if (event.state === 'idle') void reloadActiveAfterSync();
      }
    });
  }
  async function reloadActiveAfterSync() {
    if (!editor || dirty || !activePath()) return;
    const current = editor;
    const path = activePath();
    const content = await storage.readNote(path);
    if (content === null && current === editor && !dirty) { await goHome(); return; }
    if (content !== null && current === editor && !dirty && current.view.state.doc.toString() !== content) {
      const head = Math.min(current.view.state.selection.main.head, content.length);
      refreshing = true;
      current.view.dispatch({ changes: { from: 0, to: current.view.state.doc.length, insert: content }, selection: { anchor: head } });
      loadedVersion.text = content;
      updateTitle(content);
      refreshing = false;
    }
  }
  async function flush() {
    clearTimeout(timer);
    if (editor) await editor.pending();
    if (!editor || !dirty) { await saveTask; return; }
    const path = activePath();
    const text = editor.view.state.doc.toString();
    const currentStorage = storage;
    const version = loadedVersion;
    const key = journalKey(path);
    // 前の保存の失敗で、以後の保存を止めない。
    saveTask = saveTask.catch(() => undefined).then(async () => {
      const renamed = await currentStorage.saveNamedNote(path, text, version.text);
      if (activePath() === path && renamed !== path) {
        setActivePath(renamed); history.renamePaths(value => currentStorage.resolvePath(value));
        if (settings()) { const next = { ...settings()!, lastFile: renamed }; setSettings(next); await persistSettings(next); }
        if (localStorage.getItem(key) === text) localStorage.removeItem(key);
        if (editor?.view.state.doc.toString() !== text) remember(editor!.view.state.doc.toString());
      }
      version.text = text;
      if (editor?.view.state.doc.toString() === text && activePath() === renamed) dirty = false;
      if (localStorage.getItem(key) === text) localStorage.removeItem(key);
    });
    await saveTask;
  }
  function autosave(text: string) {
    if (refreshing) return;
    dirty = true;
    updateTitle(text);
    remember(text);
    clearTimeout(timer);
    timer = setTimeout(() => void flush().catch(error => report(`保存できませんでした。${String(error)}`)), 2000);
  }
  function updateTitle(text: string) {
    const title = noteTitle(text, filenameTitle(activePath()) || '無題');
    setActiveTitle(title); document.title = `${title} — pure`;
    if (!mobile) { setOutline(articleOutline(text)); measureOutline(); }
  }
  function bindOutline(view: EditorView) {
    if (mobile) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const bounds = view.contentDOM.getBoundingClientRect();
      setOutlineGutter(Math.max(0, bounds.left - host.getBoundingClientRect().left - 12));
      const top = view.scrollDOM.getBoundingClientRect().top + 80;
      let current = outline()[0]?.from ?? null;
      for (const heading of outline()) {
        const position = Math.min(heading.from, view.state.doc.length);
        if (view.documentTop + view.lineBlockAt(position).top > top) break;
        current = heading.from;
      }
      setOutlineCurrent(current);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measureOutline = schedule;
    const observer = new ResizeObserver(schedule); observer.observe(view.contentDOM);
    view.scrollDOM.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    schedule();
    clearOutline = () => {
      cancelAnimationFrame(frame); observer.disconnect();
      view.scrollDOM.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule);
      measureOutline = () => {};
    };
  }
  function jumpToHeading(heading: OutlineHeading) {
    if (!editor) return;
    const view = editor.view;
    const line = view.state.doc.lineAt(Math.min(heading.from, view.state.doc.length));
    const prefix = /^(?: {0,3}#{1,6}[ \t]+)/.exec(line.text)?.[0].length ?? 0;
    const position = line.from + prefix;
    view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'start', yMargin: 72 }) });
    view.focus(); setOutlineCurrent(heading.from); measureOutline();
  }
  async function openNote(path: string, restore?: Visit) {
    const next = navigationTask.catch(() => undefined).then(async () => {
      await flush();
      const text = await storage.readNote(path);
      if (text === null) throw new Error('ノートが見つかりません。');
      if (!restore) history.push({ kind: 'note', path }, currentVisit());
      clearOutline?.(); clearOutline = undefined; editor?.destroy();
      setHome(false);
      setActivePath(path);
      loadedVersion = { text };
      const recovered = localStorage.getItem(journalKey(path));
      updateTitle(recovered ?? text);
      editor = createEditor({ parent: host, text: recovered ?? text, storage, tags: existingTags, onChange: autosave, onReference: followReference, onError: report, onSave: () => void flush().then(() => report('保存しました。')).catch(error => report(String(error))) });
      bindOutline(editor.view);
      dirty = recovered !== null && recovered !== text;
      if (dirty) timer = setTimeout(() => void flush().catch(error => report(String(error))), 2000);
      else localStorage.removeItem(journalKey(path));
      if (settings()) setSettings({ ...settings()!, lastFile: path });
      closePalette();
      if (!mobile) editor.view.focus();
      if (restore) {
        editor.view.dispatch({ selection: { anchor: Math.min(restore.anchor ?? 0, editor.view.state.doc.length), head: Math.min(restore.head ?? restore.anchor ?? 0, editor.view.state.doc.length) } });
        const current = editor;
        requestAnimationFrame(() => { if (editor === current) current.view.scrollDOM.scrollTop = restore.scroll ?? 0; });
      }
      if (settings()) await persistSettings(settings()!);
    });
    navigationTask = next;
    return next;
  }
  async function goHome(tag = '', restore?: Visit) {
    await flush();
    if (!restore) history.push({ kind: 'home', tag }, currentVisit());
    clearOutline?.(); clearOutline = undefined; editor?.destroy(); editor = undefined; dirty = false;
    setActivePath(''); setHome(true); setHomeTag(tag); setHomeQuery(restore?.query ?? ''); document.title = tag ? `${tag} — pure` : 'pure'; closePalette(); await reloadNotes();
    requestAnimationFrame(() => { if (home()) homeScroller.scrollTop = restore?.scroll ?? 0; });
  }
  async function newPage() {
    if (creating || !ready()) return;
    creating = true;
    try {
      await flush();
      const path = await storage.createNote('無題');
      await storage.saveNote(path, '# \n\n'); await openNote(path);
      editor?.view.dispatch({ selection: { anchor: 2 } }); editor?.view.focus();
    } finally { creating = false; }
  }
  async function deleteCurrent() {
    if (!editor || home() || palette() || busy()) return;
    setBusy(true);
    try {
      await flush();
      const path = activePath(); const backup = await storage.deleteNote(path);
      localStorage.removeItem(journalKey(path)); setDeleted({ path, backup });
      await goHome(); report('記事を削除しました。');
    } catch (error) { report(String(error)); }
    finally { setBusy(false); }
  }
  async function restoreDeleted() {
    const entry = deleted(); if (!entry) return;
    try { await storage.restoreNote(entry.path, entry.backup); setDeleted(null); setMessage(''); await openNote(entry.path); }
    catch (error) { report(String(error)); }
  }
  async function followReference(reference: Reference) {
    try {
      if (reference.kind === 'tag' || reference.kind === 'page') {
        await flush(); await reloadNotes();
        if (notes().filter(note => note.tags.includes(reference.value)).length > 1) await goHome(reference.value);
        return;
      }
      if (reference.kind === 'url') {
        if (!isExternalUrl(reference.value)) return;
        if (native) await openUrl(reference.value);
        else window.open(reference.value, '_blank', 'noopener,noreferrer');
        return;
      }
    } catch (error) { report(String(error)); }
  }
  async function openArticleWindow(path: string) {
    try {
      await flush(); path = storage.resolvePath(path);
      const url = `/?article=${encodeURIComponent(path)}`;
      if (!native) { window.open(url, '_blank', 'noopener,noreferrer'); return; }
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const child = new WebviewWindow(`article-${crypto.randomUUID()}`, { url, title: notes().find(note => note.path === path)?.title ?? 'pure', width: 900, height: 800, minWidth: 340, minHeight: 440, titleBarStyle: 'overlay', hiddenTitle: true, dragDropEnabled: false });
      void child.once('tauri://error', event => report(`別ウィンドウを開けませんでした。${String(event.payload)}`));
    } catch (error) { report(String(error)); }
  }
  function activateNote(event: MouseEvent, path: string) {
    clearTimeout(clickTimer);
    if (mobile || event.detail === 0) { void openNote(path).catch(error => report(String(error))); return; }
    if (event.detail > 1) return;
    clickTimer = setTimeout(() => { if (home() && !palette()) void openNote(path).catch(error => report(String(error))); }, doubleClickDelay + 30);
  }
  function openPalette(value = '') {
    setScreen('notes'); setQuery(value); setSelected(0); setPalette(true);
    void reloadNotes().catch(error => report(String(error)));
  }
  function closePalette() {
    setPalette(false);
    if (dialog.open) dialog.close();
    if (!home()) editor?.view.focus();
  }
  function showSettings() {
    setDraft({ ...settings()! }); setSettingsError(''); setScreen('settings');
  }
  const filtered = createMemo(() => {
    const value = query().trim().toLocaleLowerCase();
    const tags = [...value.matchAll(/\[([^\]\n]+)\]/g)].map(match => match[1]);
    const words = value.replace(/\[[^\]\n]+\]/g, ' ').trim().split(/\s+/).filter(Boolean);
    return notes().filter(note => tags.every(tag => note.tags.some(t => t.toLocaleLowerCase() === tag)) && words.every(word => `${note.title} ${note.excerpt} ${note.tags.join(' ')}`.toLocaleLowerCase().includes(word)));
  });
  const homeNotes = createMemo(() => {
    const value = homeQuery().trim().toLocaleLowerCase();
    return notes().filter(note => (!homeTag() || note.tags.includes(homeTag())) && `${note.title} ${note.tags.join(' ')}`.toLocaleLowerCase().includes(value));
  });
  const actions = createMemo<PaletteAction[]>(() => {
    const value = query().trim();
    const result: PaletteAction[] = filtered().map(note => ({ id: note.path, label: note.title, detail: note.tags.join('  ') || note.excerpt || 'まだ、まっさらなノート', kind: 'note', run: () => openNote(note.path) }));
    const title = value && !value.startsWith('#') ? value : '';
    let valid = true;
    try { if (title) pagePath(title); } catch { valid = false; }
    if (valid && (!title || !notes().some(note => note.path === pagePath(title)))) result.push({
      id: 'new', label: title ? `「${title}」をつくる` : '新しいノート', detail: title ? 'Enter で書きはじめる' : '名前を入力して、Enter', kind: 'action', run: async () => {
        if (!title) { await newPage(); return; }
        await flush(); const path = await storage.createNote(title); await storage.saveNote(path, `# ${title}\n\n`); await openNote(path);
      }
    });
    if (!home() || homeTag()) result.push({ id: 'home', label: 'すべての記事', detail: '更新の新しい順に並べる', kind: 'action', run: () => goHome() });
    result.push({ id: 'settings', label: '設定', detail: '保存する場所と、端末間の同期', kind: 'action', run: showSettings });
    return result;
  });
  createEffect(() => { query(); setSelected(0); });
  createEffect(() => {
    if (palette()) {
      if (!dialog.open) dialog.showModal();
      if (screen() === 'notes') queueMicrotask(() => searchInput?.focus());
    } else if (dialog.open) dialog.close();
  });
  createEffect(() => { selected(); queueMicrotask(() => dialog.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })); });
  async function run(action: PaletteAction | undefined) {
    if (!action || busy()) return;
    setBusy(true);
    try { await action.run(); } catch (error) { report(String(error)); }
    finally { setBusy(false); }
  }
  async function saveSettings(event: SubmitEvent) {
    event.preventDefault();
    const next = draft();
    if (!next || busy()) return;
    setBusy(true); setSettingsError('');
    try {
      if (next.syncEnabled) validateR2(next);
      await flush();
      await storage.waitForSync();
      if (next.folder !== settings()?.folder || next.imagesFolder !== settings()?.imagesFolder) {
        await relocateImages(settings()!, next);
        const manager = new StorageManager(await createBackend(next), native && next.syncEnabled ? new R2Backend(next) : null);
        await manager.initialize();
        await persistSettings(next);
        clearOutline?.(); clearOutline = undefined; editor?.destroy(); editor = undefined; dirty = false;
        setSettings(next); bindStorage(manager);
        await reloadNotes();
        setActivePath(''); setHome(true); setHomeTag(''); history.reset(); document.title = 'pure'; closePalette();
      } else {
        await persistSettings(next);
        setSettings(next);
        storage.setRemote(native && next.syncEnabled ? new R2Backend(next) : null);
        setSyncStatus(next.syncEnabled ? '同期を待っています' : '同期はオフです');
        closePalette();
      }
      if (next.syncEnabled) void storage.sync();
      report('設定を保存しました。');
    } catch (error) { setSettingsError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  function updateDraft(key: keyof Settings, value: string | boolean) { setDraft(previous => previous ? { ...previous, [key]: value } : null); }
  async function refreshFromDisk() {
    if (!ready() || busy()) return;
    try { await flush(); await storage.refresh(); await storage.sync(); await reloadActiveAfterSync(); }
    catch (error) { report(String(error)); }
  }
  function scrollOutline(event: WheelEvent) {
    if (!editor || event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const aside = event.currentTarget as HTMLElement;
    const panel = aside.querySelector<HTMLElement>('.outline-panel');
    if (!panel || !outlineScrollsArticle(panel.contains(event.target as Node), panel.clientHeight, panel.scrollHeight)) return;
    event.preventDefault();
    const scroller = editor.view.scrollDOM;
    scroller.scrollTop += wheelDistance(event.deltaY, event.deltaMode, editor.view.defaultLineHeight, scroller.clientHeight);
  }

  onMount(() => {
    let unlistenClose: (() => void) | undefined;
    let unlistenScale: (() => void) | undefined;
    const boot = async () => {
      try {
        const currentSettings = await loadSettings();
        setSettings(currentSettings);
        const manager = new StorageManager(await createBackend(currentSettings));
        bindStorage(manager);
        await manager.initialize();
        if (native && currentSettings.syncEnabled) { manager.setRemote(new R2Backend(currentSettings)); await manager.sync(); }
        await manager.migrateNoteNames();
        for (const [from, to] of Object.entries(manager.renamedPaths)) {
          const oldKey = journalKey(from); const newKey = journalKey(to);
          const recovered = localStorage.getItem(oldKey);
          if (recovered !== null && localStorage.getItem(newKey) === null) { localStorage.setItem(newKey, recovered); localStorage.removeItem(oldKey); }
        }
        if (currentSettings.lastFile) { currentSettings.lastFile = manager.resolvePath(currentSettings.lastFile); await persistSettings(currentSettings); }
        await reloadNotes();
        if (!notes().length && !manager.hasHistory) {
          const path = await manager.createNote('はじめに');
          await manager.saveNamedNote(path, introduction);
          await reloadNotes();
        }
        setReady(true);
        document.title = 'pure';
        if (native && !mobile) {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const win = getCurrentWindow();
          doubleClickDelay = await invoke<number>('double_click_interval');
          unlistenScale = await win.onScaleChanged(() => {
            void invoke('refresh_display').then(() => { editor?.view.requestMeasure(); window.dispatchEvent(new Event('resize')); }).catch(error => report(String(error)));
          });
          let closing = false;
          unlistenClose = await win.onCloseRequested(async event => {
            event.preventDefault();
            if (closing) return;
            closing = true;
            try { await flush(); await win.destroy(); }
            catch (error) { closing = false; report(`保存できませんでした。${String(error)}`); }
          });
        }
      } catch (error) { setStartupError(error instanceof Error ? error.message : String(error)); }
    };
    void boot();
    let lastEscape = 0;
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        if (palette() || home() || event.repeat) { lastEscape = 0; return; }
        const now = performance.now();
        if (lastEscape && now - lastEscape < 400) {
          lastEscape = 0; event.preventDefault(); event.stopPropagation();
          void goHome().catch(error => report(String(error)));
        } else lastEscape = now;
        return;
      }
      lastEscape = 0;
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key) && ready()) {
        event.preventDefault(); event.stopPropagation(); void travel(event.key === 'ArrowLeft' ? -1 : 1); return;
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && ['Backspace', 'Delete'].includes(event.key) && ready()) {
        event.preventDefault(); event.stopPropagation(); void deleteCurrent(); return;
      }
      if ((event.metaKey || event.ctrlKey) && ['l', 'k', 'p', 'n', ','].includes(event.key.toLowerCase()) && ready()) {
        event.preventDefault();
        if (event.key === ',') { openPalette(); showSettings(); }
        else if (event.key.toLowerCase() === 'n') void newPage().catch(error => report(String(error)));
        else palette() ? closePalette() : openPalette();
      }
    };
    const visibility = () => { if (document.visibilityState === 'visible') void refreshFromDisk(); else void flush().catch(error => report(String(error))); };
    const pagehide = () => { void flush().catch(() => undefined); };
    const online = () => { void refreshFromDisk(); };
    const swipe = new HistorySwipe();
    const wheel = (event: WheelEvent) => {
      if (mobile || !ready() || busy() || palette()) { swipe.reset(); return; }
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, select, .cm-tooltip')) { swipe.reset(); return; }
      // Preserve horizontal scrolling inside code blocks and other scrollable regions.
      for (let node = target; node && node !== paper; node = node.parentElement) {
        if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(node).overflowX)) { swipe.reset(); return; }
      }
      const result = swipe.feed(event, performance.now());
      if (result.claim && event.cancelable) event.preventDefault();
      if (result.direction) void travel(result.direction);
    };
    paper.addEventListener('wheel', wheel, { capture: true, passive: false });
    window.addEventListener('keydown', keydown, true);
    const removeHomeScrollbar = scrollIndicator(homeScroller, homeScroller.parentElement!);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('online', online);
    window.addEventListener('focus', online);
    const retry = setInterval(() => { if (ready() && document.visibilityState === 'visible' && navigator.onLine) void storage.sync(); }, 60_000);
    onCleanup(() => {
      disposed = true; clearTimeout(clickTimer); clearTimeout(timer); clearTimeout(toastTimer); clearInterval(retry);
      paper.removeEventListener('wheel', wheel, true);
      window.removeEventListener('keydown', keydown, true); document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pagehide); window.removeEventListener('online', online); window.removeEventListener('focus', online);
      removeHomeScrollbar(); unlistenStorage?.(); unlistenClose?.(); unlistenScale?.(); clearOutline?.(); editor?.destroy();
    });
  });

  return <main ref={paper} class="paper" aria-label="pure" onTouchStart={event => {
    const touch = event.touches[0];
    touchStart = touch.clientX < 28 ? { x: touch.clientX, y: touch.clientY } : null;
  }} onTouchEnd={event => {
    const touch = event.changedTouches[0];
    if (ready() && touchStart && touch.clientX - touchStart.x > 75 && Math.abs(touch.clientY - touchStart.y) < 60) openPalette();
    touchStart = null;
  }}>
    <Show when={native && !mobile}><div class="native-title-region" data-tauri-drag-region /></Show>
    <section class="home-surface" hidden={!home()} aria-label="記事一覧">
      <div class="home-scroll" ref={homeScroller}>
        <header class="home-heading"><h1><Show when={!homeTag()} fallback={homeTag()}><AnimatedWordmark active={home() && !palette()} /></Show></h1></header>
        <div class="home-search"><input type="search" aria-label="記事を探す" placeholder="タイトル、タグで探す" value={homeQuery()} onInput={event => setHomeQuery(event.currentTarget.value)} /><Show when={homeQuery()}><button type="button" onClick={() => setHomeQuery('')}>すべて</button></Show></div>
        <div class="note-grid"><For each={homeNotes()}>{note => <article class="note-card"><button class="note-title" type="button" disabled={!ready()} onClick={event => activateNote(event, note.path)} onDblClick={() => { if (!mobile) { clearTimeout(clickTimer); void openArticleWindow(note.path); } }}>{note.title}</button><div class="note-tags"><For each={note.tags.slice(0, 3)}>{tag => <button type="button" onClick={() => void followReference({ kind: 'tag', value: tag, from: 0, to: 0 })}>{tag}</button>}</For><Show when={note.tags.length > 3}><span class="tags-more" title={note.tags.slice(3).join('、')}>…</span></Show></div></article>}</For></div>
        <Show when={ready() && homeNotes().length === 0}><p class="home-empty">{homeQuery() ? '見つかりませんでした。' : 'まだ、何も書かれていません。'}</p></Show>
      </div>
    </section>
    <div class="writing-surface" hidden={home()} ref={host} aria-busy={!ready()} />
    <Show when={ready() && !home() && !mobile && outline().length > 0}>
      <aside class="article-outline" onWheel={scrollOutline} style={{ '--toc-trigger-width': `${outlineGutter()}px` }}>
        <button class="outline-trigger" type="button" aria-label="目次を表示" onClick={event => event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('nav button')?.focus()} />
        <nav class="outline-panel" aria-label="記事の目次"><For each={outline()}>{heading => <button type="button" class="outline-heading" classList={{ 'is-current': heading.from === outlineCurrent() }} aria-current={heading.from === outlineCurrent() ? 'location' : undefined} style={{ '--toc-depth': String(heading.level - outlineLevel()) }} onClick={() => jumpToHeading(heading)}>{heading.title}</button>}</For></nav>
      </aside>
    </Show>
    <Show when={startupError()}><div class="startup-message" role="alert"><p>ノートを開けませんでした。</p><p>{startupError()}</p><button type="button" onClick={() => location.reload()}>もう一度開く</button></div></Show>
    <Show when={ready()}><button class="palette-trigger" type="button" aria-label="ノートを開く" title="ノートを開く（⌘ L）" onClick={() => openPalette()}><span aria-hidden="true">···</span></button></Show>
    <dialog class="palette" ref={dialog} aria-label={screen() === 'notes' ? 'ノートとコマンド' : '設定'} onCancel={event => { event.preventDefault(); if (!busy()) closePalette(); }} onClick={event => { if (event.target === dialog && !busy()) closePalette(); }}>
      <div class="palette-inner">
        <Show when={screen() === 'notes'} fallback={<form class="settings" onSubmit={saveSettings}>
          <div class="palette-heading"><button type="button" disabled={busy()} onClick={() => { setScreen('notes'); setSettingsError(''); }}>← ノートへ</button><button class="quiet-button" type="button" disabled={busy()} aria-label="閉じる" onClick={closePalette}>閉じる</button></div>
          <fieldset disabled={busy()}><legend>外観</legend>
            <div class="theme-options" role="radiogroup" aria-label="外観"><For each={[{ value: 'light', label: 'ライト' }, { value: 'dark', label: 'ダーク' }, { value: 'auto', label: '自動' }]}>{option => <label><input type="radio" name="theme" value={option.value} checked={(draft()?.theme ?? 'auto') === option.value} onChange={() => updateDraft('theme', option.value)} />{option.label}</label>}</For></div>
          </fieldset>
          <fieldset disabled={busy()}><legend>Markdown の保存先</legend>
            <p class="setting-description">{native ? '記事を .md ファイルとして保存します。' : 'ブラウザでは、この端末の中に保存されます。'}</p>
            <p class="folder-path">{native ? draft()?.folder : 'このブラウザの保存領域'}</p>
            <Show when={native && !mobile}><button class="text-button" type="button" onClick={async () => { try { const folder = await chooseFolder('notes'); if (folder) updateDraft('folder', folder); } catch (error) { setSettingsError(String(error)); } }}>Markdown のフォルダを選ぶ ↗</button></Show>
          </fieldset>
          <fieldset disabled={busy()}><legend>画像の保存先</legend>
            <p class="folder-path">{native ? draft()?.imagesFolder || `${draft()?.folder}/assets` : 'このブラウザの保存領域'}</p>
            <Show when={native && !mobile}><button class="text-button" type="button" onClick={async () => { try { const folder = await chooseFolder('images'); if (folder) updateDraft('imagesFolder', folder); } catch (error) { setSettingsError(String(error)); } }}>画像のフォルダを選ぶ ↗</button><p class="setting-description">画像の保存先を変えると、既存画像をコピーし、記事内の参照も更新します。</p></Show>
          </fieldset>
          <fieldset disabled={busy() || !native}><legend>端末間の同期</legend>
            <label class="checkbox-label"><input type="checkbox" checked={draft()?.syncEnabled ?? false} onChange={event => updateDraft('syncEnabled', event.currentTarget.checked)} />Cloudflare R2 を使う</label>
            <Show when={!native}><p class="setting-description">同期とフォルダの選択は、macOS・iOS アプリで利用できます。</p></Show>
            <Show when={draft()?.syncEnabled}><div class="r2-fields">
              <label>Endpoint URL<input type="url" required placeholder="https://account-id.r2.cloudflarestorage.com" value={draft()?.endpoint ?? ''} onInput={event => updateDraft('endpoint', event.currentTarget.value.trim())} spellcheck={false} autocapitalize="off" /></label>
              <label>Bucket Name<input required value={draft()?.bucket ?? ''} onInput={event => updateDraft('bucket', event.currentTarget.value.trim())} spellcheck={false} autocapitalize="off" /></label>
              <label>Access Key ID<input required value={draft()?.accessKeyId ?? ''} onInput={event => updateDraft('accessKeyId', event.currentTarget.value.trim())} autocomplete="off" spellcheck={false} autocapitalize="off" /></label>
              <label>Secret Access Key<input type="password" required value={draft()?.secretAccessKey ?? ''} onInput={event => updateDraft('secretAccessKey', event.currentTarget.value.trim())} autocomplete="off" spellcheck={false} /></label>
              <p class="setting-description">{syncStatus()}。アクセスキーは端末のキーチェーンに保存します。</p>
              <button class="text-button" type="button" onClick={() => void run({ id: 'sync', label: '', detail: '', kind: 'action', run: async () => { await flush(); await storage.sync(); } })}>今すぐ同期</button>
            </div></Show>
          </fieldset>
          <p class="settings-error" role="alert">{settingsError()}</p>
          <div class="settings-footer"><span>pure <span class="version">0.1</span></span><button type="submit" class="save-button" disabled={busy()}>{busy() ? '保存しています' : '設定を保存'}</button></div>
        </form>}>
          <div class="palette-search"><input ref={searchInput} type="text" role="combobox" aria-label="ノートを検索、または新しくつくる" aria-autocomplete="list" aria-controls="note-options" aria-expanded="true" aria-activedescendant={`option-${selected()}`} placeholder="ノートを探す、つくる。" value={query()} onInput={event => setQuery(event.currentTarget.value)} onKeyDown={event => {
            if (event.isComposing) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const length = actions().length; setSelected(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + length) % length); }
            if (event.key === 'Enter') { event.preventDefault(); void run(actions()[selected()]); }
          }} /><button class="escape-key" type="button" aria-label="閉じる" onClick={closePalette}>esc</button></div>
          <div class="palette-results" id="note-options" role="listbox" aria-label="ノートとコマンド" aria-busy={busy()}>
            <Show when={filtered().length === 0 && query()}><p class="empty-result">まだ、ここには何もありません。</p></Show>
            <For each={actions()}>{(action, index) => <button type="button" role="option" id={`option-${index()}`} aria-selected={selected() === index()} class="palette-option" classList={{ 'is-action': action.kind === 'action', 'is-current': action.id === activePath() }} disabled={busy()} onPointerMove={() => setSelected(index())} onClick={() => void run(action)}>
              <span class="option-name">{action.label}</span><span class="option-detail">{action.detail}</span><span class="option-enter" aria-hidden="true">↵</span>
            </button>}</For>
          </div>
          <div class="palette-footer"><Show when={mobile && (!home() || homeTag())} fallback={<span>pure</span>}><button class="palette-home" type="button" disabled={busy()} onClick={() => void goHome().catch(error => report(String(error)))}>トップページに戻る</button></Show><span>↑ ↓ 選ぶ <span class="footer-space">↵ 開く</span></span></div>
        </Show>
      </div>
    </dialog>
    <Show when={message()}><div class="notice" role="status"><span>{message()}</span><Show when={deleted()}><button type="button" onClick={() => void restoreDeleted()}>元に戻す</button></Show><button class="notice-close" type="button" aria-label="通知を閉じる" onClick={() => setMessage('')}>×</button></div></Show>
  </main>;
}
