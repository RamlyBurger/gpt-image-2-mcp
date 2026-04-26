import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { chromium, type BrowserContext, type Page } from "patchright";

import type { AppConfig } from "../config.js";
import { createOutputDir, writeBase64Image, writeMetadata } from "../output.js";
import { BackendUnavailableError, type BackendStatus, type GenerateImageArgs, type GenerateImageResult, type GeneratedImage, type ImageBackend } from "./types.js";

const CHATGPT_URL = "https://chatgpt.com/";
const HIDDEN_WINDOW_LEFT = -32000;
const HIDDEN_WINDOW_TOP = -32000;
const HIDDEN_WINDOW_WIDTH = 1440;
const HIDDEN_WINDOW_HEIGHT = 960;

interface PageState {
  title: string;
  url: string;
  text: string;
}

interface BrowserImage {
  src: string;
  alt: string;
  naturalWidth: number;
  naturalHeight: number;
  displayWidth: number;
  displayHeight: number;
}

interface DirectSessionStatus {
  ready: boolean;
  starting: boolean;
  mode: "direct-typescript-browser";
  session_reused: boolean;
  profile_dir: string;
  last_error?: string;
}

interface WebGenerateResult {
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
}

type DaemonResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error_type?: string; error?: string };

export class ChatGptWebBackend implements ImageBackend {
  readonly name = "chatgpt-web" as const;
  private readonly directSession: DirectChatGptBrowserSession;

  constructor(private readonly config: AppConfig) {
    this.directSession = new DirectChatGptBrowserSession(config);
  }

  start(): Promise<void> {
    if (this.config.web.mode === "daemon") {
      return Promise.resolve();
    }
    return this.directSession.start();
  }

  async status(): Promise<BackendStatus> {
    if (this.config.web.mode === "daemon") {
      return this.daemonStatus();
    }

    const session = await this.directSession.status();
    return {
      backend: this.name,
      configured: true,
      ready: session.ready,
      message: directStatusMessage(session),
      details: {
        mode: "direct",
        profile_dir: this.config.web.profileDir,
        hide_window: this.config.web.hideWindow,
        login_timeout_seconds: this.config.web.loginTimeoutSeconds,
        session,
      },
    };
  }

  async generateImage(args: GenerateImageArgs): Promise<GenerateImageResult> {
    if (this.config.web.mode === "daemon") {
      return this.generateViaDaemon(args);
    }

    return this.directSession.generate({
      prompt: args.prompt,
      timeoutSeconds: args.timeoutSeconds,
      maxImages: args.n,
      conversationMode: args.conversationMode,
    });
  }

  private async daemonStatus(): Promise<BackendStatus> {
    try {
      const daemon = await this.daemonRequest<Record<string, unknown>>("status", undefined, 30);
      return {
        backend: this.name,
        configured: true,
        ready: true,
        message: "Legacy Python browser daemon is reachable.",
        details: {
          mode: "daemon",
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
          mode: "daemon",
          daemon_host: this.config.web.daemonHost,
          daemon_port: this.config.web.daemonPort,
        },
      };
    }
  }

  private async generateViaDaemon(args: GenerateImageArgs): Promise<GenerateImageResult> {
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
        mode: "daemon",
        session_reused: result.session_reused,
        conversation_mode: result.conversation_mode,
      },
    };
  }

  private daemonRequest<T>(action: string, payload?: Record<string, unknown>, timeoutSeconds = 900): Promise<T> {
    return new Promise((resolve, reject) => {
      import("node:net")
        .then((net) => {
          const socket = net.createConnection({
            host: this.config.web.daemonHost,
            port: this.config.web.daemonPort,
          });
          let buffer = "";
          let settled = false;

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

          const timeout = setTimeout(() => {
            finish(new BackendUnavailableError(`Browser daemon request timed out after ${timeoutSeconds}s.`, this.name));
          }, timeoutSeconds * 1000);

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
          socket.on("error", () => {
            finish(new BackendUnavailableError(`Browser daemon is not running at ${this.config.web.daemonHost}:${this.config.web.daemonPort}.`, this.name));
          });
        })
        .catch((error) => reject(error instanceof Error ? error : new Error(String(error))));
    });
  }
}

class DirectChatGptBrowserSession {
  private context?: BrowserContext;
  private page?: Page;
  private lock = Promise.resolve();
  private startup?: Promise<void>;
  private lastError?: string;

  constructor(private readonly config: AppConfig) {}

  get ready(): boolean {
    return Boolean(this.page && !this.page.isClosed());
  }

  async status(): Promise<DirectSessionStatus> {
    return {
      ready: this.ready,
      starting: Boolean(this.startup),
      mode: "direct-typescript-browser",
      session_reused: this.ready,
      profile_dir: this.config.web.profileDir,
      last_error: this.lastError,
    };
  }

