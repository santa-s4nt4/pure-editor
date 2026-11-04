import { ViewPlugin, WidgetType, type EditorView, type ViewUpdate } from '@codemirror/view';

/** Prefix still drawn as text; bullet and checkbox widgets supply their own width. */
export function listLayout(text: string): { prefix: string; widget: boolean; contentFrom: number } | null {
  const task = /^([ \t]*)(?:[-+*]|\d+[.)])[ \t]+\[[ xX]\][ \t]+/.exec(text);
  const bullet = /^([ \t]*)[-+*][ \t]+/.exec(text);
  if (task || bullet) {
    const match = task ?? bullet!;
    return { prefix: match[1], widget: true, contentFrom: match[0].length };
  }
  const ordered = /^[ \t]*\d+[.)][ \t]+/.exec(text);
  if (ordered) return { prefix: ordered[0], widget: false, contentFrom: ordered[0].length };
  const indent = /^[ \t]+/.exec(text);
  return indent ? { prefix: indent[0], widget: false, contentFrom: indent[0].length } : null;
}
export function prefixVariable(prefix: string) {
  return `--list-prefix-${prefix ? prefix.replace(/ /g, 's').replace(/\t/g, 't').replace(/\./g, 'd').replace(/\)/g, 'p') : 'empty'}`;
}
export function hangingIndent(layout: { prefix: string; widget: boolean }) {
  return `calc(var(${prefixVariable(layout.prefix)}, 0px)${layout.widget ? ' + 1.5em' : ''})`;
}

export const tabVariable = (prefix: string, offset: number) => `${prefixVariable(prefix)}-tab-${offset}`;
/** Fixed tab advances prevent hanging padding from changing the browser's tab stops. */
export class ListTabWidget extends WidgetType {
  constructor(private prefix: string, private offset: number) { super(); }
  eq(other: WidgetType) { return other instanceof ListTabWidget && other.prefix === this.prefix && other.offset === this.offset; }
  toDOM() {
    const tab = document.createElement('span'); tab.className = 'cm-list-tab'; tab.setAttribute('aria-hidden', 'true');
    tab.style.inlineSize = `var(${tabVariable(this.prefix, this.offset)}, 0px)`; return tab;
  }
  ignoreEvent() { return false; }
}

/** Measure rendered spaces/tabs, including proportional fonts and letter spacing. */
export const listPrefixMeasurements = ViewPlugin.fromClass(class {
  private measure: HTMLDivElement;
  private widths = new Map<string, number>();
  private disposed = false;
  constructor(private view: EditorView) {
    this.measure = document.createElement('div'); this.measure.className = 'cm-list-prefix-measure';
    this.measure.setAttribute('aria-hidden', 'true'); view.dom.append(this.measure);
    this.schedule();
    void document.fonts.ready.then(() => { if (!this.disposed) this.schedule(); });
  }
  update(update: ViewUpdate) { if (update.docChanged || update.viewportChanged || update.geometryChanged) this.schedule(); }
  private schedule() {
    if (this.disposed) return;
    const prefixes = new Set<string>();
    for (const range of this.view.visibleRanges) {
      const last = this.view.state.doc.lineAt(range.to).number;
      for (let number = this.view.state.doc.lineAt(range.from).number; number <= last; number++) {
        const layout = listLayout(this.view.state.doc.line(number).text);
        if (layout) { prefixes.add(layout.prefix); prefixes.add(/^[ \t]*/.exec(this.view.state.doc.line(number).text)![0]); }
      }
    }
    const samples = [...prefixes].map(prefix => {
      const span = document.createElement('span'); span.textContent = prefix; return { prefix, span };
    });
    this.measure.style.tabSize = String(this.view.state.tabSize);
    this.measure.replaceChildren(...samples.map(sample => sample.span));
    this.view.requestMeasure({ key: this,
      read: () => samples.flatMap(({ prefix, span }) => {
        const values = [{ property: prefixVariable(prefix), width: span.getBoundingClientRect().width }];
        const text = span.firstChild;
        if (text) for (let offset = 0; offset < prefix.length; offset++) if (prefix[offset] === '\t') {
          const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1);
          values.push({ property: tabVariable(prefix, offset), width: range.getBoundingClientRect().width });
        }
        return values;
      }),
      write: values => {
        if (this.disposed) return;
        let changed = false;
        for (const { property, width } of values) {
          if (Math.abs((this.widths.get(property) ?? -1) - width) < .01) continue;
          this.widths.set(property, width); this.view.dom.style.setProperty(property, `${width}px`); changed = true;
        }
        if (changed) this.view.requestMeasure();
      },
    });
  }
  destroy() { this.disposed = true; this.measure.remove(); for (const property of this.widths.keys()) this.view.dom.style.removeProperty(property); }
});
