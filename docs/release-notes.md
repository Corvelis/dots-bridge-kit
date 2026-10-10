# Dots Bridge Kit v0.1.0

自分のDotをChromeで開き、Even G2の長押しで会話できるセットです。通話・音声→テキスト・会話履歴・新着通知に対応します。

Dots Phone G2は **0.2.25**。設定の保存、左右操作の入れ替え、自動消灯、履歴表示数の変更に対応します。ASRの送信確認中・点灯中は **G2左右／R1の長押しで送信、ダブルタップで破棄**し、画面は点灯を維持します。返答待ちの間も履歴を読めます。確認中以外のPTT・消灯・モード切替・通話終了は通常の割り当てを使います。

- **Apple Silicon Macで使う:** `dots-bridge-kit-macos-arm64-v0.1.0.zip`
- **コードを変更する:** `dots-bridge-kit-source.zip`
- **ZIPの確認:** `SHA256SUMS.txt`

[導入ガイド](getting-started.md) に沿って、自分のDotとMacの接続先を設定します。Chrome拡張とG2パッケージは導入中に生成します。実行用セットではソースのビルドは不要です。

macOS 26以降、Node.js 24 LTS、Chrome、Even G2、Even App 2.2.10以降が必要です。通話にはBlackHole 2chを別途導入します。Macのヘルパーはアドホック署名で、公証済みインストーラーではありません。
