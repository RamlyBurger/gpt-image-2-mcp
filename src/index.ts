#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { BackendSelectionSchema, ConversationModeSchema, ImageQualitySchema, loadConfig, OutputFormatSchema } from "./config.js";
import { createBackends, generateWithSelectedBackend, selectedBackend } from "./backends/resolve.js";
import type { GenerateImageResult, GeneratedImage } from "./backends/types.js";

const config = loadConfig();
const backends = createBackends(config);
const server = new McpServer({
  name: "gpt-image-2-mcp",
  version: "0.2.0",
});

const GenerateImageInput = z.object({
  prompt: z.string().min(1).describe("Image prompt to send to the selected backend."),
  backend: BackendSelectionSchema.optional().describe("Backend to use. Defaults to GPT_IMAGE_BACKEND or api."),
  n: z.number().int().min(1).max(4).default(1).describe("Number of images to generate."),
  size: z.string().optional().describe("Image size. API mode accepts OpenAI-supported sizes or auto."),
  quality: ImageQualitySchema.optional().describe("Output quality for API mode."),
  output_format: OutputFormatSchema.default("png").describe("Output file format for API mode."),
  conversation_mode: ConversationModeSchema.default("new").describe("Web backend mode: new or continue."),
  timeout_seconds: z.number().int().min(30).max(1800).default(420).describe("Generation timeout in seconds."),
});

const BackendStatusInput = z.object({
  backend: BackendSelectionSchema.optional().describe("Backend to inspect. Defaults to GPT_IMAGE_BACKEND or auto summary."),
});

server.registerTool(
  "generate_image",
  {
    title: "Generate image",
    description: "Generate images using either the OpenAI gpt-image-2 API backend or the ChatGPT web automation backend.",
    inputSchema: GenerateImageInput,
  },
  async (rawArgs): Promise<CallToolResult> => {
    const args = GenerateImageInput.parse(rawArgs);
    const selection = args.backend || config.defaultBackend;
    try {
      const result = await generateWithSelectedBackend({
        backends,
        selection,
        args: {
          prompt: args.prompt,
          n: args.n,
          size: args.size,
          quality: args.quality,
          outputFormat: args.output_format,
          conversationMode: args.conversation_mode,
          timeoutSeconds: args.timeout_seconds,
        },
      });
      return await imageResultToToolResult(result, selection);
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  },
);

server.registerTool(
  "backend_status",
  {
    title: "Backend status",
    description: "Show configuration and readiness for the API and ChatGPT web backends.",
    inputSchema: BackendStatusInput,
  },
  async (rawArgs): Promise<CallToolResult> => {
    const args = BackendStatusInput.parse(rawArgs);
    const selection = args.backend || config.defaultBackend;
    const statuses =
      selection === "auto"
        ? [await backends.api.status(), await backends["chatgpt-web"].status()]
        : [await selectedBackend(backends, selection).status()];
    const summary = {
      selected_backend: selection,
      default_backend: config.defaultBackend,
      statuses,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      structuredContent: summary,
    };
  },
);

async function imageResultToToolResult(result: GenerateImageResult & { fallbackFrom?: string }, requestedBackend: string): Promise<CallToolResult> {
  const summary = {
    status: result.status,
    requested_backend: requestedBackend,
    backend: result.backend,
    fallback_from: result.fallbackFrom,
    prompt: result.prompt,
    output_dir: result.outputDir,
    image_path: result.primaryImage.path,
    images: result.images,
    metadata: result.metadata,
  };

  const content: ContentBlock[] = [{ type: "text", text: JSON.stringify(summary, null, 2) }];
  for (const image of result.images) {
    content.push(await imageToContent(image));
  }
  return {
    content,
    structuredContent: summary,
  };
}

async function imageToContent(image: GeneratedImage): Promise<ContentBlock> {
  return {
    type: "image",
    data: (await readFile(image.path)).toString("base64"),
    mimeType: image.mimeType,
  };
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`gpt-image-2 MCP server running on stdio with default backend: ${config.defaultBackend}`);
  if (config.defaultBackend === "chatgpt-web" && config.web.mode === "direct") {
    console.error("Starting TypeScript ChatGPT web browser session. Complete login in the opened browser window.");
    void backends["chatgpt-web"]
      .start()
      .then(() => {
        console.error("TypeScript ChatGPT web browser session is ready. Tool calls can now generate images.");
      })
      .catch((error) => {
        console.error("TypeScript ChatGPT web browser startup failed:", error);
      });
  }
}

main().catch((error) => {
  console.error("Fatal error in gpt-image-2 MCP server:", error);
  process.exit(1);
});
