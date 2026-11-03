import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { tagCompletion } from './tag-completion';
import { EditorState, EditorSelection, Prec, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, drawSelection, dropCursor, keymap, placeholder, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';
import { invoke } from '@tauri-apps/api/core';
import { protectedRanges, scanReferences, videoEmbed, type Reference } from './transformer';
import { mobile, native, type StorageManager } from './storage';
import { mediaLine } from './media';
import { scrollIndicator } from './scrollbar';
import { dataImageBlob } from './image-data';

export interface EditorOptions {
  parent: HTMLElement;
  text: string;
  readOnly?: boolean;
  imagesAllowed?: boolean;
  storage: StorageManager;
  tags(): readonly string[];
  onChange(text: string): void;
  onReference(reference: Reference): void;
  onError(message: string): void;
  onSave(): void;
}

const highlighting = HighlightStyle.define([
  { tag: tags.heading1, class: 'cm-heading-1' },
  { tag: tags.heading2, class: 'cm-heading-2' },
  { tag: tags.heading3, class: 'cm-heading-3' },
  { tag: tags.strong, class: 'cm-strong' },
  { tag: tags.emphasis, class: 'cm-emphasis' },
  { tag: tags.monospace, class: 'cm-code' },
  { tag: tags.link, class: 'cm-markdown-link' },
  { tag: tags.url, class: 'cm-url' },
  { tag: tags.processingInstruction, class: 'cm-mark' },
  { tag: tags.quote, class: 'cm-quote' },
  { tag: tags.meta, class: 'cm-mark' },
]);

function styleMediaList(container: HTMLElement, prefix: string, sourceVisible: boolean) {
  if (!prefix) return;
  container.classList.add('is-list');
  container.classList.toggle('has-source', sourceVisible);
  const indent = /^\s*/.exec(prefix)![0].replace(/\t/g, '   ').length;
  container.style.setProperty('--list-indent', `calc(1.5em + ${indent}ch)`);
}

function editMediaSource(container: HTMLElement, view: EditorView) {
  container.addEventListener('mousedown', event => {
    // プレイヤー本体は再生に使い、周囲の余白はソース行の選択に使う。
    if (event.button !== 0 || event.target !== container) return;
    const line = view.state.doc.lineAt(view.posAtDOM(container));
    const prefix = mediaLine(line.text)?.prefix ?? '';
    const head = line.from + prefix.length;
    view.focus();
    view.dispatch({ selection: { anchor: event.shiftKey ? view.state.selection.main.anchor : head, head }, scrollIntoView: true, userEvent: 'select.pointer' });
    event.preventDefault(); event.stopPropagation();
  });
}

class VideoWidget extends WidgetType {
  private observer?: ResizeObserver;
  private height = 320;
  constructor(readonly src: string, readonly title: string, readonly prefix = '', readonly sourceVisible = false) { super(); }
  eq(other: VideoWidget) { return this.src === other.src && this.prefix === other.prefix && this.sourceVisible === other.sourceVisible; }
  toDOM(view: EditorView) {
    const container = document.createElement('div');
    container.className = 'cm-embed-video';
    styleMediaList(container, this.prefix, this.sourceVisible);
    editMediaSource(container, view);
    const viewport = document.createElement('div'); viewport.className = 'cm-video-viewport';
    const iframe = document.createElement('iframe');
    const destination = new URL(this.src);
    if (native && destination.hostname === 'www.youtube-nocookie.com') {
      const id = destination.pathname.split('/').pop()!;
      void invoke<string>('video_url', { id }).then(url => { iframe.src = url; }).catch(() => { container.textContent = '動画を表示できませんでした。URL から開けます。'; });
    } else iframe.src = destination.href;
    iframe.title = this.title;
    iframe.loading = 'lazy';
    iframe.allow = 'accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen';
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
    iframe.onload = () => view.requestMeasure();
    viewport.append(iframe); container.append(viewport);
    this.observer = new ResizeObserver(() => {
      const height = container.getBoundingClientRect().height;
      if (Math.abs(height - this.height) > 0.5) { this.height = height; view.requestMeasure(); }
    });
    this.observer.observe(container);
    return container;
  }
  destroy() { this.observer?.disconnect(); }
  get estimatedHeight() { return this.height; }
  ignoreEvent() { return true; }
}

class ImageWidget extends WidgetType {
  private objectUrl = '';
  private disposed = false;
  private observer?: ResizeObserver;
  constructor(readonly path: string, readonly alt: string, readonly storage: StorageManager, readonly prefix = '', readonly sourceVisible = false) { super(); }
  eq(other: ImageWidget) { return this.path === other.path && this.alt === other.alt && this.storage === other.storage && this.prefix === other.prefix && this.sourceVisible === other.sourceVisible; }
  toDOM(view: EditorView) {
    const figure = document.createElement('figure');
    figure.className = 'cm-embed-image';
    styleMediaList(figure, this.prefix, this.sourceVisible);
    editMediaSource(figure, view);
    const image = document.createElement('img');
    image.alt = this.alt;
    image.decoding = 'async';
    image.onload = () => view.requestMeasure();
    image.onerror = () => { figure.textContent = '画像を表示できませんでした。'; };
    figure.append(image);
    this.observer = new ResizeObserver(() => view.requestMeasure()); this.observer.observe(figure);
    void this.storage.imageUrl(this.path).then(url => {
      if (this.disposed) URL.revokeObjectURL(url);
      else { this.objectUrl = url; image.src = url; }
    }).catch(() => { if (!this.disposed) figure.textContent = '画像が見つかりません。'; });
    return figure;
  }
  destroy() { this.disposed = true; this.observer?.disconnect(); if (this.objectUrl) URL.revokeObjectURL(this.objectUrl); }
  get estimatedHeight() { return 280; }
  ignoreEvent(event: Event) { return event.type !== 'mousedown' && event.type !== 'touchstart'; }
}

export async function compressImage(blob: Blob): Promise<Uint8Array> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const ratio = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('画像を処理できませんでした。');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (native) {
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const result = await invoke<ArrayBuffer>('encode_webp', new Uint8Array(pixels.buffer), { headers: { 'x-image-width': String(canvas.width), 'x-image-height': String(canvas.height) } });
      return new Uint8Array(result);
    }
    const output = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result?.type === 'image/webp' ? resolve(result) : reject(new Error('この環境では WebP に変換できません。')), 'image/webp', 0.85));
    return new Uint8Array(await output.arrayBuffer());
  } finally { URL.revokeObjectURL(url); }
}

