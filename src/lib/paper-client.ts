export interface PaperFile { id: string; name: string; path_display?: string; server_modified?: string }
export interface PaperExport { file: PaperFile; revision: number; markdown: string }
interface Credentials { appKey: string; accessToken: string; refreshToken: string; expiresAt: number; namespace?: string }
export interface PaperVault { read(): Promise<string>; write(value: string): Promise<void> }
export type PaperFetch = (url: string, init: RequestInit) => Promise<Response>;
const api = 'https://api.dropboxapi.com/2/';
const content = 'https://content.dropboxapi.com/2/';
const scopes = 'account_info.read files.metadata.read files.content.read files.content.write';
const ascii = (value: unknown) => JSON.stringify(value).replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export class PaperConflict extends Error { constructor() { super('Dropbox Paper 側にも変更があります。ローカル版をバックアップしてから、Paper を読み直してください。'); } }
export class PaperClient {
  private credentials: Credentials | null = null;
  private pending: { appKey: string; verifier: string } | null = null;
  private refreshing: Promise<void> | null = null;
  constructor(private fetcher: PaperFetch, private vault: PaperVault) {}
  get connected() { return !!this.credentials; }
  async initialize() {
    const stored = await this.vault.read();
    if (!stored) return;
    const value = JSON.parse(stored) as Credentials;
    if (typeof value.appKey !== 'string' || typeof value.accessToken !== 'string' || typeof value.refreshToken !== 'string' || !Number.isFinite(value.expiresAt)) throw new Error('Dropbox の接続情報を読み直してください。');
    this.credentials = value;
  }
  async begin(appKey: string) {
    appKey = appKey.trim();
    if (!/^[a-zA-Z0-9_-]{5,100}$/.test(appKey)) throw new Error('Dropbox App key を入力してください。');
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    this.pending = { appKey, verifier };
    const params = new URLSearchParams({ client_id: appKey, response_type: 'code', token_access_type: 'offline', code_challenge: challenge, code_challenge_method: 'S256', scope: scopes });
    return `https://www.dropbox.com/oauth2/authorize?${params}`;
  }
  async complete(code: string) {
    if (!this.pending || !code.trim()) throw new Error('接続を開始してから、Dropbox の認証コードを入力してください。');
    const pending = this.pending;
    const token = await this.token(new URLSearchParams({ grant_type: 'authorization_code', client_id: pending.appKey, code_verifier: pending.verifier, code: code.trim() }));
    if (typeof token.refresh_token !== 'string') throw new Error('Dropbox の継続接続が許可されていません。接続をやり直してください。');
    const previous = this.credentials;
    this.credentials = { appKey: pending.appKey, accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000 };
    try {
      const account = await this.rpc('users/get_current_account', null);
      const root = account.root_info?.root_namespace_id;
      if (typeof root === 'string') this.credentials.namespace = root;
      await this.vault.write(JSON.stringify(this.credentials));
      this.pending = null;
    } catch (error) { this.credentials = previous; throw error; }
  }
  async disconnect() { await this.vault.write(''); this.credentials = null; this.pending = null; }
  private async token(body: URLSearchParams): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
    const response = await this.fetcher('https://api.dropboxapi.com/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    if (!response.ok) throw new Error(`Dropbox に接続できません（${response.status}）。会社の接続許可と認証コードを確認してください。`);
    const token = await response.json();
    if (typeof token.access_token !== 'string' || !Number.isFinite(token.expires_in) || token.expires_in <= 0) throw new Error('Dropbox の認証応答が不正です。');
    return token;
  }
  private async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const credentials = this.credentials;
      if (!credentials) throw new Error('設定から Dropbox Paper に接続してください。');
      const token = await this.token(new URLSearchParams({ grant_type: 'refresh_token', client_id: credentials.appKey, refresh_token: credentials.refreshToken }));
      if (this.credentials !== credentials) throw new Error('Dropbox の接続が変更されました。');
      this.credentials = { ...credentials, accessToken: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
      await this.vault.write(JSON.stringify(this.credentials));
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  private async request(route: string, args: unknown, mode: 'rpc' | 'export' | 'update' = 'rpc', body?: string): Promise<Response> {
    if (!this.credentials) throw new Error('設定から Dropbox Paper に接続してください。');
    if (this.credentials.expiresAt <= Date.now() + 30_000) await this.refresh();
    const send = () => {
      const headers = new Headers({ Authorization: `Bearer ${this.credentials!.accessToken}` });
      if (this.credentials!.namespace) headers.set('Dropbox-API-Path-Root', ascii({ '.tag': 'root', root: this.credentials!.namespace }));
      if (mode === 'rpc') headers.set('Content-Type', 'application/json');
      else { headers.set('Dropbox-API-Arg', ascii(args)); if (mode === 'update') headers.set('Content-Type', 'application/octet-stream'); }
      return this.fetcher((mode === 'export' ? content : api) + route, { method: 'POST', headers, body: mode === 'rpc' ? JSON.stringify(args) : body });
    };
    let response = await send();
    if (response.status === 401) { await this.refresh(); response = await send(); }
    if (!response.ok) {
      if (response.status === 409) {
        const result = await response.json().catch(() => ({}));
        if (result.error?.['.tag'] === 'revision_mismatch' || String(result.error_summary ?? '').startsWith('revision_mismatch')) throw new PaperConflict();
      }
      throw new Error(`Dropbox Paper の操作に失敗しました（${response.status}）。接続許可、文書の場所、編集権限を確認してください。`);
    }
    return response;
  }
  private async rpc(route: string, args: unknown): Promise<any> { return (await this.request(route, args)).json(); }
  async findByName(name: string): Promise<PaperFile[]> {
    const found: PaperFile[] = [];
    let result = await this.rpc('files/search_v2', { query: name, options: { filename_only: true, file_extensions: ['paper'], max_results: 100 } });
    for (;;) {
      for (const match of result.matches ?? []) {
        const entry = match.metadata?.metadata;
        if (entry?.['.tag'] === 'file' && typeof entry.name === 'string' && entry.name.normalize('NFC') === name.normalize('NFC') && /\.paper$/i.test(entry.name)) found.push(entry);
      }
      if (!result.has_more) return found;
      result = await this.rpc('files/search/continue_v2', { cursor: result.cursor });
    }
  }
  async export(path: string): Promise<PaperExport> {
    if (!(path.startsWith('id:') || path.startsWith('/') && /\.paper$/i.test(path))) throw new Error('Dropbox 内の .paper のフルパスを入力してください。');
    const response = await this.request('files/export', { path, export_format: 'markdown' }, 'export');
    const metadata = JSON.parse(response.headers.get('Dropbox-API-Result') ?? '{}');
    const revision = metadata.export_metadata?.paper_revision;
    const file = metadata.file_metadata;
    if (!Number.isSafeInteger(revision) || revision < 0 || typeof file?.id !== 'string' || !/\.paper$/i.test(file?.name ?? '')) throw new Error('編集できる Paper 文書の情報を取得できませんでした。');
    return { file, revision, markdown: await response.text() };
  }
  async update(id: string, markdown: string, revision: number): Promise<number> {
    if (!id.startsWith('id:') || !Number.isSafeInteger(revision) || revision < 0) throw new Error('Paper の文書情報が不正です。');
    const response = await this.request('files/paper/update', { path: id, import_format: 'markdown', doc_update_policy: 'update', paper_revision: revision }, 'update', markdown);
    const result = await response.json();
    if (!Number.isSafeInteger(result.paper_revision) || result.paper_revision < 0) throw new Error('Paper の保存結果を確認できませんでした。再読み込みしてください。');
    return result.paper_revision;
  }
}
