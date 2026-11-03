import { parser } from '@lezer/markdown';

const suffix = /--([a-f0-9]{32})\.md$/;
export const noteId = (path: string) => suffix.exec(path)?.[1];
export function namedNotePath(title: string, id: string, previous = '') {
  // Stay comfortably below the filesystem's UTF-8 byte limit, including the ID.
  let stem = title.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[. ]+|[. ]+$/g, '') || '無題';
  while (new TextEncoder().encode(stem).length > 150) stem = Array.from(stem).slice(0, -1).join('');
  const folder = previous.slice(0, previous.lastIndexOf('/') + 1);
  return `${folder}${stem}--${id}.md`;
}
export function filenameTitle(path: string) {
  return path.split('/').pop()!.replace(suffix, '').replace(/\.(?:md|paper)$/i, '') || '無題';
}

/** Rewrite local Markdown destinations, preserving code, labels and URL fragments. */
export function renameNoteLinks(text: string, sourcePath: string, moves: ReadonlyMap<string, string>) {
  const edits: { from: number; to: number; text: string }[] = [];
  parser.parse(text).iterate({ enter(node) {
    if (node.name !== 'URL') return;
    const original = text.slice(node.from, node.to);
    const angled = original.startsWith('<') && original.endsWith('>');
    const target = angled ? original.slice(1, -1) : original;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(target)) return;
    const split = target.search(/[?#]/);
    const file = split < 0 ? target : target.slice(0, split);
    const fragment = split < 0 ? '' : target.slice(split);
    let path: string;
    try {
      path = decodeURIComponent(new URL(file, `https://pure.invalid/${sourcePath.split('/').map(encodeURIComponent).join('/')}`).pathname.slice(1));
    } catch { return; }
    const renamed = moves.get(path);
    if (!renamed) return;
    const base = sourcePath.split('/').slice(0, -1);
    const parts = renamed.split('/');
    while (base.length && parts.length && base[0] === parts[0]) { base.shift(); parts.shift(); }
    const next = [...base.map(() => '..'), ...parts].map(part => encodeURIComponent(part).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/') + fragment;
    edits.push({ from: node.from, to: node.to, text: angled ? `<${next}>` : next });
  } });
  for (const edit of edits.sort((a, b) => b.from - a.from)) text = text.slice(0, edit.from) + edit.text + text.slice(edit.to);
  return text;
}
