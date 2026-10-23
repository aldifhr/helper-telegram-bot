import { removeCommas } from "./processor";

const FETCH_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 5;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const NOMINATIM_USER_AGENT = "telegram-comma-remover-bot/1.0";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[)\].,!?;:]+$/;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface MapsResult {
  name?: string;
  address?: string;
  addressApproximate?: boolean;
  coordinates: Coordinates;
}

interface PreviewData {
  name?: string;
  address?: string;
  coordinates?: Coordinates;
}

interface MapsPage {
  url: URL;
  html: string;
}

export function extractMapsUrl(text: string): string | null {
  for (const match of text.matchAll(URL_PATTERN)) {
    const candidate = match[0].replace(TRAILING_PUNCTUATION, "");
    try {
      if (isSupportedMapsUrl(new URL(candidate))) {
        return candidate;
      }
    } catch {
      continue;
    }
  }

  return null;
}

export async function resolveMapsLink(value: string): Promise<MapsResult | null> {
  let start: URL;
  try {
    start = new URL(value);
  } catch {
    return null;
  }

  if (!isSupportedMapsUrl(start)) {
    return null;
  }

  let stage = "Google Maps redirect";
  try {
    const page = await loadMapsPage(start);
    if (!page) {
      return null;
    }

    let coordinates = parseCoordinates(page.url);
    let name = extractPlaceName(page.url);
    let address: string | undefined;
    let addressApproximate = false;

    stage = "Google Maps place data";
    let preview: PreviewData | null = null;
    try {
      preview = await loadPreview(page.html);
    } catch (error) {
      console.error("Maps place data request failed:", errorName(error));
    }

    if (preview) {
      name = preview.name ?? name;
      address = preview.address;
      coordinates = coordinates ?? preview.coordinates;
    }

    if (!coordinates) {
      return null;
    }

    if (!address) {
      stage = "OpenStreetMap reverse geocoding";
      try {
        const fallback = await reverseGeocode(coordinates);
        if (fallback) {
          address = fallback;
          addressApproximate = true;
        }
      } catch (error) {
        console.error("Maps reverse geocoding failed:", errorName(error));
      }
    }

    return {
      name: name ? cleanText(name) : undefined,
      address: address ? cleanText(address) : undefined,
      addressApproximate: addressApproximate || undefined,
      coordinates,
    };
  } catch (error) {
    console.error("Maps lookup failed during", stage, errorName(error));
    return null;
  }
}

export function formatMapsResult(result: MapsResult): string {
  const lines: string[] = [];

  if (result.name) {
    lines.push(`Nama: ${cleanText(result.name)}`);
  }

  if (result.address) {
    const label = result.addressApproximate ? "Alamat (perkiraan OSM)" : "Alamat";
    lines.push(`${label}: ${cleanText(result.address)}`);
  } else {
    lines.push("Alamat: Tidak tersedia");
  }

  lines.push(`Latitude: ${result.coordinates.latitude}`);
  lines.push(`Longitude: ${result.coordinates.longitude}`);

  return lines.join("\n");
}

export function parseCoordinates(url: URL): Coordinates | undefined {
  let href = url.href;
  try {
    href = decodeURIComponent(href);
  } catch {
    href = url.href;
  }

  const patterns = [
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
    /[?&](?:q|ll|center|destination|query|daddr)=(?:loc:)?(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(href);
    if (match) {
      const coordinates = toCoordinates(Number(match[1]), Number(match[2]));
      if (coordinates) {
        return coordinates;
      }
    }
  }

  return undefined;
}

export function extractPlaceName(url: URL): string | undefined {
  const match = /^\/maps\/(?:place|search)\/([^/]+)/.exec(url.pathname);
  if (!match) {
    return undefined;
  }

  const raw = match[1].replaceAll("+", " ");
  try {
    return decodeURIComponent(raw).trim() || undefined;
  } catch {
    return raw.trim() || undefined;
  }
}

export function parseMapsPreview(payload: string, fallbackName?: string): PreviewData | null {
  let data: unknown;
  try {
    data = JSON.parse(payload.replace(/^\)\]\}'\s*/, ""));
  } catch {
    return null;
  }

  const root =
    Array.isArray(data) && Array.isArray(data[6]) ? (data[6] as unknown[]) : null;
  let name = fallbackName?.trim();
  let address: string | undefined;
  let coordinates: Coordinates | undefined;

  if (root) {
    if (typeof root[11] === "string" && root[11].trim()) {
      name = root[11].trim();
    }

    if (typeof root[39] === "string" && root[39].trim()) {
      address = root[39].trim();
    } else if (typeof root[18] === "string" && root[18].trim()) {
      address = stripPlaceName(root[18].trim(), name);
    }

    const pair = root[9];
    if (Array.isArray(pair)) {
      coordinates = toCoordinates(Number(pair[2]), Number(pair[3]));
    }
  }

  if (!address) {
    address = findAddress(data, name);
  }

  if (!coordinates) {
    coordinates = findCoordinates(data);
  }

  if (!name && !address && !coordinates) {
    return null;
  }

  return { name, address, coordinates };
}

