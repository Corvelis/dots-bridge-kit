// Dots calls must use the same normal Chrome window as a manually opened page.
// Do not reparent or resize the page: the old compact popup cannot start calls.
export async function normalDotTab(chrome, dotUrl, tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url !== dotUrl) throw new Error("The connected tab is no longer this dot");
  const window = await chrome.windows.get(tab.windowId);
  if (window.type !== "normal" || window.incognito) {
    throw new Error("Open this dot in a normal Chrome tab; the old bridge popup is not supported");
  }
  return { tab, window };
}

export async function prepareDotTab(chrome, dotUrl, tabId, { activate = true } = {}) {
  const { tab, window } = await normalDotTab(chrome, dotUrl, tabId);
  if (activate && window.state === "minimized") await chrome.windows.update(window.id, { state: "normal" });
  await chrome.tabs.update(tab.id, { autoDiscardable: false, ...(activate ? { active: true } : {}) });
}

export async function openNormalDot(chrome, dotUrl, { focus = false, preferredTabId } = {}) {
  const candidates = await chrome.tabs.query({ url: dotUrl });
  const normal = (await Promise.all(candidates.map(async tab => {
    try { return await normalDotTab(chrome, dotUrl, tab.id); }
    catch { return null; } // A stale/closed tab or old popup is not a usable target.
  }))).filter(Boolean);
  const existing = normal.find(item => item.tab.id === preferredTabId)
    ?? normal.find(item => item.window.focused && item.tab.active) ?? normal[0];
  if (existing) {
    if (focus) {
      await chrome.tabs.update(existing.tab.id, { active: true });
      await chrome.windows.update(existing.window.id, {
        focused: true, ...(existing.window.state === "minimized" ? { state: "normal" } : {}),
      });
    }
    return existing.tab;
  }
  const windows = (await chrome.windows.getAll({ windowTypes: ["normal"] }))
    .filter(window => window.type === "normal" && !window.incognito);
  const destination = windows.find(window => window.focused) ?? windows[0];
  if (destination) {
    const tab = await chrome.tabs.create({ windowId: destination.id, url: dotUrl, active: focus });
    if (focus) await chrome.windows.update(destination.id, {
      focused: true, ...(destination.state === "minimized" ? { state: "normal" } : {}),
    });
    return tab;
  }
  const window = await chrome.windows.create({ url: dotUrl, type: "normal", incognito: false,
    focused: focus, width: 1280, height: 900 });
  return window?.tabs?.[0];
}
