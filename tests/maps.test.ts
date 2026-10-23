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
  it("removes commas from Maps address and shows coordinates", () => {
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
    expect(text).toContain(CLEAN_ADDRESS);
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
  it("extracts coordinates from short-link redirect metadata and skips page HTML", async () => {
    const fetchMock = stubFetch((url) => {
      if (url === SHORT_URL) {
        return new Response(null, { status: 302, headers: { location: FINAL_URL } });
      }
      throw new Error(`Unexpected fetch host: ${new URL(url).hostname}`);
    });
    const diagnostics = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const resolution = await resolveMapsLink(SHORT_URL);

    expect(resolution).toEqual({
      status: "ok",
      result: {
        name: "Pondok Pesantren Al Anshor",
        coordinates: { latitude: -7.2810178, longitude: 108.7039185 },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const diagnostic = JSON.parse(String(diagnostics.mock.calls[0][1])) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({
      stage: "maps_short_link_redirect",
      hostname: "maps.app.goo.gl",
      status: 302,
      redirectHostname: "www.google.com",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("bqwmTtGrR9AvJGHm9");
  });

  it("fetches page data only when the redirect does not expose coordinates", async () => {
    const pageUrl = "https://www.google.com/maps/place/Pondok+Pesantren+Al+Anshor";
    const fetchMock = stubFetch((url) => {
      if (url === SHORT_URL) {
        return new Response(null, { status: 302, headers: { location: pageUrl } });
      }
      if (url === pageUrl) {
        return new Response(
          '<html><head><link rel="preload" href="/maps/preview/place?authuser=0&amp;hl=id&amp;pb=abc"></head></html>',
        );
      }
      if (url.startsWith("https://www.google.com/maps/preview/place?")) {
        return new Response(previewPayload(), {
          headers: { "content-type": "application/json; charset=UTF-8" },
        });
      }
      throw new Error(`Unexpected fetch host: ${new URL(url).hostname}`);
    });

    const resolution = await resolveMapsLink(SHORT_URL);

    expect(resolution.status).toBe("ok");
    if (resolution.status === "ok") {
      expect(resolution.result).toEqual({
        name: "Pondok Pesantren Al Anshor",
        address: CLEAN_ADDRESS,
        coordinates: { latitude: -7.2810178, longitude: 108.7039185 },
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports HTTP 429 from maps.app.goo.gl without retrying", async () => {
    const fetchMock = stubFetch(() =>
      new Response("rate limited", {
        status: 429,
        headers: { "content-type": "text/plain", "retry-after": "60" },
      }),
    );
    const diagnostics = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const resolution = await resolveMapsLink(SHORT_URL);

    expect(resolution).toEqual({ status: "rate_limited" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(diagnostics.mock.calls[0][1]))).toMatchObject({
      stage: "maps_short_link_redirect",
      hostname: "maps.app.goo.gl",
      status: 429,
      contentType: "text/plain",
      retryAfter: "60",
    });
  });

  it("reports HTTP 429 from google.com/maps without retrying", async () => {
    const pageUrl = "https://www.google.com/maps/place/Pondok+Pesantren+Al+Anshor";
    const fetchMock = stubFetch((url) => {
      if (url === SHORT_URL) {
        return new Response(null, { status: 302, headers: { location: pageUrl } });
      }
      return new Response("rate limited", {
        status: 429,
        headers: { "content-type": "text/html", "retry-after": "120" },
      });
    });
    const diagnostics = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const resolution = await resolveMapsLink(SHORT_URL);

    expect(resolution).toEqual({ status: "rate_limited" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(diagnostics.mock.calls[1][1]))).toMatchObject({
      stage: "google_maps_redirect",
      hostname: "www.google.com",
      status: 429,
      contentType: "text/html",
      retryAfter: "120",
    });
  });

  it("returns unavailable and logs host when the short-link request fails", async () => {
    const fetchMock = stubFetch(() => {
      throw new Error("network down");
    });
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const resolution = await resolveMapsLink(SHORT_URL);

    expect(resolution).toEqual({ status: "unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(diagnostics.mock.calls[0][1]))).toMatchObject({
      stage: "maps_short_link_redirect",
      hostname: "maps.app.goo.gl",
      status: "network_error",
    });
  });

  it("does not fetch for malformed or unsupported URLs", async () => {
    const fetchMock = stubFetch(() => new Response("unexpected"));

    expect(await resolveMapsLink("not a URL")).toEqual({ status: "unavailable" });
    expect(await resolveMapsLink("https://example.com/maps/place/foo")).toEqual({
      status: "unavailable",
    });
    expect(await resolveMapsLink("http://maps.app.goo.gl/example")).toEqual({
      status: "unavailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns coordinates directly from a full Maps URL without a Places key", async () => {
    const fetchMock = stubFetch(() => new Response("unexpected"));

    expect(await resolveMapsLink(FINAL_URL)).toEqual({
      status: "ok",
      result: {
        name: "Pondok Pesantren Al Anshor",
        coordinates: { latitude: -7.2810178, longitude: 108.7039185 },
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses Places Text Search and selects the nearest address", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          places: [
            {
              id: "nearby-place",
              formattedAddress: ADDRESS,
              location: { latitude: -7.2811, longitude: 108.704 },
            },
            {
              id: "far-place",
              formattedAddress: "Wrong place",
              location: { latitude: -7.3, longitude: 108.75 },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const diagnostics = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const resolution = await resolveMapsLink(FINAL_URL, "test-places-key");

    expect(resolution.status).toBe("ok");
    if (resolution.status === "ok") {
      expect(resolution.result.address).toBe(CLEAN_ADDRESS);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(requestUrl).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("X-Goog-Api-Key")).toBe("test-places-key");
    expect(new Headers(init.headers).get("X-Goog-FieldMask")).toBe(
      "places.id,places.location,places.formattedAddress",
    );
    expect(JSON.parse(String(init.body)).textQuery).toBe("Pondok Pesantren Al Anshor");
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("test-places-key");
  });

  it("prefers the Places address over an unverified scraped page address", async () => {
    const pageUrl = "https://www.google.com/maps/place/Pondok+Pesantren+Al+Anshor";
    const correctAddress = "Jl. Sekolah, Wanareja, Kabupaten Cilacap, Jawa Tengah 53265";
    const fetchMock = stubFetch((url) => {
      if (url === SHORT_URL) {
        return new Response(null, { status: 302, headers: { location: pageUrl } });
      }
      if (url === pageUrl) {
        return new Response(
          '<link rel="preload" href="/maps/preview/place?hl=id&amp;pb=abc">',
        );
      }
      if (url.startsWith("https://www.google.com/maps/preview/place?")) {
        return new Response(previewPayload());
      }
      if (url === "https://places.googleapis.com/v1/places:searchText") {
        return new Response(
          JSON.stringify({
            places: [
              {
                formattedAddress: correctAddress,
                location: { latitude: -7.2810178, longitude: 108.7039185 },
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch host: ${new URL(url).hostname}`);
    });

    const resolution = await resolveMapsLink(SHORT_URL, "test-places-key");

    expect(resolution.status).toBe("ok");
    if (resolution.status === "ok") {
      expect(resolution.result.address).toBe("Jl. Sekolah Wanareja Kabupaten Cilacap Jawa Tengah 53265");
      expect(resolution.result.address).not.toBe(ADDRESS);
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not retry Places API HTTP 429 and keeps the resolved coordinates", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("rate limited", {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "30" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const diagnostics = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const resolution = await resolveMapsLink(FINAL_URL, "test-places-key");

    expect(resolution.status).toBe("rate_limited");
    if (resolution.status === "rate_limited") {
      expect(resolution.result?.coordinates).toEqual({
        latitude: -7.2810178,
        longitude: 108.7039185,
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(diagnostics.mock.calls[0][1]))).toMatchObject({
      stage: "google_places_text_search",
      hostname: "places.googleapis.com",
      status: 429,
      retryAfter: "30",
    });
  });

  it("does not return an invented address when Google provides no place data", async () => {
    const pageUrl = "https://www.google.com/maps/place/Pondok+Pesantren+Al+Anshor";
    stubFetch((url) => {
      if (url === SHORT_URL) {
        return new Response(null, { status: 302, headers: { location: pageUrl } });
      }
      if (url === pageUrl) {
        return new Response("<html>no preview data</html>");
      }
      throw new Error(`Unexpected fetch host: ${new URL(url).hostname}`);
    });

    expect(await resolveMapsLink(SHORT_URL)).toEqual({ status: "unavailable" });
  });
});
