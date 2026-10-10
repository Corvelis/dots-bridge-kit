export async function readConfiguredDotUrl(chrome) {
  let timeout;
  try {
    const reply = await Promise.race([
      chrome.runtime.sendNativeMessage("org.dotsbridgekit.chrome", { type: "config" }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Mac setup did not respond")), 5000); }),
    ]);
    const url = new URL(reply?.dotUrl);
    if (reply.type !== "config" || url.origin !== "https://chatgpt.com"
      || !/^\/dots\/(?:home|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(url.pathname)
      || url.search || url.hash || url.username || url.password) throw new Error("Invalid Dot URL in Mac setup");
    return url.href;
  } finally { clearTimeout(timeout); }
}
