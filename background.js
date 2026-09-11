const CONTENT_CSS = "content.css";
const CONTENT_SCRIPTS = ["vendor/jsQR.js", "content.js"];
const CONTENT_VERSION = "0.3.0";

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  try {
    await ensureContentScript(tab.id);
    await chrome.tabs.sendMessage(tab.id, {
      type: "QR_SCANNER_START_V2",
      contentVersion: CONTENT_VERSION
    });
  } catch (error) {
    console.warn("Unable to start QR scanner:", error);
    await chrome.action.setBadgeText({ tabId: tab.id, text: "ERR" });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#B91C1C" });
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: "" }), 2500);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "QR_SCANNER_CAPTURE") return false;

  chrome.tabs.captureVisibleTab(sender.tab?.windowId, { format: "png" }, (dataUrl) => {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      return;
    }

    sendResponse({ ok: true, dataUrl });
  });

  return true;
});

async function ensureContentScript(tabId) {
  let ping = null;

  try {
    ping = await chrome.tabs.sendMessage(tabId, { type: "QR_SCANNER_PING" });
  } catch {
    // No content script is active yet.
  }

  if (ping?.contentVersion === CONTENT_VERSION && ping?.hasJsQr) {
    return;
  }

  if (ping?.contentVersion === CONTENT_VERSION && !ping?.hasJsQr) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["vendor/jsQR.js"]
    });
    return;
  }

  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: [CONTENT_CSS]
    });
  } catch {
    // CSS may already be present on pages where the old script was injected.
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_SCRIPTS
  });
}
