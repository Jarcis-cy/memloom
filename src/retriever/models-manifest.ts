/**
 * 固定清单：两个公开仓库在固定 revision 下、memloom 允许下载的每个文件的大小和摘要。
 *
 * 来源：2026-11-28 从官方 https://huggingface.co 的 `/api/models/<仓库>/tree/<revision>` 元数据读出，
 * 其中默认的两个 ONNX 和两个 tokenizer.json 的 sha256 还和本机按旧脚本下载、校验过的同一批文件逐个对过。
 *
 * 这份清单编译进代码，是下载校验的唯一真源：镜像（MEMLOOM_HF_ENDPOINT / HF_ENDPOINT / --mirror）只负责传字节，
 * 大小和摘要从不取自镜像的响应，所以换成任何镜像都不会把「镜像自己报的摘要」当成独立认证。
 * revision 是完整的提交哈希，仓库里的内容按 git 对象寻址，不会悄悄换版本。
 */
export interface PinnedFile {
  bytes: number;
  /** LFS 文件（ONNX、tokenizer.json）的 sha256；ONNX 必须有 */
  sha256?: string;
  /** 普通小文件的 git blob 摘要：sha1("blob " + 字节数 + "\0" + 内容) */
  gitSha1?: string;
}

export interface PinnedModel {
  repo: string;
  revision: string;
  /** 默认拿哪个量化文件（文件名，不带 onnx/） */
  defaultFile: string;
  /** 允许的量化文件名（文件名，不带 onnx/） */
  allowedFiles: readonly string[];
  /** 相对模型子目录的路径 → 大小与摘要 */
  files: Record<string, PinnedFile>;
}

export interface PinnedModels {
  embedding: PinnedModel;
  reranker: PinnedModel;
}

/** 每个模型都要的小文件；ONNX 运行时只读 tokenizer.json 和 config.json，其余是分词器配套 */
export const SMALL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'added_tokens.json'] as const;

export const PINNED_MODELS: PinnedModels = {
  embedding: {
    repo: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    revision: 'c25a394dd583836952667c12f008335071b3f43d',
    defaultFile: 'model_int8.onnx',
    allowedFiles: ['model_int8.onnx', 'model_quantized.onnx', 'model_q4.onnx', 'model_q4f16.onnx'],
    files: {
      'config.json': { bytes: 1576, gitSha1: 'fe42030fa2c22872fcec1e333aebfbc38f2a2572' },
      'tokenizer.json': { bytes: 11423705, sha256: 'def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a' },
      'tokenizer_config.json': { bytes: 9731, gitSha1: '19d096ecc22dde6d41d64fc64b78cebe12697fbe' },
      'special_tokens_map.json': { bytes: 613, gitSha1: 'ac23c0aaa2434523c494330aeb79c58395378103' },
      'added_tokens.json': { bytes: 707, gitSha1: 'b54f9135e44c1e81047e8d05cb027af8bc039eed' },
      'onnx/model_int8.onnx': { bytes: 613527539, sha256: '6d0ea863f78b4a84afa3c7fcba1ec341572b5e28121aef77b7092b1dfdf679c7' },
      'onnx/model_quantized.onnx': { bytes: 613527631, sha256: '87cd124e0ef1fd1f223ebc283efccbaeac386d0b08344701c46975d0657b591f' },
      'onnx/model_q4.onnx': { bytes: 914121462, sha256: '8be554b37368134c3f38613c6f6ad0b7bb5f3a6465ab87574dbc0dcf24daa428' },
      'onnx/model_q4f16.onnx': { bytes: 567458583, sha256: '7f9ebb9a77c428f2b4c2d8ed8a2ee64f292a0b1ce7a3f027ccaaef150ef7bdd1' },
    },
  },
  reranker: {
    repo: 'onnx-community/Qwen3-Reranker-0.6B-ONNX',
    revision: '9995c50e2310679108a55f5ccd16ba8be9f17c20',
    defaultFile: 'model_quantized.onnx',
    allowedFiles: ['model_quantized.onnx', 'model_q4.onnx'],
    files: {
      'config.json': { bytes: 1359, gitSha1: 'c49f84be43e56d554bb361ec202c66cb092110a9' },
      'tokenizer.json': { bytes: 11422654, sha256: 'aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4' },
      'tokenizer_config.json': { bytes: 5404, gitSha1: 'ddaf69808214a44fdd26d3785b66c1367c78277a' },
      'special_tokens_map.json': { bytes: 613, gitSha1: 'ac23c0aaa2434523c494330aeb79c58395378103' },
      'added_tokens.json': { bytes: 707, gitSha1: 'b54f9135e44c1e81047e8d05cb027af8bc039eed' },
      'onnx/model_quantized.onnx': { bytes: 1219344796, sha256: 'c9428382bb48bb31e01a6034647c86d6270761781735cafbf6d5cb4a396d0450' },
      'onnx/model_q4.onnx': { bytes: 995235866, sha256: '787193952a9aa58374381ec7647b160ac6c200a386dbfc3bc998a3c458081330' },
    },
  },
};

export type ModelKind = keyof PinnedModels;
export const MODEL_KINDS: readonly ModelKind[] = ['embedding', 'reranker'];
