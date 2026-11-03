# pure のアイコンと動くワードマーク

アプリアイコンの元画像は `public/pure.png`（1024 × 1024）です。`src-tauri/icons/` に Mac 用の ICNS と各サイズの画像を生成しています。

GitHub Actions では、`tauri ios init` のあとに `tauri icon public/pure.png` を実行します。生成済みの Xcode プロジェクトにも画像を適用するため、iPhone 版がテンプレートのアイコンに戻ることを防ぎます。ブラウザーの favicon も同じ画像を使います。

トップの「pure」は `docs/pure_test.html` の、文字の芯線に線を交差させる方法を応用した Canvas 描画です。p の形は参照ツールから移植し、u・r・e も同じ描画で構成しています。参照 HTML は設計資料として残し、アプリ本体から CDN・p5.js・Tailwind を読み込むことはありません。

添付のパラメータは `src/lib/wordmark.ts` の `HATCH_SETTINGS` に固定しています。

| パラメータ | 値 |
| --- | --- |
| Background Gray | 255 |
| Stroke Gray Min / Max | 0 / 180 |
| Line Density | 250（1文字ごと） |
| Stroke Weight | 2.0 |
| Stroke Opacity | 53% |
| Hatch Angle / Span | 65 |
| Hatch Line Length | 1.25 |
| Cross-Hatch Layer | オン |
| Noise Frequency | 0.030 |
| Turbulence | 125 |
| Time Speed | 0.1 |
| Stem & Bowl Thickness | 44 |
| Bowl Expansion | 1.20 |
| Guide Skeleton | オフ |

レイアウト・テーマに合わせて拡縮・配色し、画面の密度が変わった場合も描き直します。ダークモードでは背景と線の明暗を合わせます。描画は最大30fpsとし、記事画面・パレット表示中・背景移動中・ロゴがスクロール範囲外にあるときは停止します。「視差効果を減らす」が有効な環境では静止画にします。

ワードマークの表示幅は `src/styles/tokens.css` の `--wordmark-width` で調整できます。

## 左揃えと文字間

Canvas 内部の余白を基準にせず、描いた線分の輪郭を計算して p の左端を検索欄の開始位置に合わせます。線幅と交差ハッチも含めて計測し、動いている間も p–u・u–r・r–e の間隔を同じ80描画単位（既定の表示幅で約5.7 CSS px）に保ちます。文字そのものの大きさとハッチングのパラメータは維持しています。

## iOS 向けの描画負荷とタイミング

- 芯線、線長の固定部分、ノイズのXY補間係数を事前に計算します。ノイズの前後の層も再利用します。
- 線分バッファと明暗の色データを再利用し、毎フレームの配列・色文字列の生成を避けます。線の描画順序は維持します。
- 不透明な Canvas を使い、表示サイズと画面密度が変わったときだけ描画面を再確保します。非表示時に1pxへ縮めません。Retina は最大3倍密度で描画します。
- 経過時間ベースで30fpsを上限とし、60Hz・120Hzなどの画面や1ms単位に丸められた時刻でもフレームを取りこぼしにくい時計にしています。キーボード表示やウィンドウサイズ変更でも時計をリセットしません。
- 既存のバックグラウンド・画面外・記事表示中・視差効果を減らす設定での停止を維持しています。

`tests/wordmark.test.ts` で、動きの途中の左端・文字間、ノイズの区間境界での連続性、描画面の密度、30/60/120/144Hzと時刻の丸め、停止・復帰の時刻を確認します。実機 iPhone の FPS・消費電力はこの開発環境では測定していません。

2026年11月3日の Mac 上の JavaScriptCore による5,000フレームの比較では、描画前のJS処理は平均約0.055msから0.018msになりました。これは Canvas のラスタライズ・GPU処理を除いた計測で、iPhone 実機の FPS を示すものではありません。

参考：[Canvas の最適化（MDN）](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas)、[requestAnimationFrame の時刻とリフレッシュレート（MDN）](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)
