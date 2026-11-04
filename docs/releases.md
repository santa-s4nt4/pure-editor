# 配布ビルドの確認と再実行

配布処理は [release.yaml](../.github/workflows/release.yaml) で実行します。ネイティブビルドは [native-build.yaml](../.github/workflows/native-build.yaml) を呼び出します。ローカルでアプリをビルドする必要はありません。

## 構成と成果物

1. **Verify and build frontend (Linux)**：ワークフローの構文、単体テスト、配布前の整合性チェックを実行し、フロントエンドを1回ビルドします。`frontend` Artifact に保存します。
2. **macOS / iOS**：それぞれ別の Mac ジョブで、同じコミットのフロントエンドを使ってアプリを生成します。成功したものから `native-macos` / `native-ios` Artifact に保存します。一方の失敗では他方をキャンセルしません。
3. **Summarize and publish verified pair (Linux)**：各段階の結果を Summary に表示します。両アプリが成功し、コミット・対象プラットフォーム・ファイルの SHA-256 が一致する場合だけ `latest-build` Release にアップロードします。`build-info.json` にコミットと各ファイルのハッシュも配布します。

Artifacts は各実行の画面から7日間取得できます。片方だけ成功した場合も、そのパッケージをダウンロードできます。この場合、Release は直前の配布のままです。Artifacts の取得には GitHub へのログインが必要です。`native-ios` を展開した中の `pure-ios-unsigned.ipa` を Sideloadly で使用します。

Linux で検証が成功しても、Mac のジョブが始まることを保証するものではありません。iOS のネイティブビルドには macOS / Xcode が必要です。Mac ランナーの未割り当てと、アプリのコンパイルエラーは別々に確認してください。

## Queued のまま進まないとき

ジョブのステップが空で、runner が未割り当てなら、ビルド開始前の実行環境待ちです。ソースのコンパイルや npm / Cargo のインストールはまだ始まっていません。再実行しても同じ環境に並び直すため、改善するとは限りません。

1. GitHub の Actions → **Build and Release (macOS & iOS)** を開きます。
2. **Run workflow** を選び、ブランチを `main` にします。
3. `runner` で **macos-15-intel**、**macos-26-intel**、**macos-26**、**macos-15** のいずれかを選びます。
4. 通常の配布は `platform` を **both** にします。**macos** / **ios** は片方の検証用で、Artifact を保存しますが Release は更新しません。

通常の main への push は `macos-15-intel` を使います。Intel ホストでも Apple Silicon 用の macOS アプリと iPhone 用 IPA を生成します。macOS の出力ターゲットは `aarch64-apple-darwin` に固定し、パッケージ前に `lipo` で arm64 を確認します。

`macos-26` と `macos-15` は Apple Silicon、`macos-26-intel` と `macos-15-intel` は Intel の標準ランナーです。追加料金のある大型ランナーや外部 CI は設定していません。どのランナーも即時に割り当てられる保証はありません。

2026年11月5日に確認した失敗では、ARM 側だけでなく [Intel 側の実行](https://github.com/santa-s4nt4/pure-editor/actions/runs/41861114730) もステップ0件で終了し、`The job was not acquired by Runner of type hosted even after multiple attempts` と報告されました。この状態はコンパイルエラーではなく、runner ラベルの変更だけで解消したとは判断できません。標準 Mac ランナーの取得失敗が続く場合は、実行 URL と注釈を添えて GitHub Support へ確認してください。外部 Mac CI / self-hosted runner への移行には、別途ホストと接続設定が必要です。

古い実行の **Re-run jobs** は、その実行時のコミットとワークフローを使います。更新した設定や runner の選択を使う場合は、最新の main を指定して **Run workflow** から新しく実行してください。

## 実行開始後の確認

Mac ジョブの最初に、ホスト CPU・macOS・Xcode のバージョンをログに表示します。Rust キャッシュは runner イメージとプラットフォームごとに分けます。初めて使う組合せではキャッシュがないため、その回は通常より時間がかかることがあります。

ビルド後のパッケージ処理で失敗した場合も、依存ライブラリのキャッシュを GitHub 側に保存します。完成したアプリは `lipo <実行ファイル> -verify_arch arm64` で CPU 種別を確認してから署名・圧縮します。

ジョブの上限は Linux の検証15分、各ネイティブビルド45分、配布10分です。**この上限は Queued の待ち時間には効きません。**

main に更新が入ると、同じブランチの古い実行はキャンセルします。さらにアップロード直前に main の SHA を確認し、古いコミットから配布ファイルを上書きしないようにしています。並列制御を追加する前のワークフローで既に待機している実行は、新しい設定の対象外なので、必要に応じて Actions 画面からキャンセルしてください。

フロントエンドやネイティブ成果物に記録したコミットが違う、片方のファイルがない、保存後にファイルが変わった場合は配布前に停止します。この検査は合成データのテストでローカルからも確認できます。アプリのビルドは行いません。

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/ci -v
```

配布ファイルのアップロードは GitHub のファイル単位の操作です。アップロード中に通信エラーが発生した場合は、Release の `build-info.json` にある SHA-256 とダウンロードしたファイルを照合してください。

アプリの最低対応 OS は `src-tauri/tauri.conf.json` の設定で管理します。runner の OS と、アプリの最低対応 OS は別の設定です。

参照: [GitHub のランナー仕様](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[成果物の保存と共有](https://docs.github.com/en/actions/tutorials/store-and-share-data)、[再実行時のコミット](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)、[並列実行の制御](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)、[Tauri の iOS 開発環境](https://v2.tauri.app/start/prerequisites/)。
