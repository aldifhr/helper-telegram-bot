import { MAX_INPUT_LENGTH, removeCommas } from "./processor";
import { sendMessage } from "./telegram";
import type { Env, TelegramMessage, TelegramUpdate } from "./types";

const WEBHOOK_PATH = "/webhook";
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

const START_TEXT = [
  "Halo! Saya bot penghapus koma.",
  "",
  "Kirim teks apa saja dan saya akan menghapus semua tanda koma (,) tanpa mengubah karakter lainnya.",
  "",
  "Perintah:",
  "/start - sambutan",
  "/help - panduan penggunaan",
  "/clean <teks> - hapus koma dari teks",
  "",
  "Contoh:",
  "-7.123456, 109.123456",
  "menjadi",
  "-7.123456 109.123456",
].join("\n");

const HELP_TEXT = [
  "Panduan penggunaan:",
  "",
  "1. Kirim teks biasa untuk langsung menghapus semua koma.",
  "2. Atau gunakan /clean diikuti teks:",
  "   /clean Jakarta, Bandung, Surabaya",
  "3. Jika hanya mengirim /clean, bot akan meminta teks.",
  "",
  "Yang dihapus hanya karakter koma ASCII (,).",
  "Titik desimal, tanda minus, spasi, emoji, dan karakter lain tetap dipertahankan.",
].join("\n");

const CLEAN_PROMPT =
  "Kirim teks setelah /clean, atau kirim teks biasa yang ingin diproses.\nContoh: /clean Jakarta, Bandung";

const EMPTY_TEXT = "Kirim teks yang ingin diproses.";
const EMPTY_RESULT = "Tidak ada teks yang tersisa setelah tanda koma dihapus.";
const NO_COMMAS = "Tidak ada tanda koma yang ditemukan. Teks tidak berubah.";
const TOO_LONG = `Pesan terlalu panjang. Batas aman adalah ${MAX_INPUT_LENGTH} karakter.`;

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
        return processAndRespond(env, message, command.arguments);
      default:
        return textResponse("OK", 200);
    }
  }

  if (text.trim() === "") {
    return replyAndRespond(env, message, EMPTY_TEXT);
  }

  return processAndRespond(env, message, text);
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
    return replyAndRespond(env, message, NO_COMMAS);
  }

  return replyAndRespond(env, message, result);
}

async function replyAndRespond(
  env: Env,
  message: TelegramMessage,
  text: string,
): Promise<Response> {
  const sent = await sendMessage(env, message.chat.id, text, {
    replyToMessageId: message.message_id,
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