class RuleWidget extends WidgetType {
  eq(other: WidgetType) { return other instanceof RuleWidget; }
  toDOM() { const rule = document.createElement('div'); rule.className = 'cm-rule'; rule.setAttribute('role', 'separator'); return rule; }
  get estimatedHeight() { return 40; }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly position: number) { super(); }
  eq(other: CheckboxWidget) { return this.checked === other.checked && this.position === other.position; }
  toDOM(view: EditorView) {
    const prefix = document.createElement('span'); prefix.className = 'cm-task-prefix'; prefix.contentEditable = 'false';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = this.checked; input.className = 'cm-task-checkbox'; input.disabled = view.state.readOnly; input.setAttribute('aria-label', this.checked ? '完了を取り消す' : '完了にする');
    input.addEventListener('change', () => {
      view.dispatch({ changes: { from: this.position, to: this.position + 1, insert: input.checked ? 'x' : ' ' }, userEvent: 'input.task' });
    });
    prefix.append(input); return prefix;
  }
  ignoreEvent() { return true; }
}

class BulletWidget extends WidgetType {
  eq(other: WidgetType) { return other instanceof BulletWidget; }
  toDOM() {
    const marker = document.createElement('span'); marker.className = 'cm-list-marker';
    marker.setAttribute('aria-hidden', 'true'); return marker;
  }
  ignoreEvent() { return false; }
}

async function nativeClipboardImage(): Promise<Blob> {
  const { readImage } = await import('@tauri-apps/plugin-clipboard-manager');
  const image = await readImage();
  try {
    const [size, rgba] = await Promise.all([image.size(), image.rgba()]);
    const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('画像を読み込めませんでした。');
    context.putImageData(new ImageData(new Uint8ClampedArray(rgba), size.width, size.height), 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('画像を読み込めませんでした。')), 'image/png'));
  } finally { await image.close(); }
}

