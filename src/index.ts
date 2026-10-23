import { extractMapsUrl, formatMapsResult, resolveMapsLink } from "./maps";
import { MAX_INPUT_LENGTH, parseCoordinatePair, removeCommas } from "./processor";
import { sendMessage } from "./telegram";
import type { MapsResult } from "./maps";
import type { Env, TelegramMessage, TelegramUpdate } from "./types";

const WEBHOOK_PATH = "/webhook";
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

const START_TEXT = [
  "Halo! Saya bot pengolah teks dan lokasi.",
  "",
  "CARA PAKAI TEKS",
  "Kirim teks biasa. Saya menghapus koma ASCII (,) dan membalas hasilnya agar mudah disalin.",
  "Karakter lain seperti titik desimal, minus, spasi, huruf, dan emoji tetap dipertahankan.",
  "",
  "KOORDINAT",
  "Koordinat desimal dengan koma juga dikenali:",
  "-7,3449461, 108,7079663",
  "menjadi",
  "-7.3449461 108.7079663",
  "Hasil koordinat menyediakan tombol salin latitude dan longitude secara terpisah.",
  "",
  "GOOGLE MAPS",
  "Kirim link tempat atau pin Google Maps. Bot akan membalas nama, alamat jika tersedia, dan koordinat.",
  "Koma pada alamat Maps dihapus agar hasil mudah ditempel ke formulir yang menolak koma.",
  "Tombol salin tersedia terpisah untuk nama, alamat, latitude, dan longitude.",
  "Alamat Places API memerlukan konfigurasi Google Places API; jika tidak tersedia, alamat bisa ditampilkan sebagai tidak tersedia.",
  "",
  "PERINTAH",
  "/start - tampilkan panduan ini",
  "/help - tampilkan panduan penggunaan",
  "/clean <teks> - proses teks setelah perintah",
  "Kirim /clean saja untuk melihat petunjuk singkat.",
  "",
  `Batas pesan: ${MAX_INPUT_LENGTH} karakter.`,
  "Gunakan /help untuk panduan ringkas.",
].join("\n");

const HELP_TEXT = [
  "Panduan penggunaan:",
  "",
  "1. Kirim teks biasa untuk langsung menghapus semua koma.",
  "2. Atau gunakan /clean diikuti teks:",
  "   /clean Jakarta, Bandung, Surabaya",
  "3. Jika hanya mengirim /clean, bot akan meminta teks.",
  "",
  "Pada teks biasa, koma ASCII (,) dihapus.",
  "Dalam pasangan koordinat valid, koma desimal diganti titik dan koma pemisah menjadi spasi.",
  "Koma pada alamat dari Google Maps dihapus; koma desimal koordinat diubah menjadi titik.",
  "Tanda minus, titik desimal, spasi, emoji, dan karakter lain tetap dipertahankan.",
  "",
  "Link Google Maps:",
  "Kirim link tempat atau titik dari Google Maps, misalnya maps.app.goo.gl/...",
  "Bot membalas nama tempat, alamat tanpa koma, latitude, dan longitude.",
].join("\n");

const CLEAN_PROMPT =
  "Kirim teks setelah /clean, atau kirim teks biasa yang ingin diproses.\nContoh: /clean Jakarta, Bandung";

const EMPTY_TEXT = "Kirim teks yang ingin diproses.";
const EMPTY_RESULT = "Tidak ada teks yang tersisa setelah tanda koma dihapus.";
const NO_COMMAS = "Tidak ada tanda koma yang ditemukan. Teks tidak berubah.";
const TOO_LONG = `Pesan terlalu panjang. Batas aman adalah ${MAX_INPUT_LENGTH} karakter.`;
const MAPS_FAILED =
  "Link Google Maps tidak bisa diproses. Pastikan link mengarah ke tempat atau titik di Google Maps.";
const MAPS_RATE_LIMITED =
  "Google Maps sedang membatasi permintaan (HTTP 429). Bot tidak akan mencoba ulang otomatis. Coba lagi nanti atau kirim link yang sudah memuat koordinat.";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== WEBHOOK_PATH) {
      return textResponse("Not Found", 404);
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST", "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
      console.error("Missing required worker configuration");
      return textResponse("Server misconfigured", 500);
    }

    const providedSecret = request.headers.get(SECRET_HEADER);
    if (!providedSecret || !constantTimeEqual(providedSecret, env.TELEGRAM_WEBHOOK_SECRET)) {
      return textResponse("Unauthorized", 401);
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return textResponse("Invalid JSON", 400);
    }

    const update = parseUpdate(payload);
    if (!update) {
      return textResponse("Invalid update payload", 400);
    }

    return handleUpdate(update, env);
  },
} satisfies ExportedHandler<Env>;

async function handleUpdate(update: TelegramUpdate, env: Env): Promise<Response> {
  const message = update.message;
  if (!message) {
    return textResponse("OK", 200);
  }

  if (message.from?.is_bot) {
    return textResponse("OK", 200);
  }

  const text = message.text;
  if (typeof text !== "string") {
    return textResponse("OK", 200);
  }

  if (text.length > MAX_INPUT_LENGTH) {
    return replyAndRespond(env, message, TOO_LONG);
  }

  const command = parseCommand(text);

  if (command) {
    switch (command.name) {
      case "start":
        return replyAndRespond(env, message, START_TEXT);
      case "help":
        return replyAndRespond(env, message, HELP_TEXT);
      case "clean":
        if (!command.arguments) {
          return replyAndRespond(env, message, CLEAN_PROMPT);
        }
        return processContentAndRespond(env, message, command.arguments);
      default:
        return textResponse("OK", 200);
    }
  }

  if (text.trim() === "") {
    return replyAndRespond(env, message, EMPTY_TEXT);
  }

  return processContentAndRespond(env, message, text);
}

