# 開発・GitHubリリース

拡張・Macブリッジ・G2アプリを1つのリポジトリで管理します。ソースはMITライセンスです。

## ソースからビルドする

MacにNode.js 24 LTSとXcode Command Line Toolsを用意し、ソースのフォルダで実行します。

~~~sh
npm ci
npm run build
npm run build:native
~~~

以降は [導入ガイド](getting-started.md#1-ダウンロードと自分の設定) の `npm run setup` から進めます。`npm ci --omit=dev` は実行用セットの手順なので、ソース版では上の `npm ci` を使います。
型検査は `npm run typecheck`、回帰テストは `npm test`、G2画面の開発は `npm run dev:g2` です。開発用URLに `?preview=1` を付けると、Dotへ接続せず説明用の表示を確認できます。

## リリース物を作る

macOSで、依存関係を導入済みのソースフォルダから実行します。

~~~sh
npm test
npm run release:check
npm run release:all
~~~

| 出力 | 配布先・内容 |
| --- | --- |
| `build/github/dots-bridge-kit` | GitHubのコード。明示したソース・ドキュメント・画像・設定例・テスト・CI・ライセンス |
| `build/releases/dots-bridge-kit-chrome-v0.1.0.zip` | Chromeへ読み込める共通拡張。設定はMacから取得 |
| `build/releases/dots-bridge-kit-source.zip` | 同じソースをZIPで配布 |
| `build/releases/dots-bridge-kit-macos-arm64-v0.1.0.zip` | Apple Siliconの実行用セット。ビルド済みブリッジ・音声ヘルパー・G2画面・共通Chrome拡張・導入スクリプト |
| `build/releases/SHA256SUMS.txt` | 上のZIPのチェックサム |

Intel Mac上で同じコマンドを実行すると `macos-x64` の実行用セットを作ります。
Node.jsとnpm依存関係は実行用セットに同梱せず、利用者がインストールします。AppleのフレームワークとBlackHoleも同梱しません。
ネイティブヘルパーはアドホック署名です。Developer ID署名・公証済みのMacインストーラーではありません。

Chrome拡張は共通ZIPをReleaseへ添付します。個人のDot URLやトークンを埋め込まず、Macの保存設定から対象Dotを取得します。
G2の `.ehpk` はMacの通信先をパッケージ内で許可するため、利用者が自分の接続先に合わせて作成します。G2の画面は実行用セットでビルド済みなので、コンパイラーは不要です。

## 配布するファイル

ソースは `release-files.json` に列挙したファイルだけを対象にします。未登録ファイル、個人パス、ネットワークの実値、メール、認証情報などの検出で処理を止めます。
実行用セットはビルド済みの実行ファイルと導入に必要なファイルを含みます。

設定・トークン・履歴・ログ・録音は配布しません。セットアップ済みフォルダ全体や、個人用の `.ehpk` をReleaseへ追加しないでください。

GitHub ActionsのChecksは型検査・テスト・ビルド・公開検査を実行します。Build release assetsは手動実行でChrome拡張ZIP・Apple SiliconのソースZIP・実行用ZIP・チェックサムをActionsのartifactへ保存します。GitHub Releaseへの公開は行いません。

GitHub ReleaseにはChrome拡張ZIP・ソースZIP・対象アーキテクチャのMac実行用ZIP・チェックサムを添付します。説明には [リリース内容](release-notes.md) と [導入ガイド](getting-started.md) を案内します。
