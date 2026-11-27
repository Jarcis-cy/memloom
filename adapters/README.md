# memloom 宿主适配：Pi

本目录只接 Pi。

## 文件与分工

| 文件 | 行数量级 | 只做什么 |
|---|---|---|
| `pi/index.ts` | 54 行（非注释非空行 36） | Pi 扩展入口：把 Pi 事件接到下面的纯映射上，不含业务 |
| `pi/memloom.ts` | 127 行（非注释非空行 87，其中类型声明 7 行） | 纯映射：Pi 事件 → 契约 `HostEvent`；`HostResponse` 的三段文字放到 Pi 允许的位置；任何失败安静放行 |
| `smoke-pi.mjs` | 288 行 | 可重复的回环冒烟：真实 `pi` 进程 + 只听 127.0.0.1 的模拟模型端点 + 全部在临时目录的隔离环境 |
| `../tests/adapter-pi.test.ts` | 283 行 | 离线映射回归 8 条（用按脚本回话的核心替身，不依赖核心实现） |

适配器不写 SQL、不做检索、不写提示词、不去重限频、不加载模型——这些全在 `src/host/`（契约见 `.agents/memory-rnd/projects/memloom/refs/2026-11-27-m4-host-contract.md`）。适配器只认核心的公开面 `HostCore.handle(HostEvent)` / `close()` 和 `resolveHostConfig`。

## 安装与最小启动（Linux）

Pi 用 jiti 直接加载 TypeScript 扩展，适配器本身不用编译；核心要先编译。

```bash
# 1) 编译核心（Node.js 24+）
cd /path/to/memloom && npm ci --include=dev --no-audit --no-fund && npm run build

# 2) 日常使用：只多加一个 -e。不装全局、不写 ~/.pi/agent 的任何配置。
pi -e /path/to/memloom/adapters/pi/index.ts
```

想在动真实配置之前先看它到底做了什么，跑回环冒烟（真实 `pi`，模型是本脚本起的回环替身，`HOME`、配置目录、会话目录、记忆库全在临时目录，子进程环境是重新拼的，不带你的任何密钥）：

```bash
node adapters/smoke-pi.mjs --core both          # 真实核心 + 夹具核心两档，约 10 秒，退出码 0 = 全部检查通过
node adapters/smoke-pi.mjs --core both --keep   # 保留临时目录，原始模型请求日志在 logs/model-requests.log
node --test dist/tests/adapter-pi.test.js       # 离线映射回归（先 npm run build）
```

手动起一个隔离的真实 Pi（把模型端点换成你自己的配置即可；三样隔离：`HOME`、`PI_CODING_AGENT_DIR`、`--session-dir`）：

```bash
T=$(mktemp -d /tmp/memloom-pi-XXXXXX); mkdir -p $T/agent $T/sessions $T/work $T/memloom
# 把你的 provider 写进 $T/agent/models.json（或把 auth.json 放进 $T/agent），密钥不要带进命令行历史
cd $T/work && env -i HOME=$T PATH="$PATH" PI_CODING_AGENT_DIR=$T/agent MEMLOOM_HOME=$T/memloom \
  pi -ne -ns -nc -np --no-mcp --mode json --session-dir $T/sessions --model <provider>/<model> \
  -e /path/to/memloom/adapters/pi/index.ts -p "删目录之前要做什么？"
```

## 环境变量

核心的变量沿用顶层 README（`MEMLOOM_HOME`、检索与后台模型配置等）。适配器自己只认一个：

| 变量 | 含义 |
|---|---|
| `MEMLOOM_HOST_ENTRY` | 可选。核心入口的 file URL，默认 `<仓库>/dist/src/host/index.js`（冒烟的夹具档靠它换成按脚本回话的替身） |

## 事件怎么映射、文字放在哪

