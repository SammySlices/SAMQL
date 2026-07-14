import { describe, expect, it } from "vitest";
import { jpegBytesToPdf, safeDashboardPdfName } from "./dashboardPdf";

describe("dashboardPdf", () => {
  it("sanitizes PDF filenames", () => {
    expect(safeDashboardPdfName("My Dash")).toBe("My Dash.pdf");
    expect(safeDashboardPdfName("a/b\\c?.pdf")).toBe("a_b_c_.pdf");
    expect(safeDashboardPdfName("")).toBe("dashboard.pdf");
  });

  it("embeds a JPEG into a valid single-page PDF", () => {
    // Minimal JPEG SOI/EOI frame — PDF only stores bytes; viewers may warn
    // on decode, but the container structure must be well-formed.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const pdf = jpegBytesToPdf(jpeg, 200, 100, "Sales", 400, 200);
    const text = new TextDecoder().decode(pdf);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/Type /Catalog");
    expect(text).toContain("/MediaBox [0 0 200 100]");
    // Bitmap size must be the real JPEG pixels (DPR×), not the page box —
    // mismatched Width/Height is what stretched exports.
    expect(text).toContain("/Width 400 /Height 200");
    expect(text).toContain("/Filter /DCTDecode");
    expect(text).toContain("/Title (Sales)");
    expect(text).toContain("startxref");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    // JPEG payload intact
    const soi = pdf.indexOf(0xff);
    expect(pdf[soi]).toBe(0xff);
    expect(pdf[soi + 1]).toBe(0xd8);
  });
});
