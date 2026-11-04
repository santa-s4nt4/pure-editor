import { parser } from '@lezer/markdown';

export interface TextRange { from: number; to: number }
export interface Reference extends TextRange { kind: 'page' | 'url' | 'tag'; value: string; label?: string; contentFrom?: number; contentTo?: number }

const literalNodes = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'HTMLTag', 'CommentBlock', 'ProcessingInstruction']);

/** Markdown パーサーを共用し、変換・装飾・タグ索引でコードの扱いを揃える。 */
export function protectedRanges(text: string, includeLinks = true): TextRange[] {
  const ranges: TextRange[] = [];
  const tree = parser.parse(text);
  const definitions = new Set<string>();
  tree.iterate({ enter(node) {
    if (node.name === 'LinkReference') {
      const match = /^\[([^\]\n]+)\]:/.exec(text.slice(node.from, node.to));
      if (match) definitions.add(match[1].trim().replace(/\s+/g, ' ').toLocaleLowerCase());
    }
  } });
  tree.iterate({ enter(node) {
    const source = text.slice(node.from, node.to);
    const actualLink = node.name === 'Link' && (/\]\s*[([]/.test(source) || definitions.has(source.slice(1, -1).trim().replace(/\s+/g, ' ').toLocaleLowerCase()));
    if (literalNodes.has(node.name) || node.name === 'Image' || node.name === 'LinkReference' || (includeLinks && actualLink)) {
      ranges.push({ from: node.from, to: node.to });
      return false;
    }
  } });
  return ranges;
}

function escaped(text: string, at: number): boolean {
  let count = 0;
  while (at > 0 && text[--at] === '\\') count++;
  return count % 2 === 1;
}

export function isExternalUrl(value: string): boolean {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !/\s/.test(value); }
  catch { return false; }
}

