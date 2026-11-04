import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { EditorView } from '@codemirror/view';
import { createEditor } from './lib/editor';
import { isExternalUrl, noteTitle, pagePath, type Reference } from './lib/transformer';
import { StorageManager, R2Backend, chooseFolder, createBackend, loadSettings, persistSettings, persistLastFile, relocateImages, safeRelativePath, validateR2, mobile, native, type Note, type Settings } from './lib/storage';
import { workspaceChannel, workspaceLock } from './lib/workspace';
import { scrollIndicator } from './lib/scrollbar';
import { NavigationHistory, type Visit } from './lib/navigation';
import { filenameTitle } from './lib/note-filenames';
import { articleOutline, type OutlineHeading } from './lib/outline';
import { TouchSwipe, rowActionWidth, rowSwipeOffset, touchHistoryProgress } from './lib/touch-gestures';
import { HistorySwipe, outlineScrollsArticle, wheelDistance } from './lib/gestures';
import { PaperNotebook, isPaperPath } from './lib/paper-notebook';
import { createPaperClient } from './lib/paper-native';
import type { PaperClient, PaperFile } from './lib/paper-client';
import PaperSettings from './components/PaperSettings';
import AnimatedWordmark from './components/AnimatedWordmark';
import PublicationIcon from './components/PublicationIcon';
import { ArticlePublisher, GitHubRepository, loadGithubToken, saveGithubToken, targetKey, validatePublishingTarget } from './lib/github-publisher';

type PaletteAction = { id: string; label: string; detail: string; kind: 'note' | 'action'; run(): void | Promise<void> };
const introduction = '# 余白から、はじめる。\n\n考えていることを、ひとつずつ。\n言葉にすると、少しだけ輪郭が見えてくる。\n\npure は、書くための静かな場所です。\n\n⌘ L でノートを探す。⌘ N で新しく書く。\n[思いついたこと] のように囲めば、タグになります。\n同じタグの文章を、まとめて見返せます。\n\n画像を置く。動画の URL を貼る。\n書いたものは、ふつうの Markdown として残ります。\n';

