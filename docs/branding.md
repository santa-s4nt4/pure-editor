# pure のアイコンと動くワードマーク

アプリアイコンの元画像は `public/pure.png`（1024 × 1024）です。`src-tauri/icons/` に Mac 用の ICNS と各サイズの画像を生成しています。

GitHub Actions では、`tauri ios init` のあとに `tauri icon public/pure.png` を実行します。生成済みの Xcode プロジェクトにも画像を適用するため、iPhone 版がテンプレートのアイコンに戻ることを防ぎます。ブラウザーの favicon も同じ画像を使います。

トップの「pure」は `docs/pure_test.html` の、文字の芯線に線を交差させる方法を応用した Canvas 描画です。p の形は参照ツールから移植し、u・r・e も同じ描画で構成しています。参照 HTML は設計資料として残し、アプリ本体から CDN・p5.js・Tailwind を読み込むことはありません。

添付のパラメータは `src/components/AnimatedWordmark.tsx` の `hatch` に固定しています。

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
