<div align="center">

<img src="icons/icon128.png" width="96" alt="Web MCP Bridge (Fork)">

# Web MCP Bridge (Fork)

**Use your local MCP servers with ChatGPT, Gemini, Claude Web and DeepSeek: no API keys, no extra subscriptions.**

[![English](https://img.shields.io/badge/English-Click-2563eb?style=flat-square)](README.md)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-0f766e?style=flat-square&logo=googlechrome&logoColor=white)
![License MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)
![Python](https://img.shields.io/badge/Python-3.9%2B-3776AB?style=flat-square&logo=python&logoColor=white)
![Chrome | Edge | Brave](https://img.shields.io/badge/Chrome%20%7C%20Edge%20%7C%20Brave-116%2B-informational?style=flat-square)

[![GitHub](https://img.shields.io/badge/GitHub-ranggaas6-181717?style=flat-square&logo=github)](https://github.com/ranggaas6/web-mcp-bridge)

</div>

---

> **Web MCP Bridge (Fork)** lets the free web versions of ChatGPT, Gemini, Claude and DeepSeek **use tools on your own computer**: read files, control programs, query your data, with no API keys and no extra subscriptions. **You approve every action.**

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
> | Injection marker | `[WMB:...]` | `[WMBX:...]` |
> | Web Lock | `wmb-alive` | `wmbx-alive` |
> | Control port | 8099 | 8199 |
> | Launcher port | 8098 | 8198 |
> | Hub port (gitdesktop) | 8090 | 8190 |
>
> The fork is **English only**. It keeps the welcome page, the notices feed, and OS notifications, all in English.

> [!IMPORTANT]
> Only connect MCP servers you trust. A tool with filesystem access can read whatever you allow it to.

## How it works (in 20 seconds)

Two pieces work together:

| Piece | What it is | Where it lives |
|---|---|---|
| The extension | Installed in your browser. It reads what the AI asks for and shows you the buttons and permissions. | Chrome, Edge or Brave |
| The bridge | A small Python program that connects the extension to your tools (MCP servers). | Your computer, in the background |

1. You ask the AI something in the chat.
2. The AI answers with an "order" (a JSON block) asking for a tool.
3. The extension asks if you allow it, runs it on your PC, and **pastes the result back into the chat** so the AI can continue.

## What you need

- **Chrome, Edge or Brave** (version 116 or newer)
- **Python 3.9 or newer** ([python.org/downloads](https://www.python.org/downloads/), tick "Add Python to PATH")
- **This project downloaded** (Code -> Download ZIP, or `git clone`). Keep it in a permanent folder: the extension loads from there.

Optional: **Node.js**, if you use MCP servers launched with `npx`.

## Installation (Windows)

1. Open the `server` folder and **double-click `install.cmd`**. Wait until it says *Done*.
2. Type `chrome://extensions` in the address bar (Edge: `edge://extensions`).
3. Turn on **Developer mode**, click **Load unpacked**, and pick the project folder.
4. Pin the extension with the puzzle icon.

The welcome page opens automatically and checks each step.

## Installation (macOS / Linux)

```bash
python3 server/install_service.py
```

Then load the extension as in step 2 above.

## Control the bridge from the extension

In the popup, bridge card:

| Button | What it does |
|---|---|
| **Start** | Turns the bridge on (if it was off) |
| **Stop** | Turns it off and keeps it off until you start it again |
| **Restart** | Closes and reopens it |
| **JSON editor / Add MCP** | Opens the `servers.json` editor with live validation |

The big switch in the header only makes the extension stop acting (icon shows `OFF`). "Stop" closes the program on your PC.

## Your first time (60 seconds)

The project ships with a **demo server (`demo`)** so you can try it without installing anything else.

1. Open the popup, Servers tab, turn on the **demo** switch.
2. Open ChatGPT, Gemini, Claude or DeepSeek.
3. Type something like: "What time is it? Use your tools."
4. The AI asks for a tool, a prompt appears, click **Run**.
5. The result is pasted into the chat and the AI answers you.

By default permission is **Always ask**: nothing runs unless you approve it.

## Add your own MCP servers

Your servers are defined in `server/servers.json`. Example:

```json
{
  "control_port": 8199,
  "launcher_port": 8198,
  "servers": [
    { "name": "demo",   "port": 8190, "command": ["python", "server/examples/demo_mcp_server.py"] },
    { "name": "my-mcp", "port": 8181, "command": ["python", "-m", "my_mcp_server"] }
  ]
}
```

Click **JSON editor / Add MCP** in the popup, save, and within ~2 seconds it shows up in the list. Up to **5** at once; **1** costs fewer tokens. To disable one: add `"disabled": true`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Popup says "Bridge is off" | Click **Start**. If greyed out, double-click `server/install.cmd`. |
| "Launcher missing" | Normal the first time: run `server/install.cmd` once. |
| `python` is not recognized | Reinstall Python ticking **Add Python to PATH**, or try `py`. |
| "Port in use" | Click **Restart**. If it persists, change that server's `port`. |
| Red notice "servers.json has an error" | A comma or quote is misplaced. Fix it and save. |
| Chat does not react | Reload the tab (F5) and check the header switch is on. |

## Supported platforms

| Platform | Adapter |
|---|---|
| ChatGPT | `adapters/chatgpt.js` |
| Gemini | `adapters/gemini.js` |
| Claude | `adapters/claude.js` |
| DeepSeek | `adapters/deepseek.js` |

## Call protocol

```json
{ "mcp_call": { "server": "server_name", "name": "tool_name", "arguments": { "arg1": "value" } } }
```

Results come back as:

```
[MCP_RESULT server="..." tool="..." status="ok|error|rejected"]
...
[/MCP_RESULT]
```

The content of `MCP_RESULT` is presented to the AI as *data*, not instructions (prompt-injection mitigation).

## Security model

| Risk | Mitigation |
|---|---|
| A website opens `ws://localhost` and runs tools | The bridge rejects any `Origin` that is not a browser extension. |
| The AI runs unwanted actions | "Always ask" is the default; explicit choice per MCP. |
| Hidden instructions in results | The prompt marks `MCP_RESULT` as data only. |
| Network exposure | Listens on `127.0.0.1` only; optional token (`--token`). |
| A website reads or shuts down the control/launcher ports | They only accept extension `Origin`s and local `Host`s. |

## Contributing

This fork accepts issues and pull requests at [ranggaas6/web-mcp-bridge](https://github.com/ranggaas6/web-mcp-bridge).

<div align="center">

Fork maintained by [@ranggaas6](https://github.com/ranggaas6). Upstream project by [@AstraxOf](https://github.com/AstraxOf).

**[MIT License](LICENSE)**

</div>
