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

export interface AppConfig {
  defaultBackend: BackendSelection;
  outputRoot: string;
  api: {
    apiKey?: string;
    model: string;
  };
  web: {
    daemonHost: string;
    daemonPort: number;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    defaultBackend: parseBackend(env.GPT_IMAGE_BACKEND),
    outputRoot: path.resolve(env.GPT_IMAGE_OUTPUT_DIR || path.join(process.cwd(), "output", "gpt-image-2")),
    api: {
      apiKey: env.OPENAI_API_KEY,
      model: env.GPT_IMAGE_MODEL || "gpt-image-2",
    },
    web: {
      daemonHost: env.CHATGPT_IMAGE_DAEMON_HOST || "127.0.0.1",
      daemonPort: parsePort(env.CHATGPT_IMAGE_DAEMON_PORT, 8765),
    },
  };
}
