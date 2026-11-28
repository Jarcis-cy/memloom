# memloom 宿主契约（公开版 v1.4）

这份文档说清「宿主适配层」和「宿主无关核心」之间的约定。字段名就是 `src/host/types.ts` / `src/host/index.ts` 的导出名；要改字段，先在这里改版本号，再通知 `adapters/` 的维护者。

目前官方只接 **Pi**（见 `adapters/README.md`）。别的宿主可以用通用子进程入口接入，核心不绑任何宿主的 SDK。

## 0. 一句话

适配层只做两件事：把宿主的事件翻成下面的 `HostEvent`，把 `HostResponse` 里的三段文字（静态区 / 当轮提醒 / 分歧通知）放到该放的位置。SQL、检索、提示词、凝结、CRAFT 投影、后台调度全在 `src/host/` 和内核里；适配层不写业务、不碰 `~/.memloom`、不加载模型，也不重复核心已经做了的去重、限频和超时。

## 1. 入口

| 用途 | 调用 | 说明 |
|---|---|---|
| Pi 扩展进程内常驻 | `import { HostCore, resolveHostConfig } from '<仓库>/dist/src/host/index.js'`；扩展加载时 `new HostCore(resolveHostConfig({}, process.env))`，每个事件 `await core.handle(event)`；发完 `session_end` 后 `core.close()` | 同一个宿主进程里实例一直留着。会话状态默认落文件（`<home>/sessions/`），所以续会话、reload 换了进程也拿回同一份静态区 |
| 通用子进程（不绑宿主） | `node dist/src/host/hook-cli.js --event`（stdin 一条 `HostEvent` JSON → stdout 一条 `HostResponse` JSON），或 `memloom hook --event` | 永远退出 0；诊断只写 stderr，不写用户原话和凭据 |

后台活动不在事件处理里等网络：会话内任务（纠错凝结、复盘抽取）在进程内串行跑；关会话 / 压缩前的抢救由 `node hook-cli.js --job <说明文件>` 另起的脱离短命子进程做，宿主进程退出了也做得完。没有常驻调度服务。

## 2. 事件（输入）`HostEvent`

```ts
type HostEvent =
  | { type: 'session_start'; sessionId: string; resume?: boolean; cwd?: string | null }
  | { type: 'user_message'; sessionId: string; text: string }
  | { type: 'assistant_message'; sessionId: string; text: string }   // 可选：只为复盘 / 抢救留对话
  | { type: 'tool_result'; sessionId: string; toolName: string; isError?: boolean; exitCode?: number | null; output?: string | null; skipHint?: boolean }
  | { type: 'compact'; sessionId: string }       // 压缩前：抢救最近未覆盖的 ≤ 20 条
  | { type: 'session_end'; sessionId: string };  // 关会话：抢救 + 清对话片段
```

- `sessionId` 必填、非空、不超过 200 字、不含换行；用宿主自己的会话号。
- `session_start`：`resume` 只是提示，**核心按 `sessionId` 判断**——已有会话状态就原字节返回存下来的静态区，不重算、不再发分歧通知。每次 `session_start`（或首个 `before_agent_start`）发一次即可。
- `tool_result`：每次工具调用都发；`isError === true` 或 `exitCode` 是非零数字才算失败（才触发提醒），成功只计数。可选 `skipHint: true` 表示这一下失败的提醒由适配层用别的结果负责（例如同一批工具里只提醒第一个失败），核心照常记录、计数和调度，只是不再等检索。缺省时行为与以前一致。
- 最少只需要 `session_start` + `user_message`。
- 同一会话的事件在核心里按顺序串行处理，两条事件绝不交错改状态。

## 3. 回执（输出）`HostResponse`

```ts
interface HostResponse {
  event: HostEvent['type'];
  sessionId: string;
  scope: string;                 // personal | project:<project_id> | role:<slug>
  staticBlock?: string;          // 只在 session_start 出现（含空串）；整场固定字节
  hint: string;                  // user_message / tool_result 以外恒为 ''
  hintState: 'off' | 'skipped' | 'silent' | 'timeout' | 'unavailable' | 'empty' | 'hinted';
  hintReason?: string;           // skipped / timeout / unavailable 时的大白话原因
  dilemmaNotice: string;         // 只在 session_start 可能非空
  correction: { captured: boolean; experienceId: number | null; reason: string | null };
  background: Array<{ kind: 'review' | 'flush' | 'correction' | 'model-download'; state: 'queued' | 'spawned' | 'skipped' | 'coalesced'; reason?: string }>;
  elapsedMs: { total: number; hint: number | null };
}
```

`handle()` 返回的回执永远是完整的：`background` 里的条目在事件处理返回之前就已经登记好（包括按工具调用次数触发复盘的那一次），调用者拿到回执时不需要再等什么。

### 三段文字放在哪

