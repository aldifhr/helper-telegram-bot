import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractMapsUrl,
  extractPlaceName,
  formatMapsResult,
  parseCoordinates,
  parseMapsPreview,
  resolveMapsLink,
} from "../src/maps";

const SHORT_URL = "https://maps.app.goo.gl/bqwmTtGrR9AvJGHm9";
const FINAL_URL =
  "https://www.google.com/maps/place/Pondok+Pesantren+Al+Anshor/@-7.307264,108.7143936,9580m/data=!3m1!1e3!4m6!3m5!1s0x2e6f7b93b94bf461:0xdc7e1422a9740d9b!8m2!3d-7.2810178!4d108.7039185!16s%2Fg%2F11jcfz2sm9?entry=tts";
const ADDRESS =
  "Jl. Curug Bandung, Ciheuleut, Limbangan, Kec. Wanareja, Kabupaten Cilacap, Jawa Tengah 53232";
const CLEAN_ADDRESS =
  "Jl. Curug Bandung Ciheuleut Limbangan Kec. Wanareja Kabupaten Cilacap Jawa Tengah 53232";

function previewPayload(): string {
  const root: unknown[] = [];
  root[9] = [null, null, -7.2810178, 108.7039185];
  root[11] = "Pondok Pesantren Al Anshor";
  root[18] = `Pondok Pesantren Al Anshor, ${ADDRESS}`;
  root[39] = ADDRESS;

  return ")]}'\n" + JSON.stringify([null, null, null, null, null, null, root]);
}

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractMapsUrl", () => {
  it("finds a Google Maps short link inside text", () => {
    expect(extractMapsUrl(`Cek lokasi ini (${SHORT_URL}).`)).toBe(SHORT_URL);
  });

  it("finds a full Google Maps link", () => {
    expect(extractMapsUrl(`lihat ${FINAL_URL}`)).toBe(FINAL_URL);
  });

  it("ignores links that are not Google Maps", () => {
    expect(extractMapsUrl("https://example.com/maps/app.goo.gl/abc")).toBeNull();
    expect(extractMapsUrl("https://www.google.com/search?q=test")).toBeNull();
    expect(extractMapsUrl("Tidak ada link di sini")).toBeNull();
  });
});

describe("parseCoordinates", () => {
  it("prefers exact place coordinates over the viewport center", () => {
    expect(parseCoordinates(new URL(FINAL_URL))).toEqual({
      latitude: -7.2810178,
      longitude: 108.7039185,
    });
  });

  it("reads coordinates from an @ viewport", () => {
    expect(parseCoordinates(new URL("https://www.google.com/maps/@-6.2,106.8,15z"))).toEqual({
      latitude: -6.2,
      longitude: 106.8,
    });
  });

  it("reads coordinates from a q parameter", () => {
    expect(
      parseCoordinates(new URL("https://www.google.com/maps?q=loc:-7.25,108.7")),
    ).toEqual({ latitude: -7.25, longitude: 108.7 });
  });

  it("rejects out-of-range coordinates", () => {
    expect(parseCoordinates(new URL("https://www.google.com/maps/@95,200,15z"))).toBeUndefined();
  });
});

describe("extractPlaceName", () => {
  it("decodes the place name from the URL path", () => {
    expect(extractPlaceName(new URL(FINAL_URL))).toBe("Pondok Pesantren Al Anshor");
  });

  it("returns undefined when the URL has no place name", () => {
    expect(
      extractPlaceName(new URL("https://www.google.com/maps/@-6.2,106.8,15z")),
    ).toBeUndefined();
  });
});

describe("parseMapsPreview", () => {
  it("extracts the name, address, and coordinates", () => {
    expect(parseMapsPreview(previewPayload())).toEqual({
      name: "Pondok Pesantren Al Anshor",
      address: ADDRESS,
      coordinates: { latitude: -7.2810178, longitude: 108.7039185 },
    });
  });

  it("falls back to scanning arbitrary preview data", () => {
    const payload = ")]}'\n" + JSON.stringify([null, "Jl. Melati, Kota A, Provinsi B", [null, null, -6.2, 106.8]]);

    expect(parseMapsPreview(payload)).toEqual({
      address: "Jl. Melati, Kota A, Provinsi B",
      coordinates: { latitude: -6.2, longitude: 106.8 },
    });
  });

  it("returns null for invalid JSON", () => {
    expect(parseMapsPreview("not json")).toBeNull();
  });
});

describe("formatMapsResult", () => {
  it("removes commas and shows coordinates", () => {
    const text = formatMapsResult({
      name: "Pondok Pesantren Al Anshor",
      address: ADDRESS,
      coordinates: { latitude: -7.2810178, longitude: 108.7039185 },
    });

    expect(text).toBe(
      [
        "Nama: Pondok Pesantren Al Anshor",
        `Alamat: ${CLEAN_ADDRESS}`,
        "Latitude: -7.2810178",
        "Longitude: 108.7039185",
      ].join("\n"),
    );
    expect(text).not.toContain(",");
  });

  it("handles a missing address", () => {
    const text = formatMapsResult({
      coordinates: { latitude: -7.28, longitude: 108.7 },
    });

    expect(text).toContain("Alamat: Tidak tersedia");
  });
});

describe("resolveMapsLink", () => {
  it("resolves a short link and parses the place details", async () => {
    stubFetch((url) => {
      if (url === SHORT_URL) {
        return new Response(null, { status: 302, headers: { location: FINAL_URL } });
      }
      if (url === FINAL_URL) {
        return new Response(
          '<html><head><link rel="preload" href="/maps/preview/place?authuser=0&amp;hl=id&amp;pb=abc"></head></html>',
        );
      }
      if (url.startsWith("https://www.google.com/maps/preview/place?")) {
        return new Response(previewPayload());
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await resolveMapsLink(SHORT_URL);

    expect(result).toEqual({
      name: "Pondok Pesantren Al Anshor",
      address: CLEAN_ADDRESS,
      coordinates: { latitude: -7.2810178, longitude: 108.7039185 },
    });
  });

  it("keeps Google Maps place data as the only address source", async () => {
    const fetchMock = stubFetch((url) => {
      if (url === SHORT_URL) {
        return new Response(null, { status: 302, headers: { location: FINAL_URL } });
      }
      if (url === FINAL_URL) {
        return new Response("<html>no preview data</html>");
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await resolveMapsLink(SHORT_URL);

    expect(result?.name).toBe("Pondok Pesantren Al Anshor");
    expect(result?.address).toBeUndefined();
    expect(result?.coordinates).toEqual({ latitude: -7.2810178, longitude: 108.7039185 });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("openstreetmap"))).toBe(false);
  });

  it("keeps coordinates when Google blocks the place page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = stubFetch((url) => {
      if (url === SHORT_URL) {
        return new Response(null, { status: 302, headers: { location: FINAL_URL } });
      }
      if (url === FINAL_URL) {
        return new Response("blocked", { status: 403 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await resolveMapsLink(SHORT_URL);

    expect(result?.address).toBeUndefined();
    expect(result?.coordinates).toEqual({ latitude: -7.2810178, longitude: 108.7039185 });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("openstreetmap"))).toBe(false);
  });

  it("does not fetch unsupported URLs", async () => {
    const fetchMock = stubFetch(() => new Response("unexpected"));

    expect(await resolveMapsLink("https://example.com/maps/place/foo")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when the network request fails", async () => {
    stubFetch(() => {
      throw new Error("network down");
    });

    expect(await resolveMapsLink(SHORT_URL)).toBeNull();
  });
});
