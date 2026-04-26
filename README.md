# gpt-image-2-mcp

MCP server for generating images with selectable backends:

- `api`: official OpenAI API using `gpt-image-2`
- `chatgpt-web`: TypeScript ChatGPT browser automation through Patchright
- `auto`: try the API backend first, then fall back to the web backend only when the API backend is unavailable

The TypeScript MCP server is the main entry point. The Python browser daemon remains available as a legacy compatibility mode.

## Install In An MCP Client

After this package is published to npm, configure your MCP client to launch it with `npx`:

```json
{
  "mcpServers": {
    "gpt-image-2": {
      "command": "npx",
      "args": ["-y", "gpt-image-2-mcp"],
      "env": {
        "GPT_IMAGE_BACKEND": "chatgpt-web",
        "CHATGPT_WEB_MODE": "direct"
      }
    }
  }
}
```

For API mode, add `OPENAI_API_KEY` and set `GPT_IMAGE_BACKEND` to `api`.

## Local Development

Install and build the TypeScript server:

```powershell
npm install
npm run build
```

## API Backend

Set an OpenAI API key and run the MCP server over stdio:

```powershell
$env:OPENAI_API_KEY = "sk-..."
$env:GPT_IMAGE_BACKEND = "api"
node dist/index.js
```

Generated images are written to the per-user app data directory. Call `backend_status` to inspect the exact `output_root` for the current machine.

## ChatGPT Web Backend

Select the web backend and run the TypeScript MCP server over stdio:

```powershell
$env:GPT_IMAGE_BACKEND = "chatgpt-web"
node dist/index.js
```

When the MCP server starts, it opens a real Chrome/Edge window at ChatGPT. Log in or complete verification there. Once the normal composer is visible, the TypeScript server moves the window off-screen and is ready for tool calls. No TypeScript server port is required.

The browser profile is kept under the same per-user app data directory by default, so ChatGPT login can be reused across MCP server restarts. Override with:

```powershell
$env:CHATGPT_WEB_PROFILE_DIR = "C:\path\to\profile"
```

Optional web settings:

```powershell
$env:CHATGPT_WEB_LOGIN_TIMEOUT_SECONDS = "900"
$env:CHATGPT_HIDE_WINDOW = "0"
```

`CHATGPT_HIDE_WINDOW` defaults to enabled. The browser stays visible for login or verification, then hides after `chatgpt.com` shows either the normal ChatGPT composer page or the authenticated ChatGPT shell from a restored profile. Startup `about:blank` tabs are closed after the ChatGPT tab opens, and delayed blank tabs are cleaned up again during startup. Set it to `0` if you want the browser to stay visible after login.

If the MCP profile is still open from a previous Codex session, startup stops before launching Chrome again. This avoids Chrome adding extra `about:blank` tabs to the already-open profile; close the old MCP Chrome window before starting a new automation session.

You can also control the running browser through the MCP tool:

```json
{ "action": "toggle" }
```

Use `browser_visibility` with `action` set to `show`, `hide`, `toggle`, or `status`. Set `start_browser` to `true` if you want the tool to open the ChatGPT browser when no browser session exists.

## Generated Files

The server does not use a hardcoded user directory. By default it saves generated images under:

```text
Windows: %LOCALAPPDATA%\gpt-image-2-mcp\output\chatgpt-images
macOS:   ~/Library/Application Support/gpt-image-2-mcp/output/chatgpt-images
Linux:   ${XDG_DATA_HOME:-~/.local/share}/gpt-image-2-mcp/output/chatgpt-images
```

`backend_status` returns the exact `output_root` and each `generate_image` result returns the exact `output_dir` and `image_path`.

### Legacy Python Daemon Mode

If you still want the old two-process Python daemon path, install Python dependencies and set daemon mode:

```powershell
uv sync
uv run python chatgpt_image.py browser-daemon
```

Then run the TypeScript MCP server with:

```powershell
$env:CHATGPT_WEB_MODE = "daemon"
$env:GPT_IMAGE_BACKEND = "chatgpt-web"
$env:CHATGPT_IMAGE_DAEMON_HOST = "127.0.0.1"
$env:CHATGPT_IMAGE_DAEMON_PORT = "8765"
node dist/index.js
```

## Tools

- `generate_image(prompt, backend?, n?, size?, quality?, output_format?, conversation_mode?, timeout_seconds?)`
- `backend_status(backend?)`
- `browser_visibility(action?, start_browser?)`

Backend values are `api`, `chatgpt-web`, or `auto`.

Use `conversation_mode="new"` or `conversation_mode="continue"` with the ChatGPT web backend.

## Legacy Python MCP Server

The previous Python MCP server still exists:

```powershell
uv run python chatgpt_image.py serve-mcp --transport streamable-http --port 8005
```

For new installs, prefer the TypeScript server because it supports both backend choices through one MCP surface.
