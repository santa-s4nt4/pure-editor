/** data URL は fetch せず復号する。ネイティブ版の CSP にも依存しない。 */
export function dataImageBlob(source: string): Blob {
  const match = /^data:(image\/[^;,]+)(;base64)?,([\s\S]*)$/.exec(source);
  if (!match) throw new Error('画像データを読み込めませんでした。');
  const data = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
  const bytes = match[2] ? Uint8Array.from(data, character => character.charCodeAt(0)) : new TextEncoder().encode(data);
  return new Blob([bytes], { type: match[1] });
}
