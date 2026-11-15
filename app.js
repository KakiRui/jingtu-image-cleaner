(function () {
  "use strict";

  const MAX_CANVAS_PIXELS = 24000000;
  const elements = {
    fileInput: document.getElementById("fileInput"),
    dropZone: document.getElementById("dropZone"),
    workspace: document.getElementById("workspace"),
    resultGrid: document.getElementById("resultGrid"),
    fileCount: document.getElementById("fileCount"),
    progressWrap: document.getElementById("progressWrap"),
    progressText: document.getElementById("progressText"),
    progressCount: document.getElementById("progressCount"),
    progressBar: document.getElementById("progressBar"),
    stickyActions: document.getElementById("stickyActions"),
    readyCount: document.getElementById("readyCount"),
    shareButton: document.getElementById("shareButton"),
    downloadZipButton: document.getElementById("downloadZipButton"),
    addMoreButton: document.getElementById("addMoreButton"),
    clearButton: document.getElementById("clearButton"),
    autoArrange: document.getElementById("autoArrange"),
    openSaveGuide: document.getElementById("openSaveGuide"),
    footerGuide: document.getElementById("footerGuide"),
    saveGuide: document.getElementById("saveGuide"),
    closeGuide: document.getElementById("closeGuide"),
    guideDone: document.getElementById("guideDone"),
    toast: document.getElementById("toast"),
    workspaceTitle: document.getElementById("workspaceTitle")
  };

  const state = {
    items: [],
    isProcessing: false,
    generation: 0,
    toastTimer: null,
    isZipping: false
  };

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function createId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "image-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function acceptedByExtension(file) {
    return /\.(jpe?g|jpe|jfif|png|webp)$/i.test(file.name || "");
  }

  function isJpeg(file) {
    return /^(image\/jpe?g|image\/pjpeg)$/i.test(file.type || "") || /\.(jpe?g|jpe|jfif)$/i.test(file.name || "");
  }

  function addRemoved(result, label, count) {
    if (!result.removed.includes(label)) result.removed.push(label);
    result.removedCount += count == null ? 1 : count;
  }

  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const wasEmpty = state.items.length === 0;
    for (const file of files) {
      const item = {
        id: createId(),
        file,
        status: "queued",
        result: null,
        previewUrl: null,
        error: null,
        width: 0,
        height: 0
      };
      if (!file.size) {
        item.status = "error";
        item.error = "文件为空，无法读取。";
      } else if (!file.type.startsWith("image/") && !acceptedByExtension(file)) {
        item.status = "error";
        item.error = "这不是支持的图片格式。";
      }
      state.items.push(item);
    }

    elements.fileInput.value = "";
    render();
    if (wasEmpty) {
      window.setTimeout(() => {
        elements.workspace.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 70);
    }
    processQueue();
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("浏览器无法生成处理后的图片。"));
      }, type, quality);
    });
  }

  function decodeWithImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        resolve({
          source: image,
          width: image.naturalWidth,
          height: image.naturalHeight,
          close() {
            URL.revokeObjectURL(url);
          }
        });
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("图片无法被浏览器解码。"));
      };
      image.src = url;
    });
  }

  async function decodeImage(blob) {
    if (typeof window.createImageBitmap === "function") {
      try {
        const bitmap = await window.createImageBitmap(blob, {
          imageOrientation: "from-image",
          premultiplyAlpha: "none",
          colorSpaceConversion: "none"
        });
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          close() {
            if (typeof bitmap.close === "function") bitmap.close();
          }
        };
      } catch (error) {
        try {
          const bitmap = await window.createImageBitmap(blob);
          return {
            source: bitmap,
            width: bitmap.width,
            height: bitmap.height,
            close() {
              if (typeof bitmap.close === "function") bitmap.close();
            }
          };
        } catch (fallbackError) {
          // Safari versions that lack the options or large-image support use <img>.
        }
      }
    }
    return decodeWithImage(blob);
  }

  async function transcodeForCompatibility(file, mime) {
    const decoded = await decodeWithImage(file);
    try {
      if (decoded.width * decoded.height > MAX_CANVAS_PIXELS) {
        throw new Error("图片尺寸过大，浏览器无法安全进行兼容重编码。请先缩小图片。");
      }
      const canvas = document.createElement("canvas");
      canvas.width = decoded.width;
      canvas.height = decoded.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("浏览器无法初始化图片画布。");
      if (mime === "image/jpeg") {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.drawImage(decoded.source, 0, 0);
      const quality = mime === "image/jpeg" || mime === "image/webp" ? 0.96 : undefined;
      const blob = await canvasToBlob(canvas, mime, quality);
      const extension = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
      return {
        blob,
        mime,
        extension,
        format: extension.toUpperCase(),
        name: window.Jingtu.makeCleanName(file.name, extension),
        byteLength: blob.size,
        removed: ["兼容模式重编码"],
        removedCount: 1,
        width: decoded.width,
        height: decoded.height,
        compatibility: true
      };
    } finally {
      decoded.close();
    }
  }

  async function scrubPngAlpha(decoded, result) {
    const width = decoded.width;
    const height = decoded.height;
    result.width = width;
    result.height = height;

    if (width * height > MAX_CANVAS_PIXELS) {
      throw new Error("这张 PNG 尺寸过大，无法完整检查 Alpha 隐写。请先缩小尺寸后再处理。");
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("浏览器无法初始化图片画布。");
    context.drawImage(decoded.source, 0, 0);

    let imageData;
    try {
      imageData = context.getImageData(0, 0, width, height);
    } catch (error) {
      throw new Error("浏览器内存不足，无法检查这张 PNG 的 Alpha 通道。");
    }

    const pixels = imageData.data;
    let normalizedAlpha = 0;
    let transparentPixels = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      const alpha = pixels[index];
      if (alpha >= 254) {
        if (alpha !== 255) {
          pixels[index] = 255;
          normalizedAlpha += 1;
        }
      } else {
        transparentPixels += 1;
      }
    }

    result.alphaVerified = true;
    result.transparentPixels = transparentPixels;
    if (normalizedAlpha === 0) return result;

    context.putImageData(imageData, 0, 0);
    const cleanBlob = await canvasToBlob(canvas, "image/png");
    result.blob = cleanBlob;
    result.byteLength = cleanBlob.size;
    result.alphaScrubbed = normalizedAlpha;
    addRemoved(result, "NovelAI Alpha 隐写");
    return result;
  }

  async function prepareImage(file) {
    let result;
    try {
      result = await window.Jingtu.sanitize(file);
    } catch (error) {
      if (isJpeg(file)) {
        result = await transcodeForCompatibility(file, "image/jpeg");
      } else {
        throw error;
      }
    }

    let decoded;
    try {
      decoded = await decodeImage(result.blob);
    } catch (error) {
      if (result.format === "JPEG" || result.format === "WEBP") {
        result = await transcodeForCompatibility(file, result.format === "JPEG" ? "image/jpeg" : "image/webp");
        return result;
      }
      throw new Error("净化后的 PNG 无法解码，原文件可能已经损坏。");
    }

    try {
      result.width = decoded.width;
      result.height = decoded.height;
      if (result.format === "PNG") {
        await scrubPngAlpha(decoded, result);
      }
      return result;
    } finally {
      decoded.close();
    }
  }

  async function processQueue() {
    if (state.isProcessing) return;
    state.isProcessing = true;
    render();
    const generation = state.generation;

    try {
      while (true) {
        const item = state.items.find((candidate) => candidate.status === "queued");
        if (!item || generation !== state.generation) break;
        item.status = "processing";
        render();
        await new Promise((resolve) => window.setTimeout(resolve, 16));
        if (generation !== state.generation) break;

        try {
          const result = await prepareImage(item.file);
          if (generation !== state.generation) break;
          item.result = result;
          item.width = result.width || 0;
          item.height = result.height || 0;
          item.previewUrl = URL.createObjectURL(result.blob);
          item.status = "ready";
        } catch (error) {
          item.status = "error";
          item.error = error && error.message ? error.message : "处理失败，请重试。";
        }
        render();
      }
    } finally {
      if (generation === state.generation) {
        state.isProcessing = false;
        render();
        const ready = getReadyItems().length;
        const errors = state.items.filter((item) => item.status === "error").length;
        if (ready > 0) {
          showToast(errors ? ready + " 张处理完成，" + errors + " 张失败" : ready + " 张图片已完成深度净化");
        }
      }
    }
  }

  function getReadyItems() {
    return state.items.filter((item) => item.status === "ready" && item.result);
  }

  function orientationOf(item) {
    if (!item.width || !item.height) return "unknown";
    const ratio = item.width / item.height;
    if (ratio < 0.92) return "portrait";
    if (ratio > 1.08) return "landscape";
    return "square";
  }

  function buildOrientationGroups(items) {
    const groups = [];
    for (const item of items) {
      const orientation = orientationOf(item);
      if (orientation === "unknown") continue;
      const ratio = item.width / item.height;
      let group = groups.find(
        (candidate) =>
          candidate.orientation === orientation &&
          Math.abs(Math.log(candidate.meanRatio / ratio)) <= 0.055
      );
      if (!group) {
        group = {
          orientation,
          items: [],
          meanRatio: ratio
        };
        groups.push(group);
      }
      group.items.push(item);
      group.meanRatio =
        group.items.reduce((sum, entry) => sum + entry.width / entry.height, 0) /
        group.items.length;
    }
    return groups;
  }

  function commonRatioLabel(group) {
    if (group.orientation === "square") return "方图";
    const targets =
      group.orientation === "portrait"
        ? [
            [1, 2],
            [9, 16],
            [2, 3],
            [3, 4],
            [4, 5]
          ]
        : [
            [2, 1],
            [16, 9],
            [3, 2],
            [4, 3],
            [5, 4]
          ];
    let best = null;
    for (const target of targets) {
      const ratio = target[0] / target[1];
      const difference = Math.abs(Math.log(group.meanRatio / ratio));
      if (!best || difference < best.difference) best = { target, difference };
    }
    const orientationName = group.orientation === "portrait" ? "竖图" : "横图";
    if (best && best.difference <= 0.05) {
      return orientationName + " · " + best.target[0] + ":" + best.target[1];
    }
    return orientationName + " · 相近比例";
  }

  function getOrderedOutputItems() {
    const ready = getReadyItems();
    if (!elements.autoArrange.checked) {
      return ready.map((item) => ({ item, name: item.result.name }));
    }

    const groups = buildOrientationGroups(ready);
    const ordered = [];
    const included = new Set();
    groups.forEach((group, groupIndex) => {
      const groupNumber = String(groupIndex + 1).padStart(2, "0");
      const orientationName =
        group.orientation === "portrait" ? "竖图" : group.orientation === "landscape" ? "横图" : "方图";
      group.items.forEach((item, itemIndex) => {
        const itemNumber = String(itemIndex + 1).padStart(2, "0");
        ordered.push({
          item,
          name: groupNumber + "-" + orientationName + "-" + itemNumber + "_" + item.result.name
        });
        included.add(item.id);
      });
    });

    for (const item of ready) {
      if (!included.has(item.id)) ordered.push({ item, name: item.result.name });
    }
    return ordered;
  }

  function groupSymbol(orientation) {
    if (orientation === "portrait") {
      return '<svg viewBox="0 0 16 16"><rect x="4.5" y="2" width="7" height="12" rx="1"/></svg>';
    }
    if (orientation === "landscape") {
      return '<svg viewBox="0 0 16 16"><rect x="2" y="4.5" width="12" height="7" rx="1"/></svg>';
    }
    return '<svg viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx="1"/></svg>';
  }

  function renderGroup(group, index) {
    const sameSize = group.items.every(
      (item) => item.width === group.items[0].width && item.height === group.items[0].height
    );
    const sizeLabel = sameSize
      ? group.items[0].width + " × " + group.items[0].height
      : "比例相近 · 保留原尺寸";
    return (
      '<section class="result-group" data-group="' +
      index +
      '">' +
      '<div class="group-heading">' +
      '<span class="group-symbol ' +
      group.orientation +
      '">' +
      groupSymbol(group.orientation) +
      "</span>" +
      "<h3>" +
      escapeHtml(commonRatioLabel(group)) +
      "</h3>" +
      '<span class="group-count">' +
      group.items.length +
      " 张</span>" +
      '<span class="group-size">' +
      escapeHtml(sizeLabel) +
      "</span>" +
      "</div>" +
      '<div class="result-grid">' +
      group.items.map(renderCard).join("") +
      "</div></section>"
    );
  }

  function renderStatusGroup(items, title, symbol) {
    if (!items.length) return "";
    return (
      '<section class="result-group">' +
      '<div class="group-heading"><span class="group-symbol">' +
      symbol +
      "</span><h3>" +
      title +
      '</h3><span class="group-count">' +
      items.length +
      " 张</span></div>" +
      '<div class="result-grid">' +
      items.map(renderCard).join("") +
      "</div></section>"
    );
  }

  function renderResults() {
    const ready = getReadyItems();
    const pending = state.items.filter((item) => item.status === "queued" || item.status === "processing");
    const errors = state.items.filter((item) => item.status === "error");

    if (!elements.autoArrange.checked) {
      return state.items.map(renderCard).join("");
    }

    const groups = buildOrientationGroups(ready);
    let html = groups.map(renderGroup).join("");
    html += renderStatusGroup(
      pending,
      "正在处理",
      '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>'
    );
    html += renderStatusGroup(
      errors,
      "未能处理",
      '<svg viewBox="0 0 16 16"><path d="M8 4v5M8 12h.01"/></svg>'
    );
    return html;
  }

  function removalText(item) {
    const result = item.result;
    if (!result) return "";
    if (result.removedCount > 0) return "清除了 " + result.removedCount + " 项嵌入信息";
    if (result.alphaVerified) return "文件与 Alpha 通道均已检查";
    return "已生成干净副本";
  }

  function resultPrivacyTag(item) {
    const result = item.result;
    if (!result) return "";
    if (result.warning) return '<span class="privacy-tag warn">兼容模式已重编码</span>';
    if (result.alphaScrubbed) {
      return '<span class="privacy-tag">Alpha 隐写已移除</span>';
    }
    if (result.alphaVerified) {
      return '<span class="privacy-tag">Alpha 通道已验证</span>';
    }
    return '<span class="privacy-tag">文件参数已移除</span>';
  }

  function renderCard(item) {
    const safeName = escapeHtml(item.file.name || "未命名图片");
    const removeButton =
      '<button class="card-remove" type="button" data-action="remove" data-id="' +
      item.id +
      '" aria-label="移除这张图片">×</button>';

    if (item.status === "error") {
      return (
        '<article class="result-card" data-id="' +
        item.id +
        '">' +
        '<div class="thumb card-loading"><div class="card-error"><strong>无法处理</strong><br>' +
        escapeHtml(item.error) +
        "</div></div>" +
        removeButton +
        '<div class="result-body"><div class="status-line"><span class="status-badge error">处理失败</span><span class="result-size">' +
        window.Jingtu.formatBytes(item.file.size) +
        "</span></div><h4>" +
        safeName +
        '</h4><p class="result-meta">请尝试换用 JPG 或 PNG 重新导出。</p></div></article>'
      );
    }

    if (item.status === "queued" || item.status === "processing") {
      return (
        '<article class="result-card" data-id="' +
        item.id +
        '">' +
        '<div class="thumb card-loading"><span></span></div>' +
        removeButton +
        '<div class="result-body"><div class="status-line"><span class="status-badge processing">' +
        (item.status === "processing" ? "正在深清" : "等待处理") +
        '</span><span class="result-size">' +
        window.Jingtu.formatBytes(item.file.size) +
        "</span></div><h4>" +
        safeName +
        '</h4><p class="result-meta">检查文件结构与 Alpha 通道…</p></div></article>'
      );
    }

    const result = item.result;
    return (
      '<article class="result-card" data-id="' +
      item.id +
      '">' +
      '<div class="thumb"><img loading="lazy" alt="已净化的 ' +
      safeName +
      '" src="' +
      item.previewUrl +
      '"></div>' +
      removeButton +
      '<div class="result-body"><div class="status-line"><span class="status-badge">已完成</span><span class="result-size">' +
      window.Jingtu.formatBytes(result.byteLength) +
      "</span></div><h4>" +
      safeName +
      '</h4><p class="result-meta"><strong>' +
      removalText(item) +
      "</strong><br>" +
      item.width +
      " × " +
      item.height +
      " · " +
      result.format +
      "</p>" +
      resultPrivacyTag(item) +
      '<div class="card-actions"><button type="button" data-action="share-one" data-id="' +
      item.id +
      '">保存这张</button><button type="button" data-action="download-one" data-id="' +
      item.id +
      '">下载</button></div></div></article>'
    );
  }

  function render() {
    const total = state.items.length;
    const ready = getReadyItems().length;
    const completed = state.items.filter((item) => item.status === "ready" || item.status === "error").length;
    const active = state.items.find((item) => item.status === "processing");
    const hasPending = state.items.some((item) => item.status === "processing" || item.status === "queued");

    elements.workspace.hidden = total === 0;
    elements.fileCount.textContent = String(total);
    elements.resultGrid.innerHTML = renderResults();

    elements.progressWrap.hidden = !hasPending;
    if (hasPending) {
      elements.progressText.textContent = active ? "正在净化 " + active.file.name : "准备处理…";
      elements.progressCount.textContent = completed + " / " + total;
      elements.progressBar.style.width = total ? (completed / total) * 100 + "%" : "0%";
    }

    elements.stickyActions.hidden = ready === 0;
    elements.readyCount.textContent = String(ready);
    elements.shareButton.disabled = ready === 0 || hasPending || state.isZipping;
    elements.downloadZipButton.disabled = ready === 0 || state.isZipping;
  }

  function clearObjectUrl(item) {
    if (item.previewUrl) {
      URL.revokeObjectURL(item.previewUrl);
      item.previewUrl = null;
    }
  }

  function removeItem(id) {
    const index = state.items.findIndex((item) => item.id === id);
    if (index === -1) return;
    clearObjectUrl(state.items[index]);
    state.items.splice(index, 1);
    render();
  }

  function clearAll() {
    state.generation += 1;
    for (const item of state.items) clearObjectUrl(item);
    state.items = [];
    state.isProcessing = false;
    render();
    showToast("已清空当前列表");
  }

  function makeFile(item, name) {
    return new File([item.result.blob], name || item.result.name, {
      type: item.result.mime,
      lastModified: Date.now()
    });
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function downloadOne(id) {
    const item = state.items.find((candidate) => candidate.id === id);
    if (!item || !item.result) return;
    triggerDownload(item.result.blob, item.result.name);
    showToast("已开始下载干净图片");
  }

  function openGuide() {
    if (typeof elements.saveGuide.showModal === "function") {
      if (!elements.saveGuide.open) elements.saveGuide.showModal();
    } else {
      elements.saveGuide.setAttribute("open", "");
    }
  }

  function closeGuide() {
    if (typeof elements.saveGuide.close === "function" && elements.saveGuide.open) {
      elements.saveGuide.close();
    } else {
      elements.saveGuide.removeAttribute("open");
    }
  }

  async function shareFiles(files) {
    if (!navigator.share) {
      openGuide();
      showToast("当前浏览器不支持直接分享，请使用 ZIP 下载");
      return;
    }
    if (navigator.canShare && !navigator.canShare({ files })) {
      openGuide();
      showToast("无法一次分享这些图片，请使用 ZIP 下载");
      return;
    }
    try {
      await navigator.share({ files, title: "净图 · 已深度净化" });
      showToast("已打开系统分享面板");
    } catch (error) {
      if (error && error.name === "AbortError") return;
      openGuide();
      showToast("分享没有完成，可改用 ZIP 下载");
    }
  }

  async function shareOne(id) {
    const item = state.items.find((candidate) => candidate.id === id);
    if (!item || !item.result) return;
    await shareFiles([makeFile(item)]);
  }

  async function shareAll() {
    const ready = getReadyItems();
    if (!ready.length) return;
    if (state.items.some((item) => item.status === "processing" || item.status === "queued")) {
      showToast("请等待图片处理完成");
      return;
    }
    await shareFiles(getOrderedOutputItems().map((entry) => makeFile(entry.item, entry.name)));
  }

  function zipFilename() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return (
      "jingtu-clean-" +
      now.getFullYear() +
      pad(now.getMonth() + 1) +
      pad(now.getDate()) +
      "-" +
      pad(now.getHours()) +
      pad(now.getMinutes()) +
      ".zip"
    );
  }

  async function downloadAll() {
    const items = getReadyItems();
    if (!items.length || state.isZipping) return;
    if (items.length === 1) {
      downloadOne(items[0].id);
      return;
    }

    state.isZipping = true;
    render();
    const originalText = elements.downloadZipButton.innerHTML;
    try {
      const entries = getOrderedOutputItems().map((entry) => ({
        name: entry.name,
        blob: entry.item.result.blob
      }));
      const zip = await window.Jingtu.createZip(entries, (done, total) => {
        elements.downloadZipButton.textContent = "打包中 " + done + "/" + total;
      });
      triggerDownload(zip, zipFilename());
      showToast(items.length + " 张图片已打包为 ZIP");
    } catch (error) {
      showToast(error.message || "打包失败，请分批下载");
    } finally {
      state.isZipping = false;
      elements.downloadZipButton.innerHTML = originalText;
      render();
    }
  }

  function showToast(message) {
    window.clearTimeout(state.toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add("show");
    state.toastTimer = window.setTimeout(() => elements.toast.classList.remove("show"), 2800);
  }

  function handleCardClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const id = button.dataset.id;
    if (action === "remove") removeItem(id);
    if (action === "download-one") downloadOne(id);
    if (action === "share-one") shareOne(id);
  }

  elements.fileInput.addEventListener("change", (event) => addFiles(event.target.files));
  elements.addMoreButton.addEventListener("click", () => elements.fileInput.click());
  elements.clearButton.addEventListener("click", clearAll);
  elements.resultGrid.addEventListener("click", handleCardClick);
  elements.shareButton.addEventListener("click", shareAll);
  elements.downloadZipButton.addEventListener("click", downloadAll);
  elements.autoArrange.addEventListener("change", render);

  elements.dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      elements.fileInput.click();
    }
  });

  for (const eventName of ["dragenter", "dragover"]) {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.add("dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.remove("dragging");
    });
  }
  elements.dropZone.addEventListener("drop", (event) => {
    if (event.dataTransfer && event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
  });

  document.addEventListener("paste", (event) => {
    const files = Array.from(event.clipboardData ? event.clipboardData.files : []).filter((file) =>
      file.type.startsWith("image/")
    );
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  });

  elements.openSaveGuide.addEventListener("click", openGuide);
  elements.footerGuide.addEventListener("click", openGuide);
  elements.closeGuide.addEventListener("click", closeGuide);
  elements.guideDone.addEventListener("click", closeGuide);
  elements.saveGuide.addEventListener("click", (event) => {
    const rect = elements.saveGuide.getBoundingClientRect();
    const outside =
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom;
    if (outside) closeGuide();
  });

  if ("serviceWorker" in navigator && /^https?:$/.test(window.location.protocol)) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js?v=6", { updateViaCache: "none" }).catch(() => {});
    });
  }

  render();
})();
