(() => {
  const CONTENT_VERSION = "0.6.0";
  const RESULT_AUTO_CLOSE_SECONDS = 10;
  const HISTORY_STORAGE_KEY = "qrScannerHistory";
  const HISTORY_LIMIT = 1000;
  const OCR_MAX_IMAGE_SIDE = 1800;
  const OCR_MIN_IMAGE_HEIGHT = 180;
  const OCR_MAX_UPSCALE = 3;
  const OCR_OPTIONS_KEY = "qrScannerOcrOptions";
  const DEFAULT_OCR_OPTIONS = {
    enabled: false,
    provider: "ocr-space",
    apiKey: "",
    triggerMode: "manual",
    engine: "2",
    language: "eng"
  };
  const OCR_URL_PATTERN = /\b(?:(?:https?:\/\/|https?:\/|www\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?::\d{2,5})?(?:\/[a-z0-9._~:/?#@!$&'()*+,;=%-]*)?/gi;

  if (window.__qrRegionScannerVersion === CONTENT_VERSION) {
    return;
  }

  window.__qrRegionScannerVersion = CONTENT_VERSION;
  window.__qrRegionScannerLoaded = true;
  chrome.runtime.onMessage.addListener(handleMessage);

  let overlay = null;
  let selection = null;
  let tip = null;
  let startPoint = null;
  let activeRect = null;
  let resultPanelTimer = null;

  function handleMessage(message, _sender, sendResponse) {
    if (message?.type === "QR_SCANNER_PING") {
      sendResponse({
        ok: true,
        contentVersion: CONTENT_VERSION,
        hasJsQr: typeof self.jsQR === "function"
      });
      return true;
    }

    if (message?.type === "QR_SCANNER_START_V2" && message?.contentVersion === CONTENT_VERSION) {
      startScanner();
      sendResponse({ ok: true });
      return true;
    }

    return false;
  }

  function startScanner() {
    cleanup();
    removeResultPanel();

    overlay = document.createElement("div");
    overlay.className = "qr-scanner-overlay";
    overlay.setAttribute("role", "presentation");

    selection = document.createElement("div");
    selection.className = "qr-scanner-selection";

    tip = document.createElement("div");
    tip.className = "qr-scanner-tip";
    tip.textContent = "拖拽框选二维码区域，按 Esc 取消";

    overlay.append(tip, selection);
    document.documentElement.appendChild(overlay);

    overlay.addEventListener("mousedown", onPointerStart);
    overlay.addEventListener("mousemove", onPointerMove);
    overlay.addEventListener("mouseup", onPointerEnd);
    overlay.addEventListener("mouseleave", onPointerEnd);
    window.addEventListener("keydown", onKeyDown, true);
  }

  function onPointerStart(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    startPoint = { x: event.clientX, y: event.clientY };
    activeRect = null;
    renderSelection(startPoint.x, startPoint.y, 0, 0);
  }

  function onPointerMove(event) {
    if (!startPoint) return;
    event.preventDefault();

    const x1 = Math.min(startPoint.x, event.clientX);
    const y1 = Math.min(startPoint.y, event.clientY);
    const x2 = Math.max(startPoint.x, event.clientX);
    const y2 = Math.max(startPoint.y, event.clientY);
    const left = clamp(x1, 0, window.innerWidth);
    const top = clamp(y1, 0, window.innerHeight);
    const right = clamp(x2, 0, window.innerWidth);
    const bottom = clamp(y2, 0, window.innerHeight);

    activeRect = {
      left,
      top,
      width: right - left,
      height: bottom - top
    };

    renderSelection(activeRect.left, activeRect.top, activeRect.width, activeRect.height);
  }

  async function onPointerEnd(event) {
    if (!startPoint) return;
    event.preventDefault();
    startPoint = null;

    if (!activeRect || activeRect.width < 12 || activeRect.height < 12) {
      setTip("框选区域太小，请重新选择二维码区域");
      return;
    }

    const rect = activeRect;
    activeRect = null;
    await scanRect(rect);
  }

  function onKeyDown(event) {
    if (event.key === "Escape") cleanup();
  }

  async function scanRect(rect) {
    try {
      setTip("正在截图并本地识别...");
      hideSelection();
      cleanup();
      await waitForPaint();

      const capture = await chrome.runtime.sendMessage({ type: "QR_SCANNER_CAPTURE" });
      if (!capture?.ok) throw new Error(capture?.error || "截图失败");

      const canvas = await cropScreenshot(capture.dataUrl, rect);
      const result = await decodeQr(canvas);
      const historyInfo = result ? await recordScanHistory(result) : null;
      const ocrOptions = await getOcrOptions();
      showResult(result || "", result ? "识别成功" : "没有在所选区域识别到二维码", historyInfo, {
        canvas,
        options: ocrOptions,
        autoRun: shouldAutoRunOcr(rect, result, ocrOptions)
      });
    } catch (error) {
      cleanup();
      showResult("", error?.message || "识别失败");
    }
  }

  async function cropScreenshot(dataUrl, rect) {
    const image = await loadImage(dataUrl);
    const scaleX = image.naturalWidth / window.innerWidth;
    const scaleY = image.naturalHeight / window.innerHeight;
    const padding = 16;

    const sx = Math.max(0, Math.floor((rect.left - padding) * scaleX));
    const sy = Math.max(0, Math.floor((rect.top - padding) * scaleY));
    const sw = Math.min(image.naturalWidth - sx, Math.ceil((rect.width + padding * 2) * scaleX));
    const sh = Math.min(image.naturalHeight - sy, Math.ceil((rect.height + padding * 2) * scaleY));

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, sw);
    canvas.height = Math.max(1, sh);

    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  async function decodeQr(canvas) {
    const nativeResult = await decodeWithBarcodeDetector(canvas);
    if (nativeResult) return nativeResult;

    const jsQrResult = decodeWithJsQr(canvas);
    if (jsQrResult) return jsQrResult;

    for (const variant of createDecodeVariants(canvas)) {
      const variantResult = decodeWithJsQr(variant);
      if (variantResult) return variantResult;
    }

    return "";
  }

  async function decodeWithBarcodeDetector(canvas) {
    if (!("BarcodeDetector" in window)) return "";

    try {
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      const detections = await detector.detect(canvas);
      return detections?.[0]?.rawValue || "";
    } catch {
      return "";
    }
  }

  function decodeWithJsQr(canvas) {
    if (typeof self.jsQR !== "function") {
      throw new Error("本地 jsQR 解码库未加载，请重新加载扩展后再试");
    }

    const context = canvas.getContext("2d", { willReadFrequently: true });
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const result = self.jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: "attemptBoth"
    });

    return result?.data || "";
  }

  function createDecodeVariants(canvas) {
    const variants = [
      createPaddedScaledCanvas(canvas, 2, 24),
      createPaddedScaledCanvas(canvas, 3, 32),
      createContrastCanvas(canvas, 2, 24),
      createColorDistanceBinaryCanvas(canvas, 2, 24, 34),
      createColorDistanceBinaryCanvas(canvas, 3, 32, 28),
      createLumaThresholdCanvas(canvas, 2, 24, 238)
    ];

    return variants.filter(Boolean);
  }

  function createPaddedScaledCanvas(source, scale, quietZone) {
    const target = document.createElement("canvas");
    target.width = Math.max(1, Math.round(source.width * scale + quietZone * 2));
    target.height = Math.max(1, Math.round(source.height * scale + quietZone * 2));

    const context = target.getContext("2d", { willReadFrequently: true });
    context.imageSmoothingEnabled = false;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, target.width, target.height);
    context.drawImage(source, quietZone, quietZone, source.width * scale, source.height * scale);
    return target;
  }

  function createContrastCanvas(source, scale, quietZone) {
    const target = createPaddedScaledCanvas(source, scale, quietZone);
    const context = target.getContext("2d", { willReadFrequently: true });
    const imageData = context.getImageData(0, 0, target.width, target.height);
    const data = imageData.data;
    let min = 255;
    let max = 0;

    for (let index = 0; index < data.length; index += 4) {
      const luma = getLuma(data[index], data[index + 1], data[index + 2]);
      min = Math.min(min, luma);
      max = Math.max(max, luma);
    }

    const range = Math.max(1, max - min);
    for (let index = 0; index < data.length; index += 4) {
      const luma = Math.round(((getLuma(data[index], data[index + 1], data[index + 2]) - min) / range) * 255);
      data[index] = luma;
      data[index + 1] = luma;
      data[index + 2] = luma;
      data[index + 3] = 255;
    }

    context.putImageData(imageData, 0, 0);
    return target;
  }

  function createColorDistanceBinaryCanvas(source, scale, quietZone, threshold) {
    const target = createPaddedScaledCanvas(source, scale, quietZone);
    const context = target.getContext("2d", { willReadFrequently: true });
    const imageData = context.getImageData(0, 0, target.width, target.height);
    const data = imageData.data;
    const background = sampleBorderColor(imageData);

    for (let index = 0; index < data.length; index += 4) {
      const distance = getColorDistance(
        data[index],
        data[index + 1],
        data[index + 2],
        background.r,
        background.g,
        background.b
      );
      const value = distance > threshold ? 0 : 255;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
    }

    context.putImageData(imageData, 0, 0);
    return target;
  }

  function createLumaThresholdCanvas(source, scale, quietZone, threshold) {
    const target = createPaddedScaledCanvas(source, scale, quietZone);
    const context = target.getContext("2d", { willReadFrequently: true });
    const imageData = context.getImageData(0, 0, target.width, target.height);
    const data = imageData.data;

    for (let index = 0; index < data.length; index += 4) {
      const luma = getLuma(data[index], data[index + 1], data[index + 2]);
      const value = luma < threshold ? 0 : 255;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
    }

    context.putImageData(imageData, 0, 0);
    return target;
  }

  function sampleBorderColor(imageData) {
    const { width, height, data } = imageData;
    let totalR = 0;
    let totalG = 0;
    let totalB = 0;
    let count = 0;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (x > 1 && y > 1 && x < width - 2 && y < height - 2) continue;
        const index = (y * width + x) * 4;
        totalR += data[index];
        totalG += data[index + 1];
        totalB += data[index + 2];
        count += 1;
      }
    }

    return {
      r: Math.round(totalR / count) || 255,
      g: Math.round(totalG / count) || 255,
      b: Math.round(totalB / count) || 255
    };
  }

  function getLuma(r, g, b) {
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  function getColorDistance(r1, g1, b1, r2, g2, b2) {
    const r = r1 - r2;
    const g = g1 - g2;
    const b = b1 - b2;
    return Math.sqrt(r * r + g * g + b * b);
  }

  async function recordScanHistory(value) {
    try {
      const history = await getStoredHistory();
      const now = Date.now();
      const existingIndex = history.findIndex((record) => record.value === value);
      let historyInfo = null;

      if (existingIndex >= 0) {
        const existing = history[existingIndex];
        const updated = {
          value,
          firstSeenAt: existing.firstSeenAt || now,
          lastSeenAt: now,
          count: (existing.count || 1) + 1
        };

        history.splice(existingIndex, 1);
        history.unshift(updated);
        historyInfo = {
          isRepeat: true,
          previousLastSeenAt: existing.lastSeenAt || existing.firstSeenAt || now,
          totalCount: updated.count,
          limit: HISTORY_LIMIT
        };
      } else {
        history.unshift({
          value,
          firstSeenAt: now,
          lastSeenAt: now,
          count: 1
        });
        historyInfo = {
          isRepeat: false,
          totalCount: 1,
          limit: HISTORY_LIMIT
        };
      }

      await setStoredHistory(history.slice(0, HISTORY_LIMIT));
      return historyInfo;
    } catch {
      return { unavailable: true };
    }
  }

  function getStoredHistory() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get({ [HISTORY_STORAGE_KEY]: [] }, (items) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }

        const history = Array.isArray(items[HISTORY_STORAGE_KEY]) ? items[HISTORY_STORAGE_KEY] : [];
        resolve(history.filter((record) => record && typeof record.value === "string"));
      });
    });
  }

  function setStoredHistory(history) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: history }, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }

        resolve();
      });
    });
  }

  function getOcrOptions() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ [OCR_OPTIONS_KEY]: DEFAULT_OCR_OPTIONS }, (items) => {
        if (chrome.runtime.lastError) {
          resolve(DEFAULT_OCR_OPTIONS);
          return;
        }

        resolve({ ...DEFAULT_OCR_OPTIONS, ...items[OCR_OPTIONS_KEY] });
      });
    });
  }

  function shouldAutoRunOcr(rect, qrResult, options) {
    if (!options?.enabled || !options.apiKey) return false;
    if (options.triggerMode !== "wide-selection") return false;
    if (!rect?.height) return false;

    const ratio = rect.width / rect.height;
    return ratio >= 1.8 && !qrResult;
  }

  async function runCloudOcr(canvas, options) {
    if (!options?.enabled) throw new Error("请先在 OCR 配置页启用在线 OCR");
    if (!options.apiKey) throw new Error("请先在 OCR 配置页填写 API Key");

    const base64Image = await createOcrImage(canvas);
    const response = await chrome.runtime.sendMessage({
      type: "QR_SCANNER_OCR_SPACE_PARSE",
      payload: {
        apiKey: options.apiKey,
        base64Image,
        engine: options.engine,
        language: options.language
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "OCR 请求失败");
    }

    return extractUrlsFromOcrText(response.result?.text || "");
  }

  async function createOcrImage(source) {
    const maxScaleBySize = Math.min(OCR_MAX_UPSCALE, OCR_MAX_IMAGE_SIDE / Math.max(source.width, source.height));
    const minHeightScale = Math.max(1, OCR_MIN_IMAGE_HEIGHT / Math.max(1, source.height));
    const scale = Math.max(0.1, Math.min(maxScaleBySize, minHeightScale));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));

    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    enhanceOcrImage(canvas);

    for (const quality of [0.82, 0.72, 0.62, 0.52]) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      if (getDataUrlByteLength(dataUrl) <= 900 * 1024 || quality === 0.52) {
        return dataUrl;
      }
    }

    return canvas.toDataURL("image/jpeg", 0.52);
  }

  function enhanceOcrImage(canvas) {
    const context = canvas.getContext("2d");
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    for (let index = 0; index < data.length; index += 4) {
      const gray = (data[index] * 0.299) + (data[index + 1] * 0.587) + (data[index + 2] * 0.114);
      const contrasted = Math.max(0, Math.min(255, ((gray - 128) * 1.35) + 128));
      data[index] = contrasted;
      data[index + 1] = contrasted;
      data[index + 2] = contrasted;
    }

    context.putImageData(imageData, 0, 0);
  }

  function getDataUrlByteLength(dataUrl) {
    const commaIndex = dataUrl.indexOf(",");
    const base64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
    return Math.ceil((base64.length * 3) / 4);
  }

  function extractUrlsFromOcrText(text) {
    const normalized = normalizeOcrText(text);
    const matches = normalized.match(OCR_URL_PATTERN) || [];
    const urls = matches.map(cleanOcrUrl).filter(Boolean);
    return [...new Set(urls)];
  }

  function normalizeOcrText(text) {
    return text
      .replace(/[|｜]/g, "l")
      .replace(/[\\]/g, "/")
      .replace(/[：]/g, ":")
      .replace(/[／]/g, "/")
      .replace(/[．。]/g, ".")
      .replace(/[％]/g, "%")
      .replace(/\bhttps?\s*[:：]?\s*[\/／\\]\s*[\/／\\]/gi, (match) => match.toLowerCase().startsWith("https") ? "https://" : "http://")
      .replace(/\bhttps?\s*[\/／\\]\s*/gi, (match) => match.toLowerCase().startsWith("https") ? "https://" : "http://")
      .replace(/(?<=[A-Za-z0-9-])\s*\.\s*(?=[A-Za-z])/g, ".");
  }

  function cleanOcrUrl(value) {
    const cleaned = value
      .replace(/^[^a-z0-9]+/i, "")
      .replace(/[),.;，。；]+$/g, "")
      .replace(/^http:\//, "http://")
      .replace(/^https:\//, "https://");
    if (!cleaned) return "";
    const normalized = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;

    try {
      const url = new URL(normalized);
      if (!isLikelyDomain(url.hostname)) return "";
      return url.href;
    } catch {
      return "";
    }
  }

  function isLikelyDomain(hostname) {
    const host = hostname.toLowerCase();
    const labels = host.split(".");
    if (labels.length < 2) return false;
    if (host.length < 4 || host.length > 253) return false;
    if (labels.some((label) => !label || label.length > 63)) return false;
    if (!/^[a-z]{2,24}$/.test(labels[labels.length - 1])) return false;
    if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return false;
    return true;
  }

  function showResult(value, title, historyInfo = null, ocrContext = null) {
    removeResultPanel();
    let primaryValue = value;
    let copyText = value;

    const panel = document.createElement("div");
    panel.className = "qr-scanner-panel";

    const header = document.createElement("div");
    header.className = "qr-scanner-panel-header";

    const heading = document.createElement("div");
    heading.className = "qr-scanner-panel-heading";

    const titleText = document.createElement("span");
    titleText.textContent = title;

    const countdown = document.createElement("span");
    countdown.className = "qr-scanner-countdown";

    heading.append(titleText, countdown);

    const close = document.createElement("button");
    close.className = "qr-scanner-panel-close";
    close.type = "button";
    close.title = "关闭";
    close.textContent = "x";
    close.addEventListener("click", removeResultPanel);
    header.append(heading, close);

    const body = document.createElement("div");
    body.className = "qr-scanner-panel-body";

    const result = document.createElement("div");
    result.className = "qr-scanner-result";
    result.textContent = value || "请扩大框选区域，或确认二维码清晰可见。";

    const ocrStatus = document.createElement("div");
    ocrStatus.className = "qr-scanner-ocr-status";
    ocrStatus.hidden = true;

    const history = document.createElement("div");
    history.className = "qr-scanner-history";
    history.textContent = formatHistoryMessage(historyInfo);
    history.hidden = !value || !history.textContent;

    const actions = document.createElement("div");
    actions.className = "qr-scanner-actions";

    const copy = document.createElement("button");
    copy.className = "qr-scanner-button";
    copy.type = "button";
    copy.textContent = "复制";
    copy.disabled = !value;
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(copyText);
      copy.textContent = "已复制";
      setTimeout(() => {
        copy.textContent = "复制";
      }, 1200);
    });

    const open = document.createElement("button");
    open.className = "qr-scanner-button qr-scanner-button-primary";
    open.type = "button";
    open.textContent = "打开链接";
    open.disabled = !isHttpUrl(value);
    open.addEventListener("click", () => window.open(primaryValue, "_blank", "noopener,noreferrer"));

    const ocr = document.createElement("button");
    ocr.className = "qr-scanner-button";
    ocr.type = "button";
    ocr.textContent = "在线 OCR";
    ocr.hidden = !ocrContext?.options?.enabled;
    ocr.disabled = !ocrContext?.options?.apiKey;
    ocr.title = ocr.disabled && ocrContext?.options?.enabled ? "请先在 OCR 配置页填写 API Key" : "上传框选区域并识别图片文字中的链接";
    ocr.addEventListener("click", async () => {
      clearResultPanelTimer();
      countdown.textContent = "OCR 识别中...";
      ocr.disabled = true;
      ocrStatus.hidden = false;
      ocrStatus.textContent = "正在调用在线 OCR...";
      ocrStatus.classList.remove("qr-scanner-ocr-status-error");

      try {
        const urls = await runCloudOcr(ocrContext.canvas, ocrContext.options);
        if (!urls.length) {
          ocrStatus.textContent = "OCR 已完成，但没有提取到链接";
          return;
        }

        const ocrText = `OCR 链接：\n${urls.join("\n")}`;
        result.textContent = value ? `${value}\n\n${ocrText}` : ocrText;
        primaryValue = isHttpUrl(value) ? value : urls[0];
        copyText = value ? `${value}\n${urls.join("\n")}` : urls.join("\n");
        const ocrHistoryValue = urls.find((url) => !isSameRecognizedValue(url, value));
        if (ocrHistoryValue) {
          const ocrHistoryInfo = await recordScanHistory(ocrHistoryValue);
          history.textContent = formatHistoryMessage(ocrHistoryInfo);
          history.hidden = false;
        }
        copy.disabled = false;
        open.disabled = !isHttpUrl(primaryValue);
        ocrStatus.textContent = `OCR 已识别 ${urls.length} 个链接`;
      } catch (error) {
        ocrStatus.textContent = error?.message || "在线 OCR 失败";
        ocrStatus.classList.add("qr-scanner-ocr-status-error");
        ocr.disabled = false;
      } finally {
        startResultCountdown(panel, countdown);
      }
    });

    actions.append(ocr, copy, open);
    body.append(result, ocrStatus, history, actions);
    panel.append(header, body);
    document.documentElement.appendChild(panel);
    startResultCountdown(panel, countdown);

    if (ocrContext?.autoRun && !ocr.disabled) {
      window.setTimeout(() => ocr.click(), 0);
    }
  }

  function formatHistoryMessage(historyInfo) {
    if (!historyInfo) return "";
    if (historyInfo.unavailable) return "历史记录暂不可用，本次识别结果未保存";
    if (!historyInfo.isRepeat) return `首次识别该内容，已保存到本地历史（最多 ${historyInfo.limit} 条）`;

    return `已识别过，上次：${formatLocalDateTime(historyInfo.previousLastSeenAt)}，累计 ${historyInfo.totalCount} 次`;
  }

  function formatLocalDateTime(timestamp) {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date(timestamp));
  }

  function renderSelection(left, top, width, height) {
    if (!selection) return;
    selection.style.display = "block";
    selection.style.left = `${left}px`;
    selection.style.top = `${top}px`;
    selection.style.width = `${width}px`;
    selection.style.height = `${height}px`;
  }

  function hideSelection() {
    if (selection) selection.style.display = "none";
  }

  function setTip(text) {
    if (tip) tip.textContent = text;
  }

  function cleanup() {
    overlay?.remove();
    overlay = null;
    selection = null;
    tip = null;
    startPoint = null;
    activeRect = null;
    window.removeEventListener("keydown", onKeyDown, true);
  }

  function removeResultPanel() {
    clearResultPanelTimer();
    document.querySelector(".qr-scanner-panel")?.remove();
  }

  function startResultCountdown(panel, countdown) {
    let secondsLeft = RESULT_AUTO_CLOSE_SECONDS;
    renderResultCountdown(countdown, secondsLeft);

    resultPanelTimer = window.setInterval(() => {
      if (!panel.isConnected) {
        clearResultPanelTimer();
        return;
      }

      secondsLeft -= 1;
      renderResultCountdown(countdown, secondsLeft);

      if (secondsLeft <= 0) {
        removeResultPanel();
      }
    }, 1000);
  }

  function renderResultCountdown(countdown, secondsLeft) {
    countdown.textContent = `${secondsLeft}s 后自动关闭`;
  }

  function clearResultPanelTimer() {
    if (!resultPanelTimer) return;
    window.clearInterval(resultPanelTimer);
    resultPanelTimer = null;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("截图图片加载失败"));
      image.src = src;
    });
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function isHttpUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  function isSameRecognizedValue(left, right) {
    if (left === right) return true;
    if (!left || !right) return false;

    try {
      const leftUrl = new URL(left);
      const rightUrl = new URL(right);
      return leftUrl.href === rightUrl.href;
    } catch {
      return false;
    }
  }

  function waitForPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }
})();
