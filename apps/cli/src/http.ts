// HTTP 客户端：node:http/https 直连（不用全局 fetch——undici 默认 300 秒等响应头，
// 而 50MB 样片经 nginx 整包收下再转发，进度到 100% 后还要等 4~5 分钟）。
// - 超时 ≥ 15 分钟（套接字空闲超时）；不跟随重定向（令牌不会被带去别的主机）。
// - 令牌只发给 API 根同源的地址；对象存储预签名地址（direct 模式）不带 Authorization。
// - --verbose 请求日志只打方法、地址、状态、耗时，Authorization 固定显示 swc_****。
import { createReadStream } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { CliError, EXIT, exitCodeForApiError, hintForApiError } from './errors.ts';
import type { Output } from './output.ts';
import { CLI_CLIENT_NAME, CLI_VERSION } from './version.ts';

export const DEFAULT_API_URL = 'https://api.seewow.cc';
export const HTTP_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** 规整并校验 API 根：只许 https（本机调试可 http://localhost），不许带账号密码、查询串、锚点。 */
export const normalizeApiUrl = (raw: string): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(EXIT.USAGE, 'invalid_api_url', `--api-url 不是有效地址：${raw}`);
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new CliError(EXIT.USAGE, 'invalid_api_url', 'API 地址必须是 https://（只有本机调试可以用 http://localhost）。');
  }
  if (url.username || url.password || url.search || url.hash) throw new CliError(EXIT.USAGE, 'invalid_api_url', 'API 地址不能带账号密码、查询参数或 #。');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
};

export type ApiResponse<T> = { status: number; headers: http.IncomingHttpHeaders; data: T };
type RawResponse = { status: number; headers: http.IncomingHttpHeaders; text: string };
type Body = { kind: 'json'; value: unknown } | { kind: 'file'; path: string; size: number; onProgress?: (sent: number) => void } | null;

export class ApiClient {
  readonly apiUrl: string;
  readonly apiHost: string;
  private readonly token: string | null;
  private readonly out: Output;

  constructor(options: { apiUrl: string; token?: string | null; out: Output }) {
    this.apiUrl = options.apiUrl;
    this.apiHost = new URL(options.apiUrl).host;
    this.token = options.token ?? null;
    this.out = options.out;
  }

  get hasToken(): boolean {
    return this.token !== null;
  }

