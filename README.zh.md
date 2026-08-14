# dsh-tool-search

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的工具搜索与瘦身插件：Hermes 风格渐进式披露。当工具目录变大（挂了多个 MCP 服务或插件工具）时，每个工具的 JSON schema 都会在每一轮注入模型上下文——大量 token 花在本次任务根本用不到的工具上。本插件把长尾工具折叠到三个桥接工具后面，让模型通过配置的 **rerank 模型**按需搜索、加载和调用。

- **核心工具永远直通**——文件/终端/必备工具始终直接可见。
- **桥接工具**——`tool_search` / `tool_describe` / `tool_call` 替代被折叠的 schema。
- **分级披露**——目录越大，模型可见清单自动越精简。
- **对话式配置**——随包技能 `tool-slimmer-setup` 通过对话帮你分组，并引导配置 rerank 模型。
- **全局或按项目**——分组/匹配器存在 `~/.dsh/dsh-tool-search.json`（全局）或 `<workspace>/.dsh/dsh-tool-search.json`（按项目），由你选择。

## 安装

```sh
dsh plugin --profile web add dsh-tool-search
```

## 工作原理

灵感来自 [Hermes Agent 的 Tool Search](https://hermes-agent.nousresearch.com/docs/zh-Hans/user-guide/features/tool-search)。每一轮，插件的 `system-prompt/assemble` 监听器计算档位并替换模型可见工具：

| 档位 | 条件 | 模型看到 |
| --- | --- | --- |
| 0 | 目录很小 / 无可折叠工具 | 全量直通，桥不出现 |
| 1 | 分组清单塞得进预算 | 桥 + `## 组` 名称/描述清单 |
| 2 | 只有纯名称塞得进 | 桥 + 纯名称清单 |
| 3 | 纯名称也超预算 | 桥 + 每组一行摘要（组名: 数量） |

预算 = `min(thresholdPct% × 上下文窗口, listingMaxTokens)`，每轮重算。

`tool_call` 执行时，插件以**真实工具名**走 `ctx.tools.execute`——审批、守卫、会话事件全部对着底层工具，永远不是桥本身。

## 对话式配置

对你的 agent 说：

> 帮我配置 dsh-tool-search 的工具分组

`tool-slimmer-setup` 技能会读取目录、提出分组方案、与你确认、询问配置**全局还是按项目**，并引导你配置 rerank 匹配器（`tool_search` 和预加载的前置条件）。

## 配置

静态调优放在 profile 的 `cordis.patch.yml`（改后需重启）：

```yaml
- id: tool-search
  config:
    enabled: auto        # auto | on | off
    thresholdPct: 5      # 清单预算占上下文窗口的百分比
    listingMaxTokens: 4000
    configScope: auto    # user | project | auto（存在项目文件时优先）
    core: [todo_write]   # 额外永远直通的工具
```

工具分组、匹配器和预加载放在运行时文件（用户级为 `~/.dsh/dsh-tool-search.json`）：

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

- `groups`：精确工具名和/或名称前缀；工具归入第一个命中的组。
- `matcher`：OpenAI 兼容的 `/v1/rerank` 端点——唯一的匹配器类型。未配置时 `tool_search` 返回引导提示。
- `preload`：可选；启用（需配 matcher）后，会话首轮会用任务描述语义预加载 top-K 命中工具进 eager 集。
- 文件按 mtime 热重载，下一轮生效。

## 桥接工具

| 工具 | 作用 |
| --- | --- |
| `tool_search(query, limit?)` | 对延迟目录做语义搜索（rerank），返回排序后的 `{name, description, group}` 匹配 |
| `tool_describe(name)` | 加载单个延迟工具的完整 schema |
| `tool_call(name, arguments)` | 以真实工具名调用延迟工具；审批/守卫/事件都走真实工具 |

## 设计要点与坑

- 瘦身只改写**模型可见表面**（`system-prompt/assemble`），注册表保持完整，延迟工具仍可执行。
- 桥、两个配置工具和 `skill` 永远 eager，不会被自己延迟。
- 不做本地 BM25/关键词搜索：按产品判断效果差，`tool_search` 仅走语义匹配，必须配置 matcher。
- 完整架构见 [DESIGN.md](DESIGN.md)。

## 链接

- [GitHub](https://github.com/Letter2025/dsh-tool-search)
- [npm](https://www.npmjs.com/package/dsh-tool-search)
- [设计文档](DESIGN.md)

## 许可证

MIT
