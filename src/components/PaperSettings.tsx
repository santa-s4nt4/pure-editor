import { Show, createSignal } from 'solid-js';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { PaperClient } from '../lib/paper-client';
export default function PaperSettings(props: { client: PaperClient | undefined; connected: boolean; status: string; onConnected(): void }) {
  const [appKey, setAppKey] = createSignal(import.meta.env.VITE_DROPBOX_APP_KEY ?? '');
  const [code, setCode] = createSignal('');
  const [pending, setPending] = createSignal(false);
  const [working, setWorking] = createSignal(false);
  const [error, setError] = createSignal('');
  const execute = async (run: () => Promise<void>) => {
    setWorking(true); setError('');
    try { await run(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setWorking(false); }
  };
  const complete = () => void execute(async () => { await props.client!.complete(code()); setCode(''); setPending(false); props.onConnected(); });
  return <fieldset disabled={!props.client || working()}><legend>Dropbox Paper</legend>
    <p class="setting-description">会社のアカウントでは管理者の接続許可が必要な場合があります。Paper の本文を Markdown として読み書きします。コメントや特殊なレイアウトを完全には再現できません。</p>
    <Show when={props.connected} fallback={<div class="connection-fields">
      <label>Dropbox App key<input value={appKey()} onInput={event => setAppKey(event.currentTarget.value)} autocomplete="off" autocapitalize="off" spellcheck={false} /></label>
      <button class="text-button" type="button" onClick={() => void execute(async () => { const url = await props.client!.begin(appKey()); await openUrl(url); setPending(true); })}>Dropbox に接続</button>
      <Show when={pending()}><label>Dropbox に表示された認証コード<input value={code()} onInput={event => setCode(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); complete(); } }} autocomplete="off" autocapitalize="off" spellcheck={false} /></label><button class="text-button" type="button" onClick={complete}>接続を完了</button></Show>
    </div>}>
      <p class="setting-description">{props.status || '接続済み'}。認証情報はキーチェーンに保存しています。</p>
      <button class="text-button" type="button" onClick={() => void execute(async () => { await props.client!.disconnect(); props.onConnected(); })}>Dropbox の接続を解除</button>
    </Show>
    <p class="setting-description">接続後は ⌘ O で .paper を選択、または ⌘ L に Dropbox 内のフルパス（/部署/会議.paper）を入力して開けます。</p>
    <p class="settings-error" role="alert">{error()}</p>
  </fieldset>;
}
