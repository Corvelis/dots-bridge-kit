# Chrome拡張のインストール

`dots-bridge-kit-chrome-v0.1.1.zip` は、そのまま読み込めるChrome拡張です。コンパイルや個人用ZIPの作成は不要です。
Macブリッジと組み合わせて使います。拡張だけでは動作しません。

1. 同じリリースのMac実行用セットを展開し、Node.js 24 LTSをインストールします。
2. **Mac実行用セットのフォルダ**で、ターミナルから次を実行します。自分のDotのURLとMacの接続先を入力してください。

~~~sh
npm ci --omit=dev
npm run setup
npm run chrome:install
~~~

3. 拡張のZIPを展開し、使い続ける場所へ置きます。
4. Chromeで `chrome://extensions` を開き、「デベロッパーモード」をオンにします。
5. 「パッケージ化されていない拡張機能を読み込む」で、**manifest.jsonが入っているフォルダ**を選びます。ZIP自体は選びません。
6. Mac実行用セットのフォルダで `npm run services:start` を実行し、設定したDotを通常のChromeタブで開いて再読み込みします。拡張のバッジが **ON** になれば接続できています。

セットアップが作る `build/extension` も同じ拡張です。ZIP版と両方を読み込まず、どちらか1つを使ってください。
設定はMac側に保存されます。DotのURLを変えるときはMac側で `npm run setup` を実行し、拡張とDotタブを再読み込みします。拡張の「詳細 → 拡張機能のオプション」で設定したDotを確認できます。

**v0.1.0から今回の修正を適用する場合:** 通話を終了し、新しい拡張ZIPの内容を、現在Chromeに読み込んでいる拡張フォルダへ上書きします。`chrome://extensions` で拡張の「再読み込み」を押し、設定したDotのタブも再読み込みしてください。Macの接続設定とG2アプリは引き続き使えます。

Mac実行用セットも更新する場合は、通話を終了してブリッジを停止し、設定フォルダ `.dots-bridge` を新しい実行用セットへ引き継ぎます。`npm ci --omit=dev`、`npm run setup`、`npm run chrome:install` を実行し、拡張とDotタブを再読み込みしてからブリッジを再起動してください。拡張フォルダの場所を変える場合は、古い拡張を削除して新しいフォルダを読み込みます。

## English

This ZIP is an unpacked Chrome extension. It requires the Mac bridge from the same release and Node.js 24 LTS.
In the **Mac runtime folder**, run `npm ci --omit=dev`, `npm run setup`, and `npm run chrome:install`.
Extract this ZIP to a permanent folder. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the folder containing **manifest.json**.
In the Mac runtime folder, run `npm run services:start`, then open and reload your configured Dot in a normal Chrome tab. The extension badge should show **ON**.
The setup-generated `build/extension` is identical; load only one copy. The extension reads your saved Dot URL from the Mac. Use `npm run setup` to change it, then reload the extension and Dot tab.
To apply this fix to v0.1.0, end any call and copy the new extension ZIP's contents over the extension folder already loaded in Chrome. Click **Reload** in `chrome://extensions`, then reload your configured Dot tab. Keep using your existing Mac connection settings and G2 app.
If updating the Mac runtime as well, stop calls and the bridge, carry `.dots-bridge` into the new runtime folder, and run `npm ci --omit=dev`, `npm run setup`, and `npm run chrome:install`. Reload the extension and Dot tab, then restart the bridge. If moving the extension folder, remove the old extension and load the new folder.
