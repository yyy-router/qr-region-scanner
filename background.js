const CONTENT_FILES = ["content.css", "content.js"];

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  try {
    await ensureContentScript(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: "QR_SCANNER_START" });
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
  try {
    await chrome.tabs.sendMessage(tabId, { type: "QR_SCANNER_PING" });
  } catch {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: [CONTENT_FILES[0]]
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_FILES[1]]
    });
  }
}
