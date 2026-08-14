# dsh-tool-search — Hermes 风格工具搜索与瘦身插件

> DeepSeek Harness 插件：当模型可见工具目录很大时，把长尾工具折叠为三个桥接工具
> （`tool_search` / `tool_describe` / `tool_call`），核心工具保持直通，语义搜索（rerank）
> 按需发现工具，大幅降低每次模型请求的工具 schema token 占用。

## 1. 背景与目标

DSH 是"一切皆插件"，工具数量随 MCP 服务、社区插件增长。所有工具 schema 全量注入
上下文时，几百上千个工具的描述会吃掉大量 token（Hermes 实测 Cloudflare 单个 MCP
的纯名称就约 32K token）。目标：

1. **渐进式披露**：核心工具永远直通；长尾工具按档折叠，模型需要时再搜索/加载。
2. **搜索发现**：`tool_search` 用配置的 rerank 模型做语义搜索（不做本地 BM25，用户判定效果差）。
3. **用户可定制**：工具分组通过对话式技能完成（模型提案 → 用户确认 → 写配置）；
   rerank 模型由技能引导用户配置；预加载为可选项（需配模型）。
4. **配置两级**：用户级 `~/.dsh/dsh-tool-search.json`（全局）或项目级
   `<workspace>/.dsh/dsh-tool-search.json`（按项目），由用户选择。

## 2. 参考：Hermes Tool Search（NousResearch/hermes-agent）

- 机制：MCP/插件工具替换为 `tool_search(query, limit?)` / `tool_describe(name)` /
  `tool_call(name, arguments)` 三个桥接工具；模型按需加载 schema 并调用。
- 分级披露（tiered disclosure）：
  - Tier 0：无延迟工具 → 全量直通，桥不出现。
  - Tier 1：清单（名称+一句话描述）塞得进预算 → 桥 + 清单。
  - Tier 2：清单超预算、纯名称也超 → 桥 + 每服务器一行摘要。
  - 预算 = `min(threshold_pct% × 上下文窗口, listing_max_tokens)`，每轮重算。
- `tool_call` 解包：守卫/审批/钩子全部对着**真实工具名**跑，主链感知底层工具。

## 3. DSH 接缝（源码核实）

| 需要 | 接缝 | 位置 |
| --- | --- | --- |
| 变换模型可见工具面 | `system-prompt/assemble` 瀑布：`ctx.on('system-prompt/assemble', async (assembly, context, next) => ...)`，可改写 `assembly.tools` 与 `assembly.sections` | `packages/core/system-prompt/src/index.ts:532` |
| 读取全量目录 | `ctx.tools.schemas(scope?)` → `ToolSchema[]`（name/description/parameters） | `packages/core/tools/src/index.ts:1234` |
| 桥接执行真实工具 | `ctx.tools.execute({ callId, name, arguments, agent, signal })` → 走完整管线（pre-policy → guards → dispatch → post-policy → 通知），事件落库 | `packages/core/tools/src/index.ts:1342` |
| 注册桥/管理工具 | `ctx.tools.register(definition)`（output.schema/render 必填） | `packages/core/tools/src/index.ts:1037` |
| 注册技能 | `ctx.skills.register({ name, description, content })` | `packages/skill/skill/src/index.ts:440` |
| 会话工作目录 | `agent.session.cwd`（Session 类型 `cwd?: string`） | `packages/core/session/src/types.ts:73` |
| DSH 用户根 | `$DSH_HOME` 缺省 `~/.dsh`（本地解析，不引依赖） | `packages/util/home-paths` |
| CallId | `CallId(str)` 品牌函数，从 `@deepseek-ai/dsh-llm` 导入 | `packages/llm/llm/src/brand.ts:38` |

⚠️ **不能用 `tools.restrict()` 做瘦身**：它只过滤继承的全局工具且隐藏后 dispatch 直接
`UNKNOWN_TOOL`（"看到却调不动"，PLAN-056 教训）。正确做法是只改 `assembly.tools`
模型表面，注册表保持完整。

## 4. 架构

```
dsh-tool-search = 三部分
├─ ① Hermes 桥引擎（插件本体）
│    tool_search / tool_describe / tool_call + system-prompt/assemble 瀑布分级披露
├─ ② 配置向导技能 tool-slimmer-setup（随包注册）
│    模型对话提案分组 → 用户确认 → 选择全局/项目级 → 引导配置 rerank 模型 → 写配置
└─ ③ 语义匹配器（rerank，仅此一种）
     tool_search 排序 + 可选会话预加载
```

### 4.1 分级披露（每轮 assemble 重算）

