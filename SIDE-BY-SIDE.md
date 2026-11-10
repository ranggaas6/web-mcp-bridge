# Side-by-Side Installation with Upstream

This document explains how to run **this fork** alongside the upstream [AstraxOf/web-mcp-bridge](https://github.com/AstraxOf/web-mcp-bridge) in the same Chrome/Edge/Brave without one overwriting the other.

## Differences at a glance

| Aspect | Upstream | This fork |
|---|---|---|
| Extension name | Web MCP Bridge | Web MCP Bridge (Fork) |
| Storage namespace | `wmb_*` | `wmbx_*` |
| sessionStorage keys | `wmb:*` | `wmbx:*` |
| Injection marker | `[WMB:…]` | `[WMBX:…]` |
| Web Lock | `wmb-alive` | `wmbx-alive` |
| Bridge control port | 8099 | 8199 |
| Launcher port | 8098 | 8198 |
| Demo server port | 8090 | 8190 |

All these values are defined in `shared/constants.js` and `manifest.json`.

## Why the ports must differ

Two Python bridge processes cannot bind to the same port. If upstream uses 8099, the fork uses 8199. The same applies to the launcher port (8098 vs 8198) and the demo server port (8090 vs 8190).

If you change the port in the fork's `servers.json`, also update `DEFAULT_CONTROL_PORT` in `shared/constants.js` and `controlPort` in `DEFAULT_SETTINGS`, then reload the extension.

## Side-by-side installation steps

### 1. Clone the fork

```bash
git clone https://github.com/ranggaas6/web-mcp-bridge ~/web-mcp-bridge-fork
```

### 2. Prepare the fork's `servers.json`

```bash
cp ~/web-mcp-bridge-fork/server/servers.example.json \
   ~/web-mcp-bridge-fork/server/servers.json
```

The example `servers.json` uses `control_port: 8199`. Do not change it to 8099 while upstream is running.

### 3. Start the fork bridge

```bash
cd ~/web-mcp-bridge-fork
python server/mcp_ws_bridge.py --config server/servers.json
```

The fork bridge listens on `127.0.0.1:8199`.

### 4. Load both extensions in the browser

1. Open `chrome://extensions` (or `edge://extensions` / `brave://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** for upstream: pick the original `web-mcp-bridge` folder.
4. Click **Load unpacked** again for the fork: pick `~/web-mcp-bridge-fork`.

Both extensions will appear with different names: "Web MCP Bridge" and "Web MCP Bridge (Fork)".

### 5. Set the control port in each panel

- In the **Web MCP Bridge** popup (upstream): keep `controlPort` at 8099.
- In the **Web MCP Bridge (Fork)** popup: make sure `controlPort` is 8199.

These values are stored in each extension's `chrome.storage.local` under different namespaces (`wmb_` vs `wmbx_`), so they will not overwrite each other.

### 6. Verify

Open `https://chat.deepseek.com`. Both extensions will inject their own widget. Because they use the same adapters, make sure you only keep one enabled at a time through each extension's popup, or leave both on if you really want two tool paths at once (not recommended — the model's context grows).

## What stays the same as upstream

- MCP protocol format (`PROTOCOL_VERSION`).
- Call format `{"mcp_call":{"server":"...","name":"...","arguments":{...}}}`.
- `servers.json` schema.
- Adapters for ChatGPT, Gemini, Claude, and DeepSeek.

So the same MCP servers (`gitrs-mcp`, `mcp-filesystem-server`, or `gitdesktop-mcp`) can be used by both the upstream and the fork bridge as long as they are registered in each `servers.json`.

## Cleanup

- Remove the fork extension from `chrome://extensions`.
- Delete the fork clone folder.
- Ports 8199/8198/8190 are freed automatically when the fork bridge process stops.

Nothing needs to be done for upstream: the upstream extension and bridge are untouched.
