# pure で Cloudflare R2 を使う

Mac と iPhone の pure に同じ R2 バケットを設定すると、Markdown と画像を同期できます。記事は各端末にも保存されるので、オフラインでも書けます。設定するのは GitHub の Secrets ではなく、各端末の pure の設定画面です。

## 1. Cloudflare で R2 を有効にする

1. [Cloudflare Dashboard](https://dash.cloudflare.com/) にログインします。
2. **Storage & databases → R2 → Overview** を開きます。
3. 初回は画面の案内に従って R2 の利用を有効にします。R2 の利用にはアカウントへの R2 subscription の追加が必要です。

参考：[Cloudflare R2 の利用開始](https://developers.cloudflare.com/r2/get-started/)

## 2. pure 専用バケットを作る

R2 の **Create bucket** から、たとえば `pure-notes` というバケットを作ります。保存クラスは **Standard**、場所は通常の自動選択で始められます。

pure は認証付きの S3 API でアクセスします。バケットの公開、`r2.dev` の有効化、独自ドメイン、Workers の作成は必要ありません。Mac・iPhone アプリはネイティブ HTTP を使うため、pure のための CORS 設定も不要です。

参考：[バケット作成と S3 API](https://developers.cloudflare.com/r2/get-started/s3/)

## 3. Access Key ID と Secret Access Key を発行する

R2 の Overview にある **API Tokens → Manage** を開きます。個人利用では **Create User API token** を選べます。

トークン名を `pure-devices` などにして、次の内容を指定します。

| 項目 | 設定 |
| --- | --- |
| Permissions | **Object Read & Write** |
| 対象バケット | **Apply to specific buckets only** |
| バケット | 作成した `pure-notes` |

作成後に表示される **Access Key ID** と **Secret Access Key** を控えます。Secret Access Key は後から再表示できないため、パスワードマネージャーなどに保存してください。pure に入力するのはこの2つで、Cloudflare の管理 API 用トークン文字列ではありません。

同じキーを Mac と iPhone に設定できます。端末別にキーを発行する場合も、同じバケットへの Object Read & Write 権限を付けます。

参考：[R2 の認証情報の作成](https://developers.cloudflare.com/r2/api/tokens/)

## 4. Mac の pure に設定する

Mac の pure で **⌘ ,** を押して設定を開き、**Cloudflare R2 を使う** をオンにします。

| pure の欄 | 入力する値 |
| --- | --- |
| Endpoint URL | Cloudflare が表示する **S3 API endpoint**。通常は `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| Bucket Name | `pure-notes` |
| Access Key ID | 手順3で発行した Access Key ID |
| Secret Access Key | 手順3で発行した Secret Access Key |

Endpoint URL の末尾にバケット名を付けないでください。`r2.dev` の URL や Cloudflare の管理画面の URL も使いません。特定の jurisdiction を指定したバケットでは、そのバケット用に表示された S3 endpoint をコピーします。

**設定を保存** を押すと同期が始まります。設定を再度開くと、同期状態を確認できます。設定を変更したときは、先に保存してから **今すぐ同期** を使ってください。このボタンは保存済みの接続先を使います。

pure は Secret Access Key を端末のキーチェーンに保存します。Markdown と画像のローカル保存先は、R2 のバケットとは別の設定です。

参考：[S3 API のエンドポイント](https://developers.cloudflare.com/r2/get-started/s3/)

## 5. iPhone の pure にも設定する

1. iPhone の pure で **⋯ → 設定** を開きます。
2. **Cloudflare R2 を使う** をオンにします。
3. Mac と同じ endpoint、bucket と、そのバケットにアクセスできるキーを入力します。
4. **設定を保存** を押します。

最初に Mac 側で同期を済ませ、その後 iPhone を設定すると確認しやすくなります。ローカル保存先は Mac と iPhone で同じパスにする必要はありません。iPhone はアプリ内の領域に保存し、画像のパスは同期時に共通形式へ変換します。

## 6. 初回の動作確認

1. Mac で「同期確認」という記事を作り、本文を書きます。
2. 入力を止めてローカル保存を待ち、設定で「同期済み」を確認します。
3. iPhone で pure を開き、同じ記事が一覧に現れることを確認します。必要なら設定の **今すぐ同期** を押します。
4. iPhone で追記し、Mac の pure を前面に戻して追記が届くか確認します。
5. 最後に画像でも同じ確認をします。

同期は起動時、アプリを前面に戻したとき、ローカル保存後などに実行します。オンラインで前面にある間は1分ごとにも再試行します。オフライン中の編集はローカルに残り、接続が戻ると再同期します。

## R2 の中に保存されるもの

| ファイル・フォルダ | 用途 |
| --- | --- |
| `*.md` | 記事 |
| `assets/*.webp` | 画像 |
| `_sync.json` | 各ファイルの更新情報・削除情報 |
| `_pure/objects/` | 同期の整合性と競合時の復元に使う内容のコピー |

`_sync.json` と `_pure/objects/` は pure が管理します。これらを手動や期限付きライフサイクルで削除しないでください。Cloudflare 管理画面に `.md` を置くだけでは、pure の同期インデックスが更新されません。通常の追加・編集・削除は pure から行います。

記事の削除も他の端末に同期します。同じ記事を両端末で別々に変更した場合は、片方の内容を `conflict` を含む名前の記事として残します。復元用の内容も保存するため、R2 の使用量は現在表示されている記事・画像の合計より増えることがあります。

削除と別端末の編集が重なった場合は削除を維持し、編集内容を非公開の競合コピーに残します。Finder などで外から削除したファイルにも、次の再読み込み時に削除履歴を残します。削除済みのファイルが端末内に残っていた場合は `.trash/` に退避し、自動では復活させません。

一覧や検索の読み込み時には、キャッシュ済みの記事も実ファイルを確認します。ファイルが消失・変更していた場合は同期情報を修復し、存在しない記事を一覧に残しません。別端末で改名された記事は記事 ID から現在のパスを探すため、古いリンクや履歴からも開けます。前面での定期同期時にも実ファイルを再確認します。

## 同期できないとき

| 症状 | 確認するところ |
| --- | --- |
| 403 が出る | ID と Secret の組み合わせ、キーの期限・失効、Object Read & Write 権限、対象バケット |
| 404 が出る | バケット名、Cloudflare アカウント、選択した jurisdiction の endpoint |
| endpoint を受け付けない | HTTPS の S3 API endpoint か。末尾にバケット名やパスを足していないか |
| 片方の端末だけ記事が出ない | 両端末で保存済みの endpoint と bucket が一致しているか。各端末の同期状態も確認 |
| 設定を変えて「今すぐ同期」を押しても変わらない | まず「設定を保存」。未保存の入力内容では接続しません |

## 料金

2026年11月3日時点では、Standard storage に月あたり **10 GB-month の保存容量、Class A 100万リクエスト、Class B 1,000万リクエスト** の無料枠があります。無料枠を超えた利用は従量課金です。Infrequent Access はこの無料枠の対象外なので、まず Standard で始めてください。

pure の同期は読み書きリクエストを使います。Cloudflare の使用量画面も確認しながら利用してください。

参考：[Cloudflare R2 の最新料金](https://developers.cloudflare.com/r2/pricing/)