| Pi 事件（1.4.0） | 交给核心 | 放回 Pi 的位置 |
|---|---|---|
| `session_start`（新开、`-c` 续接、`/resume`、reload 一个样） | `session_start`，会话号取宿主当前会话；`resume` = 会话里已有 user/assistant 消息（不看 `reason`：`pi -p -c` 的 reason 是 `startup`；也不能看条目数：新会话一开始就有 `model_change` 等非消息条目） | 每次运行都把核心给的那份原字节写进 system 的 `memloom` 段，整场不变 |
| `before_agent_start`（用户原话起的运行） | `user_message`（原话不改写） | 有提醒才返回一条独立的上下文消息，紧跟用户话；没有高分命中什么都不加 |
| 同上返回的 `dilemmaNotice` | — | 另起一个 `memloom_notice` system 段，不进 `memloom` 段，整场也不变（不是每轮变的静态段） |
| `message_end`（assistant 最终回复；运行中途插进来的 steer / followUp 原话） | `assistant_message`；`user_message` | 不放文字。运行开头那条原话已在 `before_agent_start` 交过，不重复计数；steer / followUp 的原话只记录（纠错照样即时入库），提醒没有合适的位置挂，丢弃 |
| `turn_end`（这一轮全部工具结果） | 每条结果一个 `tool_result`（成功也报，只计数；`isError` 原样；同一批次只有首个实际失败参与提醒，其余失败带 `skipHint: true`，核心照常计数但不再等检索；Pi 1.4.0 在这里给的 `structuredContent` 实测为空，所以 `exitCode` 实际是 `null`，成败由 `isError` 决定——bash 非零退出实测 `isError=true`） | 只有失败的出提醒：作为独立消息追加在**这一轮工具结果之后**，赶在下一次模型请求之前；不改工具结果本身 |
| `session_before_compact` | `compact` | 不返回任何东西 = 不取消、不改压缩 |
| `session_shutdown`（退出、reload、换会话） | `session_end`，然后关核心；下一次 `session_start` 再按需重建 | — |

核心在第一个事件到来时才创建（扩展加载阶段不开库、不起服务），随会话一起留着；加载失败、处理出错都安静放行，不打印任何东西，也不向宿主抛错。

## 实测证到了什么（2026-11-27，本机 Pi 1.4.0，真实进程 + 回环模拟模型端点）

`node adapters/smoke-pi.mjs --core both`：真实核心档 13 项、夹具核心档 17 项检查全部通过，另有 1 项仅记录。4 轮对话分 4 个 `pi` 进程（后 3 个 `-c` 续接），每轮约 0.5 秒。

证据口径：「字节稳定」指冒烟把模型端点收到的每个主对话请求的 system 取出来，其中 `<memloom>…</memloom>` 段的 sha256 全部相同；宿主自己的压缩摘要请求用另一份 system，单独计数、不参与比对。这只说明我们自己写进 system 的字节没变，**不是**供应商缓存命中或计费的证据。

**真实核心（`dist/src/host/index.js`，临时库里 1 条铁律 + 1 条常驻核心原则）**

- 5 个主对话请求（含压缩之后那一条）的 system 里都有同一段 `<memloom>…</memloom>`（306 字符，含 `<memloom-standing>`），sha256 前 16 位五次都是 `6759f52a0f7e357f`，跨进程、跨真实工具失败、跨压缩之后都不变。宿主自己的 2 个压缩摘要请求用的是另一份 system，不带这段，也不该带。
- 4 个进程用的是同一个宿主会话号。第 1 个进程正常退出后，冒烟往同一个临时库加了第二条不同的铁律，再 `-c` 续接：之后 3 个进程的静态段仍然全是第一份（每个 system 都含第一条铁律、没有一个含第二条），没有被重算。
- 关会话后核心的会话状态文件不再整份删：对话片段已清空，静态区和去重游标原样留着供续接；状态目录 0700、文件 0600，没有残留锁文件。
- 同一个工具批次里 3 个真实失败（模型一次并发调 3 次 `bash`，分别 `exit 7` / `8` / `9`）确实发生并一起回到模型请求。
- 没有语义模型时提醒保持安静：请求里没有任何 `<memory-hint>`（这就是「无提醒」那一档）。
- 第 2 轮的中文纠错原话经真实核心即时写进 `experiences`（`kind='correction'`，#1）。
- 第 4 轮把压缩阈值抬高后，宿主真的做了压缩（`compaction_start → compaction_end`），压缩后的主请求 system 里静态段仍是同一份字节。

