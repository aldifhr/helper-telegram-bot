import { describe, expect, it } from "vitest";
import { removeCommas } from "../src/processor";

describe("removeCommas", () => {
  it("removes commas from coordinates while preserving decimals and minus", () => {
    expect(removeCommas("-7.123456, 109.123456")).toBe("-7.123456 109.123456");
  });

  it("removes every comma between city names", () => {
    expect(removeCommas("Jakarta, Bandung, Surabaya")).toBe("Jakarta Bandung Surabaya");
  });

  it("preserves periods, spaces, and text around commas", () => {
    expect(removeCommas("Jl. Sudirman No. 12, Cilacap, Jawa Tengah")).toBe(
      "Jl. Sudirman No. 12 Cilacap Jawa Tengah",
    );
  });

  it("keeps emoji and non-ASCII characters untouched", () => {
    expect(removeCommas("Halo, dunia! 👋🏽, apa kabar?")).toBe("Halo dunia! 👋🏽 apa kabar?");
  });

  it("only removes ASCII commas", () => {
    expect(removeCommas("a，b,c")).toBe("a，bc");
  });

  it("returns an empty string when the text only contains commas", () => {
    expect(removeCommas(",,,")).toBe("");
  });

  it("returns the original text when there are no commas", () => {
    const text = "Tidak ada koma di sini. 100% aman!";
    expect(removeCommas(text)).toBe(text);
  });
});