export function clipboardImageFiles(data: DataTransfer): Blob[] {
  const files = [...data.files].filter(file => file.type.startsWith('image/') || /\.(?:png|jpe?g|gif|webp|avif|bmp|tiff?|heic)$/i.test(file.name));
  if (files.length) return files;
  return [...data.items].filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => !!file);
}

const addInsertion = StateEffect.define<{ id: string; position: number }>();
const removeInsertion = StateEffect.define<string>();
const insertions = StateField.define<Map<string, number>>({
  create: () => new Map(),
  update(previous, transaction) {
    const next = new Map([...previous].map(([id, position]) => [id, transaction.changes.mapPos(position, 1)]));
    for (const effect of transaction.effects) {
      if (effect.is(addInsertion)) next.set(effect.value.id, effect.value.position);
      if (effect.is(removeInsertion)) next.delete(effect.value);
    }
    return next;
  },
});

function mediaExtension(storage: StorageManager): Extension {
  const decorate = (state: EditorState): DecorationSet => {
    const text = state.doc.toString();
    const excluded = protectedRanges(text, false);
    const decorations: { from: number; to: number; decoration: Decoration }[] = [];
    const activeLine = (number: number) => state.selection.ranges.some(range =>
      number >= state.doc.lineAt(range.from).number && number <= state.doc.lineAt(range.to).number);
    const hiddenMedia: { from: number; to: number }[] = [];
    for (let number = 1; number <= state.doc.lines; number++) {
      const line = state.doc.line(number);
      if (excluded.some(range => range.from <= line.from && range.to > line.from && !text.slice(range.from, range.to).startsWith('!['))) continue;
      const heading = /^( {0,3})(#{1,6})\s+/.exec(line.text);
      if (/^\s*---\s*$/.test(line.text)) {
        decorations.push({ from: line.from, to: line.to, decoration: Decoration.replace({ widget: new RuleWidget(), block: true }) });
        continue;
      }
      const task = /^(\s*(?:[-+*]|\d+[.)])\s+)\[([ xX])\]\s+/.exec(line.text);
      const media = mediaLine(line.text);
      const active = activeLine(number);
      if (task) {
        const indent = /^\s*/.exec(line.text)![0].length;
        const position = line.from + task[1].length + 1;
        decorations.push({ from: line.from + indent, to: line.from + task[0].length, decoration: Decoration.replace({ widget: new CheckboxWidget(task[2].toLowerCase() === 'x', position) }) });
        if (task[2].toLowerCase() === 'x') decorations.push({ from: line.from, to: line.from, decoration: Decoration.line({ class: 'cm-task-done' }) });
      } else if (!media || active) {
        const bullet = /^(\s*)[-+*]\s+/.exec(line.text);
        if (bullet) decorations.push({ from: line.from + bullet[1].length, to: line.from + bullet[0].length, decoration: Decoration.replace({ widget: new BulletWidget() }) });
      }
      if (heading) {
        decorations.push({ from: line.from, to: line.from, decoration: Decoration.line({ class: `cm-heading-line cm-heading-level-${heading[2].length}`, attributes: number === 1 && heading[2].length === 1 && !line.text.slice(heading[0].length).trim() ? { 'data-empty-title': 'true' } : {} }) });
        decorations.push({ from: line.from + heading[1].length, to: line.from + heading[0].length, decoration: Decoration.replace({}) });
      }
      if (media) {
        const widget = media.image ? new ImageWidget(media.image.path, media.image.alt, storage, media.prefix, active) : new VideoWidget(media.video!.src, media.video!.title, media.prefix, active);
        decorations.push(active
          ? { from: line.to, to: line.to, decoration: Decoration.widget({ widget, block: true, side: 1 }) }
          : { from: line.from, to: line.to, decoration: Decoration.replace({ widget, block: true }) });
        if (!active) hiddenMedia.push({ from: line.from, to: line.to });
      }
    }
    for (const ref of scanReferences(text)) {
      if (hiddenMedia.some(range => ref.from >= range.from && ref.to <= range.to)) continue;
      if (activeLine(state.doc.lineAt(ref.from).number)) {
        const line = state.doc.lineAt(ref.from);
        if (!decorations.some(item => item.from === line.from && item.decoration.spec.class === 'cm-reference-source')) decorations.push({ from: line.from, to: line.from, decoration: Decoration.line({ class: 'cm-reference-source' }) });
        continue;
      }
      const from = ref.contentFrom ?? ref.from + 1;
      const to = ref.contentTo ?? ref.to;
      if (from > ref.from) decorations.push({ from: ref.from, to: from, decoration: Decoration.replace({}) });
      if (to < ref.to) decorations.push({ from: to, to: ref.to, decoration: Decoration.replace({}) });
      decorations.push({ from, to, decoration: Decoration.mark({ class: ref.kind === 'url' ? 'cm-scrapbox-link' : 'cm-hashtag', attributes: { 'data-reference': String(ref.from) } }) });
    }
    return Decoration.set(decorations.map(d => d.decoration.range(d.from, d.to)), true);
  };
  return StateField.define<DecorationSet>({
    create: decorate,
    update: (value, transaction) => transaction.docChanged || transaction.selection ? decorate(transaction.state) : value,
    provide: field => EditorView.decorations.from(field),
  });
}

