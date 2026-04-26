import type { BackendName, ConversationMode, ImageQuality, OutputFormat } from "../config.js";

export interface BackendStatus {
  backend: BackendName;
  ready: boolean;
  configured: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

export interface GenerateImageArgs {
  prompt: string;
  n: number;
  size?: string;
  quality?: ImageQuality;
  outputFormat: OutputFormat;
  conversationMode: ConversationMode;
  timeoutSeconds: number;
}

export interface GeneratedImage {
  path: string;
  mimeType: string;
  width?: number;
  height?: number;
  sourceUrl?: string;
}

export interface GenerateImageResult {
  status: "saved";
  backend: BackendName;
  prompt: string;
  outputDir: string;
  images: GeneratedImage[];
  primaryImage: GeneratedImage;
  metadata?: Record<string, unknown>;
}

export interface ImageBackend {
  readonly name: BackendName;
  status(): Promise<BackendStatus>;
  generateImage(args: GenerateImageArgs): Promise<GenerateImageResult>;
}

export class BackendUnavailableError extends Error {
  constructor(
    message: string,
    readonly backend: BackendName,
  ) {
    super(message);
    this.name = "BackendUnavailableError";
  }
}
