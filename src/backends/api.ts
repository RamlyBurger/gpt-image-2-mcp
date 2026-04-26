import OpenAI from "openai";

import type { AppConfig } from "../config.js";
import { createOutputDir, mimeTypeForFormat, writeBase64Image, writeMetadata } from "../output.js";
import { BackendUnavailableError, type BackendStatus, type GenerateImageArgs, type GenerateImageResult, type ImageBackend } from "./types.js";

type ImageResponseItem = {
  b64_json?: string | null;
  url?: string | null;
  revised_prompt?: string | null;
};

type ImageResponse = {
  created?: number;
  data?: ImageResponseItem[];
  usage?: unknown;
};

type ImageGenerateRequest = Parameters<OpenAI["images"]["generate"]>[0];

export class ApiImageBackend implements ImageBackend {
  readonly name = "api" as const;

  constructor(private readonly config: AppConfig) {}

  async status(): Promise<BackendStatus> {
    const configured = Boolean(this.config.api.apiKey);
    return {
      backend: this.name,
      configured,
      ready: configured,
      message: configured ? "OpenAI API key is configured." : "Set OPENAI_API_KEY to use the API backend.",
      details: {
        model: this.config.api.model,
        output_root: this.config.outputRoot,
      },
    };
  }

  async generateImage(args: GenerateImageArgs): Promise<GenerateImageResult> {
    if (!this.config.api.apiKey) {
      throw new BackendUnavailableError("OPENAI_API_KEY is not set.", this.name);
    }

    const client = new OpenAI({ apiKey: this.config.api.apiKey });
    const request: ImageGenerateRequest = {
      model: this.config.api.model,
      prompt: args.prompt,
      n: args.n,
      size: (args.size || "auto") as ImageGenerateRequest["size"],
      quality: args.quality || "auto",
      output_format: args.outputFormat,
    };
    const response = (await client.images.generate(request)) as ImageResponse;

    const items = response.data || [];
    if (items.length === 0) {
      throw new Error("OpenAI image API returned no images.");
    }

    const outputDir = await createOutputDir(this.config.outputRoot, args.prompt);
    const mimeType = mimeTypeForFormat(args.outputFormat);
    const images = [];

    for (const [index, item] of items.entries()) {
      const base64 = item.b64_json || (item.url ? await fetchImageAsBase64(item.url) : undefined);
      if (!base64) {
        throw new Error("OpenAI image API returned an image without b64_json or url.");
      }
      images.push({
        path: await writeBase64Image({
          base64,
          outputDir,
          index: index + 1,
          mimeType,
        }),
        mimeType,
      });
    }

    const metadata = {
      backend: this.name,
      model: this.config.api.model,
      prompt: args.prompt,
      created_at: new Date().toISOString(),
      openai_created: response.created,
      usage: response.usage,
      images,
    };
    await writeMetadata(outputDir, metadata);

    return {
      status: "saved",
      backend: this.name,
      prompt: args.prompt,
      outputDir,
      images,
      primaryImage: images[0],
      metadata: {
        model: this.config.api.model,
        openai_created: response.created,
        usage: response.usage,
      },
    };
  }
}

async function fetchImageAsBase64(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch generated image URL: HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer).toString("base64");
}
