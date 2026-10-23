import type { Env, TelegramApiResponse } from "./types";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = 10_000;

interface CopyTextButton {
  label: string;
  text: string;
}

interface SendMessageOptions {
  replyToMessageId?: number;
  copyText?: string;
  copyTextLabel?: string;
  copyTextButtons?: CopyTextButton[];
}

export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  options: SendMessageOptions = {},
): Promise<boolean> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
  };

  if (options.replyToMessageId !== undefined) {
    payload.reply_parameters = {
      message_id: options.replyToMessageId,
      allow_sending_without_reply: true,
    };
  }

  const copyButtons = (options.copyTextButtons ?? [])
    .filter((button) => button.text.length > 0 && button.text.length <= 256)
    .map((button) => ({ text: button.label, copy_text: { text: button.text } }));

  if (copyButtons.length > 0) {
    payload.reply_markup = { inline_keyboard: [copyButtons] };
  } else if (options.copyText && options.copyText.length <= 256) {
    payload.reply_markup = {
      inline_keyboard: [
        [{ text: options.copyTextLabel ?? "Salin teks", copy_text: { text: options.copyText } }],
      ],
    };
  }

  let response: Response;
  try {
    response = await fetch(
      `${TELEGRAM_API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  } catch (error) {
    console.error(
      "Telegram sendMessage request failed:",
      error instanceof Error ? error.name : "unknown error",
    );
    return false;
  }

  if (!response.ok) {
    console.error("Telegram sendMessage returned HTTP", response.status);
    return false;
  }

  let data: TelegramApiResponse;
  try {
    data = (await response.json()) as TelegramApiResponse;
  } catch {
    console.error("Telegram sendMessage returned invalid JSON");
    return false;
  }

  if (!data.ok) {
    console.error(
      "Telegram sendMessage rejected:",
      data.error_code ?? "unknown code",
      data.description ?? "no description",
    );
    return false;
  }

  return true;
}
