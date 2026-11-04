import type { CompletionSource } from '@codemirror/autocomplete';
import { protectedRanges } from './transformer';

export function tagContext(text: string, position: number) {
  const lineStart = text.lastIndexOf('\n', position - 1) + 1;
  const open = text.lastIndexOf('[', position - 1);
  if (open < lineStart || text.slice(open + 1, position).includes(']')) return null;
  const slashes = /\\*$/.exec(text.slice(0, open))![0].length;
  if (slashes % 2 || text[open - 1] === '!' || text[open - 1] === '[') return null;
  const endOfLine = text.indexOf('\n', position);
  const lineEnd = endOfLine < 0 ? text.length : endOfLine;
  const close = text.indexOf(']', position);
  const to = close >= 0 && close < lineEnd ? close : lineEnd;
  const value = text.slice(open + 1, to);
  if (/^\s|[\[\]]|https?:|:\/\//i.test(value)) return null;
  if (/^[xX]?$/.test(value) && /^\s*(?:[-+*]|\d+[.)])\s+$/.test(text.slice(lineStart, open))) return null;
  if (protectedRanges(text).some(range => open >= range.from && open < range.to)) return null;
  return { from: open + 1, to, query: text.slice(open + 1, position), closed: to === close };
}

export function matchingTags(tags: readonly string[], query: string): string[] {
  const fold = (value: string) => value.normalize('NFC').toLocaleLowerCase();
  const needle = fold(query.trim());
  if (!needle) return [];
  const counts = new Map<string, number>();
  for (const tag of tags) if (tag && !/[\[\]\n]/.test(tag)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.keys()].filter(tag => fold(tag).includes(needle)).sort((a, b) =>
    Number(fold(b).startsWith(needle)) - Number(fold(a).startsWith(needle)) || counts.get(b)! - counts.get(a)! || a.localeCompare(b, 'ja'),
  ).slice(0, 30);
}

export function tagCompletion(tags: () => readonly string[]): CompletionSource {
  return context => {
    if (!context.state.selection.main.empty) return null;
    const bracket = tagContext(context.state.doc.toString(), context.pos);
    if (!bracket || !bracket.query.trim()) return null;
    return {
      from: bracket.from, to: bracket.to, filter: false,
      options: matchingTags(tags(), bracket.query).map(label => ({
        label,
        apply(view, _completion, from, to) {
          const closed = view.state.doc.sliceString(to, to + 1) === ']';
          view.dispatch({ changes: { from, to, insert: label + (closed ? '' : ']') }, selection: { anchor: from + label.length + 1 }, userEvent: 'input.complete' });
        },
      })),
    };
  };
}