  start(): Promise<void> {
    if (this.ready) {
      return Promise.resolve();
    }
    if (!this.startup) {
      this.lastError = undefined;
      this.startup = this.ensureStarted()
        .catch((error) => {
          this.lastError = error instanceof Error ? error.message : String(error);
          throw error;
        })
        .finally(() => {
          this.startup = undefined;
        });
    }
    return this.startup;
  }

  async generate(params: {
    prompt: string;
    timeoutSeconds: number;
    maxImages: number;
    conversationMode: "new" | "continue";
  }): Promise<GenerateImageResult> {
    await this.start();
    if (!this.page) {
      throw new BackendUnavailableError("TypeScript ChatGPT browser session did not start.", "chatgpt-web");
    }
    const page = this.page;
    return this.runExclusive(async () => {
      await waitForComposer(page, this.config.web.loginTimeoutSeconds);
      return sendPromptAndExport(page, this.config, {
        prompt: params.prompt,
        timeoutSeconds: params.timeoutSeconds,
        maxImages: params.maxImages,
        conversationMode: params.conversationMode,
        sessionReused: true,
      });
    });
  }

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async ensureStarted(): Promise<void> {
    if (this.ready) {
      return;
    }

    await mkdir(this.config.web.profileDir, { recursive: true });
    const commonOptions = {
      headless: false,
      acceptDownloads: true,
      viewport: null,
    };

    try {
      this.context = await chromium.launchPersistentContext(this.config.web.profileDir, {
        ...commonOptions,
        channel: "chrome",
      });
    } catch {
      this.context = await chromium.launchPersistentContext(this.config.web.profileDir, {
        ...commonOptions,
        executablePath: findChrome(),
      });
    }

    this.page = this.context.pages()[0] || (await this.context.newPage());
    this.page.setDefaultTimeout(30_000);
    await this.page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await this.page.waitForTimeout(2500);

    if (!(await composerReady(this.page))) {
      console.error("ChatGPT browser opened. Log in or complete verification in that browser window.");
      console.error("The MCP server will be ready for ChatGPT web tool calls once the normal ChatGPT composer is visible.");
    }

    await waitForComposer(this.page, this.config.web.loginTimeoutSeconds);
    if (this.config.web.hideWindow) {
      await moveWindowOffscreen(this.page);
    }
  }
}

function directStatusMessage(session: DirectSessionStatus): string {
  if (session.ready) {
    return "TypeScript ChatGPT browser session is ready.";
  }
  if (session.starting) {
    return "TypeScript ChatGPT browser is starting. Complete ChatGPT login or verification in the opened browser window.";
  }
  if (session.last_error) {
    return `TypeScript ChatGPT browser startup failed: ${session.last_error}`;
  }
  return "TypeScript ChatGPT browser automation is configured but has not started.";
}

class LoginRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginRequiredError";
  }
}

class ImageGenerationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageGenerationRefusedError";
  }
}

function findChrome(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : undefined,
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  throw new BackendUnavailableError("Chrome or Edge executable not found. Set CHROME_PATH to the browser executable.", "chatgpt-web");
}

async function moveWindowOffscreen(page: Page): Promise<void> {
  try {
    const cdp = await page.context().newCDPSession(page);
    const window = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
    await cdp.send("Browser.setWindowBounds", {
      windowId: window.windowId,
      bounds: { windowState: "normal" },
    });
    await cdp.send("Browser.setWindowBounds", {
      windowId: window.windowId,
      bounds: {
        left: HIDDEN_WINDOW_LEFT,
        top: HIDDEN_WINDOW_TOP,
        width: HIDDEN_WINDOW_WIDTH,
        height: HIDDEN_WINDOW_HEIGHT,
      },
    });
  } catch {
    // Off-screen movement is cosmetic. Keep generation usable if CDP window control fails.
  }
}

async function pageState(page: Page): Promise<PageState> {
  return (await page.evaluate(`() => ({
    title: document.title,
    url: location.href,
    text: (document.body?.innerText || '').slice(0, 3000)
  })`)) as PageState;
}

async function markBestComposer(page: Page): Promise<string | null> {
  return (await page.evaluate(`() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width >= 250 && r.height >= 24 &&
        s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const score = (el) => {
      const r = el.getBoundingClientRect();
      return r.top * 20 + r.width * r.height + (el.tagName === 'TEXTAREA' ? 10000 : 0);
    };
    const candidates = Array.from(document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]'))
      .filter(visible)
      .filter((el) => !String((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || '')).toLowerCase().includes('search'))
      .sort((a, b) => score(b) - score(a));
    const chosen = candidates[0];
    if (!chosen) return null;
    const token = 'chatgpt-image-composer-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    chosen.setAttribute('data-chatgpt-image-composer', token);
    return '[data-chatgpt-image-composer="' + token + '"]';
  }`)) as string | null;
}