async function processContentAndRespond(
  env: Env,
  message: TelegramMessage,
  text: string,
): Promise<Response> {
  const mapsUrl = extractMapsUrl(text);
  if (mapsUrl) {
    return processMapsAndRespond(env, message, mapsUrl);
  }

  return processAndRespond(env, message, text);
}

async function processMapsAndRespond(
  env: Env,
  message: TelegramMessage,
  mapsUrl: string,
): Promise<Response> {
  try {
    const resolution = await resolveMapsLink(mapsUrl, env.GOOGLE_PLACES_API_KEY);

    if (resolution.status === "rate_limited") {
      const result = resolution.result;
      if (!result) {
        return replyAndRespond(env, message, MAPS_RATE_LIMITED);
      }

      const text = `${formatMapsResult(result)}\n\nGoogle Maps membatasi permintaan (HTTP 429); alamat mungkin tidak tersedia.`;
      const copy = mapsCopyOptions(result);
      return replyAndRespond(env, message, text, undefined, undefined, copy.buttons);
    }

    if (resolution.status === "unavailable") {
      return replyAndRespond(env, message, MAPS_FAILED);
    }

    const result = resolution.result;
    const text = formatMapsResult(result);
    const copy = mapsCopyOptions(result);
    return replyAndRespond(env, message, text, undefined, undefined, copy.buttons);
  } catch (error) {
    console.error("Google Maps resolution failed:", {
      errorType: error instanceof Error ? error.name : "unknown error",
    });

    return replyAndRespond(
      env,
      message,
      "Google Maps sedang tidak bisa diproses. Coba kirim link lengkap atau koordinatnya secara langsung.",
    );
  }
}

function mapsCopyOptions(result: MapsResult): {
  buttons: Array<{ label: string; text: string }>;
} {
  const buttons: Array<{ label: string; text: string }> = [];
  if (result.name && result.name.length <= 256) {
    buttons.push({ label: "Salin nama", text: result.name.replaceAll(",", "") });
  }
  if (result.address && result.address.length <= 256) {
    buttons.push({ label: "Salin alamat", text: result.address.replaceAll(",", "") });
  }
  buttons.push(
    { label: "Salin latitude", text: String(result.coordinates.latitude) },
    { label: "Salin longitude", text: String(result.coordinates.longitude) },
  );
  return { buttons };
}

async function processAndRespond(
  env: Env,
  message: TelegramMessage,
  text: string,
): Promise<Response> {
  const result = removeCommas(text);

  if (result === "") {
    return replyAndRespond(env, message, EMPTY_RESULT);
  }

  if (result === text) {
    const copyText = text.length <= 256 ? text : undefined;
    return replyAndRespond(env, message, NO_COMMAS, copyText);
  }

  const coordinates = parseCoordinatePair(result);
  if (coordinates) {
    return replyAndRespond(env, message, result, undefined, undefined, [
      { label: "Salin latitude", text: coordinates.latitude },
      { label: "Salin longitude", text: coordinates.longitude },
    ]);
  }

  const copyText = result.length <= 256 ? result : undefined;
  return replyAndRespond(env, message, result, copyText);
}

async function replyAndRespond(
  env: Env,
  message: TelegramMessage,
  text: string,
  copyText?: string,
  copyTextLabel?: string,
  copyTextButtons?: Array<{ label: string; text: string }>,
): Promise<Response> {
  const sent = await sendMessage(env, message.chat.id, text, {
    replyToMessageId: message.message_id,
    copyText,
    copyTextLabel,
    copyTextButtons,
  });

  if (!sent) {
    return textResponse("Telegram API error", 502);
  }

  return textResponse("OK", 200);
}

interface ParsedCommand {
  name: string;
  arguments: string;
}

function parseCommand(text: string): ParsedCommand | null {
  const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?=\s|$)/.exec(text);
  if (!match) {
    return null;
  }

  return {
    name: match[1].toLowerCase(),
    arguments: text.slice(match[0].length).trim(),
  };
}

function parseUpdate(value: unknown): TelegramUpdate | null {
  if (!isRecord(value) || !isFiniteNumber(value.update_id)) {
    return null;
  }

  if (value.message !== undefined && !isTelegramMessage(value.message)) {
    return null;
  }

  return value as unknown as TelegramUpdate;
}

function isTelegramMessage(value: unknown): value is TelegramMessage {
  if (!isRecord(value)) {
    return false;
  }

  if (!isFiniteNumber(value.message_id)) {
    return false;
  }

  if (!isRecord(value.chat) || !isFiniteNumber(value.chat.id)) {
    return false;
  }

  if (value.text !== undefined && typeof value.text !== "string") {
    return false;
  }

  if (value.from !== undefined) {
    if (!isRecord(value.from) || !isFiniteNumber(value.from.id)) {
      return false;
    }
  }

  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return difference === 0;
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
