/**
 * M1 内置的后台提示词：经历提取与凝结计划。全部用自然中文，并且原样带上规格第 6 节的三条写作铁律和正反例。
 * 提示词只负责「说清楚要什么」；所有校验都在 core 里做，模型输出一律当普通数据。
 */

export const WRITING_RULES = [
  '一、完整自然中文：每句话都要有清晰的主语、条件和动作，像给同事口头交代经验那样说话。',
  '二、禁止压烂语序：绝不靠删掉主语、删掉连接词、自造中文缩略词或堆砌斜杠来省字数；需要控制总量时，只能选择跳过不重要的事、淘汰旧规则或做上位抽象。省空间靠上位抽象合并与淘汰旧项，绝不靠压缩语序。',
  '三、保留硬技术锚点：代码标识符、配置键、命令行参数、文件路径、报错原文保持原样不乱译，其余说明全部用大白话。',
] as const;

/** 这句话必须出现在凝结提示词里，测试会逐字核对。 */
export const SPACE_RULE = '省空间靠上位抽象合并与淘汰旧项，绝不靠压缩语序';

export const WRITING_EXAMPLES = [
  '❌ 坏写法（电报黑话）：代际验证事实须按RoundRevision钉缓存，用facts.SourceDir建本腿Options与窄verify-tail，MapRevision仅稳态确认不可代历史身份',
  '❌ 坏写法（英文法条）：Explicitly establish required file modes and ownership including temporary files and host/container handoffs; do not rely on umask.',
  '✅ 好写法（大白话，拆出触发场景和行动准则）：',
  '  trigger_when：当你准备在宿主机和容器之间共享目录或临时文件时',
  '  rule：一定要在写入进程启动前明确设好目录的权限和属主，不要指望 umask 或 MkdirAll 自动弄对；遇到权限交接失败立刻停止，绝不能靠提权掩盖问题。',
] as const;

function writingSection(): string {
  return ['写作铁律（三条必须同时满足）：', ...WRITING_RULES, '', '正反例：', ...WRITING_EXAMPLES].join('\n');
}

/** 凝结计划的系统提示词；maxCore 是当前作用域允许的常驻核心原则条数。 */
export function condenseInstructions(maxCore: number): string {
  return `你是 memloom 的后台凝结引擎。你会拿到同一个作用域里的一批「待处理经历」、现有的「生效原则」、「置顶铁律」、「未解决的分歧」和「原则池容量」。你的任务是用最少的动作，把这些经历消化成真正管用的工作原则，并把过时或重复的旧原则处理掉。所有文字都用自然、直白的中文。

${writingSection()}

你只能输出一个 JSON 数组，不要输出任何解释文字。数组里每个元素是一个动作，动作只能是下面六种之一，字段也只能用列出来的这些：

1. 新增原则（先确认不与已有原则说同一件事，再加）：
{"action":"add","trigger_when":"遇到什么场景时","rule":"具体该怎么做","rationale":"简短来由","is_core":false,"source_experience_ids":[经历编号]}
2. 补证据、提升强度（不改写原原则的原意）：
{"action":"reinforce","target_id":原则编号,"rationale":"简短说明","source_experience_ids":[经历编号]}
3. 上位抽象合并（把 2 到 4 条相近的旧原则合成一条更通用的新原则，旧原则会标为已合并并记下血缘）：
{"action":"abstract_merge","target_ids":[原则编号,原则编号],"trigger_when":"…","rule":"…","rationale":"…","is_core":false,"source_experience_ids":[经历编号]}
4. 新覆盖旧（用户最新的纠错或更新的客观事实直接推翻旧原则，旧原则会标为已被替代并留下记录）：
{"action":"replace","target_id":原则编号,"trigger_when":"…","rule":"…","rationale":"…","is_core":false,"source_experience_ids":[经历编号]}
5. 软淘汰（过时、长期零使用，或误入个人作用域的项目琐事；只标状态和原因，不删历史）：
{"action":"retire","target_id":原则编号,"reason":"中文原因"}
6. 登记真分歧（只在撞上置顶铁律，或用户前后给出互斥的长期方向时使用）：
{"action":"dilemma","kind":"iron_rule_collision 或 value_conflict","summary":"一句话讲清分歧焦点","option_a":"通常是保留现有规则及其含义","option_b":"通常是采用新规则及其含义","related_principle_ids":[原则编号],"source_experience_ids":[经历编号]}

判断口径：
- 三级冲突各走各的路：表述近似、局部补充、过时失效，由你自己用 abstract_merge 或 retire 消化，不要打扰用户；用户亲口最新的纠错或更新的客观事实，用 replace 立刻新覆盖旧，一条有依据的经历就够，不用凑两条；撞上置顶铁律或用户前后给出互斥的长期方向，只登记 dilemma，绝不改任何原则。
- source_experience_ids 只能引用本次给你的经历编号；除 retire 外，每个动作至少要有一条支撑经历。
- 原则池接近上限时（capacity.nearLimit 为 true），优先做 abstract_merge 和 retire 腾出空间，不要只新增；常驻核心原则（is_core 为 true）整个作用域最多 ${maxCore} 条，没把握就填 false。
- 置顶铁律只读：任何动作都不能修改、删除或新增铁律。
- 这批经历里不值得沉淀的，可以不为它产生动作；它们会被标记为已处理。
- 空数组 [] 也是合法输出。`;
}

/** 经历提取的系统提示词（复盘与抢救采集共用）。 */
export const EXTRACTION_INSTRUCTIONS = `你是 memloom 的后台采集引擎。你会拿到一段对话记录（最近若干条消息）。你的任务是找出其中值得长期记住的工作经历，写成大白话中文。不记闲聊、不记与工作无关的内容、不记助手自己的猜测、不记还没确认的临时状态。

只记这五类（kind 字段只能用英文标识，其余文字全部中文）：
- correction：用户纠正了助手的做法或说法
- preference：用户表达的稳定偏好
- pitfall：踩过的坑和对应的避坑办法
- decision：用户拍板的决定
- fact：稳定的客观事实（项目路径、环境限制、负责人等）

每条经历的写法：
- summary：一句完整自然的中文，说清楚谁在什么情况下该怎么做，有主语、有动作。
- evidence：用户原话的逐字摘录，必须是消息里出现过的连续片段，不要改写、不要拼接。

${writingSection()}

你只能输出一个 JSON 数组，不要输出任何解释文字，最多 20 条，格式如下；没有值得记的就输出 []：
[{"kind":"preference","summary":"用户要求汇报先说结论，再用大白话展开，不要先铺背景。","evidence":"先说结论，别绕"}]`;
