import type { AppConfig, BackendSelection } from "../config.js";
import { ApiImageBackend } from "./api.js";
import { ChatGptWebBackend } from "./chatgptWeb.js";
import { BackendUnavailableError, type GenerateImageArgs, type GenerateImageResult, type ImageBackend } from "./types.js";

export interface BackendRegistry {
  api: ApiImageBackend;
  "chatgpt-web": ChatGptWebBackend;
}

export function createBackends(config: AppConfig): BackendRegistry {
  return {
    api: new ApiImageBackend(config),
    "chatgpt-web": new ChatGptWebBackend(config),
  };
}

export async function generateWithSelectedBackend(params: {
  backends: BackendRegistry;
  selection: BackendSelection;
  args: GenerateImageArgs;
}): Promise<GenerateImageResult & { fallbackFrom?: string }> {
  if (params.selection === "api") {
    return params.backends.api.generateImage(params.args);
  }
  if (params.selection === "chatgpt-web") {
    return params.backends["chatgpt-web"].generateImage(params.args);
  }

  try {
    return await params.backends.api.generateImage(params.args);
  } catch (error) {
    if (!(error instanceof BackendUnavailableError)) {
      throw error;
    }
    const fallback = await params.backends["chatgpt-web"].generateImage(params.args);
    return {
      ...fallback,
      fallbackFrom: error.backend,
    };
  }
}

export function selectedBackend(backends: BackendRegistry, selection: Exclude<BackendSelection, "auto">): ImageBackend {
  return backends[selection];
}
