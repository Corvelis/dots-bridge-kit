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

## 外出先から使う（TailscaleなどのVPN）

外のスマホから自宅のMacへ届くVPNを使えば、同じブリッジへ接続できます。Tailscaleを使う場合は次の順です。

1. [Tailscale](https://tailscale.com/download) をMacとスマホに導入し、同じアカウントで同じVPNネットワークへ接続します。G2へのインストールは不要です。
2. Tailscaleの端末一覧で **MacのVPN IP（IPv4）** を確認します。自宅LANのIPやスマホのIPではなく、Macに割り当てられた値を使います。[公式の接続手順](https://tailscale.com/docs/how-to/connect-to-devices)
3. 初回セットアップの「Macのホスト名／IP」にその値を入れ、その後は [導入ガイド](getting-started.md) どおりにG2パッケージを作って導入します。スマホの接続先は `ws://YOUR_MAC_VPN_IP:8799` です。`YOUR_MAC_VPN_IP` は自分のMacの値に置き換えます。
4. 外出中もMacとスマホのVPNをオンにします。Macをスリープさせず、ブリッジとChromeのDotを起動しておきます。VPN接続中は自宅でも外出先でも同じURLを使えます。

**外出前の確認：** スマホのWi-Fiをオフにし、モバイル通信とVPNをオンにして、`http://YOUR_MAC_VPN_IP:8799/` が開けるか確認します。開けたらEven Appでも接続を確認します。ポートを変更した場合は、そのポート番号に置き換えます。

LANの設定から変更する場合は、通話を終了して `npm run services:stop` を実行し、`npm run setup` でDotのURLとMacのVPN IPを設定し直します。`npm run pack:g2` で作り直したパッケージを同じアプリIDでインストールし、スマホの「Macへの接続設定」も更新します。`npm run services:start` で起動し、Chrome拡張とDotタブを再読み込みしてください。既存のペアリングトークンは引き継ぎます。

他のVPNでも、スマホからMacのホスト名／IPとブリッジのポートへ届く構成なら同様に使えます。

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
