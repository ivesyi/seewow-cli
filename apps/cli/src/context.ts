// 命令共享的上下文：全局参数、输出、取令牌（SEEWOW_TOKEN > profile）与 API 客户端。
import { isCliTokenShape } from '../../../packages/contracts/cli.ts';
import { assertProfileName, keychainGet, readProfile, type StoredProfile } from './credentials.ts';
import { CliError, EXIT } from './errors.ts';
import { ApiClient, DEFAULT_API_URL, normalizeApiUrl } from './http.ts';
import type { Output } from './output.ts';
import { registerSecret } from './redact.ts';

export type GlobalOptions = { apiUrl?: string; profile: string; json: boolean; quiet: boolean; verbose: boolean };

export type CommandContext = {
  out: Output;
  options: GlobalOptions;
  env: NodeJS.ProcessEnv;
  /** 交互终端（stdin、stderr 都是 TTY 且不是 --json）才问 y/N。 */
  interactive: boolean;
};

/** 不需要令牌时用的 API 根：--api-url > SEEWOW_API_URL > profile 记录的 > 默认。 */
export const requestedApiUrl = (ctx: CommandContext, stored?: StoredProfile | null): string => {
  if (ctx.options.apiUrl) return normalizeApiUrl(ctx.options.apiUrl);
  if (ctx.env.SEEWOW_API_URL) return normalizeApiUrl(ctx.env.SEEWOW_API_URL);
  if (stored?.apiUrl) return normalizeApiUrl(stored.apiUrl);
  return DEFAULT_API_URL;
};

export type Session = {
  client: ApiClient;
  source: 'env' | 'keychain' | 'file';
  profile: StoredProfile | null;
};

/** 取令牌并建客户端。令牌只发给登录时那个 API 根：--api-url 换了主机就拒绝（换环境请用新的 --profile）。 */
export const requireSession = (ctx: CommandContext): Session => {
  const envToken = ctx.env.SEEWOW_TOKEN;
  if (envToken !== undefined && envToken !== '') {
    registerSecret(envToken);
    if (!isCliTokenShape(envToken)) throw new CliError(EXIT.AUTH, 'cli_token_invalid', 'SEEWOW_TOKEN 不是有效的命令行令牌（应以 swc_ 开头）。');
    return { client: new ApiClient({ apiUrl: requestedApiUrl(ctx), token: envToken, out: ctx.out }), source: 'env', profile: null };
  }
  const profileName = assertProfileName(ctx.options.profile);
  const stored = readProfile(profileName, ctx.env);
  if (!stored) {
    throw new CliError(EXIT.AUTH, 'not_logged_in', `还没有登录（profile：${profileName}）。`, {
      hint: `运行 seewow auth login${profileName === 'default' ? '' : ` --profile ${profileName}`}。`,
    });
  }
  const apiUrl = requestedApiUrl(ctx, stored);
  if (apiUrl !== normalizeApiUrl(stored.apiUrl)) {
    throw new CliError(EXIT.USAGE, 'api_url_mismatch', `profile「${profileName}」登录在 ${stored.apiUrl}，不能把它的令牌发给 ${apiUrl}。`, {
      hint: '换服务地址请用新的 --profile 重新登录。',
    });
  }
  if (Date.parse(stored.expiresAt) <= Date.now()) {
    throw new CliError(EXIT.AUTH, 'cli_token_expired', `令牌已过期（${stored.expiresAt}，30 天固定不续期）。`, { hint: '重新运行 seewow auth login。' });
  }
  const token = stored.store === 'keychain' ? keychainGet(profileName) : stored.token ?? null;
  if (!token) {
    throw new CliError(EXIT.AUTH, 'not_logged_in', `profile「${profileName}」的令牌找不到了（${stored.store === 'keychain' ? '钥匙串里没有这条' : '凭据文件里没有令牌'}）。`, { hint: '重新运行 seewow auth login。' });
  }
  registerSecret(token);
  return { client: new ApiClient({ apiUrl, token, out: ctx.out }), source: stored.store, profile: stored };
};