**夹具核心（`MEMLOOM_HOST_ENTRY` 指向按脚本回话的替身；证明的是落点与时序，不是核心）**

- 当轮提醒在模型请求里紧跟用户话；工具失败后的提醒紧跟在这一批工具结果之后，下一次模型请求才看得到；没命中关键词的那轮不追加。
- 同一批次的 3 个失败都报到核心（输出一条不少）：首个不带 `skipHint` 参与提醒，后两个带 `skipHint: true`；模型请求里这 3 个失败之后只跟一段提醒，压缩前的完整对话里一共 3 段（第 1 轮原话 1 + 工具批次 1 + 第 2 轮纠错 1）。
- 分歧提醒作为独立的 `memloom_notice` 段出现在每次请求的 system 里，整场字节不变。
- 替身收到的事件序列：每个进程 `session_start → … → session_end → closed`；首场 `resume=false`，`-c` 续接的三场 `resume=true`，会话号只有一个；每轮用户原话只到核心一次；真实工具失败映射成 `isError=true` 的 `tool_result`；第 4 轮真实触发的压缩前事件被映射成 `compact`。

## 没覆盖、没证明的

- 真实供应商的缓存命中与计费、真实模型对提醒的反应：回环替身证明不了，也没接外网。
- 真实语义模型（0.6B 本地模型或 API）经本适配出一次真提醒：没有模型，真实核心档只证到「保持安静」。提醒的落点由夹具档证明，核心自己的打分与去重由核心所有者的测试负责。
- 交互界面（TUI）里的 `/new`、`/resume`、`/reload`、中途 steer / followUp：只有类型依据和离线回归，没有真实触发。steer / followUp 的原话只记录，不挂提醒。
- Pi 1.6.0（工作区 `pi-web` 里那一份）：只用它的类型声明核对了 `pi/index.ts`（0 错误，和 1.4.0 一样），没有实跑。
- Windows：按要求不测。
- 回环冒烟里模拟端点会按脚本调一次会失败的 `bash`，真实模型不会这样；它只是为了稳定造出一次真实工具失败。

## 已知取舍

- `pi/index.ts` 不在仓库的 `tsc` 构建里（Pi 自己用 jiti 加载它），所以编辑器会报找不到 `@earendil-works/pi-coding-agent` 的类型。要核对类型，拿 Pi 安装目录里的声明跑一次：

  ```bash
  cd /path/to/memloom
  PI=/path/to/node_modules/@earendil-works/pi-coding-agent   # pi 所在的包目录：readlink -f "$(which pi)" 再往上三层
  D=$(mktemp -d) && cat > $D/tsconfig.json <<EOF
  { "compilerOptions": { "target": "es2023", "lib": ["es2023"], "module": "nodenext", "moduleResolution": "nodenext", "types": ["node"],
      "typeRoots": ["$PWD/node_modules/@types"], "strict": true, "noEmit": true, "skipLibCheck": true, "allowImportingTsExtensions": true,
      "verbatimModuleSyntax": true, "isolatedModules": true, "paths": { "@earendil-works/pi-coding-agent": ["$PI/dist/index.d.ts"] } },
    "files": ["$PWD/adapters/pi/index.ts"] }
  EOF
  node node_modules/typescript/bin/tsc -p $D/tsconfig.json && echo 类型核对通过   # 2026-11-27 对 1.4.0 和 1.6.0 都是 0 错误
  ```

- `/reload` 会换掉整个扩展运行时，新核心按会话状态认出这是旧会话、不再重发分歧提醒，所以 `memloom_notice` 段会在 reload 时消失一次（system 前缀变一次，不是每轮变）。
- 每个工具批次只有首个实际失败参与提醒，其余失败带 `skipHint`（核心照常计数、记录和调度，只是不再等检索），所以一批最多挂一段提醒、最多等一个前台预算（默认 2 秒）；这一轮的下一次模型请求会等它出结果。`skipHint` 是核心契约里的可选字段，没有它时核心行为不变。
