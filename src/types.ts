export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type?: string;
}

export interface TelegramMessage {
  message_id: number;
  date?: number;
  text?: string;
  chat: TelegramChat;
  from?: TelegramUser;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface TelegramApiResponse {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
}
