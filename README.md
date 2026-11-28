# memloom

**把 AI Agent 每次干活攒下的零散经历，织成真正管用、人也能一眼看懂的工作原则。**

`memloom`（Memory + Loom）是一套面向 **干活型 AI Agent** 的轻量个人记忆与原则演化引擎。它跟着**你这个人**走，不绑死任何一款 Agent 客户端：目前自带 Pi 的接入胶水；其它支持 MCP / 命令行的 Agent 用同一套 MCP / CLI，也能共享同一份「懂你工作习惯和通用避坑直觉」的大脑。

> 姐妹项目 [**agent-crew**](https://github.com/Jarcis-cy/agent-crew)（跟项目走的动态专家班子）可以和它拼在一起用，也可以各自独立安装。

---

## 它解决什么问题？

1. **换个项目或换个工具，习惯全得重新教** —— 你对沟通方式、权限红线、工程洁癖都有稳定标准，却每开一个新项目都要从头磨合。
2. **开场灌太多记忆，反而把模型变笨** —— 几万字历史总结塞进系统提示词，模型还没干活注意力就被占满。
3. **后台越记越像「加密电报」** —— 自造缩写、删主语、中英混杂，人和模型都读着累。
4. **旧记忆只进不出，冲突全推给人手工批** —— 人反倒成了它的档案分拣员。

## 它怎么工作

记忆只有一条主干、四层，全部存在一个 SQLite 文件里：

1. **置顶铁律**：你亲口钉死的最高底线，后台永远不能擅自改动或删除。
2. **经历账本**：干活中值得记住的瞬间（纠错、踩坑、偏好、事实），只追加留底。
3. **凝结原则**：后台定期把零散经历抽象成「遇到什么场景 → 具体怎么做」的原则；接近容量上限就靠上位合并和淘汰旧条目腾空间。
4. **真分歧队列**：绝大多数重复和过时由后台自己消化；只有撞上铁律或真正两难的分歧才记下来，等你在对话里拍板。

配套四条设计：

- **双区注入**：整场不动的静态底座（≤ 3,000 字符：铁律 + 至多 8 条核心原则）+ 挂在当轮消息尾部的动态提醒（≤ 400 字，只有高置信度命中才出现，没命中就安静）。
- **本地轻量语义检索**：单文件 SQLite + 一个单机共享的本地检索服务（Qwen3 0.6B 向量模型 + 精排模型）；也可以切到 OpenAI 兼容 API；没模型时如实退回字面检索。
- **天生大白话**：后台提示词全部中文；每条原则必须是自然的完整中文短句，省空间靠上位合并和淘汰旧条目，不靠压缩语序。
- **少打扰人**：相似表述自动合并、新纠错覆盖旧、过时条目自动退役；一句话就能把记忆打包成纯文本归档带走。

细节和边界见 [docs/USAGE.md](docs/USAGE.md)，数据表和接口定义见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 快速开始

### 1. 环境

- **Node.js 24 或更新**（直接用内置的 `node:sqlite`，不用编译 C++ 扩展）。
- 只在 Linux x86_64 上实测过；Windows 没有测。
- **路径要短**：共享检索服务用 Unix socket 通信，`<状态目录>/retriever.sock` 不能超过 100 字节（Linux 内核上限 108 字节）。状态目录默认 `~/.memloom`；跑测试用的临时目录（`TMPDIR`）也要是短的公共路径（例如默认的 `/tmp`），别指向很深的私有目录——太长时 memloom 会直接报「状态目录路径太长，Unix socket 放不下」。

### 2. 安装并编译

```bash
npm ci --include=dev --no-audit --no-fund   # 需要联网装一次依赖（不假设你本机已有 npm 缓存；确定有缓存时可以加 --offline）
npm run build                                # tsc，产物在 dist/
npm link                                     # 可选：得到 memloom / memloom-mcp 两个命令；不 link 就用 node dist/src/cli/main.js
```

`onnxruntime-node` 和 `@huggingface/tokenizers` 是可选依赖：装不上不影响编译，也不影响字面检索和 API 模式。

### 3. 模型：默认自动下载，也可以一条命令手动下

```bash
memloom models status                                   # 模型目录、两个模型齐不齐、当前 modelId、后台下载进度或上次失败原因（只读，不联网）
memloom models download                                 # 手动下载固定的 Qwen3 0.6B 双模型（向量 + 精排），下完校验大小和 sha256
memloom models download --mirror https://hf-mirror.com  # 国内镜像；也可以用环境变量 MEMLOOM_HF_ENDPOINT
```

- **默认行为**：没配置 API、也没强制 `fts-only` 时，第一次发现本地缺模型，**当轮立刻退回字面检索、不卡对话**，同时在后台下载；两个模型都下完并校验通过后，同一个会话的下一次召回自动切到本地语义检索，不用重启。
- **下载量**：默认清单 12 个文件，共 1,855,739,404 字节（约 1.86 GB）；总量硬上限 3 GiB。模型目录默认 `<状态目录>/models`。
- **关掉自动下载**：`MEMLOOM_AUTO_DOWNLOAD=0` —— 缺模型时永远只用字面检索，不联网（`npm test` 就是这么跑的）。
- **镜像**：优先级 `--mirror` > `MEMLOOM_HF_ENDPOINT` > `HF_ENDPOINT` > 官方源，只接受 `https://`。仓库、revision、每个文件的大小和摘要都固定在代码里，镜像只负责传字节，给坏文件只会被拒绝重下。
- 下载失败后 30 分钟内不再自动拉起，之后下一次召回再试（手动 `memloom models download` 不受退避限制）；同一个模型目录同一时间只跑一个下载。旧脚本 `node scripts/fetch-retriever-models.mjs --out <目录>` 仍然可用，只是上面这条命令的薄壳。

### 4. 检查

```bash
memloom doctor          # 配置、库完整性、容量、检索档位、本地模型与下载进度、共享检索服务状态；不启动模型、不联网
```

### 5. 一条最小闭环（全程临时目录，不碰 `~/.memloom`）

```bash
export MEMLOOM_HOME=$(mktemp -d)            # 状态目录和默认库都在这里；测试和示例都这么隔离
memloom capture --kind correction --summary "删目录之前先 ls -la 看一眼是不是软链接，确认后再删。"
memloom iron-rules add "没有明说怎么处理就不许擅自动手改用户的项目文件。"
memloom recall 软链接                       # 没模型时如实写 fts-only、没经过模型精排
memloom export --out $MEMLOOM_HOME/personal.tar.gz
memloom --db $MEMLOOM_HOME/b.db import $MEMLOOM_HOME/personal.tar.gz
memloom doctor
```

常用命令（`memloom --help` 看全部，`--json` 输出原始数据）：

| 命令 | 做什么 |
|---|---|
| `recall <查询文字>` | 按语义 + 字面召回相关的原则与经历 |
| `capture --kind … --summary …` / `capture --message … --session … --turn …` | 手动记一条经历 / 按原话检测纠错 |
| `iron-rules list \| add \| disable` | 置顶铁律：只有这些显式的人工入口能改 |
| `dilemmas list` / `dilemmas resolve <编号> --choice A\|B --confirm <编号>` | 看真分歧 / 由你拍板（选 B 要逐字段给出新原则） |
| `concresce` | 手动凝结一次（需要先配置后台模型） |
| `export` / `import <文件.tar.gz> [--mode merge\|replace]` | 纯文本归档打包 / 安全增量合并 |
| `models status` / `models download` | 本地模型状态 / 下载 |
| `daemon status` / `daemon stop` | 查看 / 安全停止共享检索服务 |
| `doctor` | 体检 |
| `hook --event` | 其它宿主的通用子进程入口（stdin 一条事件 JSON，stdout 一条回执 JSON） |
| `craft sync [--brief]` | 把项目 / 角色作用域的原则单向投到 `.team/CRAFT.md`（配合 agent-crew） |

退出码：0 正常；1 用法错或失败（包括「数据库已提交、但后置的向量 / 可读快照步骤没完成」，回执里会先写明已落库，再按提示处理或用 `memloom doctor` 排错）；2「没配置后台模型」这类什么都没做的情况。

---

## 接 Pi

Pi 的扩展在进程内常驻调用 memloom 的宿主核心，负责静态注入、当轮提醒、纠错即时入库和后台采集：

```bash
npm run build
pi -e /path/to/memloom/adapters/pi/index.ts     # 只多加一个 -e；不装全局、不改 ~/.pi/agent 的任何配置
```

想在动真实配置之前先看它到底做了什么：`node adapters/smoke-pi.mjs --core both`（真实 `pi` 进程 + 只听本机的模拟模型端点，全部在临时目录，约 10 秒）。事件怎么映射、文字放在哪、实测证到了什么，见 [adapters/README.md](adapters/README.md)；宿主核心的契约见 [docs/HOST-CONTRACT.md](docs/HOST-CONTRACT.md)。

---

## 接其它 Agent：CLI 与 MCP

任何支持 MCP 的客户端这样配：命令 `node`，参数 `/path/to/memloom/dist/src/mcp/main.js`（或 `npm link` 后的 `memloom-mcp`），环境变量同命令行（`MEMLOOM_HOME` 等）。工具与命令行一一对应：`memloom_recall`、`memloom_capture`、`memloom_iron_rules`、`memloom_dilemmas`、`memloom_concresce`、`memloom_export`、`memloom_import`，外加兼容入口 `memloom_resolve_dilemma`。

- 分歧只能由人拍板：`resolve` 必须 `choice` + `confirm=分歧编号`，同一条不执行第二次。
- `concresce` 需要你显式配置后台模型（`MEMLOOM_LLM_BASE_URL` / `MEMLOOM_LLM_MODEL`，凭据 `MEMLOOM_LLM_API_KEY` 只在内存；可选 `MEMLOOM_LLM_REASONING_EFFORT` 与 `MEMLOOM_LLM_THINKING_FORMAT`）；推荐写在 `~/.config/memloom/env` 里供 CLI / MCP / 宿主扩展共用（显式环境变量优先），没配置就明确拒绝，不调用任何默认服务。
- 不支持 MCP 的宿主可以用 `memloom hook --event` 子进程入口接同一套核心。

---

## 可选：和 agent-crew 一起用

项目启用 [agent-crew](https://github.com/Jarcis-cy/agent-crew) 时，`memloom --project <目录> [--role <角色>]` 会把该项目的记忆存在 `.team/.mind.db`，凝结成功后把生效原则单向写进 `.team/CRAFT.md` 的管理区。两边都没有对对方的硬依赖，各用各的也完全可以。联动边界见 [docs/HOST-CONTRACT.md](docs/HOST-CONTRACT.md) 第 7 节。

---

## 测试

```bash
npm test                      # 离线全套：只用临时目录和合成样本，不联网、不调用外部模型、不碰真实的 ~/.memloom
MEMLOOM_TEST_MODEL_DIR=~/.memloom/models npm run test:real-model   # 人工主动：真实模型（约 80 秒）
```

---

## 文档导航

| 想知道什么 | 看哪里 |
|---|---|
| 安装细节、环境变量、三档检索模式、共享服务、归档格式、各里程碑的最小闭环、本机参考实测 | [docs/USAGE.md](docs/USAGE.md) |
| 数据表、提示词规范、对外接口清单、分阶段验收标准 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 宿主怎么接：事件 / 回执字段、三段文字放哪、和 agent-crew 的单向联动 | [docs/HOST-CONTRACT.md](docs/HOST-CONTRACT.md) |
| Pi 适配的事件映射与实测证据 | [adapters/README.md](adapters/README.md) |
| 来参与开发 | [AGENTS.md](AGENTS.md) |

## 已知边界

- 提醒是**单次 2 秒预算**（`MEMLOOM_HINT_BUDGET_MS`），到点就安静，不排队、不补发；本地模型冷启动要 8~13 秒，所以会话开始会先在后台预热。
- memloom 自己的静态段整场字节不变，但**供应商的前缀缓存命中和计费不归它管**，也没有实测过。
- 归档导出会掩蔽常见格式的凭据，但**不能保证识别所有秘密**，导出后请人手看一遍。
- 镜像源和 API 模式只在离线回环里验证过；Pi 只在 1.4.0 上实跑过；Windows 没测。

## License

MIT © 2026 Jarcis-cy
