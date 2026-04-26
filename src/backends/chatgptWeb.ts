import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { chromium, type BrowserContext, type Page } from "patchright";

import type { AppConfig } from "../config.js";
import { createOutputDir, writeBase64Image, writeMetadata } from "../output.js";
import { BackendUnavailableError, type BackendStatus, type GenerateImageArgs, type GenerateImageResult, type GeneratedImage, type ImageBackend } from "./types.js";

const CHATGPT_URL = "https://chatgpt.com/";
const HIDDEN_WINDOW_LEFT = -32000;
const HIDDEN_WINDOW_TOP = -32000;
const HIDDEN_WINDOW_WIDTH = 1440;
const HIDDEN_WINDOW_HEIGHT = 960;
const VISIBLE_WINDOW_LEFT = 80;
const VISIBLE_WINDOW_TOP = 80;
const VISIBLE_WINDOW_WIDTH = 1280;
const VISIBLE_WINDOW_HEIGHT = 900;
const execFileAsync = promisify(execFile);

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

interface ChatPageReadiness {
  ready: boolean;
  hideReady: boolean;
  composerSelector?: string;
  state?: PageState;
  reason?: string;
  hideReason?: string;
}

interface BrowserHideResult {
  hidden: boolean;
  method?: "offscreen" | "minimized";
  bounds?: Record<string, unknown>;
  previousBounds?: Record<string, unknown>;
  error?: string;
}

interface BrowserShowResult {
  visible: boolean;
  method?: "window-bounds" | "bring-to-front";
  bounds?: Record<string, unknown>;
  error?: string;
}

interface BrowserProfileOwner {
  pid: number;
  processName: string;
}

export type BrowserVisibilityAction = "show" | "hide" | "toggle" | "status";

export interface BrowserVisibilityOptions {
  action: BrowserVisibilityAction;
  startBrowser: boolean;
}

export interface BrowserVisibilityStatus {
  backend: "chatgpt-web";
  mode: "direct" | "daemon";
  supported: boolean;
  requested_action: BrowserVisibilityAction;
  applied_action?: Exclude<BrowserVisibilityAction, "status" | "toggle">;
  default_hide_window: boolean;
  hide_window: boolean;
  browser_open: boolean;
  chat_ready: boolean;
  hide_ready: boolean;
  hidden: boolean;
  visible: boolean;
  hide_attempted: boolean;
  hide_method?: string;
  hide_error?: string;
  show_method?: string;
  show_error?: string;
  current_url?: string;
  message: string;
}

interface DirectSessionStatus {
  ready: boolean;
  starting: boolean;
  mode: "direct-typescript-browser";
  session_reused: boolean;
  profile_dir: string;
  browser_open: boolean;
  chat_ready: boolean;
  hide_ready: boolean;
  default_hide_window: boolean;
  hide_window: boolean;
  hidden: boolean;
  hide_attempted: boolean;
  hide_method?: string;
  hide_error?: string;
  current_url?: string;
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
        output_root: this.config.outputRoot,
        profile_dir: this.config.web.profileDir,
        default_hide_window: this.config.web.hideWindow,
        hide_window: session.hide_window,
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

  async close(): Promise<void> {
    if (this.config.web.mode === "direct") {
      await this.directSession.close();
    }
  }

