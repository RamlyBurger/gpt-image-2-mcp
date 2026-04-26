import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { OutputFormat } from "./config.js";

export function nowSlug(date = new Date()): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

export function safeSlug(text: string, maxLength = 42): string {
  const slug = text.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return (slug || "image").slice(0, maxLength).replace(/-+$/g, "") || "image";
}

export function mimeTypeForFormat(format: OutputFormat): string {
  return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}

export function extensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/png":
    default:
      return ".png";
  }
}

export async function createOutputDir(outputRoot: string, prompt: string): Promise<string> {
  const outputDir = path.join(outputRoot, `${nowSlug()}-${safeSlug(prompt)}`);
  await mkdir(outputDir, { recursive: true });
  return outputDir;
}

export async function writeBase64Image(params: {
  base64: string;
  outputDir: string;
  index: number;
  mimeType: string;
}): Promise<string> {
  const ext = extensionForMimeType(params.mimeType);
  const outputPath = path.join(params.outputDir, `image-${params.index.toString().padStart(2, "0")}${ext}`);
  await writeFile(outputPath, Buffer.from(params.base64, "base64"));
  return outputPath;
}

export async function writeMetadata(outputDir: string, metadata: unknown): Promise<void> {
  await writeFile(path.join(outputDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");
}
