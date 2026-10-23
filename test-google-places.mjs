import { readFile } from "node:fs/promises";

const envFile = (await readFile(new URL("./.env", import.meta.url), "utf8").catch(() => "")).replace(/^\uFEFF/, "");
const getSetting = (name, fallback = "") => {
  if (process.env[name]?.trim()) return process.env[name].trim();
  const line = envFile.split(/\r?\n/).find((entry) => {
    const trimmed = entry.trim();
    return !trimmed.startsWith("#") && trimmed.startsWith(`${name}=`);
  });
  if (!line) return fallback;
  return line.trim().slice(name.length + 1).trim().replace(/^(?:"([\\s\\S]*)"|'([\\s\\S]*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
};

const mapsUrl = getSetting("MAPS_URL", "https://maps.app.goo.gl/1nXUgzubRScCfKo67").trim();
const apiKey = getSetting("GOOGLE_PLACES_API_KEY").trim();
const place = await resolveMapsUrl(mapsUrl);

if (!place) {
  console.error("Maps link could not be resolved to a supported Google Maps URL with coordinates.");
  process.exitCode = 1;
} else {
  console.log(`Place: ${place.name ?? "Unknown"}`);
  console.log(`Latitude: ${place.latitude}`);
  console.log(`Longitude: ${place.longitude}`);

  if (!apiKey) {
    console.log("Places API request skipped: set GOOGLE_PLACES_API_KEY in the environment.");
  } else {
    try {
      const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "places.id,places.location,places.formattedAddress",
        },
        body: JSON.stringify({
          textQuery: process.env.PLACE_QUERY?.trim() || place.name,
          languageCode: "id",
          maxResultCount: 3,
          locationBias: {
            circle: {
              center: { latitude: place.latitude, longitude: place.longitude },
              radius: 500,
            },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        console.error(`Google Places API returned HTTP ${response.status}: ${data?.error?.message ?? "No error details"}`);
        process.exitCode = 1;
      } else if (!Array.isArray(data?.places) || data.places.length === 0) {
        console.log("Places API returned no results.");
      } else {
        for (const [index, result] of data.places.entries()) {
          console.log(`${index + 1}. ${result.formattedAddress ?? "Address unavailable"}`);
          if (result.location) {
            console.log(`Latitude: ${result.location.latitude}`);
            console.log(`Longitude: ${result.location.longitude}`);
          }
          if (result.id) {
            console.log(`Place ID: ${result.id}`);
          }
        }
      }
    } catch (error) {
      console.error("Google Places request failed:", error instanceof Error ? error.name : "unknown error");
      process.exitCode = 1;
    }
  }
}

async function resolveMapsUrl(value) {
  let current;
  try {
    current = new URL(value);
  } catch {
    return null;
  }

  if (current.protocol !== "https:" || !isGoogleMapsHost(current)) {
    return null;
  }

  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(8_000),
    });
    const location = response.headers.get("location");

    if (response.status === 429) {
      console.error(`Google Maps link resolver returned HTTP 429 from ${current.hostname}; Retry-After=${response.headers.get("retry-after") ?? "not provided"}`);
      return null;
    }

    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      await response.body?.cancel();
      current = new URL(location, current);
      if (current.protocol !== "https:" || !isGoogleMapsHost(current)) {
        return null;
      }

      const coordinates = parseCoordinates(current);
      if (coordinates) {
        return {
          name: extractPlaceName(current),
          latitude: coordinates.latitude,
          longitude: coordinates.longitude,
        };
      }
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel();
      console.error(`Google Maps link resolver returned HTTP ${response.status} from ${current.hostname}`);
      return null;
    }

    const finalUrl = response.url ? new URL(response.url) : current;
    await response.body?.cancel();
    const coordinates = parseCoordinates(finalUrl);
    if (!coordinates) {
      return null;
    }
    return {
      name: extractPlaceName(finalUrl),
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
    };
  }

  return null;
}

function parseCoordinates(url) {
  let decoded = url.href;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return null;
  }
  const match =
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(decoded) ??
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(decoded) ??
    /[?&](?:q|ll|center|destination|query)=(?:loc:)?(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(decoded);
  if (!match) {
    return null;
  }

  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return null;
  }

  return { latitude, longitude };
}

function extractPlaceName(url) {
  const match = /^\/maps\/place\/([^/]+)/.exec(url.pathname);
  if (!match) {
    return undefined;
  }
  try {
    return decodeURIComponent(match[1].replaceAll("+", " "));
  } catch {
    return match[1].replaceAll("+", " ");
  }
}

function isGoogleMapsHost(url) {
  return (
    url.hostname === "goo.gl" && url.pathname.startsWith("/maps") ||
    url.hostname.endsWith(".goo.gl") ||
    /^(?:www\.|maps\.)?google\.(?:[a-z]{2,3}|co\.[a-z]{2})$/.test(url.hostname) &&
      (url.pathname.startsWith("/maps") || url.hostname.startsWith("maps."))
  );
}
