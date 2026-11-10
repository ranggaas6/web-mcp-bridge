# Security Policy

Web MCP Bridge (Fork) connects web chats (ChatGPT, Gemini, Claude, DeepSeek) with MCP servers running on your own computer. Because it can trigger tools with access to local files and programs, we take security reports seriously and appreciate responsible disclosure.

## Supported versions

Security fixes are provided for the latest minor release only.

| Version | Supported |
|---------|-----------|
| 1.7.x   | ✅ Yes    |
| < 1.7   | ❌ No     |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use one of these private channels:

1. **GitHub Private Vulnerability Reporting** (preferred): go to the [Security tab](https://github.com/ranggaas6/web-mcp-bridge/security/advisories/new) and click *Report a vulnerability*.
2. **Email**: [avpn497@gmail.com](mailto:avpn497@gmail.com) with the subject `[SECURITY] Web MCP Bridge (Fork)`.

Please include, as far as you can:

- A description of the issue and its impact.
- Steps to reproduce (or a proof of concept).
- Affected version, operating system and browser.
- Any suggested fix or mitigation.

### What to expect

| Stage | Target time |
|-------|-------------|
| Acknowledgement of your report | within 72 hours |
| Initial assessment and severity | within 7 days |
| Fix or mitigation plan | within 30 days for confirmed issues |

We will keep you informed, credit you in the release notes if you wish, and coordinate a disclosure date with you. Please give us a reasonable time to release a fix before any public disclosure.

## Scope

In scope (examples):

- A website being able to reach the bridge, the control port (`:8199`) or the launcher port (`:8198`), bypassing `Origin` / `Host` checks.
- Bypassing the permission system ("Always ask", "Always allow", "Block").
- Execution of tools without user approval.
- Prompt-injection paths that escape the `MCP_RESULT` data framing.
- Token handling flaws, path traversal, or command injection in the Python bridge or launcher.
- Unsafe use of `eval`, `innerHTML` with page data, or unexpected external network requests in the extension.

Out of scope:

- Actions performed by an MCP server that the user chose to install and approve (the server's own behavior is its author's responsibility).
- Attacks requiring prior full control of the user's machine or browser profile.
- Social engineering of the user, and issues in third-party sites (ChatGPT, Gemini, Claude, DeepSeek) themselves.
- Selector breakage after a site redesign (please use the *broken selector* issue template).

## Security model summary

- The bridge listens on `127.0.0.1` only and accepts only `chrome-extension://` origins; an optional `--token` is supported.
- The control and launcher ports accept only extension origins and local hosts; state-changing routes require `POST`.
- Every tool call requires approval by default.
- Tool results are presented to the AI as data, not instructions.

More details are in the [Security model](README.md#-security-model) section of the README.

## Safe usage recommendations

- Only connect MCP servers you trust and review the commands in `server/servers.json`.
- Restrict filesystem MCP servers to the narrowest folder possible.
- Prefer "Always ask" over "Always allow" for tools that write, delete or execute.
- Keep the project and your browser up to date.
