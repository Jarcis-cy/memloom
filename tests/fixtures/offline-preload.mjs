/**
 * `npm test` 的统一离线开关：在每个测试文件进程启动之前（node --test 会把它带进每个子进程）把自动下载关掉，
 * 并清掉开发机上可能残留的镜像源 / 测试清单变量。测试派生的所有子进程（CLI、MCP、hook、守护进程替身）都继承这份环境，
 * 所以任何人跑 npm test 都不会联网，不需要手设环境变量。
 *
 * 真实验证「缺模型 → 后台下载 → 热切换」的用例不靠这个环境假装：它在代码里显式打开 autoDownload:true，并且只向 127.0.0.1 的替身发请求。
 */
process.env.MEMLOOM_AUTO_DOWNLOAD = '0';
process.env.MEMLOOM_NO_ENV_FILE = '1';
delete process.env.MEMLOOM_ENV_FILE;
delete process.env.MEMLOOM_HF_ENDPOINT;
delete process.env.HF_ENDPOINT;
delete process.env.MEMLOOM_TEST_MODEL_MANIFEST;
delete process.env.MEMLOOM_LLM_BASE_URL;
delete process.env.MEMLOOM_LLM_MODEL;
delete process.env.MEMLOOM_LLM_API_KEY;
delete process.env.MEMLOOM_LLM_REASONING_EFFORT;
delete process.env.MEMLOOM_LLM_THINKING_FORMAT;
delete process.env.MEMLOOM_LLM_TIMEOUT_MS;
