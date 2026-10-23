const MAX_LOOKUP_MS = 20_000;
const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 64 * 1024;
const MAX_PREVIEW_BYTES = 256 * 1024;
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
  coordinates: Coordinates;
}

export type MapsResolution =
  | { status: "ok"; result: MapsResult }
  | { status: "rate_limited"; result?: MapsResult }
  | { status: "unavailable" };

interface PreviewData {
  name?: string;
  address?: string;
  coordinates?: Coordinates;
}

interface MapsPage {
  url: URL;
  html: string;
  rateLimited?: boolean;
}

interface PreviewResult {
  data: PreviewData | null;
  rateLimited: boolean;
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

export async function resolveMapsLink(
  value: string,
  placesApiKey?: string,
): Promise<MapsResolution> {
  let start: URL;
  try {
    start = new URL(value);
  } catch {
    return { status: "unavailable" };
  }

  if (!isSupportedMapsUrl(start)) {
    return { status: "unavailable" };
  }

  const deadline = Date.now() + MAX_LOOKUP_MS;
  const directCoordinates = parseCoordinates(start);
  if (directCoordinates) {
    return resolvePlacesAddress(
      {
        name: trimOptionalText(extractPlaceName(start)),
        coordinates: directCoordinates,
      },
      placesApiKey,
      deadline,
    );
  }

  let stage = "maps_redirect";
  try {
    const page = await loadMapsPage(start, deadline);
    if (!page) {
      return { status: "unavailable" };
    }

    let coordinates = parseCoordinates(page.url);
    let name = extractPlaceName(page.url);
    let address: string | undefined;
    let rateLimited = page.rateLimited ?? false;

    if (!page.html) {
      if (!coordinates) {
        return rateLimited ? { status: "rate_limited" } : { status: "unavailable" };
      }
      return resolvePlacesAddress(
        { name: trimOptionalText(name), coordinates },
        placesApiKey,
        deadline,
        rateLimited,
      );
    }

    stage = "google_place_data";
    const previewResult = await loadPreview(page.html, deadline);
    rateLimited ||= previewResult.rateLimited;
    const preview = previewResult.data;
    if (preview) {
      name = preview.name ?? name;
      address = preview.address;
      coordinates = coordinates ?? preview.coordinates;
    }

    if (!coordinates) {
      return rateLimited ? { status: "rate_limited" } : { status: "unavailable" };
    }

    return resolvePlacesAddress(
      {
        name: trimOptionalText(name),
        address: address ? address.replaceAll(",", "").trim() : undefined,
        coordinates,
      },
      placesApiKey,
      deadline,
      rateLimited,
    );
  } catch (error) {
    logNetworkFailure(stage, error);
    return { status: "unavailable" };
  }
}

async function resolvePlacesAddress(
  result: MapsResult,
  apiKey: string | undefined,
  deadline: number,
  previouslyRateLimited = false,
): Promise<MapsResolution> {
  const resultWithoutUnverifiedAddress = { ...result, address: undefined };
  if (!apiKey || !result.name) {
    return previouslyRateLimited
      ? { status: "rate_limited", result }
      : { status: "ok", result };
  }

  const url = "https://places.googleapis.com/v1/places:searchText";
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.id,places.location,places.formattedAddress",
      },
      body: JSON.stringify({
        textQuery: result.name,
        languageCode: "id",
        maxResultCount: 5,
        locationBias: {
          circle: {
            center: result.coordinates,
            radius: 500,
          },
        },
      }),
      signal: timeoutSignal(deadline),
    });
  } catch (error) {
    logNetworkFailure("google_places_text_search", error, "places.googleapis.com");
    return previouslyRateLimited
      ? { status: "rate_limited", result: resultWithoutUnverifiedAddress }
      : { status: "ok", result: resultWithoutUnverifiedAddress };
  }

  logResponse("google_places_text_search", "places.googleapis.com", response);
  if (!response.ok) {
    await cancelBody(response);
    return response.status === 429 || previouslyRateLimited
      ? { status: "rate_limited", result: resultWithoutUnverifiedAddress }
      : { status: "ok", result: resultWithoutUnverifiedAddress };
  }

  const data = (await response.json().catch(() => null)) as
    | {
        places?: Array<{
          formattedAddress?: unknown;
          location?: { latitude?: unknown; longitude?: unknown };
        }>;
      }
    | null;
  const places = Array.isArray(data?.places) ? data.places : [];
  const match = places
    .map((place) => {
      const coordinates = toCoordinates(place.location?.latitude, place.location?.longitude);
      return {
        address: typeof place.formattedAddress === "string" ? place.formattedAddress : undefined,
        distance: coordinates ? distanceMeters(result.coordinates, coordinates) : Infinity,
      };
    })
    .filter((place) => place.address && place.distance <= 500)
    .sort((left, right) => left.distance - right.distance)[0];

  if (match?.address) {
    return {
      status: "ok",
      result: { ...result, address: match.address.replaceAll(",", "").trim() },
    };
  }

  return previouslyRateLimited
    ? { status: "rate_limited", result: resultWithoutUnverifiedAddress }
    : { status: "ok", result: resultWithoutUnverifiedAddress };
}

