/** Publication intent travels with the Markdown through R2, never with credentials. */
export interface Publication {
  repository: string;
  branch: string;
  visibility: 'public' | 'private';
  revision: string;
  parent: string | null;
}
const header = /^<!-- pure:publication (\{[^\n]*\}) -->\r?\n(?:\r?\n)?/;
export const validRevision = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
export function publicationDocument(text: string): { body: string; publication?: Publication } {
  const match = header.exec(text);
  if (!match) return { body: text };
  try {
    const value = JSON.parse(match[1]);
    if (!/^[\w.-]+\/[\w.-]+$/.test(value.repository) || !validRevision(value.revision) || value.parent !== null && !validRevision(value.parent) || !['public', 'private'].includes(value.visibility) || typeof value.branch !== 'string' || !value.branch) throw new Error();
    return { body: text.slice(match[0].length), publication: value };
  } catch { throw new Error('記事の公開設定を読み取れませんでした。ファイル先頭の pure:publication を確認してください。'); }
}
export function withPublication(body: string, publication?: Publication): string {
  return publication ? `<!-- pure:publication ${JSON.stringify(publication)} -->\n\n${body}` : body;
}