  async browserVisibility(options: BrowserVisibilityOptions): Promise<BrowserVisibilityStatus> {
    if (this.config.web.mode === "daemon") {
      return {
        backend: this.name,
        mode: "daemon",
        supported: false,
        requested_action: options.action,
        default_hide_window: this.config.web.hideWindow,
        hide_window: this.config.web.hideWindow,
        browser_open: false,
        chat_ready: false,
        hide_ready: false,
        hidden: false,
        visible: false,
        hide_attempted: false,
        message: "Browser visibility control is only available for direct TypeScript browser mode.",
      };
    }

    return this.directSession.browserVisibility(options);
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
          output_root: this.config.outputRoot,
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
          output_root: this.config.outputRoot,
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
  private chatReady = false;
  private hideReady = false;
  private hideWindowEnabled: boolean;
  private hidden = false;
  private hideAttempted = false;
  private hideMethod?: string;
  private hideError?: string;
  private showMethod?: string;
  private showError?: string;
  private lastVisibleBounds?: Record<string, unknown>;
  private blankPageCleanupContext?: BrowserContext;

  constructor(private readonly config: AppConfig) {
    this.hideWindowEnabled = config.web.hideWindow;
  }

  private get browserOpen(): boolean {
    return Boolean(this.page && !this.page.isClosed());
  }

  get ready(): boolean {
    return this.browserOpen && this.chatReady;
  }

  async status(): Promise<DirectSessionStatus> {
    if (this.browserOpen && !this.startup) {
      try {
        await this.refreshChatReadiness("status");
      } catch (error) {
        this.chatReady = false;
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      ready: this.ready,
      starting: Boolean(this.startup),
      mode: "direct-typescript-browser",
      session_reused: this.browserOpen,
      profile_dir: this.config.web.profileDir,
      browser_open: this.browserOpen,
      chat_ready: this.chatReady,
      hide_ready: this.hideReady,
      default_hide_window: this.config.web.hideWindow,
      hide_window: this.hideWindowEnabled,
      hidden: this.hidden,
      hide_attempted: this.hideAttempted,
      hide_method: this.hideMethod,
      hide_error: this.hideError,
      current_url: this.browserOpen ? safePageUrl(this.page) : undefined,
      last_error: this.lastError,
    };
  }

  start(): Promise<void> {
    if (this.ready) {
      void this.hideWindowIfConfigured("already-ready").catch((error) => {
        this.hideError = error instanceof Error ? error.message : String(error);
      });
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

  async browserVisibility(options: BrowserVisibilityOptions): Promise<BrowserVisibilityStatus> {
    return this.runExclusive(async () => {
      const requestedAction = options.action;
      let appliedAction: "show" | "hide" | undefined;
      let message = "Browser visibility status returned.";

      if (requestedAction === "toggle") {
        appliedAction = this.hidden ? "show" : "hide";
      } else if (requestedAction === "show" || requestedAction === "hide") {
        appliedAction = requestedAction;
      }

      if (appliedAction === "show") {
        this.hideWindowEnabled = false;
        if (!this.browserOpen && options.startBrowser) {
          await this.start();
        }
        if (this.browserOpen && this.page) {
          await this.showBrowserWindow();
          message = this.hidden ? "Browser show was requested, but the browser could not be restored." : "Browser window is visible.";
        } else {
          message = "Browser will remain visible when the ChatGPT web session starts.";
        }
      } else if (appliedAction === "hide") {
        this.hideWindowEnabled = true;
        if (!this.browserOpen && options.startBrowser) {
          await this.start();
        } else if (this.browserOpen && this.page) {
          await this.refreshChatReadiness("visibility-hide");
          if (this.hideReady) {
            await this.hideWindowIfConfigured("visibility-hide");
          }
        }

        if (!this.browserOpen) {
          message = "Browser will hide after the ChatGPT web session starts and reaches the composer page.";
        } else if (!this.hideReady) {
          message = "Browser will hide after ChatGPT login or verification reaches the composer page.";
        } else if (this.hidden) {
          message = "Browser window is hidden.";
        } else {
          message = "Browser hide was requested, but the browser could not be hidden.";
        }
      } else if (this.browserOpen) {
        await this.refreshChatReadiness("visibility-status");
      }

      return this.visibilityStatus(requestedAction, appliedAction, message);
    });
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
      await this.waitForComposerWithHide(page, this.config.web.loginTimeoutSeconds, "before-generate");
      await this.hideWindowIfConfigured("before-generate");
      return sendPromptAndExport(page, this.config, {
        prompt: params.prompt,
        timeoutSeconds: params.timeoutSeconds,
        maxImages: params.maxImages,
        conversationMode: params.conversationMode,
        sessionReused: true,
      });
    });
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    this.chatReady = false;
    this.hideReady = false;
    this.hidden = false;
    this.startup = undefined;
    this.blankPageCleanupContext = undefined;
    if (context) {
      try {
        await context.close();
      } catch {
        // Shutdown should be best-effort; the process may already be exiting.
      }
    }
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
      await this.hideWindowIfConfigured("already-started");
      return;
    }

    if (!this.browserOpen) {
      await mkdir(this.config.web.profileDir, { recursive: true });
      const profileOwner = await findBrowserProfileOwner(this.config.web.profileDir);
      if (profileOwner) {
        throw profileAlreadyOpenError(this.config.web.profileDir, profileOwner);
      }
      const commonOptions = {
        headless: false,
        acceptDownloads: true,
        viewport: null,
        ignoreDefaultArgs: ["about:blank"],
      };

      try {
        this.context = await chromium.launchPersistentContext(this.config.web.profileDir, {
          ...commonOptions,
          channel: "chrome",
        });
      } catch (error) {
        if (isExistingBrowserSessionError(error)) {
          const owner = await findBrowserProfileOwner(this.config.web.profileDir);
          throw profileAlreadyOpenError(this.config.web.profileDir, owner);
        }
        try {
          this.context = await chromium.launchPersistentContext(this.config.web.profileDir, {
            ...commonOptions,
            executablePath: findChrome(),
          });
        } catch (fallbackError) {
          if (isExistingBrowserSessionError(fallbackError)) {
            const owner = await findBrowserProfileOwner(this.config.web.profileDir);
            throw profileAlreadyOpenError(this.config.web.profileDir, owner);
          }
          throw fallbackError;
        }
      }

      this.page = (await selectStartupPage(this.context)) || (await this.context.newPage());
      this.installBlankPageCleanup(this.context);
      this.scheduleBlankPageCleanup("startup");
      this.hidden = false;
      this.hideAttempted = false;
      this.hideMethod = undefined;
      this.hideError = undefined;
      this.hideReady = false;
      this.chatReady = false;
    }

    const page = this.page;
    if (!page) {
      throw new BackendUnavailableError("TypeScript ChatGPT browser page was not created.", "chatgpt-web");
    }

    page.setDefaultTimeout(30_000);
    await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(2500);
    await this.closeExtraBlankPages("post-navigation");
    const readiness = await this.refreshChatReadiness("post-navigation");

    if (!readiness?.hideReady) {
      console.error("ChatGPT browser opened. Log in or complete verification in that browser window.");
      console.error("The MCP server will hide the browser after chatgpt.com shows the normal ChatGPT composer page.");
    }

    await this.waitForComposerWithHide(page, this.config.web.loginTimeoutSeconds, "startup");
    await this.closeExtraBlankPages("composer-ready");
    await this.hideWindowIfConfigured("login-complete");
  }

  private installBlankPageCleanup(context: BrowserContext): void {
    if (this.blankPageCleanupContext === context) {
      return;
    }
    this.blankPageCleanupContext = context;
    context.on("page", () => {
      this.scheduleBlankPageCleanup("new-page");
    });
  }

  private scheduleBlankPageCleanup(reason: string): void {
    for (const delay of [250, 1500, 5000, 15_000, 30_000]) {
      const timer = setTimeout(() => {
        void this.closeExtraBlankPages(reason).catch(() => undefined);
      }, delay);
      timer.unref?.();
    }
  }

  private async closeExtraBlankPages(reason: string): Promise<void> {
    if (!this.context || !this.page || this.page.isClosed()) {
      return;
    }
    try {
      await closeExtraBlankPages(this.context, this.page);
    } catch (error) {
      console.error(`Failed to close extra blank ChatGPT browser tabs during ${reason}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async waitForComposerWithHide(page: Page, timeoutSeconds: number, reason: string): Promise<string> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let lastReadiness: ChatPageReadiness | undefined;
    while (Date.now() < deadline) {
      try {
        await this.closeExtraBlankPages(`${reason}-poll`);
        lastReadiness = await chatPageReadiness(page);
        this.chatReady = lastReadiness.ready;
        this.hideReady = lastReadiness.hideReady;
        if (lastReadiness.hideReady) {
          await this.hideWindowIfConfigured(lastReadiness.hideReason || reason);
        }
        if (lastReadiness.ready && lastReadiness.composerSelector) {
          return lastReadiness.composerSelector;
        }
      } catch {
        lastReadiness = undefined;
      }
      await page.waitForTimeout(2000);
    }

    if (lastReadiness?.state && looksBlocked(lastReadiness.state)) {
      throw new LoginRequiredError("Timed out waiting for ChatGPT verification. Complete verification/login faster, then run the command again.");
    }
    const detail = lastReadiness?.reason ? ` Last observed state: ${lastReadiness.reason}.` : "";
    throw new LoginRequiredError(`Timed out waiting for ChatGPT login. Log in in the opened browser before the login timeout.${detail}`);
  }

  private async refreshChatReadiness(reason: string): Promise<ChatPageReadiness | undefined> {
    if (!this.browserOpen || !this.page) {
      this.chatReady = false;
      this.hideReady = false;
      this.hidden = false;
      return undefined;
    }

    const readiness = await chatPageReadiness(this.page);
    this.chatReady = readiness.ready;
    this.hideReady = readiness.hideReady;
    if (readiness.hideReady) {
      await this.hideWindowIfConfigured(reason);
    }
    return readiness;
  }

  private async hideWindowIfConfigured(reason: string): Promise<void> {
    if (!this.hideWindowEnabled || !this.hideReady || !this.page || this.page.isClosed() || this.hidden) {
      return;
    }

    this.hideAttempted = true;
    const result = await hideBrowserWindow(this.page);
    this.hidden = result.hidden;
    this.hideMethod = result.method;
    this.hideError = result.error;
    if (result.previousBounds && !hiddenBounds(result.previousBounds)) {
      this.lastVisibleBounds = result.previousBounds;
    }

    if (result.hidden) {
      console.error(`ChatGPT browser hidden after ${reason} using ${result.method}.`);
      return;
    }
    if (result.error) {
      console.error(`ChatGPT browser hide failed after ${reason}: ${result.error}`);
    }
  }

  private async showBrowserWindow(): Promise<void> {
    if (!this.page || this.page.isClosed()) {
      return;
    }

    const result = await showBrowserWindow(this.page, this.lastVisibleBounds);
    this.hidden = !result.visible;
    this.showMethod = result.method;
    this.showError = result.error;
    if (result.bounds && !hiddenBounds(result.bounds)) {
      this.lastVisibleBounds = result.bounds;
    }
    if (result.visible) {
      this.hideMethod = undefined;
      this.hideError = undefined;
    }
  }

  private visibilityStatus(
    requestedAction: BrowserVisibilityAction,
    appliedAction: "show" | "hide" | undefined,
    message: string,
  ): BrowserVisibilityStatus {
    return {
      backend: "chatgpt-web",
      mode: "direct",
      supported: true,
      requested_action: requestedAction,
      applied_action: appliedAction,
      default_hide_window: this.config.web.hideWindow,
      hide_window: this.hideWindowEnabled,
      browser_open: this.browserOpen,
      chat_ready: this.chatReady,
      hide_ready: this.hideReady,
      hidden: this.hidden,
      visible: this.browserOpen && !this.hidden,
      hide_attempted: this.hideAttempted,
      hide_method: this.hideMethod,
      hide_error: this.hideError,
      show_method: this.showMethod,
      show_error: this.showError,
      current_url: this.browserOpen ? safePageUrl(this.page) : undefined,
      message,
    };
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

async function findBrowserProfileOwner(profileDir: string): Promise<BrowserProfileOwner | undefined> {
  if (process.platform !== "win32") {
    return undefined;
  }

  const script = `
$ErrorActionPreference = 'Stop'
$profileDir = [System.IO.Path]::GetFullPath($env:CHATGPT_WEB_PROFILE_OWNER_DIR).TrimEnd('\\').ToLowerInvariant()
$owner = Get-CimInstance Win32_Process -Filter "name = 'chrome.exe' OR name = 'msedge.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($profileDir) } |
  Sort-Object @{ Expression = { if ($_.CommandLine -match '\\s--type=') { 1 } else { 0 } } }, ProcessId |
  Select-Object -First 1 @{ Name = 'pid'; Expression = { $_.ProcessId } }, @{ Name = 'processName'; Expression = { $_.Name } }
if ($owner) { $owner | ConvertTo-Json -Compress }
`;

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CHATGPT_WEB_PROFILE_OWNER_DIR: profileDir,
        },
        timeout: 5000,
        windowsHide: true,
      },
    );
    const trimmed = stdout.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = JSON.parse(trimmed) as Partial<BrowserProfileOwner>;
    return typeof parsed.pid === "number" && typeof parsed.processName === "string" ? { pid: parsed.pid, processName: parsed.processName } : undefined;
  } catch {
    return undefined;
  }
}

function profileAlreadyOpenError(profileDir: string, owner?: BrowserProfileOwner): BackendUnavailableError {
  const ownerText = owner ? `${owner.processName} PID ${owner.pid}` : "another Chrome or Edge process";
  return new BackendUnavailableError(
    `The ChatGPT browser profile is already open in ${ownerText}. The MCP did not launch another browser because Chrome would add extra about:blank tabs to the existing profile. Close the existing MCP Chrome window, then restart Codex or call the MCP again. Profile: ${profileDir}`,
    "chatgpt-web",
  );
}

function isExistingBrowserSessionError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /Opening in existing browser session/i.test(text);
}

function isChatGptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return hostname === "chatgpt.com" || hostname === "www.chatgpt.com";
  } catch {
    return false;
  }
}

function isBlankStartupUrl(value: string): boolean {
  return value === "about:blank" || value.startsWith("chrome://new-tab") || value.startsWith("edge://new-tab");
}

function safePageUrl(page?: Page): string {
  if (!page || page.isClosed()) {
    return "";
  }
  try {
    return page.url();
  } catch {
    return "";
  }
}

async function selectStartupPage(context: BrowserContext): Promise<Page | undefined> {
  const pages = context.pages().filter((page) => !page.isClosed());
  return pages.find((page) => isChatGptUrl(safePageUrl(page))) || pages.find((page) => isBlankStartupUrl(safePageUrl(page))) || pages[0];
}

async function closeExtraBlankPages(context: BrowserContext, keepPage: Page): Promise<void> {
  await Promise.all(
    context
      .pages()
      .filter((page) => page !== keepPage && !page.isClosed() && isBlankStartupUrl(safePageUrl(page)))
      .map(async (page) => {
        try {
          await page.close();
        } catch {
          // Blank startup tabs are cosmetic; failing to close one should not block login or generation.
        }
      }),
  );
}

function hiddenBounds(bounds?: Record<string, unknown>): boolean {
  if (!bounds) {
    return false;
  }
  return bounds.windowState === "minimized" || (typeof bounds.left === "number" && bounds.left <= -10_000);
}

function visibleWindowBounds(previousBounds?: Record<string, unknown>): Record<string, unknown> {
  const left = typeof previousBounds?.left === "number" && previousBounds.left > -10_000 ? previousBounds.left : VISIBLE_WINDOW_LEFT;
  const top = typeof previousBounds?.top === "number" && previousBounds.top > -10_000 ? previousBounds.top : VISIBLE_WINDOW_TOP;
  const width = typeof previousBounds?.width === "number" && previousBounds.width >= 640 ? previousBounds.width : VISIBLE_WINDOW_WIDTH;
  const height = typeof previousBounds?.height === "number" && previousBounds.height >= 480 ? previousBounds.height : VISIBLE_WINDOW_HEIGHT;
  return { left, top, width, height };
}

async function hideBrowserWindow(page: Page): Promise<BrowserHideResult> {
  try {
    const cdp = await page.context().newCDPSession(page);
    const targetWindow = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
    const before = (await cdp.send("Browser.getWindowBounds", { windowId: targetWindow.windowId })) as { bounds?: Record<string, unknown> };
    await cdp.send("Browser.setWindowBounds", {
      windowId: targetWindow.windowId,
      bounds: { windowState: "normal" },
    });
    await cdp.send("Browser.setWindowBounds", {
      windowId: targetWindow.windowId,
      bounds: {
        left: HIDDEN_WINDOW_LEFT,
        top: HIDDEN_WINDOW_TOP,
        width: HIDDEN_WINDOW_WIDTH,
        height: HIDDEN_WINDOW_HEIGHT,
      },
    });
    await page.waitForTimeout(250);
    const offscreen = (await cdp.send("Browser.getWindowBounds", { windowId: targetWindow.windowId })) as { bounds?: Record<string, unknown> };
    if (hiddenBounds(offscreen.bounds)) {
      return { hidden: true, method: "offscreen", bounds: offscreen.bounds, previousBounds: before.bounds };
    }

    await cdp.send("Browser.setWindowBounds", {
      windowId: targetWindow.windowId,
      bounds: { windowState: "minimized" },
    });
    await page.waitForTimeout(250);
    const minimized = (await cdp.send("Browser.getWindowBounds", { windowId: targetWindow.windowId })) as { bounds?: Record<string, unknown> };
    return {
      hidden: hiddenBounds(minimized.bounds),
      method: hiddenBounds(minimized.bounds) ? "minimized" : undefined,
      bounds: minimized.bounds,
      previousBounds: before.bounds,
      error: hiddenBounds(minimized.bounds) ? undefined : "CDP accepted hide commands but the browser window remained visible.",
    };
  } catch (error) {
    return {
      hidden: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function showBrowserWindow(page: Page, previousBounds?: Record<string, unknown>): Promise<BrowserShowResult> {
  try {
    const cdp = await page.context().newCDPSession(page);
    const targetWindow = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
    const visibleBounds = visibleWindowBounds(previousBounds);
    await cdp.send("Browser.setWindowBounds", {
      windowId: targetWindow.windowId,
      bounds: { windowState: "normal" },
    });
    await cdp.send("Browser.setWindowBounds", {
      windowId: targetWindow.windowId,
      bounds: visibleBounds,
    });
    await page.bringToFront();
    await page.waitForTimeout(250);
    const after = (await cdp.send("Browser.getWindowBounds", { windowId: targetWindow.windowId })) as { bounds?: Record<string, unknown> };
    return {
      visible: !hiddenBounds(after.bounds),
      method: "window-bounds",
      bounds: after.bounds,
      error: hiddenBounds(after.bounds) ? "CDP accepted show commands but the browser window remained hidden." : undefined,
    };
  } catch (error) {
    try {
      await page.bringToFront();
      return { visible: true, method: "bring-to-front" };
    } catch {
      return {
        visible: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

async function pageState(page: Page): Promise<PageState> {
  return (await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    text: (document.body?.innerText || "").slice(0, 3000),
  }))) as PageState;
}

async function markBestComposer(page: Page): Promise<string | null> {
  return (await page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width >= 250 && r.height >= 24 && s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
    };
    const score = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.top * 20 + r.width * r.height + (el.tagName === "TEXTAREA" ? 10000 : 0);
    };
    const candidates = Array.from(document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]'))
      .filter(visible)
      .filter((el) => !String((el.getAttribute("aria-label") || "") + " " + (el.getAttribute("placeholder") || "")).toLowerCase().includes("search"))
      .sort((a, b) => score(b) - score(a));
    const chosen = candidates[0];
    if (!chosen) return null;
    const token = "chatgpt-image-composer-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    chosen.setAttribute("data-chatgpt-image-composer", token);
    return '[data-chatgpt-image-composer="' + token + '"]';
  })) as string | null;
}

async function composerSelectorIfReady(page: Page): Promise<string | null> {
  return markBestComposer(page);
}

function isChatGptChatPageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!isChatGptUrl(value)) {
      return false;
    }
    const pathname = url.pathname.toLowerCase();
    return !["/auth", "/login", "/signup", "/signin", "/sign-in", "/api/auth"].some((prefix) => pathname.startsWith(prefix));
  } catch {
    return false;
  }
}

async function chatPageReadiness(page: Page): Promise<ChatPageReadiness> {
  const state = await pageState(page);
  if (!isChatGptChatPageUrl(state.url)) {
    return { ready: false, hideReady: false, state, reason: "not-chatgpt-chat-url" };
  }
  if (looksBlocked(state)) {
    return { ready: false, hideReady: false, state, reason: "verification-or-security-check" };
  }
  const composerSelector = await composerSelectorIfReady(page);
  const authenticatedShell = looksAuthenticatedChatShell(state);
  if (composerSelector) {
    return { ready: true, hideReady: true, composerSelector, state, hideReason: "composer-visible" };
  }
  if (authenticatedShell) {
    return { ready: false, hideReady: true, state, reason: "composer-not-visible", hideReason: "authenticated-chat-shell" };
  }
  if (looksLikeLoginPrompt(state)) {
    return { ready: false, hideReady: false, state, reason: "login-prompt-visible" };
  }
  return { ready: false, hideReady: false, state, reason: "composer-not-visible" };
}

async function chatPageReady(page: Page): Promise<boolean> {
  return (await chatPageReadiness(page)).ready;
}

function looksAuthenticatedChatShell(state: PageState): boolean {
  const haystack = `${state.title}\n${state.text}`;
  const markers = [
    /\bnew chat\b/i,
    /\bsearch chats\b/i,
    /\blibrary\b/i,
    /\brecents\b/i,
    /\bgpts\b/i,
    /\bprojects\b/i,
    /\bask anything\b/i,
    /\bwhat are you working on\?/i,
    /chatgpt can make mistakes/i,
  ];
  return markers.filter((marker) => marker.test(haystack)).length >= 2;
}

function looksLikeLoginPrompt(state: PageState): boolean {
  const haystack = `${state.title}\n${state.url}\n${state.text}`;
  return /continue with google|continue with apple|email address|log in|sign up/i.test(haystack);
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
  let lastReadiness: ChatPageReadiness | undefined;
  while (Date.now() < deadline) {
    try {
      lastReadiness = await chatPageReadiness(page);
      if (lastReadiness.ready && lastReadiness.composerSelector) {
        return lastReadiness.composerSelector;
      }
    } catch {
      lastReadiness = undefined;
    }
    await page.waitForTimeout(2000);
  }

  if (lastReadiness?.state && looksBlocked(lastReadiness.state)) {
    throw new LoginRequiredError("Timed out waiting for ChatGPT verification. Complete verification/login faster, then run the command again.");
  }
  const detail = lastReadiness?.reason ? ` Last observed state: ${lastReadiness.reason}.` : "";
  throw new LoginRequiredError(`Timed out waiting for ChatGPT login. Log in in the opened browser before the login timeout.${detail}`);
}

async function openNewChat(page: Page): Promise<void> {
  await waitForComposer(page, 30);
  const selector = (await page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width >= 20 && r.height >= 20 && s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
    };
    const candidates = Array.from(document.querySelectorAll("a,button"))
      .filter(visible)
      .filter((el) => {
        const label = String((el.getAttribute("aria-label") || "") + " " + (el.textContent || "")).trim().toLowerCase();
        return /^new chat$/.test(label) || label.includes("new chat");
      });
    const chosen = candidates[0];
    if (!chosen) return null;
    const token = "chatgpt-image-new-chat-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    chosen.setAttribute("data-chatgpt-image-new-chat", token);
    return '[data-chatgpt-image-new-chat="' + token + '"]';
  })) as string | null;
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
  return (await page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width >= 160 && r.height >= 160 && s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
    };
    return Array.from(document.querySelectorAll("main img"))
      .filter(visible)
      .map((img) => {
        const image = img as HTMLImageElement;
        const r = img.getBoundingClientRect();
        return {
          src: image.currentSrc || image.src,
          alt: image.alt || "",
          naturalWidth: image.naturalWidth || 0,
          naturalHeight: image.naturalHeight || 0,
          displayWidth: Math.round(r.width),
          displayHeight: Math.round(r.height)
        };
      })
      .filter((img) => img.src && img.naturalWidth >= 256 && img.naturalHeight >= 256)
      .filter((img) => !/avatar|profile|icon|logo/i.test(img.alt));
  })) as BrowserImage[];
}

async function readComposerText(page: Page, selector: string): Promise<string> {
  return (await page
    .locator(selector)
    .first()
    .evaluate((el) => (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : el.textContent || ""))) as string;
}

async function clickSendNear(page: Page, composerSelector: string): Promise<void> {
  const selector = (await page.evaluate(
    (sourceSelector) => {
      const source = document.querySelector(sourceSelector);
      if (!source) return null;
      const visible = (el: HTMLButtonElement) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width >= 20 && r.height >= 20 && s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
      };
      const sr = source.getBoundingClientRect();
      const sx = sr.left + sr.width / 2;
      const sy = sr.top + sr.height / 2;
      const candidates = Array.from(document.querySelectorAll("button"))
        .filter((button) => visible(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true")
        .map((button) => {
          const r = button.getBoundingClientRect();
          const label = String((button.getAttribute("aria-label") || "") + " " + (button.textContent || "")).toLowerCase();
          return {
            button,
            dist: Math.hypot(r.left + r.width / 2 - sx, r.top + r.height / 2 - sy) +
              (/send|submit|up arrow/.test(label) ? -300 : 0)
          };
        })
        .sort((a, b) => a.dist - b.dist);
      const chosen = candidates[0]?.button;
      if (!chosen) return null;
      const token = "chatgpt-image-send-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      chosen.setAttribute("data-chatgpt-image-send", token);
      return '[data-chatgpt-image-send="' + token + '"]';
    },
    composerSelector,
  )) as string | null;
  if (selector) {
    await page.locator(selector).first().click({ force: true });
  }
}

async function exportImageFromSrc(page: Page, image: BrowserImage, outputDir: string, index: number): Promise<GeneratedImage> {
  const payload = (await page.evaluate(
    async (src) => {
      const response = await fetch(src);
      if (!response.ok) throw new Error("fetch failed " + response.status);
      const blob = await response.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("failed to read image blob"));
        reader.readAsDataURL(blob);
      });
      return { dataUrl, mimeType: blob.type || "image/png" };
    },
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
