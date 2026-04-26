# gpt-image-2-mcp

MCP server for generating images with selectable backends:

- `api`: official OpenAI API using `gpt-image-2`
- `chatgpt-web`: TypeScript ChatGPT browser automation through Patchright
- `auto`: try the API backend first, then fall back to the web backend only when the API backend is unavailable

The TypeScript MCP server is the main entry point. The Python browser daemon remains available as a legacy compatibility mode.

## Setup

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

Generated images are always written to `output/chatgpt-images/`.

## ChatGPT Web Backend

Select the web backend and run the TypeScript MCP server over stdio:

```powershell
$env:GPT_IMAGE_BACKEND = "chatgpt-web"
node dist/index.js
```

When the MCP server starts, it opens a real Chrome/Edge window at ChatGPT. Log in or complete verification there. Once the normal composer is visible, the TypeScript server moves the window off-screen and is ready for tool calls. No TypeScript server port is required.

The browser profile is kept at `.chatgpt-image-mcp/ts-profile` by default, so ChatGPT login can be reused across MCP server restarts. Override with:

```powershell
$env:CHATGPT_WEB_PROFILE_DIR = "C:\path\to\profile"
```

Optional web settings:

```powershell
$env:CHATGPT_WEB_LOGIN_TIMEOUT_SECONDS = "900"
$env:CHATGPT_HIDE_WINDOW = "0"
```

`CHATGPT_HIDE_WINDOW` defaults to enabled. Set it to `0` if you want the browser to stay visible after login.

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

Backend values are `api`, `chatgpt-web`, or `auto`.

Use `conversation_mode="new"` or `conversation_mode="continue"` with the ChatGPT web backend.

## Legacy Python MCP Server

The previous Python MCP server still exists:

```powershell
uv run python chatgpt_image.py serve-mcp --transport streamable-http --port 8005
```

For new installs, prefer the TypeScript server because it supports both backend choices through one MCP surface.
