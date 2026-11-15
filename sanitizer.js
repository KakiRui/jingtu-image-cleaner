(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.Jingtu = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  const JPEG_APP_MARKERS = new Set([0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed, 0xee, 0xef]);
  const JPEG_STANDALONE_MARKERS = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9]);
  const PNG_RENDERING_CHUNKS = new Set([
    "tRNS",
    "sRGB",
    "gAMA",
    "cHRM",
    "iCCP",
    "cICP",
    "acTL",
    "fcTL",
    "fdAT"
  ]);
  const WEBP_RENDERING_CHUNKS = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF", "ICCP"]);

  function startsWith(bytes, signature, offset) {
    const start = offset || 0;
    if (bytes.length < start + signature.length) return false;
    for (let i = 0; i < signature.length; i += 1) {
      if (bytes[start + i] !== signature[i]) return false;
    }
    return true;
  }

  function bytesAscii(bytes, start, end) {
    let value = "";
    const stop = Math.min(end, bytes.length);
    for (let i = start; i < stop; i += 1) {
      value += String.fromCharCode(bytes[i]);
    }
    return value;
  }

  function readUint16BE(bytes, offset) {
    return (bytes[offset] << 8) | bytes[offset + 1];
  }

  function readUint32BE(bytes, offset) {
    return (
      bytes[offset] * 0x1000000 +
      (bytes[offset + 1] << 16) +
      (bytes[offset + 2] << 8) +
      bytes[offset + 3]
    );
  }

  function readUint32LE(bytes, offset) {
    return (
      bytes[offset] +
      bytes[offset + 1] * 0x100 +
      bytes[offset + 2] * 0x10000 +
      bytes[offset + 3] * 0x1000000
    );
  }

  function writeUint32LE(target, offset, value) {
    target[offset] = value & 0xff;
    target[offset + 1] = (value >>> 8) & 0xff;
    target[offset + 2] = (value >>> 16) & 0xff;
    target[offset + 3] = (value >>> 24) & 0xff;
  }

  function asciiBytes(value) {
    const bytes = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i += 1) bytes[i] = value.charCodeAt(i) & 0xff;
    return bytes;
  }

  function detectFormat(input) {
    if (startsWith(input, [0xff, 0xd8, 0xff])) return "jpeg";
    if (startsWith(input, PNG_SIGNATURE)) return "png";
    if (startsWith(input, [0x52, 0x49, 0x46, 0x46]) && bytesAscii(input, 8, 12) === "WEBP") {
      return "webp";
    }
    return null;
  }

  function buildResult(format, parts, removedSet, removedCount, sourceName, extra) {
    const outputMime = format === "jpeg" ? "image/jpeg" : format === "png" ? "image/png" : "image/webp";
    const extension = format === "jpeg" ? "jpg" : format;
    const cleanName = makeCleanName(sourceName, extension);
    const blob = new Blob(parts, { type: outputMime });
    return Object.assign(
      {
        blob,
        mime: outputMime,
        extension,
        format: format.toUpperCase(),
        name: cleanName,
        byteLength: blob.size,
        removed: Array.from(removedSet),
        removedCount
      },
      extra || {}
    );
  }

  function makeCleanName(name, extension) {
    const raw = (name || "image").replace(/\\/g, "/").split("/").pop();
    const dot = raw.lastIndexOf(".");
    let base = dot > 0 ? raw.slice(0, dot) : raw;
    base = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim() || "image";
    if (!/-clean$/i.test(base)) base += "-clean";
    return base + "." + extension;
  }

  async function sanitize(file) {
    if (!file || typeof file.arrayBuffer !== "function") {
      throw new Error("无法读取这个文件。");
    }
    const input = new Uint8Array(await file.arrayBuffer());
    return sanitizeBytes(input, file.name, file.type);
  }

  function sanitizeBytes(input, sourceName, sourceType) {
    const format = detectFormat(input);
    if (format === "jpeg") return sanitizeJpeg(input, sourceName, sourceType);
    if (format === "png") return sanitizePng(input, sourceName, sourceType);
    if (format === "webp") return sanitizeWebp(input, sourceName, sourceType);
    const error = new Error("目前仅支持 JPG、PNG 与 WebP 图片。请先将图片导出为这些格式。");
    error.code = "UNSUPPORTED_FORMAT";
    throw error;
  }

  function createRemovalTracker() {
    const labels = new Set();
    let count = 0;
    return {
      add(label) {
        labels.add(label);
        count += 1;
      },
      get labels() {
        return labels;
      },
      get count() {
        return count;
      }
    };
  }

  function jpegAppLabel(marker, input, payloadStart, payloadEnd) {
    if (marker === 0xfe) return "JPEG 注释";
    if (marker === 0xe1) {
      if (bytesAscii(input, payloadStart, Math.min(payloadStart + 6, payloadEnd)) === "Exif\0\0") {
        return "EXIF";
      }
      const head = bytesAscii(input, payloadStart, Math.min(payloadStart + 40, payloadEnd));
      if (head.includes("http://ns.adobe.com/xap/") || head.includes("http://ns.adobe.com/xmp/")) {
        return "XMP";
      }
      return "JPEG APP1 扩展参数";
    }
    if (marker === 0xed) return "IPTC / Photoshop";
    if (marker === 0xeb) return "C2PA / JUMBF";
    if (marker >= 0xe1 && marker <= 0xef) return "JPEG APP" + (marker - 0xe0) + " 扩展参数";
    return "JPEG 元数据";
  }

  function isEssentialJpegApp(marker, input, payloadStart, payloadEnd) {
    if (marker === 0xe0) return true;
    if (marker === 0xe2) {
      return bytesAscii(input, payloadStart, Math.min(payloadStart + 12, payloadEnd)).startsWith("ICC_PROFILE");
    }
    if (marker === 0xee) return true;
    return false;
  }

  function findJpegScanEnd(input, start) {
    let pos = start;
    while (pos < input.length - 1) {
      const markerStart = input.indexOf(0xff, pos);
      if (markerStart === -1 || markerStart >= input.length - 1) {
        throw new Error("JPEG 缺少结束标记，无法确认清理完整。");
      }
      const next = input[markerStart + 1];
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        pos = markerStart + 2;
        continue;
      }
      return markerStart;
    }
    throw new Error("JPEG 缺少结束标记，无法确认清理完整。");
  }

  function sanitizeJpeg(input, sourceName, sourceType) {
    if (input.length < 4) throw new Error("JPEG 文件不完整。");
    const removal = createRemovalTracker();
    const parts = [input.subarray(0, 2)];
    let pos = 2;

    while (pos < input.length) {
      if (input[pos] !== 0xff) {
        throw new Error("JPEG 文件结构异常，无法安全处理。");
      }
      const markerStart = pos;
      while (pos < input.length && input[pos] === 0xff) pos += 1;
      if (pos >= input.length) throw new Error("JPEG 文件不完整。");
      const marker = input[pos];
      pos += 1;

      if (marker === 0xd9) {
        if (pos < input.length) {
          removal.add("文件尾部附加数据");
        }
        parts.push(input.subarray(markerStart, pos));
        break;
      }

      if (marker === 0xda) {
        if (pos + 2 > input.length) throw new Error("JPEG 扫描数据不完整。");
        const length = readUint16BE(input, pos);
        const scanHeaderEnd = pos + length;
        if (length < 2 || scanHeaderEnd > input.length) throw new Error("JPEG 扫描数据不完整。");
        parts.push(input.subarray(markerStart, scanHeaderEnd));
        const nextMarker = findJpegScanEnd(input, scanHeaderEnd);
        parts.push(input.subarray(scanHeaderEnd, nextMarker));
        pos = nextMarker;
        continue;
      }

      if (JPEG_STANDALONE_MARKERS.has(marker)) {
        parts.push(input.subarray(markerStart, pos));
        continue;
      }

      if (pos + 2 > input.length) throw new Error("JPEG 标记长度不完整。");
      const length = readUint16BE(input, pos);
      if (length < 2 || pos + length > input.length) {
        throw new Error("JPEG 文件结构异常，无法安全处理。");
      }
      const segmentEnd = pos + length;
      const payloadStart = pos + 2;

      if (marker === 0xfe || JPEG_APP_MARKERS.has(marker)) {
        if (!isEssentialJpegApp(marker, input, payloadStart, segmentEnd)) {
          removal.add(jpegAppLabel(marker, input, payloadStart, segmentEnd));
        } else {
          parts.push(input.subarray(markerStart, segmentEnd));
        }
      } else {
        parts.push(input.subarray(markerStart, segmentEnd));
      }
      pos = segmentEnd;
    }

    return buildResult("jpeg", parts, removal.labels, removal.count, sourceName);
  }

  function pngChunkLabel(type) {
    const names = {
      tEXt: "PNG 文本参数",
      zTXt: "PNG 压缩文本",
      iTXt: "PNG 国际文本",
      eXIf: "EXIF",
      caBX: "C2PA 内容凭证",
      tIME: "修改时间",
      pHYs: "物理尺寸信息",
      oFFs: "图像偏移信息",
      pCAL: "像素校准信息",
      sCAL: "比例信息",
      sPLT: "建议调色板",
      hIST: "直方图信息",
      bKGD: "背景色信息"
    };
    return names[type] || "PNG " + type + " 附加信息";
  }

  function sanitizePng(input, sourceName, sourceType) {
    if (!startsWith(input, PNG_SIGNATURE)) throw new Error("PNG 文件结构异常。");
    const removal = createRemovalTracker();
    const parts = [input.subarray(0, 8)];
    let pos = 8;
    let sawEnd = false;

    while (pos < input.length) {
      if (pos + 12 > input.length) throw new Error("PNG 数据块不完整。");
      const length = readUint32BE(input, pos);
      const chunkEnd = pos + 12 + length;
      if (chunkEnd > input.length) throw new Error("PNG 数据块长度异常。");
      const type = bytesAscii(input, pos + 4, pos + 8);
      const critical = (input[pos + 4] & 0x20) === 0;
      const keep = critical || PNG_RENDERING_CHUNKS.has(type);

      if (keep) {
        parts.push(input.subarray(pos, chunkEnd));
      } else {
        removal.add(pngChunkLabel(type));
      }

      pos = chunkEnd;
      if (type === "IEND") {
        sawEnd = true;
        if (pos < input.length) removal.add("文件尾部附加数据");
        break;
      }
    }

    if (!sawEnd) throw new Error("PNG 缺少结束标记，无法确认清理完整。");
    return buildResult("png", parts, removal.labels, removal.count, sourceName);
  }

  function webpChunkLabel(type) {
    if (type === "EXIF") return "EXIF";
    if (type === "XMP ") return "XMP";
    if (type === "META") return "WebP 元数据";
    return "WebP " + type.trim() + " 扩展块";
  }

  function sanitizeWebp(input, sourceName, sourceType) {
    if (input.length < 20) throw new Error("WebP 文件不完整。");
    const declaredEnd = readUint32LE(input, 4) + 8;
    if (declaredEnd < 20 || declaredEnd > input.length) throw new Error("WebP 文件长度异常。");

    const removal = createRemovalTracker();
    const keptChunks = [];
    let pos = 12;

    while (pos < declaredEnd) {
      if (pos + 8 > declaredEnd) throw new Error("WebP 数据块不完整。");
      const type = bytesAscii(input, pos, pos + 4);
      const size = readUint32LE(input, pos + 4);
      const dataEnd = pos + 8 + size;
      const chunkEnd = dataEnd + (size & 1);
      if (chunkEnd > declaredEnd) throw new Error("WebP 数据块长度异常。");

      if (WEBP_RENDERING_CHUNKS.has(type)) {
        if (type === "VP8X") {
          if (size < 10) throw new Error("WebP 扩展头不完整。");
          const data = new Uint8Array(input.subarray(pos + 8, dataEnd));
          data[0] &= ~0x08;
          data[0] &= ~0x04;
          keptChunks.push({
            type: asciiBytes(type),
            size,
            data
          });
        } else {
          keptChunks.push({
            type: asciiBytes(type),
            size,
            data: input.subarray(pos + 8, dataEnd)
          });
        }
      } else {
        removal.add(webpChunkLabel(type));
      }
      pos = chunkEnd;
    }

    let bodySize = 4;
    for (const chunk of keptChunks) {
      bodySize += 8 + chunk.size + (chunk.size & 1);
    }
    const header = new Uint8Array(12);
    header.set(asciiBytes("RIFF"), 0);
    writeUint32LE(header, 4, bodySize);
    header.set(asciiBytes("WEBP"), 8);
    const parts = [header];

    for (const chunk of keptChunks) {
      const chunkHeader = new Uint8Array(8);
      chunkHeader.set(chunk.type, 0);
      writeUint32LE(chunkHeader, 4, chunk.size);
      parts.push(chunkHeader, chunk.data);
      if (chunk.size & 1) parts.push(new Uint8Array(1));
    }

    return buildResult("webp", parts, removal.labels, removal.count, sourceName);
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      crc ^= bytes[i];
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    return {
      time: ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() & 63) >> 1),
      date: (((year - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31)
    };
  }

  function uniqueZipName(name, used) {
    const safe = (name || "image").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-");
    if (!used.has(safe)) {
      used.add(safe);
      return safe;
    }
    const dot = safe.lastIndexOf(".");
    const base = dot > 0 ? safe.slice(0, dot) : safe;
    const extension = dot > 0 ? safe.slice(dot) : "";
    let index = 2;
    let candidate = base + " (" + index + ")" + extension;
    while (used.has(candidate)) {
      index += 1;
      candidate = base + " (" + index + ")" + extension;
    }
    used.add(candidate);
    return candidate;
  }

  async function createZip(entries, onProgress) {
    if (!Array.isArray(entries) || entries.length === 0) throw new Error("没有可打包的图片。");
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    const usedNames = new Set();
    let localOffset = 0;
    let centralSize = 0;
    const now = dosDateTime(new Date());

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const name = uniqueZipName(entry.name, usedNames);
      const nameBytes = encoder.encode(name);
      const bytes = new Uint8Array(await entry.blob.arrayBuffer());
      const crc = crc32(bytes);

      const local = new Uint8Array(30 + nameBytes.length);
      writeUint32LE(local, 0, 0x04034b50);
      local[4] = 20;
      local[5] = 0;
      local[6] = 0x08;
      local[7] = 0x08;
      local[8] = now.time & 0xff;
      local[9] = (now.time >>> 8) & 0xff;
      local[10] = now.date & 0xff;
      local[11] = (now.date >>> 8) & 0xff;
      writeUint32LE(local, 14, crc);
      writeUint32LE(local, 18, bytes.length);
      writeUint32LE(local, 22, bytes.length);
      local[26] = nameBytes.length & 0xff;
      local[27] = (nameBytes.length >>> 8) & 0xff;
      local.set(nameBytes, 30);

      const central = new Uint8Array(46 + nameBytes.length);
      writeUint32LE(central, 0, 0x02014b50);
      central[4] = 20;
      central[5] = 0;
      central[6] = 20;
      central[7] = 0;
      central[8] = 0x08;
      central[9] = 0x08;
      central[10] = now.time & 0xff;
      central[11] = (now.time >>> 8) & 0xff;
      central[12] = now.date & 0xff;
      central[13] = (now.date >>> 8) & 0xff;
      writeUint32LE(central, 16, crc);
      writeUint32LE(central, 20, bytes.length);
      writeUint32LE(central, 24, bytes.length);
      central[28] = nameBytes.length & 0xff;
      central[29] = (nameBytes.length >>> 8) & 0xff;
      writeUint32LE(central, 42, localOffset);
      central.set(nameBytes, 46);

      localParts.push(local, bytes);
      centralParts.push(central);
      localOffset += local.length + bytes.length;
      centralSize += central.length;
      if (onProgress) onProgress(index + 1, entries.length);
    }

    const end = new Uint8Array(22);
    writeUint32LE(end, 0, 0x06054b50);
    end[8] = entries.length & 0xff;
    end[9] = (entries.length >>> 8) & 0xff;
    end[10] = entries.length & 0xff;
    end[11] = (entries.length >>> 8) & 0xff;
    writeUint32LE(end, 12, centralSize);
    writeUint32LE(end, 16, localOffset);

    if (localOffset + centralSize > 0xffffffff) {
      throw new Error("图片总大小超过 4GB，请分批处理。");
    }
    return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  return {
    sanitize,
    sanitizeBytes,
    createZip,
    formatBytes,
    detectFormat,
    makeCleanName
  };
});
