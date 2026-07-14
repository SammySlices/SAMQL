// Dashboard → PDF for Downloads. Rasterize the board (canvas panes swapped to
// images), embed the JPEG in a single-page PDF, write via /api/save/download.
//
// Important: the JPEG may be devicePixelRatio× larger than the CSS layout.
// The PDF Image XObject must declare the *bitmap* size; the page MediaBox uses
// CSS pixels so aspect ratio matches the on-screen board.

import { saveToDownloads } from "./api";

const EXPORT_HIDE =
  ".dash-resize, .dash-header-resize, .dash-widget-actions, .dash-text-grab, .dash-add, button";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("Malformed image data.");
  const b64 = dataUrl.slice(comma + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Copy computed styles onto the clone so foreignObject paint matches the UI. */
function inlineComputedStyles(src: Element, dst: Element): void {
  if (!(src instanceof HTMLElement) || !(dst instanceof HTMLElement)) return;
  const cs = getComputedStyle(src);
  let css = "";
  for (let i = 0; i < cs.length; i++) {
    const prop = cs.item(i);
    if (!prop) continue;
    // Skip properties that fight pinned layout / cause foreignObject quirks.
    if (
      prop === "transform" ||
      prop === "translate" ||
      prop === "zoom" ||
      prop.startsWith("animation") ||
      prop.startsWith("transition")
    ) {
      continue;
    }
    css += `${prop}:${cs.getPropertyValue(prop)};`;
  }
  dst.setAttribute("style", css);
  const sChildren = src.children;
  const dChildren = dst.children;
  const n = Math.min(sChildren.length, dChildren.length);
  for (let i = 0; i < n; i++) {
    inlineComputedStyles(sChildren[i]!, dChildren[i]!);
  }
}

/**
 * Pin every widget to the exact on-screen box (px relative to the board).
 * Percentage/`calc()` widths remount differently inside SVG foreignObject and
 * were the main source of stretched / shifted layouts.
 */
function pinWidgetLayout(srcRoot: HTMLElement, dstRoot: HTMLElement): void {
  const root = srcRoot.getBoundingClientRect();
  const srcWidgets = srcRoot.querySelectorAll<HTMLElement>(".dash-widget");
  const dstWidgets = dstRoot.querySelectorAll<HTMLElement>(".dash-widget");
  srcWidgets.forEach((src, i) => {
    const dst = dstWidgets[i];
    if (!dst) return;
    const r = src.getBoundingClientRect();
    dst.style.position = "absolute";
    dst.style.left = `${Math.round(r.left - root.left)}px`;
    dst.style.top = `${Math.round(r.top - root.top)}px`;
    dst.style.width = `${Math.max(1, Math.round(r.width))}px`;
    dst.style.height = `${Math.max(1, Math.round(r.height))}px`;
    dst.style.right = "auto";
    dst.style.bottom = "auto";
    dst.style.margin = "0";
    dst.style.transform = "none";
  });
}

function syncFormValues(srcRoot: HTMLElement, dstRoot: HTMLElement): void {
  const srcFields = srcRoot.querySelectorAll("input, textarea, select");
  const dstFields = dstRoot.querySelectorAll("input, textarea, select");
  srcFields.forEach((src, i) => {
    const dst = dstFields[i];
    if (!dst) return;
    if (src instanceof HTMLInputElement && dst instanceof HTMLInputElement) {
      if (src.type === "checkbox" || src.type === "radio") {
        dst.checked = src.checked;
        if (src.checked) dst.setAttribute("checked", "checked");
        else dst.removeAttribute("checked");
      } else {
        dst.value = src.value;
        dst.setAttribute("value", src.value);
      }
    } else if (
      src instanceof HTMLTextAreaElement &&
      dst instanceof HTMLTextAreaElement
    ) {
      dst.value = src.value;
      dst.textContent = src.value;
    } else if (
      src instanceof HTMLSelectElement &&
      dst instanceof HTMLSelectElement
    ) {
      dst.value = src.value;
    }
  });
}

function replaceCanvasesWithImages(
  srcRoot: HTMLElement,
  dstRoot: HTMLElement,
): void {
  const srcCanvases = srcRoot.querySelectorAll("canvas");
  const dstCanvases = dstRoot.querySelectorAll("canvas");
  srcCanvases.forEach((src, i) => {
    const dst = dstCanvases[i];
    if (!dst || !dst.parentNode) return;
    try {
      const displayW = Math.max(1, Math.round(src.clientWidth || src.width));
      const displayH = Math.max(1, Math.round(src.clientHeight || src.height));
      const img = document.createElement("img");
      img.src = src.toDataURL("image/png");
      // Fill the on-screen box exactly — ECharts canvas buffers are often
      // devicePixelRatio× larger; contain would letterbox and look wrong.
      img.setAttribute(
        "style",
        `display:block;width:${displayW}px;height:${displayH}px;` +
          `max-width:none;max-height:none;object-fit:fill;`,
      );
      img.width = displayW;
      img.height = displayH;
      dst.parentNode.replaceChild(img, dst);
    } catch {
      /* tainted / empty canvas — leave blank */
    }
  });
}

function stripExportChrome(clone: HTMLElement): void {
  clone.querySelectorAll(EXPORT_HIDE).forEach((node) => node.remove());
  clone.classList.remove("selected");
  clone.querySelectorAll(".selected").forEach((node) => {
    node.classList.remove("selected");
  });
}

async function waitForImages(root: HTMLElement): Promise<void> {
  const imgs = Array.from(root.querySelectorAll("img"));
  await Promise.all(
    imgs.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete) {
            resolve();
            return;
          }
          img.onload = () => resolve();
          img.onerror = () => resolve();
        }),
    ),
  );
}

