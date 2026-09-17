const OCR_OPTIONS_KEY = "qrScannerOcrOptions";

const DEFAULT_OCR_OPTIONS = {
  enabled: false,
  provider: "ocr-space",
  apiKey: "",
  triggerMode: "manual",
  engine: "2",
  language: "eng"
};

const form = document.querySelector("#ocr-options-form");
const enabled = document.querySelector("#enable-cloud-ocr");
const provider = document.querySelector("#ocr-provider");
const apiKey = document.querySelector("#ocr-api-key");
const triggerMode = document.querySelector("#ocr-trigger-mode");
const engine = document.querySelector("#ocr-engine");
const language = document.querySelector("#ocr-language");
const reset = document.querySelector("#reset-options");
const statusMessage = document.querySelector("#status-message");

loadOptions();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveOptions(readFormOptions());
  showStatus("配置已保存");
});

reset.addEventListener("click", async () => {
  fillForm(DEFAULT_OCR_OPTIONS);
  await saveOptions(DEFAULT_OCR_OPTIONS);
  showStatus("已恢复默认配置");
});

function loadOptions() {
  chrome.storage.local.get({ [OCR_OPTIONS_KEY]: DEFAULT_OCR_OPTIONS }, (items) => {
    if (chrome.runtime.lastError) {
      showStatus("读取配置失败", true);
      return;
    }

    fillForm({ ...DEFAULT_OCR_OPTIONS, ...items[OCR_OPTIONS_KEY] });
  });
}

function saveOptions(options) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [OCR_OPTIONS_KEY]: options }, () => {
      if (chrome.runtime.lastError) {
        showStatus("保存配置失败", true);
        reject(chrome.runtime.lastError);
        return;
      }

      resolve();
    });
  });
}

function readFormOptions() {
  return {
    enabled: enabled.checked,
    provider: provider.value,
    apiKey: apiKey.value.trim(),
    triggerMode: triggerMode.value,
    engine: engine.value,
    language: language.value
  };
}

function fillForm(options) {
  enabled.checked = Boolean(options.enabled);
  provider.value = options.provider;
  apiKey.value = options.apiKey;
  triggerMode.value = options.triggerMode;
  engine.value = options.engine;
  language.value = options.language;
}

function showStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.style.color = isError ? "#b91c1c" : "#166534";
  window.clearTimeout(showStatus.timer);
  showStatus.timer = window.setTimeout(() => {
    statusMessage.textContent = "";
  }, 1800);
}
