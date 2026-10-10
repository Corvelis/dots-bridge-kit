import { readConfiguredDotUrl } from "./settings.js";
import { openNormalDot } from "./tab-routing.js";
const dot = document.getElementById("dot"), status = document.getElementById("status"), open = document.getElementById("open");
let url;
async function refresh() {
  open.disabled = true; status.textContent = "Macの設定を確認しています…";
  try {
    url = await readConfiguredDotUrl(chrome);
    dot.textContent = url; status.textContent = "設定を読み取りました。"; open.disabled = false;
  } catch {
    url = undefined; dot.textContent = "未接続";
    status.textContent = "Mac側でsetupとchrome:installを実行し、設定を読み直してください。";
  }
}
document.getElementById("refresh").addEventListener("click", refresh);
open.addEventListener("click", () => { if (url) void openNormalDot(chrome, url, { focus: true }).catch(() => { status.textContent = "Chromeの通常ウインドウでDotを開いてください。"; }); });
void refresh();