export type DashboardCapture = {
  dataUrl: string;
  /** CSS / on-screen size (PDF page). */
  width: number;
  height: number;
  /** Actual JPEG bitmap size (may be DPR × CSS). */
  pixelWidth: number;
  pixelHeight: number;
};

/**
 * Rasterize a DOM subtree to a JPEG data URL. Chart canvases are snapshotted
 * as images first so ECharts panes survive the SVG foreignObject pass.
 */
export async function captureElementToJpeg(
  el: HTMLElement,
  quality = 0.95,
): Promise<DashboardCapture> {
  const rect = el.getBoundingClientRect();
  const width = Math.max(
    1,
    Math.ceil(Math.max(el.scrollWidth, el.clientWidth, rect.width)),
  );
  const height = Math.max(
    1,
    Math.ceil(Math.max(el.scrollHeight, el.clientHeight, rect.height)),
  );
  const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));

  const clone = el.cloneNode(true) as HTMLElement;
  syncFormValues(el, clone);
  replaceCanvasesWithImages(el, clone);
  inlineComputedStyles(el, clone);
  pinWidgetLayout(el, clone);
  stripExportChrome(clone);

  clone.style.boxSizing = "border-box";
  clone.style.margin = "0";
  clone.style.padding = getComputedStyle(el).padding;
  clone.style.transform = "none";
  clone.style.position = "relative";
  clone.style.left = "0";
  clone.style.top = "0";
  clone.style.width = `${width}px`;
  clone.style.height = `${height}px`;
  clone.style.minWidth = `${width}px`;
  clone.style.minHeight = `${height}px`;
  clone.style.maxWidth = `${width}px`;
  clone.style.maxHeight = `${height}px`;
  clone.style.overflow = "hidden";

  // Host the clone off-screen so percentage leftovers and font metrics settle
  // before we serialize into SVG foreignObject.
  const host = document.createElement("div");
  host.setAttribute("data-dash-pdf-capture", "1");
  host.style.cssText =
    `position:fixed;left:-100000px;top:0;width:${width}px;height:${height}px;` +
    `overflow:hidden;pointer-events:none;opacity:0;z-index:-1;`;
  host.appendChild(clone);
  document.body.appendChild(host);
  try {
    await waitForImages(clone);

    const xhtml = new XMLSerializer().serializeToString(clone);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}">` +
      `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px;margin:0;padding:0;">` +
      `${xhtml}</div></foreignObject></svg>`;

    const svgUrl =
      "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () =>
        reject(new Error("Could not rasterize the dashboard for PDF export."));
      img.src = svgUrl;
    });

    const pixelWidth = Math.round(width * scale);
    const pixelHeight = Math.round(height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is unavailable for PDF export.");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#16181d";
    ctx.fillRect(0, 0, pixelWidth, pixelHeight);
    ctx.drawImage(img, 0, 0, pixelWidth, pixelHeight);

    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    return { dataUrl, width, height, pixelWidth, pixelHeight };
  } finally {
    host.remove();
  }
}

