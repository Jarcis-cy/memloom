# memloom 完整架构与工程规格书

本文档是 `memloom` 的施工蓝图，面向开发者与编程 Agent。所有设计围绕四个硬目标展开：**干活型定位、单轨过程演化、极低前台注意力税、原生中文大白话**。

---

## 1. 系统边界与作用域模型

`memloom` 只处理**面向干活的耐久知识与工作习惯**（沟通风格、权限边界、工程铁律、跨项目避坑原则、项目内稳定事实与手艺），不追求情感陪伴、不存闲聊流水。

底层内核采用函数式思想设计——同一套“采集 → 召回 → 凝结 → 淘汰 → 自愈”逻辑，通过 `scope`（作用域）隔离不同“主体”的数据：

- **`personal`（默认，跟人走）**：存在 `~/.memloom/personal.db`。存放你的个人铁律、跨项目工作偏好、通用处世原则和本机工具常识。
- **`project:<project_id>`（可选，跟项目走）**：当项目目录启用 [agent-crew](https://github.com/Jarcis-cy/agent-crew) 时，可在 `<项目>/.team/.mind.db`（加入 `.gitignore`）实例化同一内核，为该项目及下属角色（`scope = role:<role_name>`）提供语义检索与手艺凝结，同时自动导出干净的 Markdown 文件到 `.team/`。

个人数据与项目数据物理隔离，项目专属的实现细节不污染个人大脑；仅当某条经历明确属于用户跨项目偏好或通用处世原则时，才归入 `personal`。

---

## 2. 单轨数据模型（SQLite）

使用 Node.js 24 内置 `node:sqlite`（开启 WAL 模式与外键约束）。彻底采用单一真相源，所有面向人阅读的 Markdown（如 `STANDING.md`、`PRINCIPLES.md`）均由数据库单向导出，不再维护双向同步的旧文本账本。

### 表 1：`iron_rules`（置顶铁律）
人工主导的最高红线，建议 ≤ 10 条、总计 ≤ 1,200 字。后台自动任务**禁止修改或删除**。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 自增编号 |
| `scope` | TEXT NOT NULL | 默认 `'personal'` |
| `content` | TEXT NOT NULL | 大白话中文铁律正文 |
| `active` | INTEGER NOT NULL DEFAULT 1 | 1 生效 / 0 停用 |
| `created_at` | TEXT NOT NULL | ISO-8601 时间戳 |
| `updated_at` | TEXT NOT NULL | ISO-8601 时间戳 |

### 表 2：`experiences`（经历账本）
只追加的事件流水，记录有持续价值的具体经历。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 自增编号 |
| `scope` | TEXT NOT NULL | `personal` / `project:<id>` / `role:<name>` |
| `kind` | TEXT NOT NULL | `correction`（纠错）/ `preference`（偏好）/ `pitfall`（踩坑）/ `decision`（拍板）/ `fact`（稳定事实） |
| `summary` | TEXT NOT NULL | 大白话中文一句话总结（完整句子，禁止电报体） |
| `evidence` | TEXT | 对话原文短摘录（用于溯源与纠偏） |
| `source` | TEXT NOT NULL | `review` / `correction` / `flush` / `manual` / `import` |
| `source_session` | TEXT | 来源会话 ID |
| `embedding` | BLOB | `Float32Array` 序列化字节（默认 512 维，2 KB/条） |
| `embedding_model` | TEXT | 生成该向量的模型与维度标识（如 `qwen3-emb-0.6b:512`） |
| `occurred_at` | TEXT NOT NULL | 发生时间 |
| `created_at` | TEXT NOT NULL | 写入时间 |
| `processed_at` | TEXT | 被凝结引擎处理的时间（NULL 表示待处理） |
| `hit_count` | INTEGER NOT NULL DEFAULT 0 | 被召回次数 |
| `last_hit_at` | TEXT | 最近召回时间 |

配套虚表：`experiences_fts`（SQLite FTS5，采用 `trigram` 分词器索引 `summary` 与 `evidence`，并通过 `AFTER INSERT/UPDATE/DELETE` 触发器自动同步）。

### 表 3：`principles`（凝结原则池）
从多条经历中抽象出来的通用行为准则。**结构上强制拆出“触发场景”和“行动准则”两栏**，既提升语义匹配精度，又倒逼语言清晰。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 自增编号 |
| `scope` | TEXT NOT NULL | `personal` / `project:<id>` / `role:<name>` |
| `trigger_when` | TEXT NOT NULL | 触发场景一句话（如“当你准备递归删除一个目录时”） |
| `rule` | TEXT NOT NULL | 大白话行动准则（如“先检查它是不是软链接，不要直接带尾斜杠删除，防止顺着链接误删目标目录”） |
| `rationale` | TEXT | 简短来由说明 |
| `status` | TEXT NOT NULL | `active` / `merged` / `superseded` / `retired` |
| `is_core` | INTEGER NOT NULL DEFAULT 0 | 1 表示入选静态常驻区的高频核心原则（严格限额 ≤ 8 条） |
| `parent_ids` | TEXT | JSON 数组，记录合并或替代了哪些旧原则 ID（完整血缘） |
| `source_experience_ids` | TEXT | JSON 数组，记录支撑它的经历 ID |
| `embedding` | BLOB | 对 `trigger_when + "\n" + rule` 生成的向量（512 维） |
| `embedding_model` | TEXT | 向量模型与维度标识 |
| `strength` | REAL NOT NULL DEFAULT 1.0 | 强度分（结合近期使用、遵守与违背反馈动态计算） |
| `applied_count` | INTEGER NOT NULL DEFAULT 0 | 被遵守次数 |
| `violated_count` | INTEGER NOT NULL DEFAULT 0 | 被违背次数 |
| `retire_reason` | TEXT | 软淘汰或被替代的中文说明 |
| `created_at` | TEXT NOT NULL | 创建时间 |
| `updated_at` | TEXT NOT NULL | 更新时间 |
| `last_used_at` | TEXT | 最近命中或反馈时间 |

**硬容量天花板（默认配置，可调）**：
- `personal` 域生效原则上限：**100 条 / 25,000 中文字符**（硬天花板 120 条）；
- 单个专家 `role` 域手艺上限：**30 条 / 8,000 中文字符**（硬天花板 40 条）。
- 达到软上限（80%）时，凝结任务优先执行 `abstract_merge`（上位抽象合并）和 `retire`（淘汰过时与长期零使用项）。

### 表 4：`dilemmas`（真分歧队列）
仅登记系统确实无法自行拍板的极少数重大分歧。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 自增编号 |
| `scope` | TEXT NOT NULL | 作用域 |
| `kind` | TEXT NOT NULL | `iron_rule_collision`（撞上置顶铁律）/ `value_conflict`（用户前后说法矛盾） |
| `summary` | TEXT NOT NULL | 一句话大白话讲清分歧焦点 |
| `option_a` | TEXT NOT NULL | 选项 A（通常是保留现有规则及其含义） |
| `option_b` | TEXT NOT NULL | 选项 B（通常是采用新规则及其含义） |
| `related_principle_ids` | TEXT | 相关原则 ID JSON 数组 |
| `source_experience_ids` | TEXT | 触发分歧的经历 ID JSON 数组 |
| `status` | TEXT NOT NULL | `open` / `resolved` / `dismissed` |
| `resolution` | TEXT | 用户选择与最终执行结果 |
| `surfaced_count` | INTEGER NOT NULL DEFAULT 0 | 已在会话里轻声提醒过几次 |
| `created_at` | TEXT NOT NULL | 创建时间 |
| `resolved_at` | TEXT | 解决时间 |

---

## 3. 轻量检索底座（`Retriever` 抽象与单机共享服务）

### 3.1 统一接口
```ts
export interface Retriever {
  readonly modelId: string;        // 例如 "qwen3-emb-0.6b:512"
  readonly dimensions: number;     // 默认 512
  embed(texts: string[], mode: "query" | "document"): Promise<Float32Array[]>;
  rerank(query: string, documents: string[], topK: number): Promise<Array<{ index: number; score: number }>>;
  health(): Promise<{ ok: boolean; mode: "local-onnx" | "api" | "fts-only"; detail?: string }>;
}
```

### 3.2 三档运行模式
1. **`local-onnx`（默认推荐，纯本地 CPU 内存）**
   - 模型：`Qwen3-Embedding-0.6B`（支持 Matryoshka 截断至 **512 维**并做 L2 归一化）+ `Qwen3-Reranker-0.6B`，采用 INT8 或 Q4 量化 ONNX 格式。
   - **单机共享驻留进程（极关键）**：
     - 绝对禁止在每个 Agent 会话进程内各自加载 ONNX 模型。
     - 内核自带一个极轻本地守护进程（监听 `~/.memloom/retriever.sock` Unix Socket，Windows 回落本地随机回环端口 + 锁文件）：
       - 首次收到请求时自动按需拉起；
       - 全机所有终端、子 Agent、MCP 客户端共用这一份常驻内存（双模型 INT8 共约 1.8–2.2 GB，Q4 共约 1.2–1.6 GB）；
       - 连续闲置超过可配置时长（默认 10 分钟）自动卸载模型并退出，空闲内存归零。
2. **`api`（低配主机可选）**
   - 兼容标准 OpenAI `/v1/embeddings` 与标准 `/v1/rerank`（SiliconFlow / Jina / Cohere 风格接口），零本地内存占用。
3. **`fts-only`（断网或无模型时的保底模式）**
   - 自动退回 SQLite FTS5 `trigram` 检索 + 关键词重叠打分。
   - **中文查询构造注意点**：中文词切分时必须直接从原始连续汉字串提取长度 ≥ 3 的窗口（不足 3 字时用精确 `LIKE` 辅助匹配），避免把 2 字切片拼回 3 字时写出死逻辑；严禁强制要求提问里必须包含英文标识符才触发检索。

### 3.3 混合召回与精排流水线
当收到一句查询 `query` 时：
1. **向量粗排**：加载当前作用域下生效的 `principles`（百来条，内存余弦扫描 < 1 ms）以及最近/高频 `experiences` 候选，取 Top 12；
2. **FTS5 精确补位**：用 `query` 跑一次 FTS5（保住命令名、报错码、路径、工单号等精确词 100% 不漏），取 Top 8；
3. **合并去重**：合并两组候选（最多 15 条）；
4. **Reranker 精排**：把 `query` 与候选文本（原则用 `trigger_when + rule`）送进 0.6B Reranker 打 `[0, 1]` 相关性分；
5. **高门槛截断**：动态注入只保留得分 ≥ 阈值（默认 `0.72`，可调）的前 **2~3 条**；手动深搜工具（`memloom_search`）可返回 Top 8~10 条。

---

## 4. 双区注入与 Prompt Cache 保护

### 4.1 静态区（写入 System Prompt，整场会话锁定不变）
总预算严格 ≤ **3,000 中文字符**，只包含：
1. `<iron-rules>`：全部生效的置顶铁律（≤ 1,200 字）；
2. `<core-principles>`：按强度精选的 5~8 条最通用核心原则（≤ 1,200 字）；
3. 极短一句工具说明（告诉模型可用 `memloom_search` 按需深查历史，≤ 200 字）；
4. **明确禁止**：不再输出任何长达数千字的“未注入原则目录索引墙”。

### 4.2 动态区（挂在当轮用户消息旁，不碰 System Prompt 前缀）
- 触发时机：每轮用户消息进入前（长度 ≥ 6 字且非纯寒暄/斜杠命令），或检测到工具返回非零报错摘要时。
- 执行逻辑：调用 `recall(query, scope)`；过滤掉本场会话已经静态注入或之前轮次已经动态提醒过的 ID（除非刚检测到再次违背）。
- 输出格式（仅在有高置信度命中时附加，总计 ≤ **400 字**）：
  ```text
  <memory-hint>
  与当前情况高度相关的历史提醒（仅作参考，以用户本轮指令和现场事实为准）：
  - [P12] 递归删除目录前先检查是不是软链接，不要带尾斜杠直接 rm -rf。
  </memory-hint>
  ```
- 没有任何高分命中时，返回空字符串，**零干扰、零开销**。

---

## 5. 后台采集、凝结抽象与三级冲突自愈

所有采集、凝结、淘汰工作全部放在后台异步执行，绝不让一线干活模型分心记账。后台使用的 LLM 完全配置化（默认任意平价快速模型，支持主备回退链）。

### 5.1 采集扳机
1. **定期后台复盘**：每经过 N 轮对话（默认 10 轮）或 M 次工具调用（默认 15 次），异步读取最近对话片段抽取值得保存的经历。
2. **中英文双语实时纠错检测**：在用户发消息后做轻量检测，同时覆盖中文强信号（如“不对”“不是这样”“别这么干”“停下来”“不要自作主张”“我不是这个意思”“说人话”“别乱改”）和英文强信号，命中后立即捕获 `correction` 经历（限频：最多每 3 轮 1 次）。
3. **压缩 / 关闭前抢救（`flush`）**：在宿主触发上下文压缩前或会话关闭前，对最近 20 条未覆盖的消息做一次快速事件抢救（仅采集经历，不做重凝结）。

### 5.2 凝结引擎（6 个标准动作）
当待处理经历攒够一批（默认 15 条，或距上次凝结超过设定时间）时，后台按**小批量（每次 15~20 条）**运行凝结：

- **`add`**：新增原则（必须拆成 `trigger_when` + `rule`，校验不与已有原则高语义重复）；
- **`reinforce`**：补充证据并提升原原则强度，不改写原意；
- **`abstract_merge`**：当系统通过向量相似度（如 ≥ 0.78）发现 2~4 条相似原则，或原则池逼近容量上限时，把这一小簇相似原则单独拎给模型，要求**往上抽象一层，写成一条脱离具体事件、更凝练的大白话处世原则**，旧条目全部标 `merged` 并记录血缘；
- **`replace`**：新证据直接推翻旧原则时，用新原则接替，旧条目标 `superseded`；
- **`retire`**：对已过时、长期零使用且绑定旧一次性场景、或误入 `personal` 的具体项目琐事，标为 `retired` 并记录中文原因（软淘汰，不删历史，且**不会**像撤销误合并那样把旧碎片全部复活）；
- **`dilemma`**：仅在撞上 `iron_rules` 或用户前后亲口给出矛盾大方向时登记。

### 5.3 三级冲突自愈与“轻声冒泡”协议
| 级别 | 冲突类型 | 处理方式 | 是否打扰用户 |
|---|---|---|---|
| **一级** | 表述近似 / 局部补充 / 过时失效 | 后台自动 `abstract_merge` 或 `retire` | **不打扰** |
| **二级** | 用户亲口最新纠错 / 更新的客观事实反转旧原则 | 立刻自动 `replace`（新覆盖旧，旧条目软退役可追溯），无需凑满 2 条才动 | **不打扰** |
| **三级** | 撞上置顶铁律 / 用户前后给出互斥的长期方向 | 写入 `dilemmas` 表 | **达阈值后轻声冒泡** |

**轻声冒泡机制**：
- 当 `dilemmas` 中状态为 `open` 的条数 ≥ 3 条，或存在任意 1 条 `iron_rule_collision` 时，在**下一次新会话的开场上下文里**附带一条极短指令，让主模型在回答完用户正事后，于回复末尾追加一个小段落（同一批分歧最多提醒一次，避免连环刷屏）：
  > 顺带一提：记忆系统里目前有 N 处拿不准的规则分歧（涉及：XX、YY）。你方便时可以新开一个会话，发一句「处理记忆分歧」，我会把选项用大白话列出来，你回个序号，剩下的我全部自动更新写回。
- 当用户在新会话说出“处理记忆分歧”时，模型调用 MCP 工具拉出 `dilemmas` 清单、逐条给出 A/B 大白话选项；用户选完后，模型调用 `memloom_resolve_dilemma` 一次性完成更新、淘汰、向量刷新和快照导出。

---

## 6. 底层大白话提示词规范（必须内置在 `src/prompts/`）

所有后台提取与凝结提示词一律使用**自然中文**，并强制包含以下三条铁律及正反例：

1. **完整自然中文**：必须有清晰主语、条件和动作，像给同事口头交代经验一样说话。
2. **禁止压烂语序**：绝不通过删掉主语、删掉连接词、自造中文缩略词或堆砌斜杠来省字数；需要控制总量时，只能选择跳过不重要的事、淘汰旧规则或做上位抽象。
3. **保留硬技术锚点**：代码标识符、配置键、命令行参数、文件路径、报错原文保持原样不乱译，其余说明全部用大白话。

**内置正反例示例（直接写进系统提示词）**：
- ❌ 坏写法（电报黑话）：`代际验证事实须按RoundRevision钉缓存，用facts.SourceDir建本腿Options与窄verify-tail，MapRevision仅稳态确认不可代历史身份`
- ❌ 坏写法（英文法条）：`Explicitly establish required file modes and ownership including temporary files and host/container handoffs; do not rely on umask.`
- ✅ 好写法（大白话，拆出触发场景 + 行动准则）：
  - `trigger_when`：`当你准备在宿主机和容器之间共享目录或临时文件时`
  - `rule`：`一定要在写入进程启动前明确设好目录的权限和属主，不要指望 umask 或 MkdirAll 自动弄对；遇到权限交接失败立刻停止，绝不能靠提权掩盖问题。`

---

## 7. 一句话打包与加载（便携归档协议）

### 导出（`memloom export --scope personal|project --out <file.tar.gz>`）
归档包结构（纯文本为主，典型大小几百 KB ~ 几 MB，**严格排除二进制 SQLite、向量字节与任何凭据**）：
```text
memloom-personal-20261127.tar.gz
├── manifest.json         # schema_version, scope, exported_at, counts, sha256
├── iron_rules.json       # 置顶铁律
├── principles.json       # 生效原则（含血缘与统计）
├── experiences.jsonl     # 精选高价值经历（可配置仅导出被原则引用或近期高命中的条目）
├── readable/
│   ├── STANDING.md       # 人可直接阅读的铁律
│   └── PRINCIPLES.md     # 人可直接阅读的原则清单
└── team/                 # (仅 project 导出时包含) 完整 .team/ 纯文本目录
```

### 导入（`memloom import <file.tar.gz> [--mode merge|replace]`）
1. 校验 `manifest.json` 版本号与各文件 sha256；
2. 默认 `merge` 模式：按内容指纹与语义相似度与本地库安全合并（不粗暴覆盖新机器已有记录，冲突走分级自愈）；
3. 写入本地 SQLite 后，自动调用本地 `Retriever` 批量重建全部向量索引（100 条原则约数秒完成）；
4. 重新生成人可读的 Markdown 视图，输出清晰导入回执（新增 / 合并 / 跳过 / 重建向量数）。

---

## 8. 对外接口清单

### MCP Server 工具（`memloom-mcp`）
- `memloom_recall(query, scope?, limit?)`：按语义 + FTS5 精排检索相关原则与经历；
- `memloom_capture(scope, kind, summary, evidence?)`：手动记录一条经历；
- `memloom_iron_rules(action: "list"|"add"|"disable", ...)`：管理置顶铁律；
- `memloom_dilemmas(action: "list"|"resolve", ...)`：列出或一键解决待拍板分歧；
- `memloom_concresce(scope?)`：手动触发一次凝结与瘦身；
- `memloom_export(scope, outPath?)` / `memloom_import(archivePath, mode?)`：一句话打包与加载。

### CLI 命令（`memloom`）
与上述 MCP 工具一一对应，外加 `memloom daemon status|stop`（查看或手动停掉共享本地检索进程）与 `memloom doctor`（一键体检配置、数据库、检索模式与容量）。

### 极薄宿主胶水（`adapters/`）
- `adapters/pi/`（≤ 100 行）：监听 `before_agent_start`（注入静态区 + 当轮尾部动态提醒）、`message_end`（中英文纠错检测）、`turn_end`（定时异步采集）、`session_before_compact / session_shutdown`（抢救采集）。
- `adapters/claude-code/`：映射对应 Hook（`SessionStart` / `UserPromptSubmit` / `PreCompact` / `Stop`）调用 `memloom` CLI。
- **硬约束**：`adapters/` 内绝不写数据库 SQL、向量计算、提示词模板或凝结逻辑。

---

## 9. 分阶段验收清单

1. **M1 验收**：SQLite 4 表与 FTS5 触发器完整；`iron_rules` 不可被凝结覆盖；大白话凝结（含 `abstract_merge` / `retire`）和三级冲突自愈全通过离线模拟测试。
2. **M2 验收**：本地 0.6B ONNX 共享进程跑通（并发 5 个客户端只占 1 份内存、闲置后自动释放）；中文同义句能高分召回；切 API 模式与断网退回 FTS5 均不报错。
3. **M3 验收**：导出包不含凭据与二进制库；在干净临时目录导入后能自动重建向量并召回原原则；MCP 与 CLI 端到端测试通过。
4. **M4 验收**：在宿主实测多轮对话——验证静态区 ≤ 3,000 字且字节级稳定（Prompt Cache 不失效）；中途换中文话题或触发报错时动态尾部提醒准确弹出且 ≤ 400 字；中文纠错立即捕获。
