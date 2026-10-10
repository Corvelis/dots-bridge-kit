# Chrome拡張のインストール

`dots-bridge-kit-chrome-v0.1.0.zip` は、そのまま読み込めるChrome拡張です。コンパイルや個人用ZIPの作成は不要です。
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

旧版から更新する場合は、通話を終了してMacブリッジを停止し、同じリリースのMac実行用セットへ更新してください。設定フォルダ `.dots-bridge` を保持し、`setup` と `chrome:install` を再実行します。古い拡張を削除してからZIP版を読み込み、ブリッジを再起動してください。

## English

This ZIP is an unpacked Chrome extension. It requires the Mac bridge from the same release and Node.js 24 LTS.
In the **Mac runtime folder**, run `npm ci --omit=dev`, `npm run setup`, and `npm run chrome:install`.
Extract this ZIP to a permanent folder. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the folder containing **manifest.json**.
In the Mac runtime folder, run `npm run services:start`, then open and reload your configured Dot in a normal Chrome tab. The extension badge should show **ON**.
The setup-generated `build/extension` is identical; load only one copy. The extension reads your saved Dot URL from the Mac. Use `npm run setup` to change it, then reload the extension and Dot tab.
When upgrading an older installation, stop calls and the bridge, update the Mac runtime while keeping `.dots-bridge`, rerun setup and native-host installation, remove the old extension, load this one and restart the bridge.
