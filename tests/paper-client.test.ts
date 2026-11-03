import { expect, it } from 'vitest';
import { PaperClient, PaperConflict, type PaperFetch, type PaperVault } from '../src/lib/paper-client';
const credentials = (expiresAt = Date.now() + 3_600_000) => JSON.stringify({ appKey: 'test_app_key', accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt, namespace: 'team-root' });
const exported = () => new Response('# 会議\n\n本文', { headers: { 'Dropbox-API-Result': JSON.stringify({ export_metadata: { paper_revision: 7 }, file_metadata: { id: 'id:doc', name: 'meeting.paper' } }) } });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function vault(initial = '') { let value = initial; return { read: async () => value, write: async (next: string) => { value = next; } } satisfies PaperVault; }

it('企業のルート名前空間とASCIIのヘッダーを使ってMarkdownを取得する', async () => {
  let headers = new Headers();
  const fetcher: PaperFetch = async (url, init) => { expect(url).toBe('https://content.dropboxapi.com/2/files/export'); headers = new Headers(init.headers); return exported(); };
  const client = new PaperClient(fetcher, vault(credentials())); await client.initialize();
  expect(await client.export('/部署/会議.paper')).toMatchObject({ revision: 7, markdown: '# 会議\n\n本文' });
  expect(headers.get('Dropbox-API-Arg')).toContain('\\u4f1a');
  expect(JSON.parse(headers.get('Dropbox-API-Arg')!)).toEqual({ path: '/部署/会議.paper', export_format: 'markdown' });
  expect(JSON.parse(headers.get('Dropbox-API-Path-Root')!)).toEqual({ '.tag': 'root', root: 'team-root' });
});
it('固定IDと更新番号で書き戻し、無条件上書きやファイル名変更はしない', async () => {
  const calls: string[] = [];
  const client = new PaperClient(async (url, init) => {
    calls.push(url);
    expect(JSON.parse(new Headers(init.headers).get('Dropbox-API-Arg')!)).toEqual({ path: 'id:doc', import_format: 'markdown', doc_update_policy: 'update', paper_revision: 7 });
    expect(init.body).toBe('# 変更後\n本文'); return json({ paper_revision: 8 });
  }, vault(credentials())); await client.initialize();
  expect(await client.update('id:doc', '# 変更後\n本文', 7)).toBe(8);
  expect(calls).toEqual(['https://api.dropboxapi.com/2/files/paper/update']);
});
it('更新番号の競合と会社による禁止を区別し、エラー本文の機密情報を表示しない', async () => {
  const conflict = new PaperClient(async () => json({ error: { '.tag': 'revision_mismatch' } }, 409), vault(credentials())); await conflict.initialize();
  await expect(conflict.update('id:doc', 'draft', 7)).rejects.toBeInstanceOf(PaperConflict);
  const denied = new PaperClient(async () => new Response('private diagnostic', { status: 403 }), vault(credentials())); await denied.initialize();
  await expect(denied.export('/会議.paper')).rejects.toThrow('403');
  await expect(denied.export('/会議.paper')).rejects.not.toThrow('private diagnostic');
});
it('PKCEで接続し、更新トークンを保管して期限切れ時に再認証する', async () => {
  const store = vault(); let verifier = ''; let refreshes = 0;
  const client = new PaperClient(async (url, init) => {
    if (url.endsWith('/oauth2/token')) {
      const body = new URLSearchParams(String(init.body));
      if (body.get('grant_type') === 'authorization_code') { verifier = body.get('code_verifier')!; expect(body.has('client_secret')).toBe(false); }
      else { refreshes++; expect(body.get('refresh_token')).toBe('refresh'); }
      return json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
    }
    if (url.endsWith('users/get_current_account')) return json({ root_info: { root_namespace_id: 'company-root' } });
    return exported();
  }, store);
  const url = new URL(await client.begin('test_app_key'));
  expect(url.searchParams.get('token_access_type')).toBe('offline');
  expect(url.searchParams.has('code_verifier')).toBe(false);
  await client.complete('one-time-code');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  expect(url.searchParams.get('code_challenge')).toBe(Buffer.from(digest).toString('base64url'));
  const stored = JSON.parse(await store.read()); expect(stored.namespace).toBe('company-root');
  stored.expiresAt = 1; await store.write(JSON.stringify(stored));
  await client.initialize(); await Promise.all([client.export('id:doc'), client.export('id:doc')]);
  expect(refreshes).toBe(1);
  await client.disconnect(); expect(await store.read()).toBe(''); expect(client.connected).toBe(false);
});
it('同名のPaperをページ送りして探し、異なる文書を勝手に選ばない', async () => {
  let count = 0;
  const client = new PaperClient(async () => ++count === 1 ? json({ matches: [{ metadata: { '.tag': 'metadata', metadata: { '.tag': 'file', id: 'id:a', name: 'meeting.paper' } } }], cursor: 'next', has_more: true }) : json({ matches: [{ metadata: { '.tag': 'metadata', metadata: { '.tag': 'file', id: 'id:b', name: 'meeting.paper' } } }, { metadata: { '.tag': 'metadata', metadata: { '.tag': 'file', name: 'other.paper' } } }], has_more: false }), vault(credentials()));
  await client.initialize(); expect((await client.findByName('meeting.paper')).map(file => file.id)).toEqual(['id:a', 'id:b']);
});
