# dsh-tool-search

[![release](https://img.shields.io/npm/v/dsh-tool-search?style=flat&label=release&color=blue)](https://www.npmjs.com/package/dsh-tool-search)
[![downloads](https://img.shields.io/npm/dt/dsh-tool-search?style=flat&label=downloads&color=blue)](https://www.npmjs.com/package/dsh-tool-search)
[![stars](https://img.shields.io/github/stars/Letter2025/dsh-tool-search?style=flat&label=stars&color=blue)](https://github.com/Letter2025/dsh-tool-search)
[![license](https://img.shields.io/github/license/Letter2025/dsh-tool-search?style=flat&label=license&color=blue)](LICENSE)
[![docs](https://img.shields.io/badge/docs-English%20%7C%20%E4%B8%AD%E6%96%87-0075cc?style=flat&labelColor=555555)](https://github.com/Letter2025/dsh-tool-search/blob/main/README.zh.md)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

Tool search & slimming for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): Hermes-style progressive disclosure. When your tool catalog gets large (many MCP servers or plugin tools), every tool's JSON schema is injected into the model context on every turn — wasting tokens on tools the task never uses. This plugin collapses the long tail behind three bridge tools and lets the model discover and load them on demand through a configured **rerank model**.

- **Core tools stay eager** — file/shell/essential tools are always directly visible.
- **Bridge tools** — `tool_search`, `tool_describe`, `tool_call` replace the deferred schemas.
- **Tiered disclosure** — the visible listing shrinks automatically as the catalog grows.
- **Conversational setup** — the bundled `tool-slimmer-setup` skill groups your tools by talking to you, and guides configuring the rerank model.
- **User or project config** — groups/matcher live in `~/.dsh/dsh-tool-search.json` (global) or `<workspace>/.dsh/dsh-tool-search.json` (per project), your choice.

## Install

```sh
dsh plugin --profile web add dsh-tool-search
```

## How it works

Inspired by [Hermes Agent's Tool Search](https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-search). On every turn, the plugin's `system-prompt/assemble` listener computes the tier and replaces the model-visible tools:

| Tier | Condition | Model sees |
| --- | --- | --- |
| 0 | Small catalog / nothing deferrable | Every tool, bridge absent |
| 1 | Grouped manifest fits the budget | Bridge + `## group` name/description listing |
| 2 | Only names fit | Bridge + names-only listing |
| 3 | Even names overflow | Bridge + one line per group (name: count) |

Budget = `min(thresholdPct% × contextWindow, listingMaxTokens)`, recomputed every turn. The manifest rides a runtime context, so it survives complete-prompt composition.

**Dynamic injection**: searching, describing, or calling a deferred tool warms it into the session's visible set (LRU-bounded by `maxWarmTools`), so its full schema is injected into the context for later turns — the model pulls tools into context on demand instead of keeping everything.

When `tool_call` runs, the plugin executes the **real tool by name** through `ctx.tools.execute`, so approvals, guards, and session events all reference the underlying tool — never the bridge. `tool_search` ranks with the configured rerank matcher and falls back to keyword matching (exact name > name tokens > description tokens) when no matcher is configured or the rerank call fails.

## Setup (conversational)

Ask your agent:

> 帮我配置 dsh-tool-search 的工具分组

The `tool-slimmer-setup` skill will read the catalog, propose groups, confirm with you, ask whether the config should be **global or per-project**, and guide you through configuring the rerank matcher (required for `tool_search` and preload).

## Configuration

Static tuning lives in your profile `cordis.patch.yml` (restart to change):

```yaml
- id: tool-search
  config:
    enabled: auto        # auto | on | off
    thresholdPct: 5      # listing budget as % of context window
    listingMaxTokens: 4000
    configScope: auto    # user | project | auto (project file wins when present)
    core: [todo_write]   # extra always-eager tools
    maxWarmTools: 8      # LRU cap for dynamically injected tools
```

Tool groups, the matcher, and preload live in the runtime file (`~/.dsh/dsh-tool-search.json` for user scope):

```json
{
  "version": 1,
  "scope": "user",
  "groups": [
    { "name": "git", "tools": ["git_status", "git_diff"] },
    { "name": "mcp-github", "prefixes": ["mcp_github_"] }
  ],
  "matcher": {
    "endpoint": "https://dashscope.aliyuncs.com/compatible-mode/v1/rerank",
    "apiKey": "sk-...",
    "model": "qwen3-reranker",
    "topN": 20
  },
  "preload": { "enabled": false, "topK": 5 },
  "core": ["read_file", "write_file"]
}
```

- `groups`: exact tool names and/or name prefixes; a tool belongs to the first matching group.
- `matcher`: an OpenAI-compatible `/v1/rerank` endpoint — the only matcher type. `tool_search` returns setup guidance until one is configured.
- `preload`: optional; when enabled (with a matcher), the session's first turn semantically preloads the top-K matching tools into the eager set.
- The file is watched by mtime and hot-reloads; changes take effect on the next turn.

## Bridge tools

| Tool | Purpose |
| --- | --- |
| `tool_search(query, limit?)` | Search the deferred catalog (rerank, keyword fallback) and return ranked `{name, description, group}` matches; matches are injected into the visible context |
| `tool_describe(name)` | Load the full schema of one deferred tool; the tool is injected into the visible context |
| `tool_call(name, arguments)` | Invoke a deferred tool by real name; approvals/guards/events use the real tool; the tool is injected into the visible context |

## Design notes & pitfalls

- Slimming only rewrites the **model-visible surface** (`system-prompt/assemble`); the registry stays complete, so deferred tools remain executable.
- The bridge, the two setup tools, and `skill` are always eager and never defer themselves.
- Keyword matching is only a **fallback**: rerank is the primary ranking; without a matcher or on rerank failure, search degrades to keyword matching (exact name > name tokens > description tokens) and never errors.
- See [DESIGN.md](DESIGN.md) for the full architecture.

## Links

- [GitHub](https://github.com/Letter2025/dsh-tool-search)
- [npm](https://www.npmjs.com/package/dsh-tool-search)
- [Design doc](DESIGN.md)

## License

MIT
