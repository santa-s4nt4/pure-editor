import { ViewPlugin, type EditorView } from '@codemirror/view';
import { scrollIndicator } from './scrollbar';

/** Autocomplete replaces its list as results change; keep the shared indicator attached. */
export const completionScrollbar = ViewPlugin.fromClass(class {
  private observer: MutationObserver;
  private list: HTMLElement | null = null;
  private remove: (() => void) | undefined;
  constructor(private view: EditorView) {
    this.observer = new MutationObserver(() => this.attach());
    this.observer.observe(view.dom, { childList: true, subtree: true });
    this.attach();
  }
  private attach() {
    const list = this.view.dom.querySelector<HTMLElement>('.tag-suggestions > ul');
    if (list === this.list) return;
    this.remove?.(); this.remove = undefined; this.list = list;
    if (list) this.remove = scrollIndicator(list, list.parentElement!);
  }
  destroy() { this.observer.disconnect(); this.remove?.(); }
});
