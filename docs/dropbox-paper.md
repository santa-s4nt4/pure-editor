# Dropbox Paper を pure で編集する

この機能は、Dropbox 上の `.paper` を Markdown として読み込み、編集後の本文を **同じ Paper 文書**へ書き戻します。元のファイル名を維持し、pure の Markdown 用の自動命名は適用しません。選択したローカル `.paper` の参照ファイルも、内容を変えずに保存します。

Dropbox の実アカウントでの接続・書き戻しは未確認です。企業アカウントの許可と、最初のテスト文書での確認が必要です。

## 企業アカウントの確認

企業アカウントでも API を利用できる場合があります。自作アプリの接続を管理者が制限している場合は、許可が必要です。Paper の閲覧権限だけでなく、対象文書の編集権限も必要です。

管理者への確認例：

> 自作の Markdown エディター pure から、Dropbox ユーザー API を使って、自分が編集権限を持つ Paper 文書を読み書きしたいです。独自アプリの接続を許可できますか？ 必要なスコープは account_info.read、files.metadata.read、files.content.read、files.content.write です。チーム管理 API の権限は使いません。

管理者は **管理コンソール → 設定 → 連携** で外部アプリの接続を確認できます。App Center にない独自アプリは App key または App ID を指定して例外を追加できます。[Dropbox の公式管理手順](https://help.dropbox.com/integrations/app-integrations)

許可されない場合、pure から元の Paper への書き戻しは使えません。許可された範囲での Markdown エクスポートとコピーの編集が代替になります。

## Dropbox アプリの準備

1. [Dropbox App Console](https://www.dropbox.com/developers/apps) で Scoped access のアプリを作成します。会社側で作成できない場合は管理者に依頼してください。
2. アクセス対象は **Full Dropbox** にします。Paper の更新 API は **App folder** のアプリには対応していません。
3. Permissions で以下を有効にし、Submit します。
   - `account_info.read`：企業のチームスペースのルートを取得するため。
   - `files.metadata.read`：渡されたファイルと同じ名前の Paper を検索するため。
   - `files.content.read`：Paper の本文を取得するため。
   - `files.content.write`：同じ Paper に本文を反映するため。
4. Settings で公開クライアントの PKCE を許可し、**App key** を控えます。App secret は pure に入力しません。
5. pure の **⌘ , → Dropbox Paper** に App key を入力し、「Dropbox に接続」を押します。
6. Dropbox のブラウザ画面で権限を確認して承認し、表示された認証コードを pure に貼り付け、「接続を完了」を押します。

自動リダイレクトを使わず、認証コードを手動で戻す PKCE フローです。認証情報と更新トークンは端末のキーチェーンに保持します。App secret、Dropbox のパスワード、API トークンをチャットやリポジトリに渡す必要はありません。各端末で接続してください。[Dropbox の OAuth 仕様](https://docs.dropboxapi.com/riviera/docs/get-started/authorization)

## Paper を開く

- **⌘ O**、または **⌘ L → Paper ファイルを開く** から `.paper` ファイルを選択します。トップ画面へのドラッグ＆ドロップにも対応します。
- 同じ名前の文書が複数あれば Dropbox 内のパスを表示するので、対象を選びます。
- ファイル名を変更してコピーしている場合や、自動で見つからない場合は、**⌘ L** に `/部署/会議.paper` のような Dropbox 内のフルパスを入力して、Paper を開く項目を選択します。
- iPhone は **⋯ → Paper ファイルを開く** から選択できます。

いったん開いた Paper はトップ画面に通常の記事と一緒に表示します。ファイル名は記事タイトルを編集しても維持します。Dropbox 上の既存文書を固定 ID で更新し、別名の文書を勝手に作成しません。

## 保存と競合

本文は最初にローカルへ保存し、接続中は Dropbox に反映します。反映状態は設定の Dropbox Paper 欄に表示します。通信できない間の変更も保持し、起動時・前面復帰・保存後・定期再試行で反映します。

他の人が先に Paper を更新していた場合は、取得時の `paper_revision` が一致しないため更新を止めます。**⌘ L → Paper を読み直す** を選ぶと、ローカル版を `.paper/backups/` に残してから、Dropbox の本文を読み直せます。Paper 文書自体の削除は Dropbox 側で行います。[Paper 更新 API の公式仕様](https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/files/paper-update)

## 表現できる範囲

見出し、本文、箇条書き、チェックリスト、リンクなどを Markdown 経由で編集します。Paper 固有のコメント、メンション、複雑な表、タイムライン、添付やレイアウトを完全には再現できません。最初はテスト文書で往復を確認してください。Paper への新しい画像の追加は Dropbox Paper 側で行います。既存の外部画像は Markdown の URL として保持します。

これは Paper の画面をそのまま再現する編集機能ではありません。Dropbox が提供するエクスポート／更新 API による Markdown の読み書きです。[公式のエクスポート説明](https://learn.dropbox.com/self-guided-learning/dropbox-fundamentals-course/fundamentals-how-do-i-use-paper)

## ローカルの保存先

Markdown 保存先の `.paper/documents.json` に、文書 ID、取得時の更新番号、本文、未反映の編集を保存します。手動で読み直す前の本文は `.paper/backups/` に残します。渡された `.paper` 参照ファイルは `Paper/<文書のIDから生成したフォルダ>/<元のファイル名>.paper` にそのまま保持します。

これらの Paper 用データは通常の Markdown／画像の R2 同期には含めません。競合時のローカルバックアップもこの同期対象には含めません。
