const CONTENT_CSS = "content.css";
const CONTENT_SCRIPTS = ["vendor/jsQR.js", "content.js"];
const CONTENT_VERSION = "0.6.0";
const OCR_OPTIONS_MENU_ID = "open-ocr-options";
const OCR_SPACE_API_URL = "https://api.ocr.space/parse/image";
const OCR_REQUEST_TIMEOUT_MS = 20000;
const OCR_RETRY_DELAYS_MS = [600, 1600];

chrome.runtime.onInstalled.addListener(() => {
  createOcrOptionsMenu();
});

chrome.runtime.onStartup.addListener(() => {
  createOcrOptionsMenu();
});

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

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === OCR_OPTIONS_MENU_ID) {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "QR_SCANNER_CAPTURE") {
    chrome.tabs.captureVisibleTab(sender.tab?.windowId, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      sendResponse({ ok: true, dataUrl });
    });

    return true;
  }

  if (message?.type === "QR_SCANNER_OCR_SPACE_PARSE") {
    parseWithOcrSpace(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || "OCR 请求失败" }));

    return true;
  }

  return false;
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

function createOcrOptionsMenu() {
  chrome.contextMenus.remove(OCR_OPTIONS_MENU_ID, () => {
    chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: OCR_OPTIONS_MENU_ID,
      title: "配置 OCR",
      contexts: ["action"]
    });
  });
}

async function parseWithOcrSpace(payload) {
  if (!payload?.apiKey) {
    throw new Error("请先在 OCR 配置页填写 API Key");
  }

  if (!payload?.base64Image) {
    throw new Error("OCR 图片为空");
  }

  const data = await requestOcrSpace(payload);
  if (data?.IsErroredOnProcessing) {
    const message = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join("; ") : data.ErrorMessage;
    throw new Error(message || "OCR 服务处理失败");
  }

  const parsedText = (data?.ParsedResults || [])
    .map((item) => item?.ParsedText || "")
    .join("\n")
    .trim();

  return {
    text: parsedText,
    raw: data
  };
}

async function requestOcrSpace(payload) {
  let lastError = null;

  for (let attempt = 0; attempt <= OCR_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await postOcrSpace(payload);
    } catch (error) {
      lastError = error;
      if (!isRetryableOcrError(error) || attempt === OCR_RETRY_DELAYS_MS.length) {
        break;
      }

      await wait(OCR_RETRY_DELAYS_MS[attempt]);
    }
  }

  if (isNetworkFetchError(lastError)) {
    throw new Error(`OCR 网络请求失败，已自动重试 ${OCR_RETRY_DELAYS_MS.length} 次。请稍后重试，或检查代理/网络是否允许访问 api.ocr.space`);
  }

  throw lastError || new Error("OCR 请求失败");
}

async function postOcrSpace(payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OCR_REQUEST_TIMEOUT_MS);
  const formData = new FormData();
  formData.append("apikey", payload.apiKey);
  formData.append("base64Image", payload.base64Image);
  formData.append("language", payload.language || "eng");
  formData.append("isOverlayRequired", "false");
  formData.append("scale", "true");
  formData.append("OCREngine", payload.engine || "2");

  try {
    const response = await fetch(OCR_SPACE_API_URL, {
      method: "POST",
      body: formData,
      signal: controller.signal
    });

    if (!response.ok) {
      const error = new Error(`OCR 请求失败：HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }

    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`OCR 请求超时，请稍后重试`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function isRetryableOcrError(error) {
  if (isNetworkFetchError(error)) return true;
  if (error?.message?.includes("OCR 请求超时")) return true;
  return [408, 429, 500, 502, 503, 504].includes(error?.status);
}

function isNetworkFetchError(error) {
  return error instanceof TypeError || error?.message === "Failed to fetch";
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
