import { mapImagePaths } from './transformer';

function normalized(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) { if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part); }
  return `/${parts.join('/')}`;
}
function relative(from: string, to: string): string {
  const left = normalized(from).split('/').filter(Boolean);
  const right = normalized(to).split('/').filter(Boolean);
  while (left.length && right.length && left[0] === right[0]) { left.shift(); right.shift(); }
  return [...left.map(() => '..'), ...right].join('/');
}
const encoded = (path: string) => path.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

/** 同期では assets/ を共通キーに使い、実ファイルでは正しい相対 URL にする。 */
export function diskImagePaths(text: string, notePath: string, notesFolder: string, imagesFolder: string, toDisk: boolean): string {
  const directory = normalized(`${notesFolder}/${notePath.split('/').slice(0, -1).join('/')}`);
  const images = normalized(imagesFolder);
  return mapImagePaths(text, source => {
    let path: string;
    try { path = decodeURIComponent(source); } catch { return source; }
    if (toDisk) {
      if (!/^assets\/[^/]+\.webp$/i.test(path)) return source;
      return encoded(relative(directory, `${images}/${path.slice(7)}`));
    }
    if (/^[a-z]+:/i.test(path)) return source;
    const absolute = normalized(path.startsWith('/') ? path : `${directory}/${path}`);
    if (!absolute.startsWith(`${images}/`) || absolute.slice(images.length + 1).includes('/')) return source;
    return `assets/${absolute.slice(images.length + 1)}`;
  });
}
