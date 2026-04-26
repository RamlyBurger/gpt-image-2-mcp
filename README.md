# @ramlyburger/gpt-image-2-mcp

[![Demo](./assets/demo.gif)](./assets/demo.mp4)

Generate images from any MCP-compatible AI client with a normal prompt.

Install the server, choose a backend, then ask your assistant for a poster, product mockup, concept image, or illustration. The server runs the image request and returns the saved file path.

This package can:

- create images through the official OpenAI API
- create images with a signed-in ChatGPT account without a ChatGPT API key
- return the exact output path for each generated image
- reuse your ChatGPT sign-in across runs

Click the demo above to open the full MP4.

## Quick Start

Add the server to your MCP client:

```json
{
  "mcpServers": {
    "gpt-image-2": {
      "command": "npx",
      "args": ["-y", "@ramlyburger/gpt-image-2-mcp"],
      "env": {
        "GPT_IMAGE_BACKEND": "chatgpt-web"
      }
    }
  }
}
```

This starts in `chatgpt-web` mode. No ChatGPT API key is required for this mode. You only need a ChatGPT account and to sign in at `chatgpt.com`. If you want direct API generation instead, set `OPENAI_API_KEY` and change `GPT_IMAGE_BACKEND` to `api`.

## Backend Modes

- `api`: official OpenAI API using `gpt-image-2`
- `chatgpt-web`: use your signed-in ChatGPT website session
- `auto`: try the API backend first, then fall back to the ChatGPT website mode only when the API backend is unavailable

## Tools

- `generate_image(prompt, backend?, n?, size?, quality?, output_format?, conversation_mode?, timeout_seconds?)`
- `backend_status(backend?)`
- `browser_visibility(action?, start_browser?)`

Backend values are `api`, `chatgpt-web`, or `auto`.

Use `conversation_mode="new"` or `conversation_mode="continue"` with the ChatGPT web backend.

## Generated Files

The server does not use a hardcoded user directory. By default it saves generated images under:

```text
Windows: %LOCALAPPDATA%\gpt-image-2-mcp\output\chatgpt-images
macOS:   ~/Library/Application Support/gpt-image-2-mcp/output/chatgpt-images
Linux:   ${XDG_DATA_HOME:-~/.local/share}/gpt-image-2-mcp/output/chatgpt-images
```

`backend_status` returns the exact `output_root` and each `generate_image` result returns the exact `output_dir` and `image_path`.

## ChatGPT Website Mode

Run the MCP server in ChatGPT website mode:

```powershell
$env:GPT_IMAGE_BACKEND = "chatgpt-web"
node dist/index.js
```

When the MCP server starts, it opens ChatGPT in Chrome or Edge. Log in or complete verification there. Once the normal composer is visible, the server is ready for tool calls. No ChatGPT API key is required for this mode.

The local ChatGPT sign-in profile is kept under the same per-user app data directory by default, so your login can be reused across restarts. Override with:

```powershell
$env:CHATGPT_WEB_PROFILE_DIR = "C:\path\to\profile"
```

Optional web settings:

```powershell
$env:CHATGPT_WEB_LOGIN_TIMEOUT_SECONDS = "900"
$env:CHATGPT_HIDE_WINDOW = "0"
```

`CHATGPT_HIDE_WINDOW` defaults to enabled. The ChatGPT window stays visible for login or verification, then hides after `chatgpt.com` shows either the normal composer page or your signed-in ChatGPT session from a restored profile. Startup `about:blank` tabs are closed after the ChatGPT tab opens, and delayed blank tabs are cleaned up again during startup. Set it to `0` if you want the window to stay visible after login.

If the MCP profile is still open from a previous session, startup stops before launching Chrome again. This avoids Chrome adding extra `about:blank` tabs to the already-open profile; close the old MCP Chrome window before starting a new session.

You can also control the running browser through the MCP tool:

```json
{ "action": "toggle" }
```

Use `browser_visibility` with `action` set to `show`, `hide`, `toggle`, or `status`. Set `start_browser` to `true` if you want the tool to open the ChatGPT browser when no browser session exists.

## API Backend

Set an OpenAI API key and run the MCP server over stdio:

```powershell
$env:OPENAI_API_KEY = "sk-..."
$env:GPT_IMAGE_BACKEND = "api"
node dist/index.js
```

Generated images are written to the per-user app data directory. Call `backend_status` to inspect the exact `output_root` for the current machine.

## Local Development

The TypeScript MCP server is the only supported entry point.

Install and build the server:

```powershell
npm install
npm run build
```