```
catalog = ctx.tools.schemas(scope)                       # 全量注册面
core    = config.core ∪ 桥工具 ∪ 管理工具 ∪ 'skill'       # 永远 eager
deferred = catalog − core
catalog 大小 ≤ minCatalogSize (12) 或 deferred 为空 → Tier 0：原样返回
budget = min(thresholdPct% × contextWindow, listingMaxTokens)
manifest = 按组输出的 "name - description" 文本
manifest 估 token ≤ budget      → Tier 1：桥 + 分组清单
纯名称清单 ≤ budget             → Tier 2：桥 + 纯名称分组清单
否则                            → Tier 3：桥 + 每组一行摘要（组名 + 工具数）
替换 assembly.tools = core 工具 + 3 桥；清单以 section 追加进 assembly.sections
```

幂等：目录来自注册表（`ctx.tools.schemas`），变换不改注册表，每轮重建即幂等。

### 4.2 桥接工具

- `tool_search(query, limit?)`：目录（name+description+组）送 rerank 排序 → top-K。
  未配置 matcher → 返回引导错误（提示运行 tool-slimmer-setup）。不做 BM25。
- `tool_describe(name)`：返回单个工具的完整 schema（含 parameters）。
- `tool_call(name, arguments)`：校验名字 ∈ 目录且非桥本身 → `ctx.tools.execute` 以
  真实名执行（`callId = CallId('<外层callId>:tool:<name>')`）→ 返回 `{ok, value|error}`。
  审批/守卫/事件全部对着真实工具名，与 Hermes unwrap 语义一致。

### 4.3 配置

**cordis.yml（静态开关，改需重启）**：

```yaml
plugins:
  tool-search:
    enabled: auto            # auto/on/off（auto = 目录 > minCatalogSize 才桥接）
    thresholdPct: 5
    listingMaxTokens: 4000
    contextWindow: 128000
    searchDefaultLimit: 5
    maxSearchLimit: 20
    minCatalogSize: 12
    configScope: auto        # user | project | auto（auto = 项目文件存在则用项目）
    core: [todo_write]       # 额外永远直通的工具
    matcherTimeoutMs: 15000
```

**运行时文件 `dsh-tool-search.json`（技能写、用户可手改、mtime 热重载）**：

- 用户级：`~/.dsh/dsh-tool-search.json`
- 项目级：`<workspace>/.dsh/dsh-tool-search.json`
- `configScope: project` 且项目文件缺失 → 警告并回落用户级。
- 合并：运行时文件覆盖 cordis.yml 的同名键；`core` 取并集。

```json
{
  "version": 1,
  "groups": [
    { "name": "git", "tools": ["git_status", "git_diff"], "prefixes": [] },
    { "name": "mcp-github", "tools": [], "prefixes": ["mcp_github_"] }
  ],
  "matcher": { "endpoint": "https://dashscope.aliyuncs.com/compatible-mode/v1/rerank", "apiKey": "sk-...", "model": "qwen3-reranker", "topN": 20 },
  "preload": { "enabled": false, "topK": 5 },
  "core": ["read_file", "write_file"]
}
```

### 4.4 管理工具（永远 eager）

- `tool_slimmer_catalog()`：返回全量目录（按现有分组），供技能做分组提案。
- `tool_slimmer_update_config(groups?, matcher?, preload?, scope?)`：校验并写运行时
  配置文件，返回写入路径与摘要。scope ∈ user|project。

### 4.5 技能 tool-slimmer-setup（随包注册）

工作流：`tool_slimmer_catalog` 读目录 → 对话提案分组 → 用户确认/修改 → 询问
全局/项目级 → `tool_slimmer_update_config` 写入 → 引导配置 rerank（endpoint/apiKey/
model，说明 qwen3-rerank 等兼容端点）→ 可选预加载开关说明。

### 4.6 预加载（可选）

`preload.enabled && matcher` 配置时：会话首次 assemble 用会话最近用户消息对目录
rerank，topK 命中并入该会话的 eager 集（按 sessionId 缓存）。matcher 未配置而
preload 开启 → 记警告并保持不激活（不 fail-loud，因配置可由技能稍后写入）。

## 5. 防坑清单

| 坑 | 对策 |
| --- | --- |
| 看到却调不动 | 只改模型表面（assemble 瀑布），不用 restrict |
| 桥被自己延迟 | 桥+管理工具+skill 强制 eager |
| 目录中途变化 | 每轮从注册表重建；`tools/change` 触发缓存失效 |
| 审批显示 tool_call 而非真实工具 | 桥 body 用真实名 execute，审批层天然看真名 |
| 模型伪造工具名 | tool_call 校验 ∈ 目录且非桥 |
| complete prompt 覆盖 sections | 清单走 sections，被 complete 覆盖时瘦身语义退化可接受 |
| 配置改了不生效 | mtime 热重载 + 写入时主动失效 |

## 6. 里程碑

- v0.1.0：桥引擎 + 分级披露 + rerank 搜索 + 管理工具 + 技能 + 两级配置 + 预加载
- v0.2.0：`tools/change` 目录缓存、更多 rerank 端点兼容、web UI 状态显示
