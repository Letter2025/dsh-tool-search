# dsh-tool-search

[![release](https://img.shields.io/npm/v/dsh-tool-search?style=flat&label=release&color=blue)](https://www.npmjs.com/package/dsh-tool-search)
[![downloads](https://img.shields.io/npm/dt/dsh-tool-search?style=flat&label=downloads&color=blue)](https://www.npmjs.com/package/dsh-tool-search)
[![stars](https://img.shields.io/github/stars/Letter2025/dsh-tool-search?style=flat&label=stars&color=blue)](https://github.com/Letter2025/dsh-tool-search)
[![license](https://img.shields.io/github/license/Letter2025/dsh-tool-search?style=flat&label=license&color=blue)](LICENSE)
[![docs](https://img.shields.io/badge/docs-English%20%7C%20%E4%B8%AD%E6%96%87-0075cc?style=flat&labelColor=555555)](https://github.com/Letter2025/dsh-tool-search/blob/main/README.zh.md)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

Tool search & slimming for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): Hermes-style progressive disclosure. When your tool catalog gets large (many MCP servers or plugin tools), every tool's JSON schema is injected into the model context on every turn — wasting tokens on tools the task never uses. This plugin keeps a small core set visible and lets the model discover and load long-tail tools on demand. Local keyword search works without an external rerank service; a compatible rerank endpoint is optional.

- **Core tools stay eager** — `read`, `write`, `edit`, `bash`, `glob`, `grep`, `ask_user_question`, `todo_write`, and `read_image` are the built-in defaults when available in the current tool scope.
- **Bridge tools** — `tool_search`, `tool_describe`, `tool_call` replace the deferred schemas.
- **Tiered disclosure** — the visible listing shrinks automatically as the catalog grows.
- **Conversational setup** — the bundled `tool-slimmer-setup` skill groups your tools by talking to you, and can guide optional rerank setup.
- **User or project config** — groups/matcher live in `~/.dsh/dsh-tool-search.json` (global) or `<workspace>/.dsh/dsh-tool-search.json` (per project), your choice.

## Install

```sh
dsh plugin --profile web add dsh-tool-search
```

## How it works

Inspired by [Hermes Agent's Tool Search](https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-search). On every turn, the plugin's `system-prompt/assemble` listener computes the tier and replaces the model-visible tools:

| Tier | Condition | Model sees |
| --- | --- | --- |
| 0 | Small catalog / nothing deferrable | Keep the upstream assembly unchanged; do not collapse tools |
| 1 | Grouped manifest fits the budget | Bridge + `## group` name/description listing |
| 2 | Only names fit | Bridge + names-only listing |
| 3 | Even names overflow | Bridge + one line per group (name: count) |

Budget = `min(thresholdPct% × contextWindow, listingMaxTokens)`, recomputed every turn. The manifest rides a runtime context, so it survives complete-prompt composition.

**Dynamic injection**: searching, describing, or successfully calling a deferred tool warms it into the session's visible set (LRU-bounded by `maxWarmTools`), so its full schema is injected into later turns. Successful native calls add non-core tools to the warm set and refresh their recent-use position. Search results are warmed in rank order, retaining the highest-ranked results when the limit is reached. The non-core catalog is sorted by name and stays stable across assembly turns, even when an entry has already been warmed and is directly visible.

When `tool_call` runs, the plugin executes the underlying tool by its real name through `ctx.tools.execute`; guards and execution notices use that name, while the outer session record remains `tool_call`. A successful bridge result is a JSON string; parsing it yields `{ ok: true, value, content, meta }`, where `value` is the underlying canonical value and `content` is the original model-facing content blocks. The model receives `content`, not a JSON dump of the raw value, so text and images remain displayable instead of becoming serialized image data. A failed call remains a failure (`isError: true` with structured `error`, no `value`). Additional context and turn-ending signals are preserved. Missing `meta` is represented as `null`; native results may omit it.

Without a matcher, `tool_search` uses local Unicode-aware keyword matching across tool names, descriptions, and group names. It preserves Chinese text and supports a small set of explicit aliases, such as `截图` ↔ `screenshot`/`snapshot`, `仓库` ↔ `repo`/`repository`, and `问题` ↔ `issue`. These aliases are a short lookup list, not general translation or semantic understanding. If a configured rerank request fails, keyword search remains available.

## Setup (conversational)

Ask your agent:

> 帮我配置 dsh-tool-search 的工具分组

The `tool-slimmer-setup` skill will read the catalog, propose groups, confirm with you, ask whether the config should be **global or per-project**, and can guide you through optional rerank setup. Keyword search works without a matcher; preload requires one.

## Configuration

Static tuning lives in your profile `cordis.patch.yml` (restart to change):

```yaml
- id: tool-search
  config:
    enabled: auto        # auto | on | off
    thresholdPct: 5      # listing budget as % of context window
    listingMaxTokens: 4000
    configScope: auto    # user | project | auto (project file wins when present)
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
    "endpoint": "https://<provider-host>/<compatible-rerank-route>",
    "apiKey": "<provider-api-key>",
    "model": "<provider-rerank-model>",
    "topN": 20
  },
  "preload": { "enabled": false, "topK": 5 },
  "core": []
}
```

- `groups`: exact tool names and/or name prefixes; a tool belongs to the first matching group.
- `core`: the built-in default list is the nine names above. Explicitly setting `core` in static `cordis.patch.yml` replaces that default list; `core` in the runtime JSON file is unioned with the static/default list. The built-in bridges, management tools, and `skill` are also kept visible when allowed by the current scope; `run_code` is fixed core when provided by the current transport. Strict PTC leaves SDK contents unchanged; generic-bridge catalog discovery and dispatch are unavailable in that scope. Use the existing SDK.
- Team, Gitea, and screenshot tools are opt-in; add them to static or runtime `core` if they should stay directly visible.
- `matcher`: an optional rerank endpoint using the request/response shape supported by this plugin. Without it, local keyword search still works. The matcher sends a request shaped like `{ "model": "…", "query": "…", "documents": ["…"], "top_n": 20 }` and expects `{ "results": [{ "index": 0, "relevance_score": 0.9 }] }`. Use a provider route, model name, and request structure documented for that provider; this example does not claim a specific Qwen/DashScope endpoint is compatible.
- `preload`: optional; when enabled (with a matcher), the session's first turn semantically preloads the top-K matching tools into the eager set.
- The file is watched by mtime and hot-reloads; changes take effect on the next turn.

## Bridge tools

| Tool | Purpose |
| --- | --- |
| `tool_search(query, limit?)` | Search the deferred catalog (rerank, keyword fallback) and return ranked `{name, description, group}` matches; matches are injected into the visible context |
| `tool_describe(name)` | Load the full schema of one deferred tool; the tool is injected into the visible context |
| `tool_call(name, arguments)` | Invoke a deferred tool by real name; successful JSON result includes `value`, `content`, and `meta`, while failures use `isError` and structured `error`; the outer session record remains `tool_call` |

## Design notes & pitfalls

- Slimming only rewrites the **model-visible surface** (`system-prompt/assemble`). It intersects the effective assembly snapshot with currently reachable tool schemas, so tools hidden by earlier scope filtering are not re-added. If the snapshot is unavailable, the plugin warns and leaves the assembly unchanged; bridge discovery/calls for that scope are unavailable.
- Each run must receive a fresh assembly after upstream filters have settled. The plugin replaces its same-name catalog context, so a new assembly has at most one; reusing a previously slimmed assembly as the next input cannot restore tools that were already removed.
- If the current scope has no settled assembly snapshot, `tool_search` returns no matches with a hint; `tool_describe` reports the unavailable scope and `tool_call` returns an error. In strict PTC mode, generic-bridge catalog discovery and dispatch are unavailable; the plugin leaves SDK contents unchanged, so use the existing SDK.
- The bridge, the two setup tools, and `skill` are fixed eager when allowed by the current scope; `run_code` is fixed core when the current transport provides it.
- **Strict PTC scopes keep their generated SDK intact.** The plugin does not change SDK contents; generic-bridge catalog discovery and dispatch are unavailable in that scope, so use the existing SDK.
- Keyword search works without an external service. It preserves Unicode tokens and has only a finite list of explicit bilingual aliases; it does not translate arbitrary phrases. A rerank matcher is optional.
- See [DESIGN.md](DESIGN.md) for the full architecture.

## Links

- [GitHub](https://github.com/Letter2025/dsh-tool-search)
- [npm](https://www.npmjs.com/package/dsh-tool-search)
- [Design doc](DESIGN.md)

## License

MIT
