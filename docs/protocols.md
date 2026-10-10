# 外部アプリ連携

すべて **ws://YOUR_MAC_HOST:8799** の同じ接続先を使い、用途ごとにパスを選びます。[ポート変更と設定](configuration.md)
トークンはsetupで生成されたものを使用してください。
HTTPの /health は {ok, version, components:{relay,voice,text}} を返します。okは全ワーカーが起動している状態で、ChromeやASRの利用可否は各componentsの状態を確認します。

## テキスト・通知

/dots/ws に接続し、5秒以内に次のJSONを送ります。
YOUR_TOKENとYOUR_APP_IDは自分の値に置き換えます。端末IDを再起動後も保持してください。

~~~json
{"type":"dots.hello","version":1,"appId":"YOUR_APP_ID","token":"YOUR_TOKEN"}
~~~

dots.ready の後にJSON RPCを送ります。

~~~json
{"id":"1","method":"message/send","params":{"requestId":"YOUR_UNIQUE_REQUEST_ID","text":"こんにちは"}}
~~~

受付は返答の完成ではありません。dots.message または message/read のstatusが completed になったときだけreplyを利用します。
queued / processing は待機中、failed は配達前の失敗、uncertain は配達後の結果が不明です。
requestIdと本文を送信前に保存し、切断やタイムアウトでは同じIDを message/read で照会します。
不明な発言に新しいrequestIdを付けて自動再送しないでください。

通知は notification/sync の params: {"after":0,"limit":100} から取得し、hasMoreがfalseになるまで続けます。
その後は dots.notification を受信します。通知のsequenceと内容を保存した後に受信位置を進めてください。
通知ストリームで入力の受付を監視する場合は params に `includeInputs:true` を追加します。`role:"user"` が自分の入力、role省略または `"assistant"` がDotです。`inputId` はブリッジ受付済み入力のIDで、ASRとChrome観測の重複防止に使います。自分の入力は受付記録であり、配達完了を示しません。従来のクライアントはDotのみを受信しますが、nextCursorは省略した入力の位置も含みます。会話履歴の表示には、下記の `history/sync` を使ってください。この受付・通知の到着順は会話順ではなく、通常の最初の返答もすべて含むものではありません。

入力12,000文字、返答24,000文字、通知保存1,024件です。画像・添付・過去のChatGPT会話全体の取得には対応していません。

## 通話

/voice/ws に接続し、5秒以内に認証します。resumeKeyは端末側で生成した32バイトのランダム値を64文字の小文字16進数で保存します。clientIdは接続ごとにサーバーから受け取ります。

~~~json
{"type":"voice.hello","version":1,"token":"YOUR_TOKEN","resumeKey":"YOUR_RESUME_KEY"}
~~~

voice.ready の後、status、session.start、audio.input、session.stopをJSON RPCで使用します。
audio.input の params は {"enabled":true} または {"enabled":false} です。
session.startで作った自分の通話だけを制御し、手動で始まった他の通話を所有した扱いにしません。
session.startにパラメータは不要です。PCM仕様の詳細は [通話プロトコル](../dots-voice-bridge/README.md) を参照してください。

入力は16kHz・モノラル・signed PCM16 little-endianのバイナリです。
出力は audio.chunk のメタデータの直後に、指定byteLengthのバイナリが続きます。
古い音声が混雑した場合はキューを間引きます。回線復旧で通話を再開しても、PTTは新しく操作します。

## G2 ASR・テキスト

/ws へ {"type":"hello","version":16,"client":"dots","token":"YOUR_TOKEN"} で接続します。
echo.snapshot のconfig.dedicatedDots、dotsReady、asrReadyを確認します。
echo.voice.start を送り、echo.state のphaseが listening になってから16kHzモノラルPCMを送り、echo.voice.stopで録音を終了します。
reviewTranscript:true を指定すると、echo.transcript のawaitingConfirmationで停止します。
echo.transcript.submit と対応するturnIdを送ると、確認中の認識結果をDotへ送信します。
echo.text.submit とtextを送ると、文字列を直接送信できます。

echo.state は idle / listening / transcribing / thinking / error を通知します。
echo.transcript が認識結果、echo.reply がDotの文章、echo.done が応答処理の完了です。
echo.cancel は録音・確認中の認識結果・ローカルの返答待ちを取り消します。Dotへ渡った入力を取り消すものではありません。

echo.notification の内容を表示してから、echo.notification.displayed と同じturnId・notificationIdを返します。
サーバーは表示の確認後に通知位置を保存します。表示前に切断した通知は再接続後に届けます。


### 会話順の履歴同期

`dots.ready` / `status` の `conversationHistory: true` に対応するクライアントは、`history/sync`（空パラメータ）で `{epoch, revision, ready, gap, items}` を取得し、以後の `dots.history`（`history`に同じ形式）を購読します。`items`はDots画面の会話順です。各要素は `{id, sourceId, role, text, sequence:0, receivedAt, inputId?}`。IDは`dom:<sourceId>`、`role`は`user`または`assistant`です。`receivedAt`は観測時刻で、発言時刻ではありません。並べ替えには使わず、スナップショットで表示キャッシュを置き換えます。同じ`epoch`の古い`revision`は無視します。

最新100件・240 KiB以内で、文章を途中で切らず古いメッセージから落とします。`ready:false`は拡張から初回履歴がまだ届いていない状態です。`gap:true`は保存上限や表示範囲の作り直しにより過去の範囲が欠けたことを示します。Chromeで読み込まれた会話だけを対象にし、Dots全履歴の取得は行いません。過去の追加読み込みは共有メッセージIDでつなぎます。新着通知のカーソルと独立しており、履歴同期だけでは点灯・音声再生を開始しません。