  private resolve(pathOrUrl: string): URL {
    if (/^https?:\/\//i.test(pathOrUrl)) return new URL(pathOrUrl);
    if (!pathOrUrl.startsWith('/')) throw new CliError(EXIT.UNKNOWN, 'invalid_path', `内部错误：请求路径必须以 / 开头（${pathOrUrl}）。`);
    return new URL(`${this.apiUrl}${pathOrUrl}`);
  }

  /** 只有与 API 根同源的地址才带令牌。 */
  private sameOriginAsApi(url: URL): boolean {
    return url.origin === new URL(this.apiUrl).origin;
  }

  private send(method: string, url: URL, headers: Record<string, string>, body: Body): Promise<RawResponse> {
    const lib = url.protocol === 'https:' ? https : http;
    const started = Date.now();
    const shownHeaders = Object.keys(headers).map((key) => (key.toLowerCase() === 'authorization' ? 'Authorization: Bearer swc_****' : `${key}: ${headers[key]}`));
    this.out.debug(`→ ${method} ${url.origin}${url.pathname}${shownHeaders.length ? `  [${shownHeaders.join('; ')}]` : ''}`);
    return new Promise<RawResponse>((resolve, reject) => {
      // agent: false = 不复用连接（keep-alive 空闲连接会拖住进程退出；CLI 每条命令只发几次请求）。
      const request = lib.request(url, { method, headers, timeout: HTTP_TIMEOUT_MS, agent: false }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        });
        response.on('end', () => {
          this.out.debug(`← ${response.statusCode ?? 0} ${method} ${url.pathname}（${Date.now() - started}ms）`);
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') });
        });
        response.on('error', reject);
      });
      request.on('timeout', () => request.destroy(new Error(`请求超过 ${Math.round(HTTP_TIMEOUT_MS / 60000)} 分钟没有响应`)));
      request.on('error', reject);
      if (!body) {
        request.end();
      } else if (body.kind === 'json') {
        request.end(JSON.stringify(body.value));
      } else {
        const stream = createReadStream(body.path);
        let sent = 0;
        stream.on('data', (chunk) => {
          sent += chunk.length;
          body.onProgress?.(sent);
        });
        stream.on('error', (error) => request.destroy(error));
        stream.pipe(request);
      }
    });
  }

  private toNetworkError(error: unknown, url: URL): CliError {
    const detail = error instanceof Error ? error.message : String(error);
    return new CliError(EXIT.NETWORK, 'network_error', `连不上 ${url.host}：${detail}`, { hint: hintForApiError(0, 'network_error', url.host, { protocol: url.protocol }) });
  }

  private toApiError(raw: RawResponse, url: URL): CliError {
    let parsed: { error?: { message?: unknown; code?: unknown; retryAfter?: unknown; quota?: unknown; limit?: unknown } } | null = null;
    try {
      parsed = JSON.parse(raw.text);
    } catch {
      parsed = null;
    }
    const err = parsed && typeof parsed === 'object' ? parsed.error : undefined;
    const code = typeof err?.code === 'string' ? err.code : `http_${raw.status}`;
    const message = typeof err?.message === 'string' && err.message ? err.message : `服务端返回 HTTP ${raw.status}。`;
    const headerRetry = Number(raw.headers['retry-after']);
    const retryAfter = typeof err?.retryAfter === 'number' ? err.retryAfter : Number.isFinite(headerRetry) && headerRetry > 0 ? headerRetry : undefined;
    const quota = typeof err?.quota === 'string' ? err.quota : undefined;
    const limit = typeof err?.limit === 'number' ? err.limit : undefined;
    const extra: Record<string, unknown> = {};
    if (quota) extra.quota = quota;
    if (limit !== undefined) extra.limit = limit;
    return new CliError(exitCodeForApiError(raw.status, code), code, message, {
      status: raw.status,
      retryAfter,
      hint: hintForApiError(raw.status, code, url.host, { retryAfter, quota, limit, protocol: url.protocol }),
      extra: Object.keys(extra).length ? extra : undefined,
    });
  }

  private baseHeaders(url: URL, auth: boolean): Record<string, string> {
    const headers: Record<string, string> = { 'User-Agent': `${CLI_CLIENT_NAME}/${CLI_VERSION} node/${process.versions.node}`, Accept: 'application/json' };
    if (auth) {
      if (!this.token) throw new CliError(EXIT.AUTH, 'not_logged_in', '还没有登录。', { hint: '运行 seewow auth login。' });
      if (!this.sameOriginAsApi(url)) throw new CliError(EXIT.UNKNOWN, 'token_origin_mismatch', '内部错误：拒绝把令牌发给 API 以外的地址。');
      headers.Authorization = `Bearer ${this.token}`;
    }
    return headers;
  }

  /** JSON 请求。auth 默认 true；非 2xx 抛 CliError（带退出码与 hint）。 */
  async json<T>(method: string, path: string, options: { body?: unknown; headers?: Record<string, string>; auth?: boolean } = {}): Promise<ApiResponse<T>> {
    const url = this.resolve(path);
    const headers = { ...this.baseHeaders(url, options.auth !== false), ...(options.headers ?? {}) };
    let body: Body = null;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = { kind: 'json', value: options.body };
    }
    let raw: RawResponse;
    try {
      raw = await this.send(method, url, headers, body);
    } catch (error) {
      throw this.toNetworkError(error, url);
    }
    if (raw.status < 200 || raw.status >= 300) throw this.toApiError(raw, url);
    let data: T;
    try {
      data = (raw.text ? JSON.parse(raw.text) : {}) as T;
    } catch {
      throw new CliError(EXIT.NETWORK, 'invalid_response', `服务端返回的不是 JSON（HTTP ${raw.status}）。`, { hint: hintForApiError(0, 'invalid_response', url.host, { protocol: url.protocol }) });
    }
    return { status: raw.status, headers: raw.headers, data };
  }

  /**
   * 上传素材原始字节。uploadUrl 是相对路径（同源转存，带令牌）或对象存储预签名地址（不带令牌）。
   * 返回服务端响应 JSON（同源模式）或空对象（预签名模式）。
   */
  async upload(uploadUrl: string, filePath: string, size: number, extraHeaders: Record<string, string>, onProgress?: (sent: number) => void): Promise<unknown> {
    const url = this.resolve(uploadUrl);
    const auth = this.sameOriginAsApi(url);
    const headers: Record<string, string> = { ...this.baseHeaders(url, auth), ...extraHeaders, 'Content-Length': String(size) };
    if (!auth) delete headers.Authorization;
    let raw: RawResponse;
    try {
      raw = await this.send('PUT', url, headers, { kind: 'file', path: filePath, size, onProgress });
    } catch (error) {
      throw this.toNetworkError(error, url);
    }
    if (raw.status < 200 || raw.status >= 300) throw this.toApiError(raw, url);
    try {
      return raw.text ? JSON.parse(raw.text) : {};
    } catch {
      return {};
    }
  }
}
