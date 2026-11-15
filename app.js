(function () {
  "use strict";

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
    heroUploadButton: document.getElementById("heroUploadButton"),
    openSaveGuide: document.getElementById("openSaveGuide"),
    footerGuide: document.getElementById("footerGuide"),
    saveGuide: document.getElementById("saveGuide"),
    closeGuide: document.getElementById("closeGuide"),
    guideDone: document.getElementById("guideDone"),
    toast: document.getElementById("toast"),
    tool: document.getElementById("tool")
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
    return "img-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function acceptedByExtension(file) {
    return /\.(jpe?g|png|webp)$/i.test(file.name || "");
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
        error: null
      };
      if (!file.size) {
        item.status = "error";
        item.error = "文件为空，无法读取。";
      } else if (!file.type.startsWith("image/") && !acceptedByExtension(file)) {
        item.status = "error";
        item.error = "这个文件不是支持的图片格式。";
      }
      state.items.push(item);
    }

    elements.fileInput.value = "";
    render();
    if (wasEmpty) {
      window.setTimeout(() => {
        elements.workspace.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 80);
    }
    processQueue();
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
          const result = await window.Jingtu.sanitize(item.file);
          if (generation !== state.generation) break;
          item.result = result;
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
        const ready = state.items.filter((item) => item.status === "ready").length;
        const errors = state.items.filter((item) => item.status === "error").length;
        if (ready > 0) {
          showToast(errors ? ready + " 张处理完成，" + errors + " 张失败" : ready + " 张图片已经净化完成");
        }
      }
    }
  }

  function getReadyItems() {
    return state.items.filter((item) => item.status === "ready" && item.result);
  }

  function removedDescription(item) {
    const result = item.result;
    if (!result || result.removedCount === 0) return "未发现附加参数，已生成干净副本";
    return "已移除 " + result.removedCount + " 项嵌入信息";
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
        '<div class="thumb"><div class="card-error"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v6M12 17h.01"></path></svg><p>' +
        escapeHtml(item.error) +
        "</p></div></div>" +
        removeButton +
        '<div class="result-body"><div class="status-line"><span class="status-badge error">无法处理</span><span class="result-size">' +
        window.Jingtu.formatBytes(item.file.size) +
        "</span></div><h3>" +
        safeName +
        '</h3><p class="removed-copy">支持 JPG、PNG、WebP；请换一个文件后再试。</p></div></article>'
      );
    }

    if (item.status === "queued" || item.status === "processing") {
      return (
        '<article class="result-card" data-id="' +
        item.id +
        '">' +
        '<div class="thumb"><div class="thumb-placeholder"><span></span></div></div>' +
        removeButton +
        '<div class="result-body"><div class="status-line"><span class="status-badge processing">' +
        (item.status === "processing" ? "正在净化" : "等待处理") +
        '</span><span class="result-size">' +
        window.Jingtu.formatBytes(item.file.size) +
        "</span></div><h3>" +
        safeName +
        '</h3><p class="removed-copy">正在读取并重写图片容器…</p><div class="removed-tags"><span>本机处理中</span></div></div></article>'
      );
    }

    const result = item.result;
    const tags = result.removed.slice(0, 3);
    return (
      '<article class="result-card" data-id="' +
      item.id +
      '">' +
      '<div class="thumb"><img alt="已净化的 ' +
      safeName +
      '" src="' +
      item.previewUrl +
      '"></div>' +
      removeButton +
      '<div class="result-body"><div class="status-line"><span class="status-badge">已净化</span><span class="result-size">' +
      window.Jingtu.formatBytes(result.byteLength) +
      "</span></div><h3>" +
      safeName +
      '</h3><p class="removed-copy"><strong>' +
      removedDescription(item) +
      "</strong> · " +
      result.format +
      ' · 原画质</p><div class="removed-tags">' +
      (tags.length
        ? tags.map((tag) => "<span>" + escapeHtml(tag) + "</span>").join("")
        : "<span>无可移除参数</span>") +
      '</div><div class="card-actions"><button type="button" data-action="share-one" data-id="' +
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
    elements.resultGrid.innerHTML = state.items.map(renderCard).join("");

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

  function makeFile(item) {
    return new File([item.result.blob], item.result.name, {
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

  async function shareFiles(files) {
    if (!navigator.share) {
      openGuide();
      showToast("当前浏览器不支持直接分享，请使用 ZIP 下载");
      return;
    }
    if (navigator.canShare && !navigator.canShare({ files })) {
      openGuide();
      showToast("当前浏览器无法一次分享多张，请使用 ZIP 下载");
      return;
    }
    try {
      await navigator.share({
        files,
        title: "净图 · 已清除参数"
      });
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
    const items = getReadyItems();
    if (!items.length) return;
    if (state.items.some((item) => item.status === "processing" || item.status === "queued")) {
      showToast("请等待图片处理完成");
      return;
    }
    await shareFiles(items.map(makeFile));
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
      const entries = items.map((item) => ({ name: item.result.name, blob: item.result.blob }));
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
  elements.heroUploadButton.addEventListener("click", () => {
    elements.tool.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => elements.fileInput.click(), 350);
  });
  elements.clearButton.addEventListener("click", clearAll);
  elements.resultGrid.addEventListener("click", handleCardClick);
  elements.shareButton.addEventListener("click", shareAll);
  elements.downloadZipButton.addEventListener("click", downloadAll);

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
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }

  render();
})();
