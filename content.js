(() => {
  const CONTENT_VERSION = "0.3.0";
  const RESULT_AUTO_CLOSE_SECONDS = 10;

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
      showResult(result || "", result ? "识别成功" : "没有在所选区域识别到二维码");
    } catch (error) {
      cleanup();
      showResult("", error?.message || "识别失败");
    }
  }

  async function cropScreenshot(dataUrl, rect) {
    const image = await loadImage(dataUrl);
    const scaleX = image.naturalWidth / window.innerWidth;
    const scaleY = image.naturalHeight / window.innerHeight;
    const padding = 8;

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

  function showResult(value, title) {
    removeResultPanel();

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

    const actions = document.createElement("div");
    actions.className = "qr-scanner-actions";

    const copy = document.createElement("button");
    copy.className = "qr-scanner-button";
    copy.type = "button";
    copy.textContent = "复制";
    copy.disabled = !value;
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(value);
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
    open.addEventListener("click", () => window.open(value, "_blank", "noopener,noreferrer"));

    actions.append(copy, open);
    body.append(result, actions);
    panel.append(header, body);
    document.documentElement.appendChild(panel);
    startResultCountdown(panel, countdown);
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

  function waitForPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }
})();