export default function App(props: { initialArticle?: string } = {}) {
  // A child keeps its own recovery journal, including across a webview reload.
  const recoverySession = props.initialArticle ? sessionStorage.getItem('pure-recovery-session') || crypto.randomUUID() : '';
  if (recoverySession) sessionStorage.setItem('pure-recovery-session', recoverySession);
  const [paperClient, setPaperClient] = createSignal<PaperClient>();
  const [paperConnected, setPaperConnected] = createSignal(false);
  const [paperStatus, setPaperStatus] = createSignal('未接続');
  const [paperMatches, setPaperMatches] = createSignal<PaperFile[]>([]);
  let paperNotebook: PaperNotebook | undefined;
  let paperFileInput!: HTMLInputElement;
  let pendingPaperFile: File | undefined;
  const [ready, setReady] = createSignal(false);
  const [visibilityFilter, setVisibilityFilter] = createSignal<'all' | 'public' | 'private'>('all');
  const [githubToken, setGithubToken] = createSignal('');
  const [tokenDraft, setTokenDraft] = createSignal('');
  const [articleMenuError, setArticleMenuError] = createSignal('');
  const [publishStatus, setPublishStatus] = createSignal('GitHub は未接続です');
  let publisher: ArticlePublisher | undefined;
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  let publishingPaused = false;
  const [notes, setNotes] = createSignal<Note[]>([]);
  const [activePath, setActivePath] = createSignal('');
  const [home, setHome] = createSignal(!props.initialArticle);
  const currentArticle = createMemo(() => notes().find(note => note.path === activePath()));
  const articleIsPublic = createMemo(() => currentArticle()?.publication?.visibility === 'public');
  const [homeQuery, setHomeQuery] = createSignal('');
  const [homeTag, setHomeTag] = createSignal('');
  const [activeTitle, setActiveTitle] = createSignal('');
  const [deleted, setDeleted] = createSignal<{ path: string; backup: string; fromHome?: boolean } | null>(null);
  const [swipedRow, setSwipedRow] = createSignal<{ path: string; offset: number; dragging: boolean; full: boolean } | null>(null);
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
  const [swipeHint, setSwipeHint] = createSignal<{ side: -1 | 1; progress: number; available: boolean; committed: boolean } | null>(null);
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
  let pendingSave: { storage: StorageManager; version: { text: string }; text: string; task: Promise<void> } | undefined;
  let navigationTask: Promise<void> = Promise.resolve();
  let dirty = false;
  let loadedVersion = { text: '' };
  let disposed = false;
  let refreshing = false;
  let creating = false;
  let clearOutline: (() => void) | undefined;
  let measureOutline = () => {};
  const history = new NavigationHistory();
  let navigatingHistory = false;
  let pendingTravel: number | null = null;
  let clickTimer: ReturnType<typeof setTimeout> | undefined;
  let doubleClickDelay = 500;
  let workspace: ReturnType<typeof workspaceChannel> | undefined;
  createEffect(() => {
    const theme = (palette() && screen() === 'settings' ? draft()?.theme : settings()?.theme) ?? 'auto';
    document.documentElement.dataset.theme = theme;
    if (native && !mobile) void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setTheme(theme === 'auto' ? null : theme)).catch(error => report(String(error)));
  });

  function currentVisit(): Visit {
    const selection = editor?.view.state.selection.main;
    return home() || !editor ? { kind: 'home', tag: homeTag(), query: homeQuery(), scroll: homeScroller.scrollTop } : { kind: 'note', path: activePath(), anchor: selection?.anchor, head: selection?.head, scroll: editor?.view.scrollDOM.scrollTop };
  }
  async function travel(direction: number) {
    if (navigatingHistory) { pendingTravel = direction; return; }
    navigatingHistory = true;
    try {
      await navigationTask; await flush();
      const visit = history.move(direction, currentVisit(), visit => visit.kind === 'home' || notes().some(note => note.path === visit.path));
      if (!visit) return;
      if (visit.kind === 'home') await goHome(visit.tag ?? '', visit);
      else await openNote(visit.path!, visit);
    } catch (error) { report(String(error)); }
    finally {
      navigatingHistory = false;
      if (pendingTravel !== null) { const next = pendingTravel; pendingTravel = null; void travel(next); }
    }
  }

  const report = (text: string) => {
    setMessage(text);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setMessage(''), 7000);
  };
  const journalKey = (path: string) => `pure-recovery:${settings()?.folder || 'browser'}:${path}${recoverySession ? `:${recoverySession}` : ''}`;
  const remember = (text: string) => {
    try { localStorage.setItem(journalKey(activePath()), text); }
    catch { report('一時保存領域がいっぱいです。⌘ S で保存してください。'); }
  };
  async function reloadNotes() { if (!disposed) setNotes(await storage.listNotes()); }
  function bindStorage(manager: StorageManager) {
    unlistenStorage?.();
    storage = manager;
    unlistenStorage = storage.onChange(event => {
      if (event.type === 'files') {
        workspace?.post('files', settings()?.folder || 'browser');
        void reloadNotes().catch(error => report(String(error)));
        clearTimeout(publishTimer);
        if (publisher) setPublishStatus('公開同期を待っています');
        if (ready() && !publishingPaused) publishTimer = setTimeout(() => { void syncPublished().catch(() => undefined); }, 1500);
      }
      else {
        setSyncStatus({ idle: '同期済み', syncing: '同期しています', offline: '接続が戻ると再同期します', error: '同期を完了できませんでした' }[event.state]);
        if (event.message) report(`${event.message} ローカルの文章は保存されています。`);
        if (event.state === 'idle') void reloadActiveAfterSync();
      }
    });
  }
  function connectPublisher() {
    const current = settings();
    publisher = native && githubToken() && current?.githubRepository ? new ArticlePublisher(new GitHubRepository(current.githubRepository, current.githubBranch || 'main', githubToken())) : undefined;
    setPublishStatus(publisher ? '公開同期を待っています' : 'GitHub は未接続です');
  }
  async function syncPublished() {
    const current = publisher;
    const currentStorage = storage;
    if (!current || publishingPaused || disposed) return;
    setPublishStatus('公開先を更新しています');
    try {
      await workspaceLock(`pure-publish:${targetKey(current.remote.repository, current.remote.branch)}`, async () => {
        if (current !== publisher || currentStorage !== storage || publishingPaused || disposed) return;
        await currentStorage.reloadSharedState(); await current.sync(currentStorage);
      });
      if (current === publisher) setPublishStatus('公開先は最新です');
    }
    catch (error) { if (current === publisher) setPublishStatus(`公開先の更新待ち：${error instanceof Error ? error.message : String(error)}`); throw error; }
  }
  async function changePublication(path: string, visibility: 'public' | 'private') {
    if (!publisher) { showSettings(); report('GitHub 公開の接続情報を設定してください。'); return; }
    await flush(); path = storage.resolvePath(path);
    const previous = (await storage.listNotes()).find(note => note.path === path)?.publication;
    if (previous && targetKey(previous.repository, previous.branch) !== targetKey(publisher.remote.repository, publisher.remote.branch)) throw new Error(`この記事の公開先は ${previous.repository}（${previous.branch}）です。設定を元の公開先に戻してから操作してください。`);
    const intent = await publisher.intent(storage, path, visibility);
    await storage.setPublication(path, intent);
    await reloadNotes();
    await syncPublished();
    report(visibility === 'public' ? 'poin7s.com の公開用リポジトリに保存しました。' : '公開用リポジトリから取り下げました。過去の Git 履歴は残ります。');
  }
  async function toggleArticlePublication() {
    if (busy() || home() || isPaperPath(activePath())) return;
    setBusy(true); setArticleMenuError('');
    try { await changePublication(activePath(), articleIsPublic() ? 'private' : 'public'); }
    catch (error) { setArticleMenuError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function reloadActiveAfterSync() {
    if (!editor || dirty || !activePath()) return;
    const current = editor;
    const previousPath = activePath();
    const path = storage.resolvePath(previousPath);
    const content = await storage.readNote(path);
    if (current !== editor || activePath() !== previousPath || dirty) return;
    const resolved = storage.resolvePath(path);
    if (resolved !== previousPath) {
      setActivePath(resolved); history.renamePaths(value => storage.resolvePath(value));
      updateTitle(content ?? current.view.state.doc.toString());
    }
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
    if (pendingSave?.storage === currentStorage && pendingSave.version === version && pendingSave.text === text) { await pendingSave.task; return; }
    const key = journalKey(path);
    // 前の保存の失敗で、以後の保存を止めない。
    saveTask = saveTask.catch(() => undefined).then(async () => {
      const renamed = await currentStorage.saveNamedNote(path, text, version.text);
      if (activePath() === path && renamed !== path) {
        setActivePath(renamed); history.renamePaths(value => currentStorage.resolvePath(value));
        if (settings()) { setSettings({ ...settings()!, lastFile: renamed }); await persistLastFile(renamed); }
        if (localStorage.getItem(key) === text) localStorage.removeItem(key);
        if (editor?.view.state.doc.toString() !== text) remember(editor!.view.state.doc.toString());
      }
      version.text = text;
      if (editor?.view.state.doc.toString() === text && activePath() === renamed) dirty = false;
      if (localStorage.getItem(key) === text) localStorage.removeItem(key);
    });
    const pending = { storage: currentStorage, version, text, task: saveTask };
    pendingSave = pending;
    try { await pending.task; }
    finally { if (pendingSave === pending) pendingSave = undefined; }
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
    if (native && !mobile && activeTitle() !== title) void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title)).catch(error => report(String(error)));
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
      path = storage.resolvePath(path);
      if (text === null) throw new Error('ノートが見つかりません。');
      if (!restore) history.push({ kind: 'note', path }, currentVisit());
      clearOutline?.(); clearOutline = undefined; editor?.destroy();
      setSwipedRow(null); setHome(false);
      setActivePath(path);
      loadedVersion = { text };
      const recovered = localStorage.getItem(journalKey(path));
      updateTitle(recovered ?? text);
      editor = createEditor({ parent: host, text: recovered ?? text, storage, imagesAllowed: !isPaperPath(path), tags: existingTags, onChange: autosave, onReference: followReference, onError: report, onSave: () => void flush().then(() => report(isPaperPath(path) ? `ローカルに保存しました。${paperStatus()}` : '保存しました。')).catch(error => report(String(error))) });
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
      if (settings()) await persistLastFile(path);
    });
    navigationTask = next;
    return next;
  }
  async function goHome(tag = '', restore?: Visit) {
    await flush();
    if (!restore) history.push({ kind: 'home', tag }, currentVisit());
    clearOutline?.(); clearOutline = undefined; editor?.destroy(); editor = undefined; dirty = false;
    setSwipedRow(null); setActivePath(''); setHome(true); setHomeTag(tag); setHomeQuery(restore?.query ?? ''); document.title = tag ? `${tag} — pure` : 'pure'; closePalette(); await reloadNotes();
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
  async function deleteArticle(path: string) {
    if (busy() || !ready()) return;
    setBusy(true);
    try {
      await flush(); path = storage.resolvePath(path);
      const publication = (await storage.listNotes()).find(note => note.path === path)?.publication;
      if (publication) {
        if (!publisher) throw new Error('公開済み記事は、GitHub に接続して取り下げてから削除してください。');
        await changePublication(path, 'private');
      }
      const fromHome = home(); const backup = await storage.deleteNote(path);
      localStorage.removeItem(journalKey(path)); setDeleted({ path, backup, fromHome }); setSwipedRow(null);
      if (!fromHome && activePath() === path) await goHome();
      else await reloadNotes();
      report('記事を削除しました。');
    } catch (error) { setSwipedRow(null); setArticleMenuError(String(error)); report(String(error)); }
    finally { setBusy(false); }
  }
  async function deleteCurrent() {
    if (!editor || home() || palette() || busy()) return;
    await deleteArticle(activePath());
  }
  async function restoreDeleted() {
    const entry = deleted(); if (!entry) return;
    try {
      await storage.restoreNote(entry.path, entry.backup); setDeleted(null); setMessage('');
      if (entry.fromHome) await reloadNotes(); else await openNote(entry.path);
    }
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
  async function bindPaper(manager: StorageManager) {
    const notebook = new PaperNotebook(manager.backend, paperClient() ?? null, () => {
      workspace?.post('files', settings()?.folder || 'browser');
      void reloadNotes().catch(error => report(String(error)));
    }, status => {
      setPaperStatus(status);
      if (/失敗|変更があります|接続してください/.test(status)) report(status);
    });
    await notebook.initialize();
    paperNotebook = notebook; manager.setPaperNotebook(notebook);
  }
  async function openPaper(path: string, original?: File) {
    if (!paperClient()?.connected || !paperNotebook) throw new Error('設定から Dropbox Paper に接続してください。');
    await flush();
    const exported = await paperClient()!.export(path);
    const file = original ?? (pendingPaperFile?.name === exported.file.name ? pendingPaperFile : undefined);
    const imported = await paperNotebook.attach(exported, file ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : undefined);
    pendingPaperFile = undefined; setPaperMatches([]);
    await reloadNotes(); await openNote(imported);
  }
  async function importPaperFile(file: File) {
    if (!/\.paper$/i.test(file.name)) return;
    pendingPaperFile = file;
    if (!paperClient()?.connected) { openPalette(); showSettings(); report('設定の Dropbox Paper から接続してください。会社側の許可が必要な場合があります。'); return; }
    if (file.size > 5 * 1024 * 1024) throw new Error('Paper の参照ファイルとしては大きすぎます。Dropbox 内のパスから開いてください。');
    const matches = await paperClient()!.findByName(file.name);
    if (!matches.length) throw new Error('同じ名前の Paper が見つかりません。⌘ L に Dropbox 内のフルパスを入力して開いてください。');
    if (matches.length === 1) { await openPaper(matches[0].id, file); return; }
    setPaperMatches(matches); openPalette(file.name);
  }
  function paperConnectionChanged() {
    setPaperConnected(paperClient()?.connected ?? false);
    if (paperConnected()) {
      setPaperStatus('接続済み');
      if (pendingPaperFile) void importPaperFile(pendingPaperFile).catch(error => report(String(error)));
      else void paperNotebook?.refresh().then(() => reloadNotes()).catch(error => report(String(error)));
    } else setPaperStatus('未接続。編集済みの本文はローカルに残っています');
  }
  async function recoverPaper() {
    if (!paperNotebook || !isPaperPath(activePath())) return;
    await flush();
    const path = activePath();
    await paperNotebook.reloadRemote(path); await openNote(path);
    report('ローカル版を .paper/backups に残し、Paper を読み直しました。');
  }
  async function openArticleWindow(path: string) {
    try {
      await flush(); path = storage.resolvePath(path);
      if (!navigator.locks || typeof BroadcastChannel === 'undefined') throw new Error('複数ウィンドウの編集に必要な機能を利用できません。macOS を更新してください。');
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
    setSwipedRow(null);
    if (value !== pendingPaperFile?.name) setPaperMatches([]);
    setArticleMenuError(''); setScreen('notes'); setQuery(value); setSelected(0); setPalette(true);
    void reloadNotes().catch(error => report(String(error)));
  }
  function closePalette() {
    setPalette(false);
    if (dialog.open) dialog.close();
    if (!home()) editor?.view.focus();
  }
  function showSettings() {
    setDraft({ ...settings()! }); setTokenDraft(githubToken()); setSettingsError(''); setScreen('settings');
  }
  const filtered = createMemo(() => {
    const value = query().trim().toLocaleLowerCase();
    const tags = [...value.matchAll(/\[([^\]\n]+)\]/g)].map(match => match[1]);
    const words = value.replace(/\[[^\]\n]+\]/g, ' ').trim().split(/\s+/).filter(Boolean);
    return notes().filter(note => tags.every(tag => note.tags.some(t => t.toLocaleLowerCase() === tag)) && words.every(word => `${note.title} ${note.excerpt} ${note.tags.join(' ')}`.toLocaleLowerCase().includes(word)));
  });
  const homeNotes = createMemo(() => {
    const value = homeQuery().trim().toLocaleLowerCase();
    return notes().filter(note => (visibilityFilter() === 'all' || (note.publication?.visibility ?? 'private') === visibilityFilter()) && (!homeTag() || note.tags.includes(homeTag())) && `${note.title} ${note.tags.join(' ')}`.toLocaleLowerCase().includes(value));
  });
  const actions = createMemo<PaletteAction[]>(() => {
    publishStatus();
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
    if (paperConnected()) {
      if (/^\/.+\.paper$/i.test(value)) result.unshift({ id: 'paper-path', label: `Paper「${value}」を開く`, detail: 'Dropbox の同じ文書を編集', kind: 'action', run: () => openPaper(value) });
      for (const file of paperMatches()) result.unshift({ id: `paper-${file.id}`, label: file.path_display ?? file.name, detail: 'この Paper を開く', kind: 'action', run: () => openPaper(file.id, pendingPaperFile) });
    }
    if (!home() && !isPaperPath(activePath())) {
      const isPublic = notes().find(note => note.path === activePath())?.publication?.visibility === 'public';
      result.push({ id: 'publication', label: isPublic ? 'この記事を非公開にする' : 'この記事を公開する', detail: isPublic ? `${publishStatus()} · 取り下げ後も Git 履歴は残ります` : '本文・タグ・参照画像を公開リポジトリへ送る', kind: 'action', run: () => changePublication(activePath(), isPublic ? 'private' : 'public') });
    }
    if (publisher) result.push({ id: 'publish-sync', label: '公開先を同期する', detail: publishStatus(), kind: 'action', run: async () => { await flush(); await syncPublished(); } });
    if (native) result.push({ id: 'paper-open', label: 'Paper ファイルを開く', detail: '⌘ O · 元の名前を維持して Dropbox と連携', kind: 'action', run: () => paperFileInput.click() });
    if (isPaperPath(activePath())) result.push({ id: 'paper-recover', label: 'Paper を読み直す', detail: 'ローカルにバックアップを残して Dropbox の内容を読み直す', kind: 'action', run: recoverPaper });
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
      if (next.githubRepository) validatePublishingTarget(next.githubRepository, next.githubBranch || 'main');
      publishingPaused = true; clearTimeout(publishTimer);
      await publisher?.wait().catch(() => undefined);
      await saveGithubToken(tokenDraft().trim()); setGithubToken(tokenDraft().trim());
      await flush();
      await storage.waitForSync();
      if (next.folder !== settings()?.folder || next.imagesFolder !== settings()?.imagesFolder) {
        await relocateImages(settings()!, next);
        const manager = new StorageManager(await createBackend(next), native && next.syncEnabled ? new R2Backend(next) : null);
        await manager.initialize(); await bindPaper(manager);
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
      connectPublisher(); publishingPaused = false;
      workspace?.post('settings', next.folder || 'browser');
      if (next.syncEnabled) void storage.sync();
      void syncPublished().catch(() => undefined);
      report('設定を保存しました。');
    } catch (error) { setSettingsError(error instanceof Error ? error.message : String(error)); }
    finally { publishingPaused = false; setBusy(false); }
  }
  function updateDraft(key: keyof Settings, value: string | boolean) { setDraft(previous => previous ? { ...previous, [key]: value } : null); }
  async function refreshFromDisk() {
    if (!ready() || busy()) return;
    try { await flush(); await storage.refresh(); await storage.sync(); await paperNotebook?.refresh(); await reloadActiveAfterSync(); await syncPublished(); }
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
    let unlistenTrackpad: (() => void) | undefined;
    let nativeTrackpadReady = false;
    let sharedTimer: ReturnType<typeof setTimeout> | undefined;
    let sharedTask = Promise.resolve();
    let sharedSettingsChanged = false;
    workspace = workspaceChannel(change => {
      if (!ready() || disposed) return;
      if (change.kind === 'settings') sharedSettingsChanged = true;
      clearTimeout(sharedTimer);
      sharedTimer = setTimeout(() => {
        sharedTask = sharedTask.catch(() => undefined).then(async () => {
          if (disposed) return;
          if (sharedSettingsChanged) {
            sharedSettingsChanged = false; await flush();
            sessionStorage.setItem('pure-restore-visit', JSON.stringify(currentVisit()));
            location.reload(); return;
          }
          if (change.folder !== (settings()?.folder || 'browser')) return;
          await storage.reloadSharedState(); await reloadNotes(); await reloadActiveAfterSync();
          if (!publishingPaused) { clearTimeout(publishTimer); publishTimer = setTimeout(() => void syncPublished().catch(() => undefined), 1500); }
        }).catch(error => report(String(error)));
      }, 40);
    });
    const boot = async () => {
      try {
        const currentSettings = await loadSettings();
        setSettings(currentSettings);
        const manager = new StorageManager(await createBackend(currentSettings));
        bindStorage(manager);
        await manager.initialize();
        if (native) {
          const client = createPaperClient();
          try { await client.initialize(); setPaperClient(client); setPaperConnected(client.connected); setPaperStatus(client.connected ? '接続済み' : '未接続'); }
          catch (error) { report(String(error)); setPaperClient(client); }
        }
        await bindPaper(manager);
        if (native && currentSettings.syncEnabled) { manager.setRemote(new R2Backend(currentSettings)); await manager.sync(); }
        await manager.migrateNoteNames();
        for (const [from, to] of Object.entries(manager.renamedPaths)) {
          const oldKey = journalKey(from); const newKey = journalKey(to);
          const recovered = localStorage.getItem(oldKey);
          if (recovered !== null && localStorage.getItem(newKey) === null) { localStorage.setItem(newKey, recovered); localStorage.removeItem(oldKey); }
        }
        if (currentSettings.lastFile) { currentSettings.lastFile = manager.resolvePath(currentSettings.lastFile); await persistLastFile(currentSettings.lastFile); }
        await reloadNotes();
        if (!notes().length && !manager.hasHistory) {
          const path = await manager.createNote('はじめに');
          await manager.saveNamedNote(path, introduction);
          await reloadNotes();
        }
        try { setGithubToken(await loadGithubToken()); connectPublisher(); } catch (error) { setPublishStatus(String(error)); }
        setReady(true);
        void syncPublished().catch(() => undefined);
        if (paperConnected()) void paperNotebook?.refresh().then(() => reloadActiveAfterSync()).catch(error => report(String(error)));
        const restore = sessionStorage.getItem('pure-restore-visit');
        sessionStorage.removeItem('pure-restore-visit');
        if (restore) {
          const visit = JSON.parse(restore) as Visit;
          const path = visit.path ? manager.resolvePath(safeRelativePath(visit.path)) : '';
          if (visit.kind === 'note' && notes().some(note => note.path === path)) await openNote(path, visit);
          else await goHome(visit.tag ?? '', visit.kind === 'home' ? visit : undefined);
        } else if (props.initialArticle) {
          if (!navigator.locks || typeof BroadcastChannel === 'undefined') throw new Error('複数ウィンドウの編集に必要な機能を利用できません。macOS を更新してください。');
          const path = safeRelativePath(props.initialArticle);
          if (!/\.md$/i.test(path) && !isPaperPath(path)) throw new Error('記事のパスが不正です。');
          await openNote(manager.resolvePath(path));
        } else document.title = 'pure';
        if (native && !mobile) {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const win = getCurrentWindow();
          doubleClickDelay = await invoke<number>('double_click_interval');
          unlistenTrackpad = await win.listen<Parameters<typeof swipe.feed>[0] & { x: number; yFromBottom: number }>('pure://trackpad-scroll', event => {
            handleSwipe(event.payload, document.elementFromPoint(event.payload.x, window.innerHeight - event.payload.yFromBottom));
          });
          nativeTrackpadReady = true;
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
      if ((event.metaKey || event.ctrlKey) && ['l', 'k', 'p', 'n', 'o', ','].includes(event.key.toLowerCase()) && ready()) {
        event.preventDefault();
        if (event.key.toLowerCase() === 'o') { if (native) paperFileInput.click(); else report('Paper の連携は Mac・iPhone アプリから利用できます。'); }
        else if (event.key === ',') { openPalette(); showSettings(); }
        else if (event.key.toLowerCase() === 'n') void newPage().catch(error => report(String(error)));
        else palette() ? closePalette() : openPalette();
      }
    };
    const visibility = () => { if (document.visibilityState === 'visible') void refreshFromDisk(); else void flush().catch(error => report(String(error))); };
    const pagehide = () => { void flush().catch(() => undefined); };
    const online = () => { void refreshFromDisk(); };
    const swipe = new HistorySwipe();
    let hintTimer: ReturnType<typeof setTimeout> | undefined;
    const handleSwipe = (event: Parameters<typeof swipe.feed>[0], target: Element | null) => {
      if (mobile || !ready() || busy() || palette()) { swipe.reset(); setSwipeHint(null); return false; }
      if (target?.closest('select, .cm-tooltip, iframe')) { swipe.reset(); return false; }
      for (let node = target; node && node !== paper; node = node.parentElement) {
        if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(node).overflowX)) { swipe.reset(); return false; }
      }
      const result = swipe.feed(event, performance.now());
      if (result.side) {
        const available = history.canMove(result.side, visit => visit.kind === 'home' || notes().some(note => note.path === visit.path));
        setSwipeHint({ side: result.side, progress: result.progress, available, committed: !!result.direction });
        clearTimeout(hintTimer); hintTimer = setTimeout(() => setSwipeHint(null), 220);
      }
      if (result.direction) void travel(result.direction);
      return result.claim;
    };
    const wheel = (event: WheelEvent) => {
      if (nativeTrackpadReady) return;
      if (handleSwipe(event, event.target instanceof Element ? event.target : null) && event.cancelable) event.preventDefault();
    };
    type Contact = { id: number; gesture: TouchSwipe; mode: 'history' | 'row'; direction: -1 | 1; path: string; initial: number; width: number };
    let contact: Contact | null = null;
    let suppressClickUntil = 0;
    const cancelTouch = () => { contact = null; setSwipeHint(null); setSwipedRow(null); };
    const touchstart = (event: TouchEvent) => {
      if (!mobile) return;
      clearTimeout(hintTimer); setSwipeHint(null); suppressClickUntil = 0;
      if (event.touches.length !== 1 || !ready() || busy() || palette()) { cancelTouch(); return; }
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest('input, textarea, select, iframe, .cm-tooltip, .palette-trigger, .notice, .note-delete')) { contact = null; return; }
      if (window.getSelection()?.toString() || !home() && editor && !editor.view.state.selection.main.empty) { cancelTouch(); return; }
      const touch = event.touches[0]; const width = paper.clientWidth;
      const edge = touch.clientX <= 24 ? -1 : touch.clientX >= width - 24 ? 1 : null;
      if (edge) {
        setSwipedRow(null);
        contact = { id: touch.identifier, gesture: new TouchSwipe({ x: touch.clientX, y: touch.clientY, time: performance.now() }), mode: 'history', direction: edge, path: '', initial: 0, width };
        return;
      }
      const card = home() ? target.closest<HTMLElement>('.note-card[data-note-path]') : null;
      const path = card?.dataset.notePath;
      if (card && path && !isPaperPath(path)) {
        const initial = swipedRow()?.path === path ? swipedRow()!.offset : 0;
        if (swipedRow()?.path !== path) setSwipedRow(null);
        contact = { id: touch.identifier, gesture: new TouchSwipe({ x: touch.clientX, y: touch.clientY, time: performance.now() }), mode: 'row', direction: -1, path, initial, width: card.clientWidth };
      } else { contact = null; setSwipedRow(null); }
    };
    const touchmove = (event: TouchEvent) => {
      if (!contact) return;
      if (event.touches.length !== 1 || event.touches[0].identifier !== contact.id || palette() || busy()) { cancelTouch(); return; }
      const touch = event.touches[0]; const result = contact.gesture.move({ x: touch.clientX, y: touch.clientY, time: performance.now() });
      if (result.cancelled) { cancelTouch(); return; }
      if (!result.claimed) return;
      if (contact.mode === 'history' && (result.dx > 0 ? -1 : 1) !== contact.direction) { cancelTouch(); return; }
      event.preventDefault(); event.stopPropagation(); suppressClickUntil = performance.now() + 450;
      if (contact.mode === 'history') {
        const hint = touchHistoryProgress(result.dx, contact.width);
        setSwipeHint({ side: contact.direction, progress: hint.progress, available: history.canMove(contact.direction, visit => visit.kind === 'home' || notes().some(note => note.path === visit.path)), committed: false });
      } else {
        const row = rowSwipeOffset(result.dx, contact.initial, contact.width);
        setSwipedRow({ path: contact.path, offset: row.offset, dragging: true, full: row.full });
      }
    };
    const touchend = (event: TouchEvent) => {
      if (!contact) return;
      const touch = [...event.changedTouches].find(touch => touch.identifier === contact!.id);
      if (!touch) { cancelTouch(); return; }
      const current = contact; contact = null;
      const result = current.gesture.move({ x: touch.clientX, y: touch.clientY, time: performance.now() });
      if (!result.claimed) { setSwipeHint(null); return; }
      event.preventDefault(); event.stopPropagation(); suppressClickUntil = performance.now() + 450;
      if (current.mode === 'history') {
        const hint = touchHistoryProgress(result.dx, current.width);
        if (hint.complete && (result.dx > 0 ? -1 : 1) === current.direction) void travel(current.direction);
        clearTimeout(hintTimer); hintTimer = setTimeout(() => setSwipeHint(null), 180);
      } else {
        const row = rowSwipeOffset(result.dx, current.initial, current.width);
        if (row.full) { setSwipedRow({ path: current.path, offset: -current.width, dragging: false, full: true }); void deleteArticle(current.path); }
        else setSwipedRow(row.open ? { path: current.path, offset: -rowActionWidth, dragging: false, full: false } : null);
      }
    };
    const click = (event: MouseEvent) => {
      if (!mobile || event.detail === 0) return;
      const target = event.target instanceof Element ? event.target : null;
      if (performance.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (swipedRow() && target?.closest('.note-card')?.getAttribute('data-note-path') === swipedRow()!.path && !target.closest('.note-delete')) {
        setSwipedRow(null); event.preventDefault(); event.stopImmediatePropagation();
      }
    };
    paper.addEventListener('touchstart', touchstart, { capture: true, passive: true });
    paper.addEventListener('touchmove', touchmove, { capture: true, passive: false });
    paper.addEventListener('touchend', touchend, { capture: true, passive: false });
    paper.addEventListener('touchcancel', cancelTouch, true); paper.addEventListener('click', click, true);
    paper.addEventListener('wheel', wheel, { capture: true, passive: false });
    const paperDrop = (event: DragEvent) => {
      const file = [...(event.dataTransfer?.files ?? [])].find(file => /\.paper$/i.test(file.name));
      if (!file) return;
      event.preventDefault(); event.stopPropagation();
      void importPaperFile(file).catch(error => report(String(error)));
    };
    const paperDrag = (event: DragEvent) => { if ([...(event.dataTransfer?.types ?? [])].includes('Files') && home()) event.preventDefault(); };
    paper.addEventListener('drop', paperDrop, true); paper.addEventListener('dragover', paperDrag);
    window.addEventListener('keydown', keydown, true);
    const removeHomeScrollbar = scrollIndicator(homeScroller, homeScroller.parentElement!);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('online', online);
    window.addEventListener('focus', online);
    const retry = setInterval(() => { if (ready() && document.visibilityState === 'visible' && navigator.onLine) { void storage.sync(); void paperNotebook?.sync(); void syncPublished().catch(() => undefined); } }, 60_000);
    onCleanup(() => {
      disposed = true; clearTimeout(hintTimer); clearTimeout(clickTimer); clearTimeout(timer); clearTimeout(toastTimer); clearInterval(retry);
      clearTimeout(sharedTimer); workspace?.close();
      paper.removeEventListener('touchstart', touchstart, true); paper.removeEventListener('touchmove', touchmove, true); paper.removeEventListener('touchend', touchend, true); paper.removeEventListener('touchcancel', cancelTouch, true); paper.removeEventListener('click', click, true);
      paper.removeEventListener('wheel', wheel, true); paper.removeEventListener('drop', paperDrop, true); paper.removeEventListener('dragover', paperDrag);
      window.removeEventListener('keydown', keydown, true); document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pagehide); window.removeEventListener('online', online); window.removeEventListener('focus', online);
      clearTimeout(publishTimer); removeHomeScrollbar(); unlistenStorage?.(); unlistenClose?.(); unlistenScale?.(); unlistenTrackpad?.(); clearOutline?.(); editor?.destroy();
    });
  });

  return <main ref={paper} class="paper" aria-label="pure">
    <input type="file" accept=".paper" hidden ref={paperFileInput} aria-label="Paper ファイルを選択" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void importPaperFile(file).catch(error => report(String(error))); }} />
    <Show when={native && !mobile}><div class="native-title-region" data-tauri-drag-region /></Show>
    <section class="home-surface" hidden={!home()} aria-label="記事一覧">
      <div class="home-scroll" ref={homeScroller}>
        <header class="home-heading"><h1><Show when={!homeTag()} fallback={homeTag()}><AnimatedWordmark active={home() && !palette()} /></Show></h1></header>
        <div class="home-search"><input type="search" aria-label="記事を探す" placeholder="タイトル、タグで探す" value={homeQuery()} onInput={event => setHomeQuery(event.currentTarget.value)} /><Show when={homeQuery()}><button type="button" onClick={() => setHomeQuery('')}>すべて</button></Show></div>
        <div class="publication-filters" role="group" aria-label="記事の公開範囲"><For each={[{ value: 'all' as const, label: 'すべて' }, { value: 'private' as const, label: '非公開' }, { value: 'public' as const, label: '公開' }]}>{filter => <button type="button" aria-pressed={visibilityFilter() === filter.value} onClick={() => setVisibilityFilter(filter.value)}>{filter.label}</button>}</For></div>
        <div class="note-grid"><For each={homeNotes()}>{note => <article class="note-card" data-note-path={note.path} classList={{ 'is-swiping': swipedRow()?.path === note.path && swipedRow()!.dragging, 'is-revealed': swipedRow()?.path === note.path && swipedRow()!.offset < 0, 'is-delete-ready': swipedRow()?.path === note.path && swipedRow()!.full }} style={{ '--row-offset': `${swipedRow()?.path === note.path ? swipedRow()!.offset : 0}px` }}>
          <Show when={mobile && !isPaperPath(note.path)}><button class="note-delete" type="button" aria-label={`${note.title}を削除`} tabindex={swipedRow()?.path === note.path ? 0 : -1} disabled={busy()} onClick={() => void deleteArticle(note.path)}>削除</button></Show>
          <div class="note-card-content">
            <button class="note-title" type="button" disabled={!ready() || busy()} onClick={event => activateNote(event, note.path)} onDblClick={() => { if (!mobile) { clearTimeout(clickTimer); void openArticleWindow(note.path); } }}>{note.title}</button>
            <div class="note-tags">
              <Show when={note.publication?.visibility === 'public'}><PublicationIcon label="公開" status={publishStatus()} /></Show>
              <Show when={note.publication?.visibility === 'private' && publishStatus() !== '公開先は最新です'}><PublicationIcon pending label="取り下げ設定あり" status={publishStatus()} /></Show>
              <For each={note.tags.slice(0, 3)}>{tag => <button type="button" onClick={() => void followReference({ kind: 'tag', value: tag, from: 0, to: 0 })}>{tag}</button>}</For>
              <Show when={note.tags.length > 3}><span class="tags-more" title={note.tags.slice(3).join('、')}>…</span></Show>
            </div>
          </div>
        </article>}</For></div>
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
    <div class="history-swipe" classList={{ 'is-visible': !!swipeHint(), 'is-forward': swipeHint()?.side === 1, 'is-unavailable': !swipeHint()?.available }} style={{ '--swipe-progress': String(swipeHint()?.progress ?? 0) }} aria-hidden="true"><span>{swipeHint()?.side === 1 ? '›' : '‹'}</span></div>
    <Show when={startupError()}><div class="startup-message" role="alert"><p>ノートを開けませんでした。</p><p>{startupError()}</p><button type="button" onClick={() => location.reload()}>もう一度開く</button></div></Show>
    <Show when={ready()}><button class="palette-trigger" classList={{ 'is-native-desktop': native && !mobile }} type="button" aria-label="ノートを開く" title="記事の操作とノート（⌘ L）" onClick={() => openPalette()}><span aria-hidden="true">···</span></button></Show>
    <dialog class="palette" ref={dialog} aria-label={screen() === 'notes' ? 'ノートとコマンド' : '設定'} onCancel={event => { event.preventDefault(); if (!busy()) closePalette(); }} onClick={event => { if (event.target === dialog && !busy()) closePalette(); }}>
      <div class="palette-inner">
        <Show when={screen() === 'notes'} fallback={<form class="settings" onSubmit={saveSettings}>
          <div class="palette-heading"><button type="button" disabled={busy()} onClick={() => { setScreen('notes'); setSettingsError(''); }}>← ノートへ</button><div class="palette-top-actions"><button class="quiet-button" type="button" disabled={busy()} aria-label="閉じる" onClick={closePalette}>閉じる</button><Show when={mobile && (!home() || homeTag())}><button class="palette-home" type="button" disabled={busy()} aria-label="トップページに戻る" onClick={() => void goHome().catch(error => report(String(error)))}>top</button></Show></div></div>
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
            <Show when={draft()?.syncEnabled}><div class="connection-fields r2-fields">
              <label>Endpoint URL<input type="url" required placeholder="https://account-id.r2.cloudflarestorage.com" value={draft()?.endpoint ?? ''} onInput={event => updateDraft('endpoint', event.currentTarget.value.trim())} spellcheck={false} autocapitalize="off" /></label>
              <label>Bucket Name<input required value={draft()?.bucket ?? ''} onInput={event => updateDraft('bucket', event.currentTarget.value.trim())} spellcheck={false} autocapitalize="off" /></label>
              <label>Access Key ID<input required value={draft()?.accessKeyId ?? ''} onInput={event => updateDraft('accessKeyId', event.currentTarget.value.trim())} autocomplete="off" spellcheck={false} autocapitalize="off" /></label>
              <label>Secret Access Key<input type="password" required value={draft()?.secretAccessKey ?? ''} onInput={event => updateDraft('secretAccessKey', event.currentTarget.value.trim())} autocomplete="off" spellcheck={false} /></label>
              <p class="setting-description">{syncStatus()}。アクセスキーは端末のキーチェーンに保存します。</p>
              <button class="text-button" type="button" onClick={() => void run({ id: 'sync', label: '', detail: '', kind: 'action', run: async () => { await flush(); await storage.sync(); } })}>今すぐ同期</button>
            </div></Show>
          </fieldset>
          <fieldset disabled={busy() || !native}><legend>GitHub に公開</legend>
            <p class="setting-description">すべての記事は初期状態で非公開です。記事の ⋯ または ⌘ L から公開を選ぶと、本文・タグ・参照画像を poin7s.com に公開します。取り下げ後も Git の過去履歴は残ります。</p>
            <div class="connection-fields github-fields"><label>記事専用リポジトリ<input placeholder="santa-s4nt4/pure-notes" value={draft()?.githubRepository ?? ''} onInput={event => updateDraft('githubRepository', event.currentTarget.value.trim())} spellcheck={false} autocapitalize="off" /></label>
            <label>ブランチ<input placeholder="main" value={draft()?.githubBranch ?? 'main'} onInput={event => updateDraft('githubBranch', event.currentTarget.value.trim())} spellcheck={false} autocapitalize="off" /></label>
            <label>GitHub トークン<input type="password" value={tokenDraft()} onInput={event => setTokenDraft(event.currentTarget.value)} autocomplete="off" spellcheck={false} autocapitalize="off" placeholder="Fine-grained personal access token" /></label></div>
            <p class="setting-description">{publishStatus()}。トークンはこの端末のキーチェーンだけに保存します。Paper 文書は公開の対象になりません。</p>
          </fieldset>
          <Show when={native}><PaperSettings client={paperClient()} connected={paperConnected()} status={paperStatus()} onConnected={paperConnectionChanged} /></Show>
          <p class="settings-error" role="alert">{settingsError()}</p>
          <div class="settings-footer"><span>pure <span class="version">0.1</span></span><button type="submit" class="save-button" disabled={busy()}>{busy() ? '保存しています' : '設定を保存'}</button></div>
        </form>}>
          <div class="palette-search"><input ref={searchInput} type="text" role="combobox" aria-label="ノートを検索、または新しくつくる" aria-autocomplete="list" aria-controls="note-options" aria-expanded="true" aria-activedescendant={`option-${selected()}`} placeholder="ノートを探す、つくる。" value={query()} onInput={event => setQuery(event.currentTarget.value)} onKeyDown={event => {
            if (event.isComposing) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const length = actions().length; setSelected(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + length) % length); }
            if (event.key === 'Enter') { event.preventDefault(); void run(actions()[selected()]); }
          }} /><div class="palette-top-actions"><Show when={mobile}><button class="palette-settings" type="button" disabled={busy()} aria-label="設定を開く" onClick={showSettings}>設定</button></Show><button class="escape-key" type="button" aria-label="閉じる" onClick={closePalette}>{mobile ? '閉じる' : 'esc'}</button><Show when={mobile && (!home() || homeTag())}><button class="palette-home" type="button" disabled={busy()} aria-label="トップページに戻る" onClick={() => void goHome().catch(error => report(String(error)))}>top</button></Show></div></div>
          <Show when={!home() && !isPaperPath(activePath())}>
            <section class="article-actions" aria-label="この記事の操作">
              <div class="article-visibility"><span>公開範囲</span><div class="visibility-control"><span class="visibility-value">{articleIsPublic() ? '公開' : '非公開'}</span><button class="publication-switch" type="button" role="switch" aria-label="この記事を公開" aria-checked={articleIsPublic()} disabled={busy()} onClick={() => void toggleArticlePublication()}><span /></button></div></div>
              <p class="article-publish-status">{currentArticle()?.publication ? publishStatus() : '公開すると、本文と参照画像が poin7s.com に表示されます。'}</p>
              <div class="article-menu-buttons"><button class="article-delete" type="button" disabled={busy()} onClick={() => { setArticleMenuError(''); void deleteArticle(activePath()); }}>この記事を削除</button></div>
              <Show when={articleMenuError()}><p class="settings-error" role="alert">{articleMenuError()}</p></Show>
            </section>
          </Show>
          <div class="palette-results" id="note-options" role="listbox" aria-label="ノートとコマンド" aria-busy={busy()}>
            <Show when={filtered().length === 0 && query()}><p class="empty-result">まだ、ここには何もありません。</p></Show>
            <For each={actions()}>{(action, index) => <button type="button" role="option" id={`option-${index()}`} aria-selected={selected() === index()} class="palette-option" classList={{ 'is-action': action.kind === 'action', 'is-current': action.id === activePath() }} disabled={busy()} onPointerMove={() => setSelected(index())} onClick={() => void run(action)}>
              <span class="option-name">{action.label}</span><span class="option-detail">{action.detail}</span><span class="option-enter" aria-hidden="true">↵</span>
            </button>}</For>
          </div>
          <div class="palette-footer"><span>pure</span><span>↑ ↓ 選ぶ <span class="footer-space">↵ 開く</span></span></div>
        </Show>
      </div>
    </dialog>
    <Show when={message()}><div class="notice" role="status"><span>{message()}</span><Show when={deleted()}><button type="button" onClick={() => void restoreDeleted()}>元に戻す</button></Show><button class="notice-close" type="button" aria-label="通知を閉じる" onClick={() => setMessage('')}>×</button></div></Show>
  </main>;
}
