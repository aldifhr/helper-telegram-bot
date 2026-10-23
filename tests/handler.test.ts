import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { MAX_INPUT_LENGTH } from "../src/processor";
import type { Env, TelegramMessage, TelegramUpdate } from "../src/types";

const SECRET = "test-webhook-secret";
const env: Env = {
  TELEGRAM_BOT_TOKEN: "test-bot-token",
  TELEGRAM_WEBHOOK_SECRET: SECRET,
};

function stubTelegramFetch() {
  const fetchMock = vi.fn(async () => {
    return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function webhookRequest(body: string, secret: string | null = SECRET): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) {
    headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  }
  return new Request("https://worker.example.com/webhook", {
    method: "POST",
    headers,
    body,
  });
}

function textUpdate(text: string, overrides: Partial<TelegramMessage> = {}): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      text,
      chat: { id: -100123, type: "private" },
      from: { id: 42, is_bot: false, username: "user" },
      ...overrides,
    },
  };
}

async function sendUpdate(update: TelegramUpdate | string, requestEnv: Env = env) {
  const body = typeof update === "string" ? update : JSON.stringify(update);
  return worker.fetch(webhookRequest(body), requestEnv);
}

function sentPayload(fetchMock: ReturnType<typeof stubTelegramFetch>): Record<string, unknown> {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(call[0]).toContain("/sendMessage");
  return JSON.parse(String(call[1].body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("webhook routing and validation", () => {
  it("rejects non-POST requests", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example.com/webhook", { method: "GET" }),
      env,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });

  it("returns 404 for unknown paths", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example.com/other", { method: "POST", body: "{}" }),
      env,
    );
    expect(response.status).toBe(404);
  });

  it("rejects requests without a secret header", async () => {
    const fetchMock = stubTelegramFetch();
    const response = await worker.fetch(
      webhookRequest(JSON.stringify(textUpdate("a,b")), null),
      env,
    );
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects requests with a wrong secret header", async () => {
    const response = await worker.fetch(
      webhookRequest(JSON.stringify(textUpdate("a,b")), "wrong-secret"),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("rejects invalid JSON", async () => {
    const response = await worker.fetch(webhookRequest("{not-json"), env);
    expect(response.status).toBe(400);
  });

  it("rejects malformed update payloads", async () => {
    const response = await sendUpdate({ update_id: "1" } as unknown as TelegramUpdate);
    expect(response.status).toBe(400);
  });

  it("returns 500 when configuration is missing", async () => {
    const response = await worker.fetch(webhookRequest(JSON.stringify(textUpdate("a,b"))), {
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_WEBHOOK_SECRET: SECRET,
    });
    expect(response.status).toBe(500);
  });
});

describe("message handling", () => {
  it("removes commas and replies to the original message", async () => {
    const fetchMock = stubTelegramFetch();

    const response = await sendUpdate(textUpdate("Jakarta, Bandung, Surabaya"));

    expect(response.status).toBe(200);
    expect(sentPayload(fetchMock)).toMatchObject({
      chat_id: -100123,
      text: "Jakarta Bandung Surabaya",
      reply_parameters: { message_id: 10, allow_sending_without_reply: true },
    });
    expect(sentPayload(fetchMock)).not.toHaveProperty("parse_mode");
  });

  it("preserves decimal points and minus signs", async () => {
    const fetchMock = stubTelegramFetch();
    await sendUpdate(textUpdate("-7.123456, 109.123456"));
    expect(sentPayload(fetchMock).text).toBe("-7.123456 109.123456");
  });

  it("handles /clean with inline text", async () => {
    const fetchMock = stubTelegramFetch();
    await sendUpdate(textUpdate("/clean Jl. Sudirman No. 12, Cilacap, Jawa Tengah"));
    expect(sentPayload(fetchMock).text).toBe("Jl. Sudirman No. 12 Cilacap Jawa Tengah");
  });

  it("handles /clean with a bot mention", async () => {
    const fetchMock = stubTelegramFetch();
    await sendUpdate(textUpdate("/clean@CommaRemoverBot a, b"));
    expect(sentPayload(fetchMock).text).toBe("a b");
  });

  it("asks for text when /clean has no arguments", async () => {
    const fetchMock = stubTelegramFetch();
    await sendUpdate(textUpdate("/clean"));
    expect(String(sentPayload(fetchMock).text)).toContain("/clean");
  });

  it("shows help for /start and /help", async () => {
    const startFetch = stubTelegramFetch();
    await sendUpdate(textUpdate("/start"));
    expect(String(sentPayload(startFetch).text)).toContain("penghapus koma");
    vi.unstubAllGlobals();

    const helpFetch = stubTelegramFetch();
    await sendUpdate(textUpdate("/help"));
    expect(String(sentPayload(helpFetch).text)).toContain("Panduan penggunaan");
  });

  it("informs the user when there are no commas", async () => {
    const fetchMock = stubTelegramFetch();
    await sendUpdate(textUpdate("Teks tanpa koma"));
    expect(String(sentPayload(fetchMock).text)).toContain("Tidak ada tanda koma");
  });

  it("handles text that only contains commas", async () => {
    const fetchMock = stubTelegramFetch();
    await sendUpdate(textUpdate(",,,"));
    expect(String(sentPayload(fetchMock).text)).toContain("Tidak ada teks");
  });

  it("asks for text when the message is blank", async () => {
    const fetchMock = stubTelegramFetch();
    await sendUpdate(textUpdate("   "));
    expect(String(sentPayload(fetchMock).text)).toContain("Kirim teks");
  });

  it("rejects messages above the safe input limit", async () => {
    const fetchMock = stubTelegramFetch();
    await sendUpdate(textUpdate("a".repeat(MAX_INPUT_LENGTH + 1)));
    expect(String(sentPayload(fetchMock).text)).toContain("terlalu panjang");
  });

  it("ignores messages sent by bots", async () => {
    const fetchMock = stubTelegramFetch();
    const update = textUpdate("a,b", { from: { id: 7, is_bot: true } });

    const response = await sendUpdate(update);

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores non-text messages", async () => {
    const fetchMock = stubTelegramFetch();
    const update = textUpdate("", { text: undefined });

    const response = await sendUpdate(update);

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores updates without a message", async () => {
    const fetchMock = stubTelegramFetch();
    const response = await sendUpdate({ update_id: 5 });

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores unknown commands", async () => {
    const fetchMock = stubTelegramFetch();
    const response = await sendUpdate(textUpdate("/unknown"));

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 502 when Telegram rejects the message", async () => {
    stubTelegramFetch().mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request" }), {
        status: 400,
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await sendUpdate(textUpdate("a,b"));

    expect(response.status).toBe(502);
  });

  it("returns 502 when the Telegram request throws", async () => {
    stubTelegramFetch().mockRejectedValueOnce(new Error("network down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await sendUpdate(textUpdate("a,b"));

    expect(response.status).toBe(502);
  });
});


describe("map link handling", () => {
  const shortUrl = "https://maps.app.goo.gl/bqwmTtGrR9AvJGHm9";
  const finalUrl =
    "https://www.google.com/maps/place/Pondok+Pesantren+Al+Anshor/@-7.307264,108.7143936,9580m/data=!3m1!1e3!4m6!3m5!1s0x2e6f7b93b94bf461:0xdc7e1422a9740d9b!8m2!3d-7.2810178!4d108.7039185!16s%2Fg%2F11jcfz2sm9?entry=tts";
  const address =
    "Jl. Curug Bandung, Ciheuleut, Limbangan, Kec. Wanareja, Kabupaten Cilacap, Jawa Tengah 53232";

  function mapsPreview(): string {
    const root: unknown[] = [];
    root[9] = [null, null, -7.2810178, 108.7039185];
    root[11] = "Pondok Pesantren Al Anshor";
    root[18] = `Pondok Pesantren Al Anshor, ${address}`;
    root[39] = address;
    return ")]}'\n" + JSON.stringify([null, null, null, null, null, null, root]);
  }

  function stubMapsFetch(mapFailure = false) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === shortUrl) {
        if (mapFailure) {
          return new Response("not found", { status: 404 });
        }
        return new Response(null, { status: 302, headers: { location: finalUrl } });
      }
      if (url === finalUrl) {
        return new Response(
          '<html><head><link rel="preload" href="/maps/preview/place?auth_user=0&amp;pb=abc"></head></html>',
        );
      }
      if (url.startsWith("https://www.google.com/maps/preview/place?")) {
        return new Response(mapsPreview());
      }
      if (url.includes("api.telegram.org")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function telegramText(fetchMock: ReturnType<typeof stubMapsFetch>): string {
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    const call = calls.find(([url]) => url.includes("api.telegram.org"));
    expect(call).toBeDefined();
    const body = JSON.parse(String(call?.[1].body)) as { text?: string };
    return body.text ?? "";
  }

  it("replies with the map address and coordinates", async () => {
    const fetchMock = stubMapsFetch();

    const response = await sendUpdate(textUpdate(`Lokasi: ${shortUrl}`));

    expect(response.status).toBe(200);
    const text = telegramText(fetchMock);
    expect(text).toContain("Nama: Pondok Pesantren Al Anshor");
    expect(text).toContain(
      "Alamat: Jl. Curug Bandung Ciheuleut Limbangan Kec. Wanareja Kabupaten Cilacap Jawa Tengah 53232",
    );
    expect(text).toContain("Latitude: -7.2810178");
    expect(text).toContain("Longitude: 108.7039185");
    expect(text).not.toContain(",");
  });

  it("replies with an error when the map link cannot be read", async () => {
    const fetchMock = stubMapsFetch(true);

    const response = await sendUpdate(textUpdate(shortUrl));

    expect(response.status).toBe(200);
    expect(telegramText(fetchMock)).toContain("tidak bisa diproses");
  });
});
