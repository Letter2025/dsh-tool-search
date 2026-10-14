# dsh-tool-search

[![release](https://img.shields.io/npm/v/dsh-tool-search?style=flat&label=release&color=blue)](https://www.npmjs.com/package/dsh-tool-search)
[![downloads](https://img.shields.io/npm/dt/dsh-tool-search?style=flat&label=downloads&color=blue)](https://www.npmjs.com/package/dsh-tool-search)
[![stars](https://img.shields.io/github/stars/Letter2025/dsh-tool-search?style=flat&label=stars&color=blue)](https://github.com/Letter2025/dsh-tool-search)
[![license](https://img.shields.io/github/license/Letter2025/dsh-tool-search?style=flat&label=license&color=blue)](LICENSE)
[![docs](https://img.shields.io/badge/docs-English%20%7C%20%E4%B8%AD%E6%96%87-0075cc?style=flat&labelColor=555555)](https://github.com/Letter2025/dsh-tool-search/blob/main/README.md)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的工具搜索与瘦身插件：采用 Hermes 风格的渐进式披露。当工具目录变大（挂了多个 MCP 服务或插件工具）时，每个工具的 JSON schema 都会在每一轮注入模型上下文。本插件让一小组核心工具常驻，把长尾工具折叠到三个桥接工具后面按需发现。无需外部 rerank 服务也能进行本地关键词搜索；兼容的 rerank 端点是可选项。

- **核心工具默认直通**——当前 scope 允许的 `read`、`write`、`edit`、`bash`、`glob`、`grep`、`ask_user_question`、`todo_write`、`read_image` 九项默认常驻。
- **桥接工具**——`tool_search` / `tool_describe` / `tool_call` 替代被折叠的 schema。
- **分级披露**——目录越大，模型可见清单自动越精简。
- **对话式配置**——随包技能 `tool-slimmer-setup` 通过对话帮你分组，也可引导配置可选 rerank。
- **全局或按项目**——分组/匹配器存在 `~/.dsh/dsh-tool-search.json`（全局）或 `<workspace>/.dsh/dsh-tool-search.json`（按项目），由你选择。

## 安装

```sh
dsh plugin --profile web add dsh-tool-search
```

## 工作原理

灵感来自 [Hermes Agent 的 Tool Search](https://hermes-agent.nousresearch.com/docs/zh-Hans/user-guide/features/tool-search)。每一轮，插件的 `system-prompt/assemble` 监听器计算档位并替换模型可见工具：

| 档位 | 条件 | 模型看到 |
| --- | --- | --- |
| 0 | 目录很小 / 无可折叠工具 | 上游组装原样保留，不折叠工具 |
| 1 | 分组清单塞得进预算 | 桥 + `## 组` 名称/描述清单 |
| 2 | 只有纯名称塞得进 | 桥 + 纯名称清单 |
| 3 | 纯名称也超预算 | 桥 + 每组一行摘要（组名: 数量） |

预算 = `min(thresholdPct% × 上下文窗口, listingMaxTokens)`，每轮重算。清单挂在 runtime context 上，不会被 complete prompt 组合丢弃。

**动态注入**：搜索、查看或成功调用某个延迟工具后，该工具会进入会话的可见集（LRU 上限 `maxWarmTools`），完整 schema 注入后续轮次。原生工具调用成功会把非固定 core 工具加入 warm 集并刷新最近使用顺序；搜索命中按排名加入，超过上限时保留排名靠前项。非核心目录按名称排序并在组装轮次间保持稳定，即使其中的工具已 warm 且当前直接可见，仍会保留在目录中。

`tool_call` 执行时，插件通过 `ctx.tools.execute` 按底层真实工具名执行；守卫和执行通知使用该名称，外层会话记录仍是 `tool_call`。成功桥接结果是 JSON 字符串，解析后为 `{ ok: true, value, content, meta }`：`value` 是底层规范值，`content` 是原有的模型可见内容块。模型只收到 `content`，不会收到原始值的 JSON dump；文字与图片仍能正常展示，不会被图片原始数据的序列化文本取代。失败仍为失败（`isError: true`，带结构化 `error`，没有 `value`）。额外上下文和结束回合信号也会保留。缺少 `meta` 时用 `null` 表示；原生结果可能省略该字段。

未配置 matcher 时，`tool_search` 使用本地 Unicode 关键词匹配工具名、说明和分组名，保留中文并支持少量明确列出的别名，例如 `截图` ↔ `screenshot`/`snapshot`、`仓库` ↔ `repo`/`repository`、`问题` ↔ `issue`。这只是有限的词条映射，不是通用翻译或语义理解。已配置的 rerank 请求失败时，也仍可退回关键词搜索。

## 对话式配置

对你的 agent 说：

> 帮我配置 dsh-tool-search 的工具分组

`tool-slimmer-setup` 技能会读取目录、提出分组方案、与你确认、询问配置**全局还是按项目**，并可引导你配置可选 rerank。无 matcher 时关键词搜索仍可用；预加载需要 matcher。

## 配置

静态调优放在 profile 的 `cordis.patch.yml`（改后需重启）：

```yaml
- id: tool-search
  config:
    enabled: auto        # auto | on | off
    thresholdPct: 5      # 清单预算占上下文窗口的百分比
    listingMaxTokens: 4000
    configScope: auto    # user | project | auto（存在项目文件时优先）
    maxWarmTools: 8      # 动态注入工具的 LRU 上限
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
    "endpoint": "https://<provider-host>/<compatible-rerank-route>",
    "apiKey": "<provider-api-key>",
    "model": "<provider-rerank-model>",
    "topN": 20
  },
  "preload": { "enabled": false, "topK": 5 },
  "core": []
}
```

- `groups`：精确工具名和/或名称前缀；工具归入第一个命中的组。
- `core`：内置默认值为上文九个名称。在静态 `cordis.patch.yml` 中显式设置 `core` 会替换默认名单；运行时 JSON 中的 `core` 会与静态/默认名单取并集。桥接工具、管理工具和 `skill` 也会在当前 scope 允许时常驻；当前传输提供 `run_code` 时，它也属于固定常驻项。严格 PTC 保持 SDK 内容不变；该作用域的通用桥目录发现与派发不可用，应使用现有 SDK。
- 团队、Gitea 和截图工具是可选项；如需直接常驻，可加入静态或运行时 `core`。
- `matcher`：可选的 rerank 端点，需符合本插件支持的请求/响应形状。未配置时，本地关键词搜索仍可用。请求示例为 `{ "model": "…", "query": "…", "documents": ["…"], "top_n": 20 }`，预期响应示例为 `{ "results": [{ "index": 0, "relevance_score": 0.9 }] }`。端点路径、模型名和请求结构应以服务商文档为准；此处不承诺某个 Qwen/DashScope 端点已兼容。
- `preload`：可选；启用（需配 matcher）后，会话首轮会用任务描述语义预加载 top-K 命中工具进 eager 集。
- 文件按 mtime 热重载，下一轮生效。

## 桥接工具

| 工具 | 作用 |
| --- | --- |
| `tool_search(query, limit?)` | 搜索延迟目录（rerank，关键词兜底），返回排序后的 `{name, description, group}` 匹配；命中工具注入可见上下文 |
| `tool_describe(name)` | 加载单个延迟工具的完整 schema；该工具注入可见上下文 |
| `tool_call(name, arguments)` | 以真实工具名调用延迟工具；成功结果的 JSON 字符串含 `value`、`content`、`meta`，失败通过 `isError` 和结构化 `error` 表示；外层会话记录仍是 `tool_call` |

## 设计要点与坑

- 瘦身只改写**模型可见表面**（`system-prompt/assemble`），并将有效组装快照与当前可达工具 schema 求交集；此前被 scope 过滤的工具不会被重新加入。拿不到快照时，插件发出提示并保持组装不变；该 scope 无法通过桥发现或调用工具。
- 每次都必须传入上游过滤已完成的新 assembly。插件会替换同名目录 context，因此一次组装最多有一个；若把上一轮已瘦身的 assembly 再作为下一轮输入，已从快照移除的工具不会自动恢复。
- 当前 scope 允许时，桥、两个配置工具和 `skill` 会常驻，不会被自己延迟；当前传输提供 `run_code` 时，它也属于固定常驻项。
- **严格 PTC 作用域保留生成的 SDK。** 插件不改变 SDK 内容；该作用域的通用桥目录发现与派发不可用，应使用现有 SDK。
- 本地关键词搜索无需外部服务；它保留 Unicode 词项并只使用有限的显式中英别名，不会翻译任意短语。rerank matcher 是可选项。
- 没有当前 scope 的稳定组装快照时，`tool_search` 返回空结果和提示，`tool_describe` 报告该 scope 不可用，`tool_call` 返回错误。strict PTC 下通用桥目录发现与派发不可用，插件不改变 SDK 内容，应使用现有 SDK。
- 完整架构见 [DESIGN.md](DESIGN.md)。

## 链接

- [GitHub](https://github.com/Letter2025/dsh-tool-search)
- [npm](https://www.npmjs.com/package/dsh-tool-search)
- [设计文档](DESIGN.md)

## 许可证

MIT
