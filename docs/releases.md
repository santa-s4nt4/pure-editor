# 配布ビルドの確認と再実行

配布処理は [release.yaml](../.github/workflows/release.yaml) で実行します。ローカルでアプリをビルドする必要はありません。

## Queued のまま進まないとき

ジョブのステップが空で、runner が未割り当てなら、ビルド開始前の実行環境待ちです。ソースのコンパイルや npm / Cargo のインストールはまだ始まっていません。再実行しても同じ環境に並び直すため、改善するとは限りません。

1. GitHub の Actions → **Build and Release (macOS & iOS)** を開きます。
2. **Run workflow** を選び、ブランチを `main` にします。
3. `runner` で **macos-26** または **macos-15** を選び、実行します。

通常の main への push は `macos-26` を使います。どちらも Apple Silicon の標準ランナーです。別のイメージを選んでも即時に割り当てられる保証はありません。

古い実行の **Re-run jobs** は、その実行時のコミットとワークフローを使います。更新した設定や runner の選択を使う場合は、最新の main を指定して **Run workflow** から新しく実行してください。

## 実行開始後の流れ

1. 実際の CPU・macOS・Xcode のバージョンをログに表示。
2. Node.js / Rust の準備と依存キャッシュの復元。Rust キャッシュは runner イメージごとに分けます。
3. `npm ci`、単体テスト、フロントエンドのビルドを1回実行。
4. 同じフロントエンドを使って macOS と iOS を順にビルド。
5. macOS の ZIP と未署名の iOS IPA を `latest-build` Release へアップロード。

ジョブの上限は実行開始後45分です。**この上限は Queued の待ち時間には効きません。** 初めて使う runner イメージでは依存キャッシュがないため、その回は通常よりビルドに時間がかかることがあります。

main に更新が入ると、同じブランチの古い実行はキャンセルします。さらにアップロード直前に main の SHA を確認し、古いコミットから配布ファイルを上書きしないようにしています。並列制御を追加する前のワークフローで既に待機している実行は、新しい設定の対象外なので、必要に応じて Actions 画面からキャンセルしてください。

アプリの最低対応 OS は `src-tauri/tauri.conf.json` の設定で管理します。runner の OS と、アプリの最低対応 OS は別の設定です。

参照: [GitHub のランナー仕様](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[再実行時のコミット](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)、[並列実行の制御](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)。