export function pagePath(name: string): string {
  const path = name.trim().normalize('NFC').replace(/\.md$/i, '');
  if (!path || /[<>:"\\|?*#\u0000-\u001f\u007f]/.test(path) || path.split('/').some(part => !part.trim() || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' '))) {
    throw new Error('ファイル名に使えない文字が含まれています。');
  }
  return `${path}.md`;
}

export function scanReferences(text: string): Reference[] {
  const protectedText = protectedRanges(text);
  const allowed = (from: number, to: number) => !protectedText.some(r => from < r.to && to > r.from);
  const refs: Reference[] = [];
  const brackets = /\[([^\[\]\n]+)\]/g;
  for (const match of text.matchAll(brackets)) {
    const from = match.index;
    const to = from + match[0].length;
    if (!allowed(from, to) || escaped(text, from) || text[from - 1] === '!' || /[([\]:]/.test(text[to] || '\0')) continue;
    const value = match[1].trim();
    if (!value) continue;
    const before = text.slice(text.lastIndexOf('\n', from - 1) + 1, from);
    if (/^[ xX]$/.test(value) && /^\s*(?:[-+*]|\d+[.)])\s+$/.test(before)) continue;
    const valueFrom = from + 1 + match[1].indexOf(value);
    const labeled = /^(https?:\/\/\S+)[ \t]+(.+)$/i.exec(value);
    const trailingUrl = /^(.+?)[ \t]+(https?:\/\/\S+)$/i.exec(value);
    if (labeled && isExternalUrl(labeled[1])) {
      const contentFrom = valueFrom + value.length - labeled[2].length;
      refs.push({ kind: 'url', value: labeled[1], label: labeled[2], contentFrom, contentTo: contentFrom + labeled[2].length, from, to });
    } else if (trailingUrl && isExternalUrl(trailingUrl[2])) {
      refs.push({ kind: 'url', value: trailingUrl[2], label: trailingUrl[1], contentFrom: valueFrom, contentTo: valueFrom + trailingUrl[1].length, from, to });
    } else if (isExternalUrl(value)) refs.push({ kind: 'url', value, contentFrom: valueFrom, contentTo: valueFrom + value.length, from, to });
    else refs.push({ kind: 'tag', value, contentFrom: from + 1, contentTo: to - 1, from, to });
  }
  return refs.sort((a, b) => a.from - b.from);
}

function replaceRanges(text: string, edits: (TextRange & { text: string })[]): string {
  for (const edit of edits.sort((a, b) => b.from - a.from)) text = text.slice(0, edit.from) + edit.text + text.slice(edit.to);
  return text;
}

const encodePathSegment = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
const urlDestination = (value: string) => value.replace(/[()]/g, character => character === '(' ? '%28' : '%29');

export function toMarkdown(text: string, _resolvePath: (name: string) => string = pagePath): string {
  return replaceRanges(text, scanReferences(text).filter(ref => ref.kind === 'url').map(ref => ({
    ...ref,
    text: `[${ref.label ?? ref.value}](${urlDestination(ref.value)})`,
  })));
}

export function fromMarkdown(text: string, resolveInternal?: (label: string, target: string) => boolean): string {
  const edits: (TextRange & { text: string })[] = [];
  const blocked = protectedRanges(text, false);
  parser.parse(text).iterate({ enter(node) {
    if (node.name !== 'Link' || blocked.some(r => node.from >= r.from && node.from < r.to)) return;
    // タイトル付き・別名付き・参照形式のリンクは意味を失わないよう保持する。
    const match = /^\[([^\[\]\n]+)\]\(([^\s]+)\)$/.exec(text.slice(node.from, node.to));
    if (!match) return;
    const [, label, target] = match;
    let internal = false;
    try { const path = decodeURIComponent(target.replace(/^\.\//, '')); internal = path === pagePath(label) || !!resolveInternal?.(label, path); } catch { /* 外部リンク等。 */ }
    if (internal) edits.push({ from: node.from, to: node.to, text: `[${label}]` });
    else if (isExternalUrl(target)) {
      const url = target.replace(/%28/gi, '(').replace(/%29/gi, ')');
      edits.push({ from: node.from, to: node.to, text: label === target || label === url ? `[${label}]` : `[${url} ${label}]` });
    }
    return false;
  } });
  return replaceRanges(text, edits);
}

export function extractTags(text: string): string[] {
  return [...new Set(scanReferences(text).filter(r => r.kind === 'tag').map(r => r.value))];
}

/** 最初の H1 を記事タイトルにする。コード内の # は対象にしない。 */
export function noteTitle(text: string, fallback = '無題'): string {
  const blocked = protectedRanges(text, false);
  for (const match of text.matchAll(/^ {0,3}#[ \t]+([^\n]*)$/gm)) {
    if (!blocked.some(range => match.index >= range.from && match.index < range.to)) return match[1].replace(/[ \t]+#+[ \t]*$/, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').trim() || fallback;
  }
  return fallback;
}

/** 保存先に応じて画像の URL だけを書き換える。コードは変更しない。 */
export function mapImagePaths(text: string, map: (path: string) => string): string {
  const edits: (TextRange & { text: string })[] = [];
  const tree = parser.parse(text);
  tree.iterate({ enter(node) {
    if (literalNodes.has(node.name)) return false;
    if (node.name === 'Image') {
      const source = text.slice(node.from, node.to);
      const match = /^(.*\]\()(<[^>]+>|[^\s]+)(\))$/.exec(source);
      if (match) {
        const path = match[2].replace(/^<|>$/g, '');
        const next = map(path);
        if (next !== path) edits.push({ from: node.from, to: node.to, text: `${match[1]}${next}${match[3]}` });
      }
      return false;
    }
  } });
  return replaceRanges(text, edits);
}

export function videoEmbed(value: string): { src: string; title: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'youtu.be' || host === 'youtube.com' || host === 'm.youtube.com') {
      const id = host === 'youtu.be' ? url.pathname.slice(1) : url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|embed)\/([^/]+)$/.exec(url.pathname)?.[1];
      if (id && /^[\w-]{11}$/.test(id)) return { src: `https://www.youtube-nocookie.com/embed/${id}`, title: 'YouTube 動画' };
    }
    if (host === 'vimeo.com' || host === 'player.vimeo.com') {
      const match = /^\/(?:video\/)?(\d+)(?:\/([a-zA-Z0-9]+))?\/?$/.exec(url.pathname);
      if (match) return { src: `https://player.vimeo.com/video/${match[1]}${match[2] ? `?h=${match[2]}` : ''}`, title: 'Vimeo 動画' };
    }
  } catch { /* URL 以外は通常のテキストとして扱う。 */ }
  return null;
}
