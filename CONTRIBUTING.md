# Contributing to Web MCP Bridge (Fork)

Thanks for helping out! The most valuable contributions:

1. **Fix selectors** when a website changes its interface (a single line is often enough).
2. **New adapters** (Perplexity, Le Chat, ...).
3. Improvements to the Python bridge and to security.

## Adding a platform

1. Copy `content_scripts/adapters/claude.js` to `content_scripts/adapters/<platform>.js` (`deepseek.js` is another working example).
2. Change `id`, `name`, `matches()` and the selectors (`composer`, `sendButton`, `assistantMessages`, `stopButton`).
   Put the most stable selectors first (`data-testid`, `aria-label`) and keep CSS classes as a last resort.
3. If the site exposes an ID per message, override `getMessageKey(element, index)`.
4. Add a `content_scripts` block to `manifest.json` and the required `host_permissions`.
5. Test the full cycle: inject instructions -> call -> approval -> result sent back.

## Before opening a PR

```bash
npm test
```

- Code and comments in English, small and documented modules.
- No dependencies in the extension (browser APIs only).
- Do not use `eval`, `innerHTML` with page data, or external network requests.

## Reporting problems and questions

Use the issue templates: `broken_selector` (broken selector) when a site changes its interface, and `new_adapter` (new adapter) to propose a platform. Open issues and PRs at [ranggaas6/web-mcp-bridge](https://github.com/ranggaas6/web-mcp-bridge).
