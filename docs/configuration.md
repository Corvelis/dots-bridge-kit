# 自分の環境で設定する

## 保存先

設定とペアリング情報は .dots-bridge/ に保存します。音声認識の言語を変更する場合は .env を使います。
どちらもGitとソースZIPの対象外です。初回セットアップで生成したトークンは、再設定で勝手に変わりません。
Chromeへ渡すのはDotのURLと拡張IDです。ブリッジのトークンやChatGPTの認証情報を拡張のコードへ埋め込みません。

## 接続先

スマホへ設定するURLは **ws://YOUR_MAC_HOST:8799** の1つです。YOUR_MAC_HOSTは自分のMacの値に置き換えます。
G2アプリはこのURLから各機能のパスを作ります。外部アプリも同じポートへ接続します。

| 用途 | 既定ポート | WebSocketパス |
| --- | --- | --- |
| ASR・Dotテキスト | 8799 | /ws |
| テキストと通知 | 8799 | /dots/ws |
| 通話とPCM音声 | 8799 | /voice/ws |

ポートが重なる場合は setup に **--port** を付けます。

~~~sh
npm run setup -- --dot-url YOUR_DOT_URL --host YOUR_MAC_HOST --port 9799
~~~

YOUR_DOT_URL、YOUR_MAC_HOSTは実際の値に置き換えます。
接続先を変えた場合、pack:g2 を実行し直し、スマホに保存済みの接続設定も更新してください。
この版のパッケージ作成はLAN/VPNの ws:// に対応しています。TLSプロキシの個別構成は自分でネットワーク許可とURLを揃える必要があります。

統合ブリッジの1ポートだけがLAN/VPNからの接続を受け付け、アプリの接続にはトークンを要求します。
インターネットへ直接ポート公開する設定はセットアップに含めていません。
内部の通話・テキスト・ASRワーカーはlocalhostだけで待ち受け、まとめて起動・停止されます。
Chromeのネイティブワーカーは専用の別トークンを使用し、その制御経路を公開ポートへ転送しません。

## 起動・停止

| 操作 | コマンド |
| --- | --- |
| 手動で起動 | npm start（Ctrl+Cで終了） |
| 常駐・ログイン時の起動 | npm run services:start |
| 常駐の状態確認 | npm run services:status |
| 常駐の停止・自動起動解除 | npm run services:stop |
| 接続診断 | npm run doctor |

手動と常駐は同時に起動しません。再起動前には通話を終了してください。
ログは .dots-bridge/logs/bridge.out.log と bridge.err.log です。停止時は通話の終了処理を待つため、数十秒かかる場合があります。

## 音声認識の言語

MacのApple SpeechAnalyzerを使用します。既定はMacの言語設定です。
.env.example を .env にコピーし、DOTS_SPEECH_LOCALE を希望する言語（例: ja-JP、en-US）に設定します。
変更後はブリッジを再起動してください。対応言語と音声モデルの準備状況はMacの環境に依存します。
初回の認識では音声モデルの用意に時間がかかる場合があります。

## 更新・解除

ソース版はコード更新後に build と build:native を実行します。実行用セットはサービスを止め、同じ利用フォルダの実行ファイルを新しいセットで更新します。.dots-bridge の設定を保持し、setup と chrome:install を再実行してブリッジを起動します。Chrome拡張とDotタブも再読み込みしてください。
G2を更新する場合は pack:g2 を実行して再導入します。
スマホに保存した接続先も「Macへの接続設定」で確認し、変更後は「保存して接続」を押してください。トークンは引き継ぎます。

~~~sh
npm run services:stop
npm run services:start
~~~

完全に利用をやめる場合は services:stop、chrome:uninstall を実行し、Chromeの拡張を削除します。
これらの操作は履歴や設定を削除しません。必要なデータを自分で保管してからフォルダを片付けてください。