async function composerReady(page: Page): Promise<boolean> {
  return (await composerSelectorIfReady(page)) !== null;
}

async function composerSelectorIfReady(page: Page): Promise<string | null> {
  const selector = await markBestComposer(page);
  if (!selector) {
    return null;
  }
  const state = await pageState(page);
  if (/log in|sign up|continue with google|continue with apple/i.test(state.text)) {
    return null;
  }
  return selector;
}

function looksBlocked(state: PageState): boolean {
  const haystack = `${state.title}\n${state.url}\n${state.text}`;
  return /verify you are human|just a moment|captcha|cloudflare|security check/i.test(haystack);
}

function generationFailureReason(state: PageState): string | null {
  const text = state.text || "";
  const patterns = [
    /image we created may violate our guardrails/i,
    /may violate our guardrails/i,
    /similarity to third-party content/i,
    /we're so sorry/i,
    /we(?: are|'re) unable to generate/i,
    /couldn(?:'|')t generate/i,
    /could not generate/i,
    /cannot generate/i,
    /can(?:not|'t) create/i,
    /unable to create/i,
    /this request (?:may )?violate/i,
    /content policy/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) {
      continue;
    }
    const start = Math.max(0, match.index - 180);
    const end = Math.min(text.length, match.index + match[0].length + 360);
    return text.slice(start, end).replace(/\s+/g, " ").trim();
  }
  return null;
}

async function waitForComposer(page: Page, timeoutSeconds: number): Promise<string> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastState: PageState | undefined;
  while (Date.now() < deadline) {
    const selector = await composerSelectorIfReady(page);
    if (selector) {
      return selector;
    }
    try {
      lastState = await pageState(page);
    } catch {
      lastState = undefined;
    }
    await page.waitForTimeout(2000);
  }

  if (lastState && looksBlocked(lastState)) {
    throw new LoginRequiredError("Timed out waiting for ChatGPT verification. Complete verification/login faster, then run the command again.");
  }
  throw new LoginRequiredError("Timed out waiting for ChatGPT login. Log in in the opened browser before the login timeout.");
}

async function openNewChat(page: Page): Promise<void> {
  await waitForComposer(page, 30);
  const selector = (await page.evaluate(`() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width >= 20 && r.height >= 20 &&
        s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const candidates = Array.from(document.querySelectorAll('a,button'))
      .filter(visible)
      .filter((el) => {
        const label = String((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).trim().toLowerCase();
        return /^new chat$/.test(label) || label.includes('new chat');
      });
    const chosen = candidates[0];
    if (!chosen) return null;
    const token = 'chatgpt-image-new-chat-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    chosen.setAttribute('data-chatgpt-image-new-chat', token);
    return '[data-chatgpt-image-new-chat="' + token + '"]';
  }`)) as string | null;
  if (selector) {
    await page.locator(selector).first().click({ force: true });
    await page.waitForTimeout(1500);
  } else {
    await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(1500);
  }
  await waitForComposer(page, 30);
}

async function collectImages(page: Page): Promise<BrowserImage[]> {
  return (await page.evaluate(`() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width >= 160 && r.height >= 160 &&
        s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    return Array.from(document.querySelectorAll('main img'))
      .filter(visible)
      .map((img) => {
        const r = img.getBoundingClientRect();
        return {
          src: img.currentSrc || img.src,
          alt: img.alt || '',
          naturalWidth: img.naturalWidth || 0,
          naturalHeight: img.naturalHeight || 0,
          displayWidth: Math.round(r.width),
          displayHeight: Math.round(r.height)
        };
      })
      .filter((img) => img.src && img.naturalWidth >= 256 && img.naturalHeight >= 256)
      .filter((img) => !/avatar|profile|icon|logo/i.test(img.alt));
  }`)) as BrowserImage[];
}

async function readComposerText(page: Page, selector: string): Promise<string> {
  return (await page.locator(selector).first().evaluate(`(el) => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
    ? el.value
    : (el.innerText || el.textContent || '')`)) as string;
}

async function clickSendNear(page: Page, composerSelector: string): Promise<void> {
  const selector = (await page.evaluate(
    `(sourceSelector) => {
      const source = document.querySelector(sourceSelector);
      if (!source) return null;
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width >= 20 && r.height >= 20 &&
          s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      };
      const sr = source.getBoundingClientRect();
      const sx = sr.left + sr.width / 2;
      const sy = sr.top + sr.height / 2;
      const candidates = Array.from(document.querySelectorAll('button'))
        .filter((button) => visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true')
        .map((button) => {
          const r = button.getBoundingClientRect();
          const label = String((button.getAttribute('aria-label') || '') + ' ' + (button.textContent || '')).toLowerCase();
          return {
            button,
            dist: Math.hypot(r.left + r.width / 2 - sx, r.top + r.height / 2 - sy) +
              (/send|submit|up arrow/.test(label) ? -300 : 0)
          };
        })
        .sort((a, b) => a.dist - b.dist);
      const chosen = candidates[0]?.button;
      if (!chosen) return null;
      const token = 'chatgpt-image-send-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      chosen.setAttribute('data-chatgpt-image-send', token);
      return '[data-chatgpt-image-send="' + token + '"]';
    }`,
    composerSelector,
  )) as string | null;
  if (selector) {
    await page.locator(selector).first().click({ force: true });
  }
}

