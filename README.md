# pi-proxy-manager

A [pi](https://github.com/badlogic/pi-mono) extension that manages OpenAI/Anthropic-compatible proxy providers through a local web UI. Add a proxy, fetch its models, test them, and they register in the **running pi session immediately** — no restart, no manual `models.json` editing.

## Features

- **Web UI** (htmx, served from inside pi) — run `/proxies` in pi, manage everything in the browser
- **Live registration** — saves, edits, enable/disable, and deletes apply to the running pi session instantly
- **Model fetching** — pulls `/v1/models` from the proxy (OpenAI `Bearer` or Anthropic `x-api-key` auth)
- **Metadata enrichment** — matches model ids against the public [models.dev](https://models.dev) catalog and prefills context window, max output, pricing, reasoning/image capability. Consensus-based selection across catalog entries so single broken/reseller entries can't skew values; version-suffix aware matching (`deepseek-v4-pro-0524` → `deepseek-v4-pro`) that never confuses variants (`glm-5.2-air` ≠ `glm-5.2`)
- **Manual pricing** — every model's $/M in/out is editable; costs feed pi's usage tracking
- **Model tester** — per-model checks for everything pi needs: chat completion, streaming, tool calls, streaming tool calls, and `tool_choice` handling (OpenAI and Anthropic wire formats)
- **Quirk auto-detection** — some new-api channels reject standard string `tool_choice`; the tester detects this and enables an object-style rewrite for that provider automatically
- **Streaming tool-call fix** — proxies that report `finish_reason: "stop"` on tool calls still work
- **Real pages** — proxy detail and edit views have their own URLs; back/forward/refresh/deep-links work

## Install

```bash
pi install git:github.com/FasalZein/pi-proxy-manager
```

Or manually — copy the extension folder into pi's extensions directory:

```bash
git clone https://github.com/FasalZein/pi-proxy-manager
cp -r pi-proxy-manager/extensions/proxy-manager ~/.pi/agent/extensions/
```

Then restart pi or run `/reload`.

## Usage

1. In pi, run `/proxies` — the UI opens at `http://127.0.0.1:7788` (or the next free port)
2. Fill in **Provider ID**, **Base URL**, **API key**, pick the **API format** (`openai-completions`, `anthropic-messages`, `openai-responses`, `openai-codex-responses`)
3. **Fetch models** — pick the ones you want, adjust context/limits/pricing if needed
4. **Save & register in pi** — models are immediately selectable as `provider-id/model-id`

```bash
pi --model my-proxy/glm-5.2
# or inside pi: /model my-proxy/glm-5.2
```

Click any proxy row for details (base URL, masked key, model table, per-model **Test** button), **Edit** to change anything, and toggle **Enable/Disable** without losing the config.

## Configuration

State lives in a single JSON file — human-editable, no database:

```
~/.pi/agent/proxies.json
```

```json
{
  "my-proxy": {
    "baseUrl": "https://host.example/v1",
    "apiKey": "sk-…",
    "api": "openai-completions",
    "enabled": true,
    "objectToolChoice": false,
    "models": [
      {
        "id": "glm-5.2",
        "contextWindow": 1000000,
        "maxTokens": 131072,
        "reasoning": true,
        "image": false,
        "cost": { "input": 1.4, "output": 4.5, "cacheRead": 0.26, "cacheWrite": 0 }
      }
    ]
  }
}
```

Pasted base URLs are normalized automatically (`…/v1/chat/completions` → `…/v1`).

The API key is stored in plain text in this file — treat it like any local credentials file.

## Development

The UI server restarts every time you run `/proxies`, so the edit loop is:

```
edit files → /reload → /proxies
```

If the base port is held by another pi session, the server walks to the next free port and opens that instead.

## License

MIT
