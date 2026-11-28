/**
 * 离线回环替身：在 127.0.0.1 上冒充模型源的文件下载接口（`/<仓库>/resolve/<revision>/<路径>`）。
 * 只服务内存里的小夹具字节，不联网。能按剧本演：第一次给坏摘要的字节、发一半就断、回 503、不认 Range、先 302 再给、拖延回应。
 * 同时生成一份和固定清单同结构的「测试清单」（夹具的 sha256 / git blob sha1），测试把它写进临时文件并用
 * MEMLOOM_TEST_MODEL_MANIFEST 交给命令行（下载模块只对回环地址认这份清单）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { PINNED_MODELS, SMALL_FILES, type ModelKind, type PinnedModels } from '../../../src/retriever/models-manifest.js';

export interface HubRequest {
  url: string;
  range: string | null;
  authorization: string | null;
  userAgent: string | null;
}

export interface HubBehavior {
  /** 第一次请求给同样长度、但摘要对不上的字节；之后给对的 */
  corruptFirst?: boolean;
  /** 第一次请求只发这么多字节就把连接掐断（模拟断网），之后正常 */
  cutFirst?: number;
  /** 先回 503 这么多次 */
  failTimes?: number;
  /** 不认 Range，总是 200 全量 */
  ignoreRange?: boolean;
  /** 第一次先 302 到 /redirected/… 再给内容 */
  redirectOnce?: boolean;
  /** 回应前拖这么多毫秒（证明前台不等网络） */
  delayMs?: number;
}

export interface FakeHub {
  baseUrl: string;
  manifest: PinnedModels;
  manifestPath: string;
  requests: HubRequest[];
  /** 某个路径（相对模型子目录，如 onnx/model_int8.onnx）被完整下过几次（200/206 都算） */
  served: Record<string, number>;
  close(): Promise<void>;
}

/** 固定种子的假字节：每个文件内容不同、长度可配，足够小 */
export function fakeBytes(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let counter = 0;
  let block = createHash('sha256').update(seed).digest();
  while (counter < length) {
    for (const byte of block) {
      if (counter >= length) break;
      out[counter] = byte ^ (counter % 251);
      counter += 1;
    }
    block = createHash('sha256').update(block).digest();
  }
  return out;
}

/** 一套小夹具：仓库和 revision 用真实值（这样 modelId 看起来就是真的），内容是假的 */
export function fakeModelFiles(onnxBytes = 64 * 1024): Record<ModelKind, Record<string, Buffer>> {
  const out = {} as Record<ModelKind, Record<string, Buffer>>;
  for (const kind of ['embedding', 'reranker'] as const) {
    const files: Record<string, Buffer> = {};
    for (const name of SMALL_FILES) files[name] = Buffer.from(`${kind}/${name}\n`);
    files[`onnx/${PINNED_MODELS[kind].defaultFile}`] = fakeBytes(`${kind}-onnx`, onnxBytes);
    out[kind] = files;
  }
  return out;
}

export function fixtureManifest(files: Record<ModelKind, Record<string, Buffer>>): PinnedModels {
  const out = {} as PinnedModels;
  for (const kind of ['embedding', 'reranker'] as const) {
    const source = PINNED_MODELS[kind];
    const manifestFiles: PinnedModels[ModelKind]['files'] = {};
    for (const [path, content] of Object.entries(files[kind])) {
      if (path.startsWith('onnx/')) manifestFiles[path] = { bytes: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') };
      else manifestFiles[path] = { bytes: content.byteLength, gitSha1: createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex') };
    }
    out[kind] = { ...source, files: manifestFiles };
  }
  return out;
}

export async function startFakeHub(options: { files?: Record<ModelKind, Record<string, Buffer>>; behaviors?: Record<string, HubBehavior>; fixtureDir: string }): Promise<FakeHub> {
  const files = options.files ?? fakeModelFiles();
  const manifest = fixtureManifest(files);
  mkdirSync(options.fixtureDir, { recursive: true, mode: 0o700 });
  const manifestPath = join(options.fixtureDir, 'fixture-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const repoToKind = new Map<string, ModelKind>([
    [PINNED_MODELS.embedding.repo, 'embedding'],
    [PINNED_MODELS.reranker.repo, 'reranker'],
  ]);
  const state = new Map<string, { corrupt: boolean; cut: boolean; fails: number; redirect: boolean }>();
  const requests: HubRequest[] = [];
  const served: Record<string, number> = {};
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push({ url: request.url ?? '', range: request.headers.range ?? null, authorization: request.headers.authorization ?? null, userAgent: request.headers['user-agent'] ?? null });
    const match = /^\/(?:redirected\/)?(.+?)\/resolve\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (!match) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    const kind = repoToKind.get(match[1] as string);
    const path = match[3] as string;
    const content = kind ? files[kind][path] : undefined;
    if (!kind || !content || match[2] !== PINNED_MODELS[kind].revision) {
      response.writeHead(404);
      response.end('unknown path');
      return;
    }
    const behavior = options.behaviors?.[`${kind}/${path}`] ?? {};
    const key = `${kind}/${path}`;
    const history = state.get(key) ?? { corrupt: false, cut: false, fails: 0, redirect: false };
    const reply = (): void => {
      if (behavior.failTimes && history.fails < behavior.failTimes) {
        history.fails += 1;
        state.set(key, history);
        response.writeHead(503);
        response.end('busy');
        return;
      }
      if (behavior.redirectOnce && !history.redirect) {
        history.redirect = true;
        state.set(key, history);
        response.writeHead(302, { location: `/redirected/${match![1] as string}/resolve/${match![2] as string}/${path}` });
        response.end();
        return;
      }
      let body = content;
      if (behavior.corruptFirst && !history.corrupt) {
        history.corrupt = true;
        state.set(key, history);
        body = Buffer.from(content);
        body[0] = (body[0] as number) ^ 0xff;
      } else {
        state.set(key, history);
      }
      const range = request.headers.range;
      const rangeMatch = range ? /^bytes=(\d+)-$/.exec(range) : null;
      if (rangeMatch && !behavior.ignoreRange) {
        const start = Number(rangeMatch[1]);
        if (start >= body.byteLength) {
          response.writeHead(416, { 'content-range': `bytes */${body.byteLength}` });
          response.end();
          return;
        }
        const slice = body.subarray(start);
        response.writeHead(206, { 'content-type': 'application/octet-stream', 'content-length': String(slice.byteLength), 'content-range': `bytes ${start}-${body.byteLength - 1}/${body.byteLength}` });
        response.write(slice);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.byteLength) });
      if (behavior.cutFirst && !history.cut) {
        history.cut = true;
        state.set(key, history);
        // 先把回应头和一部分正文真的发出去，再掐断连接：这样客户端手里已经有一段 .part，下一次请求应该带 Range 续传
        response.flushHeaders();
        response.write(body.subarray(0, behavior.cutFirst));
        setTimeout(() => response.destroy(), 150);
        return;
      }
      response.end(body);
    };
    served[key] = (served[key] ?? 0) + 1;
    if (behavior.delayMs) setTimeout(reply, behavior.delayMs);
    else reply();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    manifest,
    manifestPath,
    requests,
    served,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type { IncomingMessage, ServerResponse };