| 段 | 何时出现 | 放哪 | 上限 |
|---|---|---|---|
| `staticBlock` | 仅 `session_start` | 宿主的系统位置。Pi 里是 `before_agent_start` 的 `systemPromptOptions.sections.memloom`；没有「系统位置」的宿主就是一次性附加上下文。字节稳定是为了给供应商的前缀缓存创造条件，不是计费保证 | ≤ 3,000 字符（含 `<memloom-standing>` 包装）：生效铁律 + 至多 8 条常驻核心原则 + 一句工具说明；放不下按强度从低到高整条舍弃并写明「还有 N 条」，绝不截半句 |
| `hint` | 每条 `user_message`、失败的 `tool_result` | 当轮上下文尾部：用户原话**之后**、模型回复之前，不改历史。Pi 里是 `before_agent_start` 返回的一条独立上下文消息 | ≤ 400 字符（含 `<memory-hint>` 包装），0–3 条，精排分 ≥ 0.72 |
| `dilemmaNotice` | 仅 `session_start`，且未提醒过的 open 分歧 ≥ 3 或其中有撞铁律的 | 和静态区同一个位置，但在 `staticBlock` 之外另起一段 | 两行以内；同批只提醒一次（靠 `dilemmas.surfaced_count`） |

`hintState`：`off` = 该事件不产生提醒；`skipped` = 寒暄 / 斜杠命令 / 不足 6 字，或适配层标了 `skipHint`；`empty` = 检索做了但过线的都已静态注入或本会话提醒过；`silent` = 没有语义能力（fts-only）或没找到候选或没过精排；`timeout` = 超过前台预算，结果丢弃；`unavailable` = 检索器报不可用；`hinted` = 有提醒。

去重：静态区里的原则、本会话已提醒过的条目（`P12` / `E3` 这类键）不再出现在提醒里；只有当轮用户原话命中强纠错信号（视为「再次明确违背」）时才允许重复。

## 4. 前台预算与模型

- 一次提醒（一条用户消息，或一个失败的工具结果）在前台最多等 `hint.budgetMs`（默认 **2000 毫秒**，`MEMLOOM_HINT_BUDGET_MS` 可改）；候选只取几条，超时就丢，不排队、不补发。冷启动 / 坏模型 / 无模型一律静默，不用字面分冒充语义分。
- 这是**单次预算**，不是延迟承诺，也不承诺供应商的缓存命中率。
- `session_start` 默认在后台 `warmup()` 一次共享检索服务（`MEMLOOM_WARMUP=0` 关），让第一条真正的消息时模型已就绪；宿主进程从不加载 ONNX。

## 5. 后台活动（登记在 `background`，用户会话不等）

| 触发 | 动作 | 外发 |
|---|---|---|
| 用户原话命中强纠错 | **立刻**同步写一条 `correction` 经历（同会话每 3 轮最多 1 次），再排一个 `correction` 凝结任务 | 凝结时把这一条经历 + 现有原则 + 铁律发给后台端点 |
| 每累计 10 条用户消息或 15 次工具调用 | `review`：把上次覆盖以来的消息（最多 20 条，去掉 memloom 自己注入的文字）交抽取模型写经历 | 最近对话片段 |
| `compact` / `session_end` | `flush`：最近 ≤ 20 条未覆盖消息只抽取经历，不凝结 | 最近对话片段 |
| `session_start`（auto / local-onnx 模式，本地模型没下齐） | `model-download`：在后台拉起 `memloom models download`，本轮和下完前的提醒只用字面检索；下完后的下一次召回自动切到本地语义检索。`spawned` / `coalesced`（已有下载在跑）/ `skipped`（退避期、镜像地址无效、拉不起来）；`MEMLOOM_AUTO_DOWNLOAD=0`、配了 API 或 `fts-only` 时不登记 | 固定公开模型仓库或镜像的 GET 请求（不带凭据、不带用户文本） |

- 后台模型就是命令行那一个端点（`MEMLOOM_LLM_BASE_URL` / `MEMLOOM_LLM_MODEL` / `MEMLOOM_LLM_API_KEY`），没配置就 `state: 'skipped'`，什么都不发。
- 同一会话同一时刻最多 1 个任务在跑、最多 1 个排队，同类任务在队列里只留一个（`coalesced`）。
- 项目 / 角色会话只写该项目的 `.team/.mind.db`；个人会话只写个人库；没有任何把项目内容升格进 personal 的路径。

## 6. 配置与目录边界

`resolveHostConfig(flags, env)` 和命令行同一套：`MEMLOOM_HOME`（默认 `~/.memloom`）、`MEMLOOM_DB`、`MEMLOOM_PROJECT` + `MEMLOOM_ROLE`、`MEMLOOM_STATE_DIR`，检索与后台模型变量见根目录 README。宿主专用的：

