/**
 * 合成中文语料（只用小文本，不碰任何真实记忆）：原则、经历、同义查询正反例。
 * 真实模型测试和离线替身测试共用同一份，方便对照。
 */

export interface SyntheticPrinciple {
  triggerWhen: string;
  rule: string;
}

export const SYNTHETIC_PRINCIPLES: SyntheticPrinciple[] = [
  { triggerWhen: '当你准备递归删除一个目录的时候', rule: '先检查它是不是软链接，不要带尾斜杠直接 rm -rf，防止顺着链接误删目标目录' },
  { triggerWhen: '当你准备汇报工作结果的时候', rule: '先说结论，再说细节，不要一上来铺陈过程' },
  { triggerWhen: '当你改完代码准备跑测试的时候', rule: '先执行 npm run build，否则跑的是旧产物' },
  { triggerWhen: '当你准备删除一个符号链接本身的时候', rule: '不要加尾斜杠，加了就会删到链接指向的目录' },
  { triggerWhen: '当你要和别人共享目录或临时文件的时候', rule: '一定要在写入进程启动前明确设好目录的权限和属主，不要指望 umask 自动弄对' },
  { triggerWhen: '当你发现记忆库里的规则过时时', rule: '直接软淘汰旧规则并写明中文原因，不要留着占容量' },
];

export interface SyntheticExperience {
  kind: 'correction' | 'preference' | 'pitfall' | 'decision' | 'fact';
  summary: string;
  evidence?: string;
}

export const SYNTHETIC_EXPERIENCES: SyntheticExperience[] = [
  { kind: 'pitfall', summary: '遇到 ENOENT 报错先检查路径是不是软链接', evidence: '用户说：ENOENT 多半是软链接指向的目标没了' },
  { kind: 'preference', summary: '用户要求汇报先说结论，再说细节' },
  { kind: 'pitfall', summary: '改完代码没跑 npm run build 就测试，结果跑的是旧产物' },
  { kind: 'correction', summary: '删符号链接时带了尾斜杠，把目标目录一起删掉了' },
  { kind: 'fact', summary: '本机 shell 带 NODE_ENV=production，装依赖必须加 --include=dev' },
  { kind: 'decision', summary: '后台任务只拆成单一小活，不依赖昂贵旗舰模型' },
];

/**
 * 同义正例：查询里故意不用原文的词（工作汇报 ↔ 汇报结果、编译 ↔ build、软连接 ↔ 软链接），
 * 而且查询的任何三字窗口都不在语料里，字面检索（FTS5 trigram + LIKE）一条也找不到，只能靠向量。
 */
export interface SynonymCase {
  query: string;
  /** 排第一的可以是这几条原则（SYNTHETIC_PRINCIPLES 下标）或这几条同一话题的经历（SYNTHETIC_EXPERIENCES 下标） */
  accept: { principles: number[]; experiences: number[] };
}

export const SYNONYM_CASES: SynonymCase[] = [
  { query: '怎么做工作汇报', accept: { principles: [1], experiences: [1] } },
  { query: '写完没有重新构建就跑用例，跑出来的还是上一版', accept: { principles: [2], experiences: [2] } },
  { query: '删目录时把软连接指过去的文件夹也一并清空', accept: { principles: [0, 3], experiences: [3] } },
];

/** 反例：和任何一条都不相关，精排分必须远低于 0.72 的提醒门槛 */
export const NEGATIVE_QUERIES = ['今天天气不错想喝奶茶', '周末去哪里爬山合适'];

/** 技术锚点：字面补位必须把它找回来 */
export const TECH_ANCHOR_QUERY = 'ENOENT';
export const TECH_ANCHOR_EXPERIENCE_INDEX = 0;

/** 替身用的同义概念表：同一个概念给同一个维度，离线也能演示「字面找不到、向量找得到」 */
export const STUB_CONCEPTS: Array<{ words: string[] }> = [
  { words: ['软链接', '软连接', '符号链接', 'symlink', '链接'] },
  { words: ['汇报', '结论', '工作汇报', '说结论'] },
  { words: ['build', '编译', '构建', '用例', '旧产物', '上一版'] },
  { words: ['ENOENT', '报错'] },
  { words: ['权限', '属主', 'umask'] },
  { words: ['淘汰', '过时'] },
  { words: ['奶茶', '天气'] },
  { words: ['爬山', '周末'] },
];
