# Project Specification: "Stone-inspired" Minimalist Markdown Editor (macOS & iOS)

あなたは熟練のソフトウェアアーキテクト兼フロントエンド/タイポグラフィエンジニアです。
以下の要件定義と技術仕様に基づき、macOSおよびiOSで動作する超軽量・ソリッドなMarkdownエディタを **Tauri v2 + TypeScript + SolidJS (または Svelte 5) + CodeMirror 6** で設計・実装してください。

---

## 1. コンセプトとUI/UXデザイン（Reference: "stone" by Nippon Design Center）

日本デザインセンターが開発したテキストエディタ「stone (https://stone-type.jp/)」の哲学を踏襲し、「書く気分を高める、極限までノイズを削ぎ落としたソリッドなUI」を実現します。

- **極限のミニマリズム**: ツールバー、ステータスバー、常時表示のサイドバー、境界線（border）、ドロップシャドウを一切排除する。画面には「紙（背景）」と「文字」だけが存在する状態にする。
- **ファイルナビゲーション**: ファイル一覧、新規作成、タグ検索、R2同期設定はすべてショートカットキー（`Cmd+K` / `Cmd+P`、iOSでは画面端からのスワイプまたは控えめなフローティングトリガー）で呼び出すコマンドパレット（モーダル）に集約する。

---

## 2. CSS設計・タイポグラフィ要件（最重要：人間が後から微調整しやすいモダンCSS）

開発者（人間）が後から文字サイズ、行間、字間、余白、色味などを直感的に微調整できるよう、**Tailwind CSSやCSS-in-JSは一切使用せず、バニラなモダンCSS（Native CSS）で美しく構造化**してください。
**CodeMirror 6のスタイルもJS内の `EditorView.theme()` には記述せず、必ず外部CSSファイル（`.cm-editor`, `.cm-content`, `.cm-line` 等）からスタイリングすること。**

### 2.1 ファイル分割とデザイントークン（`src/styles/`）
CSSは以下の3ファイルに明確に役割分担し、人間が `tokens.css` を触るだけで全体のトーン＆マナーを調整できるように日本語コメントを丁寧に残すこと。
1. `src/styles/tokens.css`: フォントサイズ、行間、字間、欧文サイズ補正、余白、カラーパレット、トランジション秒数などの全CSS変数（Custom Properties）を一元管理。
2. `src/styles/typography.css`: `@font-face` による「明朝体混植」定義と、見出し・本文・リンク・タグなどの文字組版ルール。
3. `src/styles/layout.css`: エディタ全体の配置、コマンドパレット、埋め込みWidget（画像・動画）のレイアウト。

### 2.2 モダンCSSコーディング規約（厳守）
以下のモダンCSSのベストプラクティスを全面的に採用して記述すること：
- **単位の使い分け（`px` の原則禁止）**:
  - ベースフォントサイズや大枠の余白には **`rem`** を使用する。
  - 文字サイズに連動させたい要素（段落間の余白、字間 `letter-spacing`、インライン要素のパディング等）には **`em`** を使用する。
  - エディタの1行あたりの最大幅（Measure）には、文字数ベースの単位 **`ch`**（例: `max-inline-size: 42ch` 〜 `48ch`）を使用する。
  - ビューポートの高さには、iOSのソフトキーボードやアドレスバーの伸縮に追従する **`100dvh`** / **`100svh`** を使用する（`100vh` は使用しない）。
- **フルードタイポグラフィと余白（`clamp()`）**:
  - Macの広い画面からiPhoneの狭い画面までメディアクエリなしで美しく伸縮するよう、`font-size: clamp(1rem, 0.94rem + 0.35vw, 1.18rem);` や `padding-inline: clamp(1.5rem, 6vw, 5rem);` のように `clamp()` を積極的に活用する。
- **論理プロパティ（Logical Properties）の徹底**:
  - `margin-left / right` や `padding-top / bottom`、`width / height` ではなく、**`margin-inline`**, **`margin-block`**, **`padding-inline`**, **`padding-block`**, **`inline-size`**, **`block-size`** を使用する（例: 中央寄せは `margin-inline: auto;`）。
- **最新のテキスト折り返し制御（`text-wrap`）**:
  - 見出し（`h1`〜`h3`）やモーダルタイトルには **`text-wrap: balance;`** を適用する。
  - 入力中の本文（`.cm-line` 等）には、タイピング中に前後の行がガタつかないよう **`text-wrap: stable;`**（または `pretty`）を適用する。
- **モダンな色指定とダークモード（`color-scheme` & `light-dark()` / `oklch`）**:
  - `:root { color-scheme: light dark; }` を宣言し、**`light-dark(#F7F6F2, #121212)`** 関数を使ってライト/ダーク両モードのカラー変数を1行でシンプルに定義する。
  - 透過色は古い `rgba()` ではなく **`rgb(0 0 0 / 0.08)`** または **`color-mix(in oklch, var(--text-ink) 12%, transparent)`** の記法を使う。
- **ネイティブCSSネスト & `:has()` / `:is()` / `:where()`**:
  - Sass等のプリプロセッサを使わず、標準のCSS Nestingと `:is()`, `:where()`, `:has()` を用いて可読性の高いセレクタを書く。

### 2.3 「混植（Konshoku）」タイポグラフィの実装（游明朝 × Times New Roman 固定）
グラフィックデザインの「混植（和文と欧文で異なる最適フォントを組み合わせる手法）」を `@font-face` の `unicode-range` と `font-family` フォールバックで厳密に実装する（ゴシック体等は不要、この明朝体混植のみに集中すること）。
- **合成フォントファミリー (`"Konshoku Mincho"`)**:
  - **欧文（ASCII 英数字・基本記号 `U+0000-007F`, `U+00A0-00FF`, `U+2010-2027` 等）**: `local("Times New Roman"), local("TimesNewRomanPSMT")` を最優先で割り当てる。和文（游明朝）との視覚的な大きさ・重心を揃えるため、`@font-face` 内に **`size-adjust: 106%;`** を指定する。
  - **和文（ひらがな・カタカナ・漢字・全角約物）**: `local("YuMincho"), local("Yu Mincho"), local("Hiragino Mincho ProN")` を割り当てる（iOS環境で游明朝が利用できない場合のフォールバックとしてヒラギノ明朝を含める）。
- **組版ディテール**:
  - `font-feature-settings: "palt" 1, "kern" 1;` を有効化し、約物（句読点や括弧）の詰めと欧文カーニングを最適化する。
  - `-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;` で明朝体の繊細なエレメントを美しく描画する。
  - `line-height: var(--line-height-body, 1.95);`、`letter-spacing: var(--letter-spacing-body, 0.04em);` を基準とする。

---

## 3. コア機能仕様

### 3.1 Scrapbox風リンク記法と標準Markdownの双方向変換
エディタ上ではScrapboxのように `[]` と `#` だけでリンク・タグを記述できるが、保存される `.md` ファイルは他アプリと完全互換の標準Markdown形式とする。
1. **読み込み時変換 (Markdown -> Editor Text)**:
   - ファイルを開く際、内部リンク `[PageName](PageName.md)` や `[PageName](./PageName.md)` を `[PageName]` に変換してCodeMirrorにロードする。
   - 外部リンク `[https://example.com](https://example.com)` のようなURL単体リンクも `[https://example.com]` に変換する（コードブロックやインラインコード内は除外）。
2. **保存時変換 (Editor Text -> Markdown)**:
   - ファイル保存時、エディタ内の `[PageName]` を検知し、`[PageName](PageName.md)` に変換して書き出す（既存の画像記法 `![](...)` やコードブロック内は除外）。
   - `[https://...]` は `[https://...](https://...)` に変換する。
   - `#tag` はそのまま保存しつつ、アプリ内のインデクサーでタグとして認識し、クリック時に同タグを持つファイル一覧をコマンドパレットで絞り込み表示する。
3. **エディタ上のDecoration**:
   - CodeMirror 6の `ViewPlugin` / `MatchDecorator` で `[PageName]` や `#tag` にクラス（`.cm-scrapbox-link`, `.cm-hashtag`）を付与し、スタイルはすべて `typography.css` 側で定義する。クリック（Cmd+Clickまたはタップ）で該当 `.md` を開く（未作成なら新規作成して開く）。

### 3.2 YouTube / Vimeo のペースト即時埋め込み
1. `EditorView.domEventHandlers({ paste })` でクリップボードの文字列を検査し、YouTube (`youtube.com/watch?v=...`, `youtu.be/...`) または Vimeo (`vimeo.com/...`) のURL単体がペーストされた場合、`[URL]` として挿入する。
2. `StateField` + `Decoration.widget` (block widget) により、該当行の直下に `aspect-ratio: 16 / 9;` を持たせたレスポンシブな `<iframe>` コンテナ（`.cm-embed-video`）をインライン描画する。テキスト自体は `[URL]` のまま維持する。

### 3.3 画像のコピペ・D&D即時埋め込み＆WebP圧縮保存
1. エディタへの `paste` または `drop` イベントで画像データ (`File` / `Blob`) を検知。
2. 即座にCanvas上でリサイズ（長辺最大1600px）＆ **WebP形式 (quality 0.85)** に変換し、ファイル名を `img_{timestamp}_{shortHash}.webp` とする。
3. 保存先ディレクトリ（Macではユーザー指定の任意のローカルフォルダ内の `assets/`、iOSではアプリ内Document領域の `assets/`）へバイナリを書き出す。
4. カーソル位置に `![](assets/img_xxx.webp)` を挿入し、Widget Decorationによって画像をインラインプレビュー表示する（カーソルがその行にない時はマークダウン文字列を隠して画像のみを美しく表示する Live Preview 方式）。

### 3.4 ストレージと Cloudflare R2 完全同期エンジン
iCloudや外部アプリに依存せず、アプリ単体でMacとiPhoneを同期する。
1. **ローカル保存先**:
   - **macOS**: 設定モーダルでユーザーが選択した任意のローカルフォルダ（例: `~/Documents/Notes`）を直接読み書きする。
   - **iOS**: アプリのサンドボックス内 `AppData/Documents/Notes` に保存する。
2. **同期インデックス (`_sync.json`) と Push / Pull ロジック**:
   - 全 `.md` ファイルと `assets/*.webp` の相対パス、`updatedAt` (Unix timestamp)、`sha256` ハッシュを記録したマニフェスト `_sync.json` をローカルとCloudflare R2のルートに保持する。
   - **起動時 & フォアグラウンド復帰時 (Pull)**: R2上の `_sync.json` を取得し、ローカルの `_sync.json` と比較して新規・更新された `.md` および画像ファイルを非同期でダウンロードする。
   - **保存時 (Auto Push)**: エディタでの変更をデバウンス（入力停止後2秒）してローカル `.md` に保存すると同時に、変更ファイルと更新後の `_sync.json` をCloudflare R2へ `PUT` する。画像追加時も即座にR2へ `PUT` する。
   - **設定項目**: R2の `Endpoint URL`, `Bucket Name`, `Access Key ID`, `Secret Access Key`、およびMac用のローカル保存先フォルダパスをコマンドパレット内の設定画面から設定・保持できるようにする。

---

## 4. 実装ステップの指示

省略（`// TODO` や `...`）を一切行わず、以下の全てのファイルを完全な動作コードとして実装してください。

1. **プロジェクト構成と設定**: `package.json`, `vite.config.ts`, Tauri v2設定ファイル (`src-tauri/tauri.conf.json`, `Cargo.toml`)。
2. **モダンCSSファイル群**:
   - `src/styles/tokens.css`（人間が後から微調整しやすいよう、各変数の役割を日本語コメントで明記）
   - `src/styles/typography.css`（游明朝 × Times New Roman の `@font-face` 混植と組版ルール）
   - `src/styles/layout.css`（論理プロパティ、`clamp()`, `dvh`, `text-wrap` を用いたstone風ミニマルレイアウト）
3. **双方向トランスフォーマー (`src/lib/transformer.ts`)**: Markdownリンク ⇔ Scrapbox記法の変換ロジック（コードブロック除外対応）。
4. **CodeMirror 6 エディタ＆Widget拡張 (`src/lib/editor.ts`)**: リンク/タグのDecoration、YouTube/Vimeoのiframe Widget、画像のWebP圧縮＆Live Preview Widget。
5. **ローカルFS ＆ Cloudflare R2 同期マネージャー (`src/lib/storage.ts`)**: Tauri FSプラグインを用いたローカル読み書きと、S3互換APIによる `_sync.json` 差分同期エンジン。
6. **アプリケーションUI (`src/App.tsx` または `src/App.svelte`)**: ノイズのないエディタ画面と、`Cmd+K` で開閉するコマンドパレット（ファイル検索・タグ絞り込み・新規作成・R2/フォルダ設定）。