async function exportImageFromSrc(page: Page, image: BrowserImage, outputDir: string, index: number): Promise<GeneratedImage> {
  const payload = (await page.evaluate(
    `async (src) => {
      const response = await fetch(src);
      if (!response.ok) throw new Error('fetch failed ' + response.status);
      const blob = await response.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('failed to read image blob'));
        reader.readAsDataURL(blob);
      });
      return { dataUrl, mimeType: blob.type || 'image/png' };
    }`,
    image.src,
  )) as { dataUrl: string; mimeType?: string };

  const match = /^data:([^;]+);base64,(.+)$/s.exec(payload.dataUrl);
  if (!match) {
    throw new Error("Image fetch did not return a data URL.");
  }
  const mimeType = payload.mimeType || match[1] || "image/png";
  return {
    path: await writeBase64Image({
      base64: match[2],
      outputDir,
      index,
      mimeType,
    }),
    mimeType,
    width: image.naturalWidth,
    height: image.naturalHeight,
    sourceUrl: image.src,
  };
}

async function sendPromptAndExport(
  page: Page,
  config: AppConfig,
  params: {
    prompt: string;
    timeoutSeconds: number;
    maxImages: number;
    conversationMode: "new" | "continue";
    sessionReused: boolean;
  },
): Promise<GenerateImageResult> {
  const prompt = params.prompt.trim();
  if (!prompt) {
    throw new Error("Prompt cannot be empty.");
  }

  const outputDir = await createOutputDir(config.outputRoot, prompt);
  if (params.conversationMode === "new") {
    await openNewChat(page);
  } else {
    await waitForComposer(page, 30);
  }
  const composerSelector = await waitForComposer(page, 30);
  const knownSources = new Set((await collectImages(page)).map((image) => image.src));

  const composer = page.locator(composerSelector).first();
  await composer.click({ force: true });
  try {
    await composer.fill(prompt);
  } catch {
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.insertText(prompt);
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  if ((await readComposerText(page, composerSelector)).trim()) {
    await clickSendNear(page, composerSelector);
  }

  const deadline = Date.now() + params.timeoutSeconds * 1000;
  let exported: GeneratedImage[] = [];
  while (Date.now() < deadline) {
    const state = await pageState(page);
    if (looksBlocked(state)) {
      await page.waitForTimeout(2500);
      continue;
    }

    const failureReason = generationFailureReason(state);
    if (failureReason) {
      const diagnostic = path.join(outputDir, "diagnostic-refusal.png");
      await page.screenshot({ path: diagnostic, fullPage: true });
      throw new ImageGenerationRefusedError(`${failureReason} Diagnostic screenshot: ${diagnostic}`);
    }

    const fresh = (await collectImages(page)).filter((image) => !knownSources.has(image.src));
    if (fresh.length === 0) {
      await page.waitForTimeout(2500);
      continue;
    }

    await page.waitForTimeout(1500);
    const finalFresh = (await collectImages(page)).filter((image) => !knownSources.has(image.src));
    const selected = (finalFresh.length > 0 ? finalFresh : fresh)
      .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight)
      .slice(0, params.maxImages);

    exported = await Promise.all(selected.map((image, index) => exportImageFromSrc(page, image, outputDir, index + 1)));
    break;
  }

  if (exported.length === 0) {
    const diagnostic = path.join(outputDir, "diagnostic-timeout.png");
    await page.screenshot({ path: diagnostic, fullPage: true });
    throw new Error(`Timed out waiting for an image. Diagnostic screenshot: ${diagnostic}`);
  }

  const metadata = {
    backend: "chatgpt-web",
    mode: "direct-typescript-browser",
    prompt,
    created_at: new Date().toISOString(),
    images: exported,
    session_reused: params.sessionReused,
    conversation_mode: params.conversationMode,
    profile_dir: config.web.profileDir,
  };
  await writeMetadata(outputDir, metadata);

  return {
    status: "saved",
    backend: "chatgpt-web",
    prompt,
    outputDir,
    images: exported,
    primaryImage: exported[0],
    metadata: {
      mode: "direct-typescript-browser",
      session_reused: params.sessionReused,
      conversation_mode: params.conversationMode,
      profile_dir: config.web.profileDir,
    },
  };
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
