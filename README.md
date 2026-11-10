<div align="center">

<img src="icons/icon128.png" width="96" alt="Web MCP Bridge (Fork)">

# Web MCP Bridge (Fork)

**Use your local MCP servers with ChatGPT, Gemini, Claude Web and DeepSeek: no API keys, no extra subscriptions.**

[![English](https://img.shields.io/badge/English-Click-2563eb?style=flat-square)](README.md)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-0f766e?style=flat-square&logo=googlechrome&logoColor=white)
![License MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)
![Python](https://img.shields.io/badge/Python-3.9%2B-3776AB?style=flat-square&logo=python&logoColor=white)
![Dependencies](https://img.shields.io/badge/extension%20deps-0-success?style=flat-square)
![Chrome | Edge | Brave](https://img.shields.io/badge/Chrome%20%7C%20Edge%20%7C%20Brave-116%2B-informational?style=flat-square)

[![GitHub](https://img.shields.io/badge/GitHub-ranggaas6-181717?style=flat-square&logo=github)](https://github.com/ranggaas6/web-mcp-bridge)

</div>

---

> **Web MCP Bridge (Fork)** lets the free web versions of ChatGPT, Gemini, Claude and DeepSeek **use tools on your own computer**: read files, control programs, query your data… with no API keys and no extra subscriptions. **You approve every action.**

> [!NOTE]
> This is a **fork** of [AstraxOf/web-mcp-bridge](https://github.com/AstraxOf/web-mcp-bridge) that can be installed **side by side** with the original, on the same browser and machine. It is the bridge used by the [Easy-Vibe](https://github.com/ranggaas6/Easy-Vibe) project.
>
> Differences from upstream:
>
> | | Upstream | This fork |
> |---|---|---|
> | Extension name | Web MCP Bridge | Web MCP Bridge (Fork) |
> | `chrome.storage` | `wmb_*` | `wmbx_*` |
> | `sessionStorage` | `wmb:*` | `wmbx:*` |
> | Injection marker | `[WMB:…]` | `[WMBX:…]` |
> | Web Lock | `wmb-alive` | `wmbx-alive` |
> | Control port | 8099 | 8199 |
> | Launcher port | 8098 | 8198 |
> | Hub port (gitdesktop) | 8090 | 8190 |
>
> The fork is **English only** and has **no welcome page**, **no notices feed** and **no OS notifications**.

> [!IMPORTANT]
> Only connect MCP servers you trust. A tool with filesystem access can read whatever you allow it to.

**Jump to:** [Install](#-step-by-step-installation) · [First use](#-your-first-time-60-seconds) · [Add my MCPs](#-add-your-own-mcp-servers) · [Troubleshooting](#-something-not-working)

## 🧩 How it works (in 20 seconds)

Two pieces work together:

| Piece | What it is | Where it lives |
|---|---|---|
| 🌐 **The extension** | Installed in your browser. It reads what the AI asks for and shows you the buttons and permissions. | Chrome, Edge or Brave |
| 🌉 **The bridge** | A small Python program that connects the extension to your tools (MCP servers). | Your computer, in the background |

```mermaid
flowchart LR
    A["💬 Chat<br/>ChatGPT · Gemini · Claude · DeepSeek"] <--> B["🌐 Extension"]
    B <-->|"local WebSocket"| C["🌉 Bridge (Python)"]
    C <--> D["🧰 Your MCP tools"]
```

1. You ask the AI something in the chat.
2. The AI answers with an "order" (a JSON block) asking for a tool.
3. The extension asks if you allow it → runs it on your PC → **pastes the result back into the chat** so the AI can continue.

> 🔒 Everything happens on your computer. Nothing is sent to third-party servers, except the AI's own chat traffic.

## ✅ What you need

| Requirement | How to check |
|---|---|
| **Chrome, Edge or Brave** (version 116 or newer) | Menu → *About*. |
| **Python 3.9 or newer** | Open a terminal and type `python --version`. If missing, get it from [python.org/downloads](https://www.python.org/downloads/) and **tick "Add Python to PATH"** during setup. |
| **This project downloaded** | Green **Code → Download ZIP** button on GitHub, then unzip (or `git clone`). **Keep it in a permanent folder**: the extension loads from there, so don't delete or move it afterwards. |

Optional: **Node.js**, if you'll use MCP servers launched with `npx` (for example the filesystem one).

## 🚀 Step-by-step installation

### 🪟 Windows

**Step 1 · Install the launcher (once)**
Open the `server` folder and **double-click `install.cmd`**. Wait until it says *Done*.
It installs what's missing (`websockets`), makes the bridge **start automatically when you log in**, and starts it right now.

**Step 2 · Load the extension in your browser**
1. Type `chrome://extensions` in the address bar (Edge: `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the project folder (the one containing `manifest.json`).
4. Pin the extension with the puzzle icon 🧩 so the popup is one click away.

**Step 3 · Check everything is green**
Open the extension icon: the top should say **"Bridge connected"** with a green dot and your servers below.

Done! Continue with [Your first time](#-your-first-time-60-seconds).

### 🍎 macOS / 🐧 Linux

```bash
python3 server/install_service.py
```

It installs what's needed and makes the bridge start with your session (launchd on macOS, systemd on Linux). Then load the extension as in Step 2.
The popup's **Start / Stop** buttons need the *launcher*, which is currently Windows-only. On macOS/Linux the bridge still works and restarts itself if it crashes.

## 🎛️ Control the bridge from the extension

No terminal needed for everyday use. In the popup, **bridge** card:

| Button | What it does |
|---|---|
| **Start** | Turns the bridge on (if it was off). |
| **Stop** | Turns it off and **keeps it off** until you start it again (even after rebooting your PC). |
| **Restart** | Closes and reopens it. Use it after changing something or if it got stuck. |
| **JSON editor / Add MCP** | Opens the `servers.json` editor with live validation. Saves and reloads instantly. |

> 💡 **Header switch vs. "Stop".** The big switch in the header only makes the *extension* stop acting (the icon shows `OFF`). "Stop" closes the *program* on your PC.

If **Start/Stop** is greyed out, the launcher is missing: double-click `server/install.cmd`.

## 💬 Your first time (60 seconds)

The project ships with a **demo server (`demo`)** so you can try it without installing anything else.

1. Open the popup → **Servers** tab → turn on the **demo** switch.
2. Go to [ChatGPT](https://chatgpt.com), [Gemini](https://gemini.google.com), [Claude](https://claude.ai) or [DeepSeek](https://chat.deepseek.com).
3. Type something like: **"What time is it? Use your tools."** (the instructions are added automatically to your first message; if not, open the **Web MCP Bridge** panel at the bottom-left and click *Inject instructions*).
4. The AI asks for a tool → a prompt appears → click **Run**.
5. The result is pasted into the chat and the AI answers you. 🎉

> By default permission is **"Always ask"**: nothing runs unless you approve it. You can change it per server or for all of them.

## ➕ Add your own MCP servers

Your servers are defined in **`server/servers.json`** (created automatically on install). Each one needs a **name**, a **unique port** and the **command** that starts it:

```json
{
  "control_port": 8199,
  "launcher_port": 8198,
  "servers": [
    { "name": "demo",   "port": 8190, "command": ["python", "server/examples/demo_mcp_server.py"] },
    { "name": "my-mcp", "port": 8181, "command": ["python", "-m", "my_mcp_server"] },
    { "name": "files",  "port": 8182, "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "C:/Users/you/Documents"] }
  ]
}
```

- More examples in `server/servers.example.json`.
- Click **JSON editor / Add MCP** in the popup, save, and within ~2 seconds it shows up in the list. Turn it on with its switch (up to **5** at once; **1** costs fewer tokens).
- To disable one without deleting it: add `"disabled": true`.
- In paths use `/` (`C:/Users/...`) instead of `\`.

## 🩺 Something not working?

| Symptom | Fix |
|---|---|
| Popup says **"Bridge is off"** | Click **Start**. If the button is greyed out, double-click `server/install.cmd`. |
| **"Launcher missing"** | Normal the first time: run `server/install.cmd` once. |
| `python` is not recognized | Reinstall Python ticking **Add Python to PATH**, or try `py` instead of `python`. |
| **"Port in use"** (8180, 8190…) | Click **Restart**. If it persists, change that server's `port` in `servers.json`. |
| A server shows **an error** | It's just an example: if you don't have it installed, delete it from `servers.json` or add `"disabled": true`. |
| Red notice **"servers.json has an error"** | A comma or quote is misplaced. Fix it and save: the bridge reloads by itself. |
| The chat doesn't react / panel missing | Reload the tab (F5) and make sure the header switch is on. If the site changed its UI, open an issue. |
| I moved or renamed the project folder | Run `server/install.cmd` again and click ⟳ in `chrome://extensions`. |
| I want to remove everything | `python server/install_service.py --uninstall` and remove the extension. |

## 🧩 Supported platforms

| Platform | Status | Adapter |
|---|---|---|
| ChatGPT | ✅ Supported | `adapters/chatgpt.js` |
| Gemini | ✅ Supported | `adapters/gemini.js` |
| Claude | ✅ Supported | `adapters/claude.js` |
| DeepSeek | ✅ Supported | `adapters/deepseek.js` |
| Perplexity · Le Chat | 🗺️ Roadmap | [Contribute](CONTRIBUTING.md) |

## ✨ Skills at a glance

| Skill | What it does |
|---|---|
| **Context control** | Register many servers, **1 active by default** (up to **5**). Only active servers' tools reach the model; the popup shows the approximate token cost. |
| **Per-MCP permissions** | 3-state selector — *Always allow* · *Always ask* · *Block* — global and per server, in the popup and the in-page panel. |
| **Nothing is dropped** | Images, audio and binary resources are attached to the chat as real files; long text is attached in full instead of truncated. |
| **No preinstalled MCP** | Add your own, or the bundled demo server with one click. |
| **Reliable in the background** | No step relies on page timers (throttled when hidden); delivery is verified and retried. |
| **The AI doesn't forget** | A one-line reminder per message plus periodic full re-injection. |
| **≈ 50 % fewer tokens** | Tools are described as `name(param: type)` signatures instead of JSON Schema. |
| **~40 lines per platform** | A new platform is just a set of selectors. |
| **Locked down** | The Python bridge listens on `127.0.0.1`, only accepts `chrome-extension://` origins and supports a token. Websites can't reach your tools. |
| **No duplicates, auto-reconnect** | Per-call IDs, exponential backoff, keep-alive for the MV3 Service Worker, call history, light/dark UI. |
| **Tolerant parser** | Badly escaped JSON never hangs the chat. Windows paths with `\`, raw newlines, unescaped quotes or trailing commas are **repaired**. If nothing works, the AI is told the exact reason instead of waiting forever. |
| **Auto-discovery** | The extension reads `server/servers.json` through the bridge's control port (`http://127.0.0.1:8199/servers`): new MCPs show up on their own and removed ones disappear. A server you delete by hand stays deleted. |
| **Easy restart** | `--restart` / `--stop` / `--status` / `--reload`, hot reload when `servers.json` is saved, and a restart that closes a previous bridge by itself. |
| **Safe retry** | If the server was down *before* the call was sent, the extension waits for the reconnection and retries. If the AI sends several calls in one message, it's told only the first one ran. |

## 🧰 For advanced users

Everything above can also be done from the terminal.

```bash
# Launcher (Windows): start, stop and restart
python server/start_bridge_loop.pyw --ctl start | stop | restart | status | quit

# Bridge directly
python server/mcp_ws_bridge.py --config server/servers.json --restart   # restart (closes the old one even if it holds :8180)
python server/mcp_ws_bridge.py --config server/servers.json --status    # status of every server
python server/mcp_ws_bridge.py --config server/servers.json --reload    # re-read servers.json
python server/mcp_ws_bridge.py --config server/servers.json --stop      # stop the bridge
python server/install_service.py --uninstall                            # remove auto-start
```

On Windows you can also double-click `server\restart_bridge.cmd` / `server\bridge_status.cmd`.

| Port | Purpose |
|---|---|
| `8180`, `8181`… | One port per MCP server (you define them in `servers.json`). |
| `8199` | Bridge control (`/servers`, `/reload`, `/restart`, `/shutdown`). |
| `8198` | Launcher (`/start`, `/stop`, `/restart`, `/status`). Configurable with `"launcher_port"`. |

- If a bridge is already running, `--config` **reloads** it instead of failing with "port in use".
- `--restart` only closes `mcp_ws_bridge` processes; if another program owns the port it tells you which and leaves it alone.
- `servers.json` accepts a BOM (added by PowerShell), a top-level `"control_port"` / `"launcher_port"` and `"disabled": true` per server.
- A single server without a config file: `python server/mcp_ws_bridge.py --port 8180 --name demo -- python server/examples/demo_mcp_server.py`

## 📡 Call protocol

```json
{ "mcp_call": { "server": "server_name", "name": "tool_name", "arguments": { "arg1": "value" } } }
```

Results come back as:

```
[MCP_RESULT server="…" tool="…" status="ok|error|rejected"]
…
[/MCP_RESULT]
```

> [!NOTE]
> The content of `MCP_RESULT` is presented to the AI as *data*, not instructions (prompt-injection mitigation).

### Tolerant formats and error feedback

The parser reads the call in three layers: **1)** strict JSON, **2)** repaired JSON (backslash paths, raw newlines, unescaped or typographic quotes, trailing commas) and **3)** *flags*: `server`, `name` and `arguments` are located separately and each argument is extracted by name using the tool schema. A call is only accepted if the server and tool exist among the active MCPs and the message isn't cut off.

If the AI clearly tried to call a tool but the block can't be read, the extension answers (max. 3 consecutive notices) instead of leaving the chat waiting:

```
[MCP_RESULT server="bridge" tool="mcp_call" status="format_error"]
Nothing was executed: your mcp_call block could not be read. Reason: invalid escape sequence (... near: ...)
[/MCP_RESULT]
```

> [!NOTE]
> A path such as `C:\new\test` is ambiguous for any JSON parser (`\n`, `\t`), which is why the prompt always asks for `/` in paths.

## 🔐 Security model

| Risk | Mitigation |
|---|---|
| A website opens `ws://localhost` and runs tools | The bridge rejects any `Origin` that isn't a browser extension. |
| The AI runs unwanted actions | "Always ask" is the default; "Always allow" is an explicit choice per MCP (or global); "Block" blocks the MCP. |
| Hidden instructions in results (*prompt injection*) | The prompt marks `MCP_RESULT` as data only, and you see each call before it runs. |
| Network exposure | Listens on `127.0.0.1` only; optional token (`--token`). |
| A website reads or shuts down the control (`:8199`) or launcher (`:8198`) ports | They only accept extension `Origin`s and local `Host`s; state-changing routes require POST; `--restart` only closes real bridge processes. |

## 🛠️ If a website changes its interface

Selectors live at the top of each adapter (`content_scripts/adapters/*.js`). Add the new selector **at the start** of the matching list (`composer`, `sendButton`, `assistantMessages`, `stopButton`) and open an issue: it's usually a one-line fix.

## 🛠️ Development

```bash
npm test      # syntax, parser, prompt builder and bridge integration tests
npm run pack  # dist/web-mcp-bridge.zip
```

## 🤝 Contributing

This fork accepts issues and pull requests at [ranggaas6/web-mcp-bridge](https://github.com/ranggaas6/web-mcp-bridge). Read [CONTRIBUTING.md](CONTRIBUTING.md) to get started — new adapters are the best first contribution.

Please also read our [Code of Conduct](CODE_OF_CONDUCT.md) before taking part, and report security issues privately by following our [Security Policy](SECURITY.md) (never in a public issue).

<div align="center">

Fork maintained by [@ranggaas6](https://github.com/ranggaas6). Upstream project by [@AstraxOf](https://github.com/AstraxOf).

**[MIT License](LICENSE)**

</div>