function pdfEscapeName(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * Build a one-page PDF that embeds a JPEG.
 * ``pageWidth`` / ``pageHeight`` are the MediaBox (CSS px ≈ pt).
 * ``imagePixelWidth`` / ``imagePixelHeight`` are the JPEG bitmap size — they
 * must match the file or viewers stretch the image (looks distorted).
 */
export function jpegBytesToPdf(
  jpeg: Uint8Array,
  pageWidth: number,
  pageHeight: number,
  title = "SamQL Dashboard",
  imagePixelWidth?: number,
  imagePixelHeight?: number,
): Uint8Array {
  const pageW = Math.max(1, Math.round(pageWidth));
  const pageH = Math.max(1, Math.round(pageHeight));
  const imgW = Math.max(1, Math.round(imagePixelWidth ?? pageW));
  const imgH = Math.max(1, Math.round(imagePixelHeight ?? pageH));
  const enc = new TextEncoder();
  // Draw the image into the full page box; PDF scales bitmap → page.
  const content = enc.encode(
    `q\n${pageW} 0 0 ${pageH} 0 0 cm\n/Im0 Do\nQ\n`,
  );

  const header =
    "%PDF-1.4\n" +
    `% SamQL dashboard export (${pdfEscapeName(title)})\n`;
  const imgHeader =
    `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} ` +
    `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
    `/Length ${jpeg.length} >>\nstream\n`;

  const parts: Uint8Array[] = [enc.encode(header)];
  const offsets: number[] = [0];
  let pos = parts[0]!.length;

  const add = (bytes: Uint8Array) => {
    parts.push(bytes);
    pos += bytes.length;
  };

  offsets.push(pos);
  add(enc.encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"));

  offsets.push(pos);
  add(enc.encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"));

  offsets.push(pos);
  add(
    enc.encode(
      "3 0 obj\n" +
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
        `/Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>\n` +
        "endobj\n",
    ),
  );

  offsets.push(pos);
  add(enc.encode(`4 0 obj\n<< /Length ${content.length} >>\nstream\n`));
  add(content);
  add(enc.encode("\nendstream\nendobj\n"));

  offsets.push(pos);
  add(enc.encode(imgHeader));
  add(jpeg);
  add(enc.encode("\nendstream\nendobj\n"));

  const xrefStart = pos;
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  xref +=
    `trailer\n<< /Size 6 /Root 1 0 R /Info << /Title (${pdfEscapeName(title)}) /Producer (SamQL) >> >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`;
  add(enc.encode(xref));

  return concatBytes(parts);
}

export function safeDashboardPdfName(base: string): string {
  const safe = base.replace(/[^\w.\- ]+/g, "_").trim() || "dashboard";
  return safe.toLowerCase().endsWith(".pdf") ? safe : `${safe}.pdf`;
}

export async function exportDashboardElementToPdf(
  el: HTMLElement,
  filename: string,
  title = "SamQL Dashboard",
): Promise<{ path: string; filename: string }> {
  const shot = await captureElementToJpeg(el);
  const jpeg = dataUrlToBytes(shot.dataUrl);
  const pdf = jpegBytesToPdf(
    jpeg,
    shot.width,
    shot.height,
    title,
    shot.pixelWidth,
    shot.pixelHeight,
  );
  const name = safeDashboardPdfName(filename);
  return saveToDownloads(name, { b64: bytesToBase64(pdf) });
}
