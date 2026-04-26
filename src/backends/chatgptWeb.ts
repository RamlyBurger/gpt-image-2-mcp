import net from "node:net";

import type { AppConfig } from "../config.js";
import { BackendUnavailableError, type BackendStatus, type GenerateImageArgs, type GenerateImageResult, type GeneratedImage, type ImageBackend } from "./types.js";

type DaemonResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error_type?: string; error?: string };

type WebGenerateResult = {
  prompt: string;
  output_dir: string;
  images: Array<{
    path: string;
    mime_type: string;
    width: number;
    height: number;
    source_url: string;
  }>;
  primary_image: {
    path: string;
    mime_type: string;
    width: number;
    height: number;
    source_url: string;
  };
  session_reused: boolean;
  conversation_mode: string;
};

export class ChatGptWebBackend implements ImageBackend {
  readonly name = "chatgpt-web" as const;

  constructor(private readonly config: AppConfig) {}

  async status(): Promise<BackendStatus> {
    try {
      const daemon = await this.daemonRequest<Record<string, unknown>>("status", undefined, 30);
      return {
        backend: this.name,
        configured: true,
        ready: true,
        message: "Browser daemon is reachable.",
        details: {
          daemon_host: this.config.web.daemonHost,
          daemon_port: this.config.web.daemonPort,
          daemon,
        },
      };
    } catch (error) {
      return {
        backend: this.name,
        configured: true,
        ready: false,
        message: error instanceof Error ? error.message : String(error),
        details: {
          daemon_host: this.config.web.daemonHost,
          daemon_port: this.config.web.daemonPort,
        },
      };
    }
  }

  async generateImage(args: GenerateImageArgs): Promise<GenerateImageResult> {
    const result = await this.daemonRequest<WebGenerateResult>(
      "generate",
      {
        prompt: args.prompt,
        timeout_seconds: args.timeoutSeconds,
        max_images: args.n,
        conversation_mode: args.conversationMode,
      },
      args.timeoutSeconds + 120,
    );

    const images = result.images.map(mapDaemonImage);
    return {
      status: "saved",
      backend: this.name,
      prompt: result.prompt,
      outputDir: result.output_dir,
      images,
      primaryImage: mapDaemonImage(result.primary_image),
      metadata: {
        session_reused: result.session_reused,
        conversation_mode: result.conversation_mode,
      },
    };
  }

  private daemonRequest<T>(action: string, payload?: Record<string, unknown>, timeoutSeconds = 900): Promise<T> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({
        host: this.config.web.daemonHost,
        port: this.config.web.daemonPort,
      });
      let buffer = "";
      let settled = false;

      const timeout = setTimeout(() => {
        finish(new BackendUnavailableError(`Browser daemon request timed out after ${timeoutSeconds}s.`, this.name));
      }, timeoutSeconds * 1000);

      const finish = (error?: Error, value?: T) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        if (error) {
          reject(error);
        } else {
          resolve(value as T);
        }
      };

      socket.setTimeout(5000);
      socket.on("connect", () => {
        socket.setTimeout(0);
        socket.write(`${JSON.stringify({ action, ...(payload || {}) })}\n`, "utf8");
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          return;
        }
        const line = buffer.slice(0, newline);
        try {
          const response = JSON.parse(line) as DaemonResponse<T>;
          if (!response.ok) {
            finish(new Error(`${response.error_type || "DaemonToolError"}: ${response.error || "Browser daemon command failed."}`));
            return;
          }
          finish(undefined, response.result);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on("timeout", () => {
        finish(new BackendUnavailableError(`Browser daemon is not responding at ${this.config.web.daemonHost}:${this.config.web.daemonPort}.`, this.name));
      });
      socket.on("error", (error) => {
        finish(new BackendUnavailableError(`Browser daemon is not running at ${this.config.web.daemonHost}:${this.config.web.daemonPort}.`, this.name));
      });
    });
  }
}

function mapDaemonImage(image: WebGenerateResult["primary_image"]): GeneratedImage {
  return {
    path: image.path,
    mimeType: image.mime_type,
    width: image.width,
    height: image.height,
    sourceUrl: image.source_url,
  };
}