function isSupportedMapsUrl(url: URL): boolean {
  if (!isGoogleHost(url.hostname)) {
    return false;
  }

  if (url.hostname === "goo.gl") {
    return url.pathname.startsWith("/maps");
  }

  if (url.hostname.endsWith(".goo.gl")) {
    return true;
  }

  return url.pathname.startsWith("/maps") || url.hostname.startsWith("maps.");
}

function isGoogleHost(hostname: string): boolean {
  const host = hostname.toLowerCase();

  return (
    host === "goo.gl" ||
    host.endsWith(".goo.gl") ||
    /^(?:www\.|maps\.)?google\.(?:[a-z]{2,3}|co\.[a-z]{2})$/.test(host)
  );
}

async function loadMapsPage(start: URL): Promise<MapsPage | null> {
  let current = start;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (!isGoogleHost(current.hostname)) {
      return null;
    }

    let response: Response;
    try {
      response = await fetch(current.toString(), {
        redirect: "manual",
        headers: {
          "user-agent": USER_AGENT,
          "accept-language": "id-ID,id;q=0.9,en;q=0.8",
          accept: "text/html,application/xhtml+xml",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      console.error("Google Maps page request failed:", errorName(error));
      return isSupportedMapsUrl(current) ? { url: current, html: "" } : null;
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        return null;
      }
      current = new URL(location, current);
      continue;
    }

    if (!response.ok) {
      console.error("Google Maps page returned HTTP", response.status);
      return { url: current, html: "" };
    }

    const finalUrl = response.url ? new URL(response.url) : current;
    if (!isSupportedMapsUrl(finalUrl)) {
      return null;
    }

    let html = "";
    try {
      html = await response.text();
    } catch (error) {
      console.error("Google Maps page body failed:", errorName(error));
    }

    return { url: finalUrl, html };
  }

  return null;
}

async function loadPreview(html: string): Promise<PreviewData | null> {
  const match =
    /href="((?:https:\/\/www\.google\.com)?\/maps\/preview\/place\?[^\"]+)"/.exec(html);
  if (!match) {
    console.error("Google Maps place data link not found");
    return null;
  }

  let url: URL;
  try {
    url = new URL(match[1].replaceAll("&amp;", "&"), "https://www.google.com");
  } catch {
    return null;
  }

  if (url.hostname !== "www.google.com" || !url.pathname.startsWith("/maps/preview/place")) {
    return null;
  }

  const response = await fetch(url.toString(), {
    headers: {
      "user-agent": USER_AGENT,
      "accept-language": "id-ID,id;q=0.9,en;q=0.8",
      accept: "application/json,text/plain,*/*",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    return null;
  }

  return parseMapsPreview(await response.text());
}

async function reverseGeocode(coordinates: Coordinates): Promise<string | null> {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(coordinates.latitude));
  url.searchParams.set("lon", String(coordinates.longitude));
  url.searchParams.set("zoom", "18");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", "id");

  const response = await fetch(url.toString(), {
    headers: {
      "user-agent": NOMINATIM_USER_AGENT,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as { display_name?: unknown };
  if (typeof data.display_name !== "string" || !data.display_name.trim()) {
    return null;
  }

  return data.display_name;
}

function findAddress(data: unknown, name?: string): string | undefined {
  let best: string | undefined;
  let bestScore = -1;

  walk(data, (value) => {
    if (typeof value !== "string") {
      return;
    }

    const candidate = value.trim();
    if (
      candidate.length < 8 ||
      candidate.length > 300 ||
      candidate.includes("http") ||
      (candidate.match(/,/g)?.length ?? 0) < 2
    ) {
      return;
    }

    const commaCount = candidate.match(/,/g)?.length ?? 0;
    const score = commaCount + (name && candidate.includes(name) ? 3 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  });

  return best ? stripPlaceName(best, name) : undefined;
}

function findCoordinates(data: unknown): Coordinates | undefined {
  let found: Coordinates | undefined;

  walk(data, (value) => {
    if (found || !Array.isArray(value) || value.length < 4) {
      return;
    }

    if (value[0] !== null || value[1] !== null) {
      return;
    }

    const coordinates = toCoordinates(Number(value[2]), Number(value[3]));
    if (coordinates) {
      found = coordinates;
    }
  });

  return found;
}

function walk(value: unknown, visit: (value: unknown) => void): void {
  visit(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, visit);
    }
    return;
  }

  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      walk(item, visit);
    }
  }
}

function stripPlaceName(address: string, name?: string): string {
  if (name && address.startsWith(`${name}, `)) {
    return address.slice(name.length + 2).trim();
  }

  return address;
}

function toCoordinates(latitude: unknown, longitude: unknown): Coordinates | undefined {
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return undefined;
  }

  return { latitude, longitude };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

function cleanText(value: string): string {
  return removeCommas(value).replace(/\s+/g, " ").trim();
}
