# gpt-image-2-mcp

MCP server for generating images with selectable backends:

- `api`: official OpenAI API using `gpt-image-2`
- `chatgpt-web`: existing ChatGPT browser automation through the local Python daemon
- `auto`: try the API backend first, then fall back to the web backend only when the API backend is unavailable

The TypeScript MCP server is the main entry point. The Python browser automation remains available for users who prefer ChatGPT web sessions.

## Setup

Install and build the TypeScript server:

```powershell
npm install
npm run build
```

If you want to use the ChatGPT web backend, also install the Python dependencies:

```powershell
uv sync
```

## API Backend

Set an OpenAI API key and run the MCP server over stdio:

```powershell
$env:OPENAI_API_KEY = "sk-..."
$env:GPT_IMAGE_BACKEND = "api"
node dist/index.js
```

Generated images are written to `output/gpt-image-2/` by default. Override with:

```powershell
$env:GPT_IMAGE_OUTPUT_DIR = "C:\path\to\images"
```

## ChatGPT Web Backend

Start the browser daemon first:

```powershell
uv run python chatgpt_image.py browser-daemon
```

Log in to ChatGPT in the opened browser, then press Enter.

In a separate MCP process, select the web backend:

```powershell
$env:GPT_IMAGE_BACKEND = "chatgpt-web"
node dist/index.js
```

The TypeScript server talks to the daemon at `127.0.0.1:8765` by default. Override with:

```powershell
$env:CHATGPT_IMAGE_DAEMON_HOST = "127.0.0.1"
$env:CHATGPT_IMAGE_DAEMON_PORT = "8765"
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
