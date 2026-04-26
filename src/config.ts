import os from "node:os";
import path from "node:path";

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

const APP_DIRECTORY_NAME = "gpt-image-2-mcp";

export function defaultAppDataRoot(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const home = os.homedir();
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA || env.APPDATA || path.join(home, "AppData", "Local"), APP_DIRECTORY_NAME);
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", APP_DIRECTORY_NAME);
  }
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), APP_DIRECTORY_NAME);
}

export function defaultOutputRoot(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  return path.join(defaultAppDataRoot(env, platform), "output", "chatgpt-images");
}

export function defaultProfileDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  return path.join(defaultAppDataRoot(env, platform), "profile");
}

export interface AppConfig {
  defaultBackend: BackendSelection;
  outputRoot: string;
  api: {
    apiKey?: string;
    model: string;
  };
  web: {
    profileDir: string;
    loginTimeoutSeconds: number;
    hideWindow: boolean;
  };
}

function parseBackend(value: string | undefined): BackendSelection {
  const parsed = BackendSelectionSchema.safeParse(value || "api");
  return parsed.success ? parsed.data : "api";
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
    outputRoot: defaultOutputRoot(env),
    api: {
      apiKey: env.OPENAI_API_KEY,
      model: env.GPT_IMAGE_MODEL || "gpt-image-2",
    },
    web: {
      profileDir: path.resolve(env.CHATGPT_WEB_PROFILE_DIR || defaultProfileDir(env)),
      loginTimeoutSeconds: parsePositiveInt(env.CHATGPT_WEB_LOGIN_TIMEOUT_SECONDS, 900),
      hideWindow: parseBoolean(env.CHATGPT_HIDE_WINDOW, true),
    },
  };
}
