import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

export const BackendSelectionSchema = z.enum(["api", "chatgpt-web", "auto"]);
export type BackendSelection = z.infer<typeof BackendSelectionSchema>;

export const BackendNameSchema = z.enum(["api", "chatgpt-web"]);
export type BackendName = z.infer<typeof BackendNameSchema>;

export const ConversationModeSchema = z.enum(["new", "continue"]);
export type ConversationMode = z.infer<typeof ConversationModeSchema>;

export const OutputFormatSchema = z.enum(["png", "jpeg", "webp"]);
export type OutputFormat = z.infer<typeof OutputFormatSchema>;

export const ImageQualitySchema = z.enum(["low", "medium", "high", "auto"]);
export type ImageQuality = z.infer<typeof ImageQualitySchema>;

export const WebModeSchema = z.enum(["direct", "daemon"]);
export type WebMode = z.infer<typeof WebModeSchema>;

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXED_OUTPUT_ROOT = path.join(PROJECT_ROOT, "output", "chatgpt-images");

export interface AppConfig {
  defaultBackend: BackendSelection;
  outputRoot: string;
  api: {
    apiKey?: string;
    model: string;
  };
  web: {
    mode: WebMode;
    daemonHost: string;
    daemonPort: number;
    profileDir: string;
    loginTimeoutSeconds: number;
    hideWindow: boolean;
  };
}

function parseBackend(value: string | undefined): BackendSelection {
  const parsed = BackendSelectionSchema.safeParse(value || "api");
  return parsed.success ? parsed.data : "api";
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseWebMode(value: string | undefined): WebMode {
  const parsed = WebModeSchema.safeParse(value || "direct");
  return parsed.success ? parsed.data : "direct";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    defaultBackend: parseBackend(env.GPT_IMAGE_BACKEND),
    outputRoot: FIXED_OUTPUT_ROOT,
    api: {
      apiKey: env.OPENAI_API_KEY,
      model: env.GPT_IMAGE_MODEL || "gpt-image-2",
    },
    web: {
      mode: parseWebMode(env.CHATGPT_WEB_MODE),
      daemonHost: env.CHATGPT_IMAGE_DAEMON_HOST || "127.0.0.1",
      daemonPort: parsePort(env.CHATGPT_IMAGE_DAEMON_PORT, 8765),
      profileDir: path.resolve(env.CHATGPT_WEB_PROFILE_DIR || path.join(process.cwd(), ".chatgpt-image-mcp", "ts-profile")),
      loginTimeoutSeconds: parsePositiveInt(env.CHATGPT_WEB_LOGIN_TIMEOUT_SECONDS, 900),
      hideWindow: parseBoolean(env.CHATGPT_HIDE_WINDOW, true),
    },
  };
}