| 变量 | 含义 |
|---|---|
| `MEMLOOM_HINT_BUDGET_MS` | 前台等提醒的上限（默认 2000） |
| `MEMLOOM_HINT_THRESHOLD` | 提醒门槛（默认 0.72） |
| `MEMLOOM_WARMUP` | `0` = 会话开始不预热共享检索服务 |
| `MEMLOOM_CREW_CLI` | **可信** agent-crew CLI 的绝对路径；只有显式给出才会在 CRAFT 投影后用它刷新 BRIEF |

- 项目 / 角色会话：必须有显式 `MEMLOOM_PROJECT` 指向含 `.team/manifest.json` 的目录；角色必须已存在（`.team/roles/<slug>/ROLE.md` 是普通文件）；`.team`、`roles`、角色目录、`manifest.json` 任一是符号链接或错误形态直接拒绝；库固定在 `.team/.mind.db`。不从 cwd 猜项目，不从任何归档指令里取命令。
- 会话快照：`<home>/sessions/`（0700）下按「库路径 + 作用域 + 会话号」散列命名的文件（0600）和锁文件；里面只有静态区文本、计数器、去重键、最近消息片段，没有凭据。`session_end` 仍当场安排最近窗口的抢救，然后清掉对话片段，**保留同一库同一作用域的静态字节 / 去重 / 限频游标**；7 天未更新的下次启动时清理。
- 后台任务说明放 `<home>/jobs/`（0600）：只含端点、模型名、作用域、路径和要抽取的那段对话，**永远没有凭据**；子进程读完即删。后台模型的凭据只通过子进程环境变量传。
- 除三段文字外，核心不向宿主输出任何用户文字；凭据只在内存。

## 7. 和 agent-crew 的单向联动

memloom 和 [agent-crew](https://github.com/Jarcis-cy/agent-crew) 可以一起用，也可以各用各的：**agent-crew 不读取也不依赖 memloom 的数据库，memloom 不往 agent-crew 的数据库里写（它也没有数据库）**。唯一的交点是项目目录里的几份 Markdown：

- **项目身份**：`.team/manifest.json` 的 `project_id` 是稳定项目身份；`project:<project_id>` / `role:<slug>` 的记忆与向量存在显式项目根下的 `.team/.mind.db`，个人库另存。
- **CRAFT（memloom → 项目，单向）**：凝结成功后核心把当前作用域的生效原则按「常驻核心优先、强度降序」写成 `- ★ <触发场景>：<行动准则>`，放进 `.team/CRAFT.md`（项目）或 `.team/roles/<slug>/CRAFT.md`（角色）的 `<!-- memloom:craft:start -->…<!-- memloom:craft:end -->` 区。区外字节原样、手写条目保留；整份文件（手写 + 生成）不超过 40 条，放不下就少写并报告，不截句。目标或父级是链接 / 错误形态就拒绝，一个字节不写。**绝不从 Markdown 反写 SQLite**。手动触发：`memloom craft sync`。
- **BRIEF（agent-crew 自己渲染）**：`BRIEF.md` 的唯一渲染器是 `crew brief --write`。`memloom craft sync --brief` 只有在 `MEMLOOM_CREW_CLI` 指向可信的 `crew.mjs`（绝对路径、普通文件）时，才用参数数组调它（无 shell、30 秒超时）；没有配置就如实提示手动命令，不另造第二个写 BRIEF 的模板。

## 8. 例子

```js
import { HostCore, resolveHostConfig } from '<仓库>/dist/src/host/index.js';

const config = resolveHostConfig({}, process.env);        // 或显式 { home, dbPath, scope, ... }
const core = new HostCore(config);
const start = await core.handle({ type: 'session_start', sessionId });   // start.staticBlock → 系统位置；start.dilemmaNotice 另起一段
const turn = await core.handle({ type: 'user_message', sessionId, text: prompt }); // turn.hint !== '' → 挂当轮尾部
core.close();
```

## 9. 版本

- v1（2026-11-27）：首版。
- v1.1（2026-11-27）：按当时的宿主证据补充映射与落点事实。
- v1.2（2026-11-27）：决定只接 Pi，保留通用子进程入口。导出形状不变。
- v1.3（2026-11-27）：`tool_result` 新增可选 `skipHint`（缺省不变）；`session_end` 改为保留同库同作用域的快照（清对话片段）以保证续会话原字节；任务说明不含凭据、凭据只走子进程环境；默认预算注明是单次提醒的预算。`HostResponse` 形状不变。
- v1.4（2026-11-28）：`background` 新增 `model-download`（auto / local-onnx 模式缺本地模型时，`session_start` 登记一次：`spawned` = 刚拉起后台下载、`coalesced` = 已有下载在跑、`skipped` = 退避期 / 镜像地址无效 / 拉不起来；关了自动下载、配了 API 或 fts-only 时不登记）。提醒在模型下完前照常静默，下完并在模型目录根 manifest.json 原子标成 ready 之后的下一次提醒自动走本地语义检索；`HostResponse` 其余形状不变。
- 改任何字段：这里改版本 + 通知 `adapters/` 的维护者。