function distanceMeters(a: Coordinates, b: Coordinates): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(b.latitude - a.latitude);
  const longitudeDelta = radians(b.longitude - a.longitude);
  const value =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(a.latitude)) *
      Math.cos(radians(b.latitude)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

export function formatMapsResult(result: MapsResult): string {
  const lines: string[] = [];

  if (result.name) {
    lines.push(`Nama: ${result.name.replaceAll(",", "").trim()}`);
  }

  if (result.address) {
    lines.push(`Alamat: ${result.address.replaceAll(",", "").trim()}`);
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
  if (url.protocol !== "https:" || url.username || url.password || !isGoogleHost(url.hostname)) {
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

async function loadMapsPage(start: URL, deadline: number): Promise<MapsPage | null> {
  let current = start;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (!isGoogleHost(current.hostname)) {
      return null;
    }

    const stage = redirects === 0 ? "maps_short_link_redirect" : "google_maps_redirect";
    let response: Response;
    try {
      response = await fetch(current.toString(), {
        redirect: "manual",
        headers: {
          "accept-language": "id-ID,id;q=0.9,en;q=0.8",
          accept: "text/html,application/xhtml+xml",
        },
        signal: timeoutSignal(deadline),
      });
    } catch (error) {
      logNetworkFailure(stage, error, current.hostname);
      return isSupportedMapsUrl(current) ? { url: current, html: "" } : null;
    }

    const location = response.headers.get("location");
    const locationHostname = locationHostnameOf(location, current);
    const responseHostname = hostnameOf(response.url);
    logResponse(
      stage,
      current.hostname,
      response,
      locationHostname ?? (responseHostname !== current.hostname ? responseHostname : undefined),
    );

    if (REDIRECT_STATUSES.has(response.status)) {
      await cancelBody(response);
      if (!location || !locationHostname) {
        return null;
      }

      current = new URL(location, current);
      if (!isGoogleHost(current.hostname)) {
        return null;
      }

      const coordinates = parseCoordinates(current);
      if (coordinates) {
        return { url: current, html: "" };
      }
      continue;
    }

    const finalUrl = response.url ? new URL(response.url) : current;
    if (!isSupportedMapsUrl(finalUrl)) {
      await cancelBody(response);
      return null;
    }

    if (!response.ok) {
      await cancelBody(response);
      return { url: finalUrl, html: "", rateLimited: response.status === 429 };
    }

    if (parseCoordinates(finalUrl)) {
      await cancelBody(response);
      return { url: finalUrl, html: "" };
    }

    return { url: finalUrl, html: await readTextLimited(response, MAX_HTML_BYTES) };
  }

  return null;
}

async function loadPreview(html: string, deadline: number): Promise<PreviewResult> {
  const match =
    /href="((?:https:\/\/www\.google\.com)?\/maps\/preview\/place\?[^\"]+)"/.exec(html);
  if (!match) {
    return { data: null, rateLimited: false };
  }

  let url: URL;
  try {
    url = new URL(match[1].replaceAll("&amp;", "&"), "https://www.google.com");
  } catch {
    return { data: null, rateLimited: false };
  }

  if (url.hostname !== "www.google.com" || !url.pathname.startsWith("/maps/preview/place")) {
    return { data: null, rateLimited: false };
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        "accept-language": "id-ID,id;q=0.9,en;q=0.8",
        accept: "application/json,text/plain,*/*",
      },
      signal: timeoutSignal(deadline),
    });
  } catch (error) {
    logNetworkFailure("google_place_data", error, url.hostname);
    return { data: null, rateLimited: false };
  }

  logResponse("google_place_data", url.hostname, response);
  if (!response.ok) {
    await cancelBody(response);
    return { data: null, rateLimited: response.status === 429 };
  }

  return {
    data: parseMapsPreview(await readTextLimited(response, MAX_PREVIEW_BYTES)),
    rateLimited: false,
  };
}

function timeoutSignal(deadline: number): AbortSignal {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("lookup timeout");
  }
  return AbortSignal.timeout(Math.min(8_000, remaining));
}

function logResponse(
  stage: string,
  hostname: string,
  response: Response,
  redirectHostname?: string,
): void {
  console.info(
    "Maps outbound request",
    JSON.stringify({
      stage,
      hostname,
      status: response.status,
      contentType: response.headers.get("content-type"),
      redirectHostname: redirectHostname ?? null,
      retryAfter: response.headers.get("retry-after"),
    }),
  );
}

function logNetworkFailure(stage: string, error: unknown, hostname?: string): void {
  console.error(
    "Maps outbound request",
    JSON.stringify({
      stage,
      hostname: hostname ?? null,
      status: "network_error",
      contentType: null,
      redirectHostname: null,
      retryAfter: null,
      errorType: errorName(error),
    }),
  );
}

function hostnameOf(value: string): string | undefined {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

function locationHostnameOf(location: string | null, current: URL): string | undefined {
  if (!location) {
    return undefined;
  }
  try {
    return new URL(location, current).hostname;
  } catch {
    return undefined;
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    return;
  }
}

async function readTextLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  while (length < maxBytes) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = value.subarray(0, maxBytes - length);
    chunks.push(chunk);
    length += chunk.length;
    if (chunk.length < value.length || length >= maxBytes) {
      await reader.cancel();
      break;
    }
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

function trimOptionalText(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
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