# Dots Bridge Kit v0.1.1

Chromeで開いた自分のDotを、外部のアプリやデバイスへつなぐローカルMacブリッジです。Even G2用アプリも付属します。

Chrome拡張を **0.2.8** に更新しました。Dotのタブから別ページへ移動した後に入力が届かなくなる問題と、通話用接続が切断・再接続を繰り返す問題を修正しています。

**v0.1.0からの更新:** 通話を終了し、新しいChrome拡張ZIPの内容を、現在読み込んでいる拡張フォルダへ上書きします。`chrome://extensions` で拡張を再読み込みし、設定したDotのタブも再読み込みしてください。Macの接続設定とG2アプリは引き続き使えます。[詳しい更新手順](chrome-extension.md)

- **Apple Silicon Macで使う:** `dots-bridge-kit-macos-arm64-v0.1.1.zip`
- **Chrome拡張を導入・更新する:** `dots-bridge-kit-chrome-v0.1.1.zip`
- **コードを変更する:** `dots-bridge-kit-source.zip`
- **ZIPの確認:** `SHA256SUMS.txt`

初回導入は [導入ガイド](getting-started.md)、グラスの操作は [G2操作ガイド](g2-controls.md) を参照してください。G2パッケージは、自分のMacの接続先に合わせて実行用セットから作成します。独自アプリやデバイスの接続方法は [API仕様](protocols.md) にあります。

macOS 26以降、Node.js 24 LTS、Chromeが必要です。付属G2アプリを使う場合はEven G2とEven App 2.2.10以降も用意します。通話にはBlackHole 2chを別途導入します。Macのヘルパーはアドホック署名で、公証済みインストーラーではありません。
