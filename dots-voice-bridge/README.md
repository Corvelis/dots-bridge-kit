# 通話ブリッジのプロトコル

Macの通話ブリッジの /voice/ws に接続します。既定ポートは8799です。
起動・Chrome・音声権限の準備は [導入手順](../README.md) を先に進めてください。
HTTPの /voice はスマホ向けの接続確認画面です。統合された /health のcomponents.voiceから通話状態を読み取ります。

## 認証と再接続

接続後5秒以内に voice.hello を送ります。

~~~json
{"type":"voice.hello","version":1,"token":"YOUR_TOKEN","resumeKey":"YOUR_RESUME_KEY"}
~~~

tokenはsetupで生成した値です。resumeKeyは端末側で別に生成する32バイトのランダム値で、小文字16進数64文字にします。
端末の安全な保存先に保持し、再接続でも同じ値を使用します。resumeKeyを省略した接続では通話所有者の再接続復旧ができません。
voice.ready は version、サーバーが発行したclientId、state、input、dotUrlを返します。
端末はstate.ownerと今回のclientIdを比較して、操作できる通話か判断します。

## コマンド

各要求に一意の文字列idを付けます。応答は同じidとresult、またはerror.messageです。

~~~json
{"id":"start-1","method":"session.start"}
{"id":"ptt-on-1","method":"audio.input","params":{"enabled":true}}
{"id":"ptt-off-1","method":"audio.input","params":{"enabled":false}}
{"id":"stop-1","method":"session.stop"}
~~~

| method | 動作 |
| --- | --- |
| status | 通話・所有者・Chromeの状態を取得 |
| session.start | Dotの通話を開始 |
| audio.input | 自分の通話のマイク送信を開始／停止 |
| session.stop | 自分の通話を終了 |


## 音声とイベント

音声入力は **16kHz、モノラル、PCM16 little-endian** のWebSocketバイナリです。
audio.inputをtrueにした自分の通話だけで送信できます。G2アプリのPTT上限は60秒です。

音声出力は audio.chunk JSONと、その直後のバイナリの組です。
sampleRate、channels、byteLength、streamIdを毎回確認し、メタデータのサンプルレートで再生します。
出力はDotの通話音声を48kHzモノラルで送ります。キュー混雑時は古い音声を間引き、遅延の蓄積を抑えます。
途切れた後の再接続で、送信済みのマイク音声を再送しません。

voice.state、browser.state、voice.notice、voice.errorを受信して画面を更新します。
stateのphaseとrecoveryを確認し、復旧中はPTTを解除します。接続が戻ってから新しい長押しを受け付けてください。
スマホ・Chrome・音声経路の一時切断は同じ通話の復旧を試みます。60秒以内に復旧できない場合やDot側が終了した場合は終了理由がstate.lastEndに入ります。
手動で始まったDotの通話を、APIで作った自分の通話として扱いません。

イベントログはMacの非公開設定フォルダへ保存します。公開用のソースZIPには含めません。
