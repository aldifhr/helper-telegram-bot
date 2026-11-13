import { describe, expect, it } from "vitest";
import {
  parseCoordinatePair,
  removeCommas,
  removeLeadingZeroFromPhoneNumber,
} from "../src/processor";

describe("parseCoordinatePair", () => {
  it("extracts latitude and longitude strings separately", () => {
    expect(parseCoordinatePair("-7.3449461 108.7079663")).toEqual({
      latitude: "-7.3449461",
      longitude: "108.7079663",
    });
  });

  it("rejects text that is not a valid coordinate pair", () => {
    expect(parseCoordinatePair("Jakarta Bandung")).toBeUndefined();
    expect(parseCoordinatePair("91 108")).toBeUndefined();
  });
});

describe("removeLeadingZeroFromPhoneNumber", () => {
  it("removes the leading zero from a standalone Indonesian phone number", () => {
    expect(removeLeadingZeroFromPhoneNumber("082218718161")).toBe("82218718161");
  });

  it("removes spaces and hyphens between digits", () => {
    expect(removeLeadingZeroFromPhoneNumber("0822-1871 8161")).toBe("82218718161");
  });

  it("ignores text that is not a standalone Indonesian phone number", () => {
    expect(removeLeadingZeroFromPhoneNumber("Nomor saya 082218718161")).toBeUndefined();
    expect(removeLeadingZeroFromPhoneNumber("62218718161")).toBeUndefined();
    expect(removeLeadingZeroFromPhoneNumber("08123")).toBeUndefined();
  });
});

describe("removeCommas", () => {
  it("removes commas from coordinates while preserving decimals and minus", () => {
    expect(removeCommas("-7.123456, 109.123456")).toBe("-7.123456 109.123456");
  });

  it("converts decimal commas in a comma-separated coordinate pair", () => {
    expect(removeCommas("-7,3449461, 108,7079663")).toBe("-7.3449461 108.7079663");
  });

  it("converts decimal commas in a space-separated coordinate pair", () => {
    expect(removeCommas(" -7,3449461  108,7079663 ")).toBe(" -7.3449461 108.7079663 ");
  });

  it("converts decimal commas in a labeled coordinate pair but removes other commas", () => {
    expect(removeCommas("Lokasi: -7,3449461, 108,7079663")).toBe(
      "Lokasi: -7.3449461 108.7079663",
    );
    expect(removeCommas("Jakarta, Bandung")).toBe("Jakarta Bandung");
    expect(removeCommas("Jalan 5,2, 30,5")).toBe("Jalan 52 305");
  });

  it("removes ordinary commas from an address without changing other characters", () => {
    expect(
      removeCommas("Nangkapeusar, Limbangan, Wanareja, Cilacap Regency, Central Java 53232"),
    ).toBe("Nangkapeusar Limbangan Wanareja Cilacap Regency Central Java 53232");
  });

  it("keeps the existing comma-removal behavior for non-coordinate numbers", () => {
    expect(removeCommas("123,45, 67,89")).toBe("12345 6789");
  });

  it("removes every comma between city names", () => {
    expect(removeCommas("Jakarta, Bandung, Surabaya")).toBe("Jakarta Bandung Surabaya");
  });

  it("removes periods and commas from an address", () => {
    expect(removeCommas("Jl. Sudirman No. 12, Cilacap, Jawa Tengah")).toBe(
      "Jl Sudirman No 12 Cilacap Jawa Tengah",
    );
    expect(removeCommas("Jl.Melati No.5, Kec. Wanareja.")).toBe("Jl Melati No 5 Kec Wanareja");
  });

  it("keeps decimal points in numbers", () => {
    expect(removeCommas("-7.123456, 109.123456")).toBe("-7.123456 109.123456");
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

  it("returns the original text when there are no commas or periods", () => {
    const text = "Tidak ada koma atau titik di sini 100% aman!";
    expect(removeCommas(text)).toBe(text);
  });
});
