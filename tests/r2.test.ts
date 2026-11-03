import { beforeEach, describe, expect, it, vi } from 'vitest';
import { R2Backend, SyncConflict, validateR2, type Settings } from '../src/lib/storage';

const { transport } = vi.hoisted(() => ({ transport: vi.fn() }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: transport }));
const settings: Settings = {
  folder: '', endpoint: 'https://test-account.r2.cloudflarestorage.com', bucket: 'pure-notes',
  accessKeyId: 'test-access-id', secretAccessKey: 'test-secret-key', syncEnabled: true, lastFile: '',
};
beforeEach(() => transport.mockReset());

describe('R2 の署名とネイティブ HTTP', () => {
  it('日本語のキーをエンコードし、SigV4 で署名する', async () => {
    transport.mockResolvedValue(new Response('hello', { headers: { etag: '"v1"' } }));
    const object = await new R2Backend(settings).get('日記.md');
    const [url, options] = transport.mock.calls[0];
    expect(url).toBe('https://test-account.r2.cloudflarestorage.com/pure-notes/%E6%97%A5%E8%A8%98.md');
    expect(options.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=test-access-id\/\d{8}\/auto\/s3\/aws4_request/);
    expect(options.headers.get('x-amz-date')).toMatch(/^\d{8}T\d{6}Z$/);
    expect(object?.etag).toBe('"v1"');
  });
  it('条件付き PUT のヘッダーも署名し、競合を呼び出し元に伝える', async () => {
    transport.mockResolvedValue(new Response(null, { status: 412 }));
    await expect(new R2Backend(settings).put('_sync.json', new Uint8Array([1]), '"v1"')).rejects.toBeInstanceOf(SyncConflict);
    const options = transport.mock.calls[0][1];
    expect(options.headers.get('if-match')).toBe('"v1"');
    expect(options.headers.get('authorization')).toContain('host;if-match;');
  });
  it('初回作成は If-None-Match を使い、404 だけを未作成として扱う', async () => {
    transport.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const backend = new R2Backend(settings);
    await backend.put('note.md', new Uint8Array([1]), null);
    expect(transport.mock.calls[0][1].headers.get('if-none-match')).toBe('*');
    transport.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await backend.get('missing.md')).toBeNull();
    transport.mockResolvedValueOnce(new Response('denied', { status: 403 }));
    await expect(backend.get('note.md')).rejects.toThrow('403');
  });
  it('資格情報を任意のホストへ送信しない', () => {
    expect(() => validateR2({ ...settings, endpoint: 'https://example.com' })).toThrow();
    expect(() => validateR2({ ...settings, endpoint: 'http://test.r2.cloudflarestorage.com' })).toThrow();
    expect(() => validateR2({ ...settings, endpoint: 'https://test.r2.cloudflarestorage.com.evil.test' })).toThrow();
  });
});