export function createEditor(options: EditorOptions): { view: EditorView; destroy(): void; pending(): Promise<void> } {
  let disposed = false;
  let dragSelection: { anchor: number; x: number; y: number } | null = null;
  let lastTouch = 0;
  let scrollFrame = 0;
  let clickStart: { x: number; y: number; moved: boolean } | null = null;
  let clickedReference: { reference: Reference; bounds: DOMRect } | null = null;
  const captureReference = (target: EventTarget | null, x: number, y: number, editor: EditorView) => {
    clickedReference = null;
    const element = target instanceof Element ? target.closest('[data-reference]') : null;
    if (!element) return;
    const bounds = [...element.getClientRects()].find(rect => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
    const reference = scanReferences(editor.state.doc.toString()).find(ref => ref.from === Number(element.getAttribute('data-reference')));
    if (bounds && reference) clickedReference = { reference, bounds };
  };
  const activateReference = (x: number, y: number, editor: EditorView) => {
    const captured = clickedReference; clickedReference = null;
    if (!captured || clickStart?.moved || !editor.state.selection.main.empty || x < captured.bounds.left || x > captured.bounds.right || y < captured.bounds.top || y > captured.bounds.bottom) return false;
    options.onReference(captured.reference); return true;
  };
  const enterMedia = (editor: EditorView, direction: -1 | 1, extend = false) => {
    const range = editor.state.selection.main;
    if (!range.empty && !extend) return false;
    const line = editor.state.doc.lineAt(range.head);
    const number = line.number + direction;
    if (number < 1 || number > editor.state.doc.lines) return false;
    const next = editor.state.doc.line(number);
    const excluded = protectedRanges(editor.state.doc.toString(), false);
    const sourceMedia = (source: typeof line) => excluded.some(range => range.from <= source.from && range.to > source.from && !editor.state.doc.sliceString(range.from, range.from + 2).startsWith('![')) ? null : mediaLine(source.text);
    const media = sourceMedia(next);
    const currentMedia = sourceMedia(line);
    if (!media && !currentMedia) return false;
    const moved = editor.moveVertically(EditorSelection.cursor(range.head), direction > 0);
    // 折り返し中は通常の移動を保ち、隠れた埋め込み行へ入るときだけ補う。
    if (editor.state.doc.lineAt(moved.head).number === line.number) {
      const origin = editor.coordsAtPos(range.head), target = editor.coordsAtPos(moved.head);
      if (!currentMedia || (origin && target && Math.abs(origin.top - target.top) > 1)) return false;
    }
    const head = next.from + Math.min(range.head - line.from, next.length);
    editor.dispatch({ selection: { anchor: extend ? range.anchor : head, head }, scrollIntoView: true, userEvent: 'select' });
    return true;
  };
  const operations = new Set<Promise<void>>();
  const applyCommittedShortcut = (editor: EditorView) => {
    if (disposed || !editor.state.selection.main.empty) return;
    const cursor = editor.state.selection.main.head;
    const line = editor.state.doc.lineAt(cursor);
    if (protectedRanges(editor.state.doc.toString(), false).some(range => line.from >= range.from && line.from < range.to)) return;
    const before = editor.state.doc.sliceString(line.from, cursor);
    const checkbox = /^(\s*(?:[-+*]|\d+[.)])\s+)?\[\][ \t]+$/.exec(before);
    if (checkbox) {
      const insert = `${checkbox[1] ?? '- '}[ ] `;
      editor.dispatch({ changes: { from: line.from, to: cursor, insert }, selection: { anchor: line.from + insert.length }, userEvent: 'input.type' });
    } else if (before === '--- ') {
      const blank = line.number > 1 && editor.state.doc.line(line.number - 1).text.trim() ? '\n' : '';
      const insert = `${blank}---\n`;
      editor.dispatch({ changes: { from: line.from, to: cursor, insert }, selection: { anchor: line.from + insert.length }, userEvent: 'input.type' });
    }
  };

  const insertImages = (files: Promise<Blob[]> | Blob[], at: number, view: EditorView, replaceTo = at, fallbackText = '') => {
    if (options.imagesAllowed === false) { if (files instanceof Promise) void files.catch(() => undefined); options.onError('Paper への画像の追加は Dropbox Paper 側で行ってください。'); return; }
    const id = crypto.randomUUID();
    view.dispatch({ effects: [addInsertion.of({ id, position: at }), addInsertion.of({ id: `${id}:end`, position: replaceTo })] });
    const operation = (async () => {
      try {
        let replaced = false;
        for (const file of await files) {
          const bytes = await compressImage(file);
          const path = await options.storage.saveImage(bytes);
          if (disposed) return;
          const bookmark = view.state.field(insertions).get(id);
          if (bookmark === undefined) return;
          let position = bookmark;
          const line = view.state.doc.lineAt(position);
          const list = /^(\s*(?:[-+*]|\d+[.)])\s+)/.exec(line.text)?.[1] ?? '';
          if (list) position = Math.max(position, line.from + list.length);
          const before = view.state.doc.sliceString(line.from, position);
          const prefix = list ? before === list ? '' : `\n${list}` : position > line.from ? '\n' : '';
          const markdown = `${prefix}![](${path})\n${list}`;
          const end = view.state.field(insertions).get(`${id}:end`) ?? position;
          view.dispatch({ changes: { from: position, to: replaced ? position : Math.max(position, end), insert: markdown }, selection: { anchor: position + markdown.length }, effects: addInsertion.of({ id, position: position + markdown.length }) });
          replaced = true;
        }
      } catch (error) {
        if (fallbackText && !disposed) {
          const position = view.state.field(insertions).get(id);
          if (position !== undefined) view.dispatch({ changes: { from: position, insert: fallbackText } });
        }
        options.onError(error instanceof Error ? error.message : '画像を追加できませんでした。');
      }
      finally { if (!disposed) view.dispatch({ effects: [removeInsertion.of(id), removeInsertion.of(`${id}:end`)] }); }
    })();
    operations.add(operation);
    void operation.finally(() => operations.delete(operation));
  };

  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: options.text,
      extensions: [
        ...(options.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorState.transactionFilter.of(transaction => transaction.docChanged ? [] : transaction)] : []),
        autocompletion({ override: [tagCompletion(options.tags)], activateOnTypingDelay: 75, defaultKeymap: false, icons: false }),
        Prec.highest(keymap.of(completionKeymap)),
        EditorState.phrases.of({ Completions: 'タグの候補' }),
        history(), markdown(), syntaxHighlighting(highlighting), EditorView.lineWrapping, drawSelection(), dropCursor(),
        EditorView.scrollMargins.of(() => ({ top: 56, bottom: 24 })),
        placeholder('ただ、書く。'), mediaExtension(options.storage), insertions, indentUnit.of('   '),
        EditorView.contentAttributes.of({ 'aria-label': 'ノート本文', 'aria-multiline': 'true', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
        keymap.of([
          { key: 'ArrowUp', run: editor => enterMedia(editor, -1), shift: editor => enterMedia(editor, -1, true) },
          { key: 'ArrowDown', run: editor => enterMedia(editor, 1), shift: editor => enterMedia(editor, 1, true) },
          indentWithTab, { key: 'Mod-s', run: () => { options.onSave(); return true; } }, ...defaultKeymap, ...historyKeymap,
        ]),
        EditorView.inputHandler.of((editor, from, to, text) => {
          if (editor.composing) return false;
          if (text === '[') {
            const selected = editor.state.doc.sliceString(from, to);
            editor.dispatch({ changes: { from, to, insert: `[${selected}]` }, selection: { anchor: from + 1, head: from + 1 + selected.length }, userEvent: 'input.type' }); return true;
          }
          if (text === ']' && from === to && editor.state.doc.sliceString(from, from + 1) === ']') {
            editor.dispatch({ selection: { anchor: from + 1 } }); return true;
          }
          if (text === ' ' && from === to) {
            const line = editor.state.doc.lineAt(from);
            if (protectedRanges(editor.state.doc.toString(), false).some(range => line.from >= range.from && line.from < range.to)) return false;
            const before = editor.state.doc.sliceString(line.from, from);
            if (before === '---') {
              const blank = line.number > 1 && editor.state.doc.line(line.number - 1).text.trim() ? '\n' : '';
              const insert = `${blank}---\n`;
              editor.dispatch({ changes: { from: line.from, to: from, insert }, selection: { anchor: line.from + insert.length }, userEvent: 'input.type' }); return true;
            }
            const checkbox = /^(\s*(?:[-+*]|\d+[.)])\s+)?\[\]$/.exec(before);
            if (checkbox) {
              const insert = `${checkbox[1] ?? '- '}[ ] `;
              editor.dispatch({ changes: { from: line.from, to: from, insert }, selection: { anchor: line.from + insert.length }, userEvent: 'input.type' }); return true;
            }
          }
          return false;
        }),
        EditorView.updateListener.of(update => { if (update.docChanged) options.onChange(update.state.doc.toString()); }),
        EditorView.domEventHandlers({
          compositionend(_event, editor) { setTimeout(() => applyCommittedShortcut(editor), 0); return false; },
          touchstart(event, editor) {
            lastTouch = Date.now(); const touch = event.touches[0];
            if (touch) { clickStart = { x: touch.clientX, y: touch.clientY, moved: false }; captureReference(event.target, touch.clientX, touch.clientY, editor); }
            return false;
          },
          touchmove(event) {
            const touch = event.touches[0];
            if (touch && clickStart && Math.hypot(touch.clientX - clickStart.x, touch.clientY - clickStart.y) > 4) clickStart.moved = true;
            return false;
          },
          touchend(event, editor) {
            const touch = event.changedTouches[0];
            if (!touch || !activateReference(touch.clientX, touch.clientY, editor)) return false;
            event.preventDefault(); return true;
          },
          mousedown(event, editor) {
            clickStart = { x: event.clientX, y: event.clientY, moved: false };
            captureReference(event.target, event.clientX, event.clientY, editor);
            if (event.button !== 0 || event.detail > 1 || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || editor.composing || Date.now() - lastTouch < 2000) return false;
            if (!(event.target instanceof Element) || !event.target.closest('.cm-line') || event.target.closest('input,button,a,iframe')) return false;
            const position = editor.posAtCoords({ x: event.clientX, y: event.clientY });
            if (position === null) return false;
            dragSelection = { anchor: position, x: event.clientX, y: event.clientY };
            editor.focus(); editor.dispatch({ selection: { anchor: position }, userEvent: 'select.pointer' });
            event.preventDefault(); return true;
          },
          paste(event, editor) {
            if (options.readOnly) { event.preventDefault(); return true; }
            const data = event.clipboardData;
            if (!data) return false;
            const images = clipboardImageFiles(data);
            const { from, to } = editor.state.selection.main;
            if (images.length) { event.preventDefault(); insertImages(images, from, editor, to); return true; }
            const html = data.getData('text/html');
            const fragment = html ? new DOMParser().parseFromString(html, 'text/html') : null;
            const source = fragment?.querySelector('img')?.getAttribute('src');
            const imageOnly = !!source && !fragment?.body.textContent?.trim() && fragment?.querySelectorAll('img').length === 1;
            if (imageOnly && source?.startsWith('data:image/')) {
              event.preventDefault(); insertImages(Promise.resolve().then(() => [dataImageBlob(source)]), from, editor, to); return true;
            }
            if (native && !mobile && (imageOnly || !data.getData('text/plain').trim() || [...data.types].some(type => /image|files/i.test(type)))) {
              event.preventDefault(); insertImages(nativeClipboardImage().then(blob => [blob]), from, editor, to, data.getData('text/plain')); return true;
            }
            const text = data.getData('text/plain').trim();
            if (videoEmbed(text)) {
              event.preventDefault();
              const before = editor.state.doc.sliceString(editor.state.doc.lineAt(from).from, from);
              const prefix = before && !/^\s*(?:[-+*]|\d+[.)])\s+$/.test(before) ? '\n' : '';
              const insert = `${prefix}[${text}]\n`;
              editor.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
              return true;
            }
            return false;
          },
          dragover(event) { if ([...(event.dataTransfer?.items ?? [])].some(item => item.type.startsWith('image/'))) { event.preventDefault(); return true; } return false; },
          drop(event, editor) {
            if (options.readOnly) { event.preventDefault(); return true; }
            const images = [...(event.dataTransfer?.files ?? [])].filter(file => file.type.startsWith('image/'));
            if (!images.length) return false;
            event.preventDefault();
            insertImages(images, editor.posAtCoords({ x: event.clientX, y: event.clientY }) ?? editor.state.selection.main.head, editor);
            return true;
          },
          click(event, editor) {
            if (!activateReference(event.clientX, event.clientY, editor)) return false;
            event.preventDefault(); return true;
          },
        }),
      ],
    }),
  });
  // WebKit では押下中の mousemove.buttons が 0 になる場合がある。
  // mousedown〜mouseup を自分で追跡し、最終座標でも選択を確定する。
  const extendSelection = (x: number, y: number) => {
    if (!dragSelection || disposed) return;
    const position = view.posAtCoords({ x, y }, false);
    if (position !== null) view.dispatch({ selection: { anchor: dragSelection.anchor, head: position }, userEvent: 'select.pointer' });
  };
  const autoScroll = () => {
    scrollFrame = 0;
    if (!dragSelection || disposed) return;
    const bounds = view.scrollDOM.getBoundingClientRect();
    const delta = dragSelection.y < bounds.top + 24 ? -12 : dragSelection.y > bounds.bottom - 24 ? 12 : 0;
    if (delta) {
      view.scrollDOM.scrollTop += delta;
      extendSelection(dragSelection.x, Math.max(bounds.top + 1, Math.min(bounds.bottom - 1, dragSelection.y)));
      scrollFrame = requestAnimationFrame(autoScroll);
    }
  };
  const move = (event: MouseEvent) => {
    if (clickStart && Math.hypot(event.clientX - clickStart.x, event.clientY - clickStart.y) > 4) clickStart.moved = true;
    if (!dragSelection) return;
    dragSelection.x = event.clientX; dragSelection.y = event.clientY;
    extendSelection(event.clientX, event.clientY);
    if (!scrollFrame) scrollFrame = requestAnimationFrame(autoScroll);
  };
  const up = (event: MouseEvent) => {
    if (clickStart && Math.hypot(event.clientX - clickStart.x, event.clientY - clickStart.y) > 4) clickStart.moved = true;
    if (dragSelection) {
      if (clickStart?.moved) extendSelection(event.clientX, event.clientY);
      dragSelection = null;
      event.preventDefault();
      cancelAnimationFrame(scrollFrame); scrollFrame = 0;
    }
    // ソース表示で押下対象の span が消えても、文字の矩形内での単純クリックだけを開く。
    if (event.button === 0 && activateReference(event.clientX, event.clientY, view)) event.preventDefault();
  };
  const document = view.contentDOM.ownerDocument;
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  const removeScrollbar = scrollIndicator(view.scrollDOM, view.dom);
  return { view, destroy() { disposed = true; dragSelection = null; cancelAnimationFrame(scrollFrame); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); removeScrollbar(); view.destroy(); }, async pending() { await Promise.all([...operations]); } };
}
