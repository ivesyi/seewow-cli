// seewow auth login / status / logout（方案 §2.1、S2、S6、S9、S10）。
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import {
  CLI_AUTHORIZE_PAGE_PATH,
  CLI_DEFAULT_SCOPES,
  CLI_SCOPE_DRAFTS_WRITE,
  type CliDeviceCodeResponse,
  type CliDeviceTokenResponse,
  type CliScope,
  type CliWhoami,
} from '../../../packages/contracts/cli.ts';
import type { ParsedArgs } from './args.ts';
import { requestedApiUrl, requireSession, type CommandContext } from './context.ts';
import {
  assertKeychainUsable,
  assertProfileName,
  defaultStoreKind,
  deleteProfile,
  keychainDelete,
  keychainGet,
  keychainSet,
  readProfile,
  storeLocation,
  writeProfile,
  type StoreKind,
  type StoredProfile,
} from './credentials.ts';
import { CliError, EXIT, describePrincipalName, usageError } from './errors.ts';
import { ApiClient, normalizeApiUrl } from './http.ts';
import { registerSecret, tokenDisplay } from './redact.ts';
import { CLI_CLIENT_NAME, CLI_VERSION } from './version.ts';

const SCOPE_LABELS: Record<CliScope, string> = { 'drafts:write': '读写模板草稿、上传草稿素材', 'drafts:submit': '【直接提交审核】' };
const describeScopes = (scopes: readonly CliScope[]) => scopes.map((scope) => SCOPE_LABELS[scope] ?? scope).join('、');
const describePrincipal = (principal: CliWhoami['principal']) => describePrincipalName(principal);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 尽量打开浏览器；失败、无图形界面都不报错。只开 http(s) 地址。 */
const tryOpenBrowser = (url: string): void => {
  if (!/^https?:\/\//i.test(url)) return;
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // 打不开就算了，地址已经打印出来。
  }
};

/** 确认页地址：优先用服务端给的；服务端没给就按 API 根推（api.x → www.x）。 */
const authorizeUrl = (apiUrl: string, response: CliDeviceCodeResponse): string => {
  if (response.verificationUriComplete) return response.verificationUriComplete;
  const api = new URL(apiUrl);
  const host = api.hostname.startsWith('api.') ? `www.${api.hostname.slice(4)}` : api.host;
  return `${api.protocol}//${host}${CLI_AUTHORIZE_PAGE_PATH}?code=${encodeURIComponent(response.userCode)}`;
};

export async function authLogin(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const { out } = ctx;
  const profile = assertProfileName(ctx.options.profile);
  const as = args.flags.as;
  if (as !== undefined && as !== 'partner' && as !== 'platform') throw usageError('invalid_flag', '--as 只能是 partner 或 platform。');
  const storeFlag = args.flags.store;
  if (storeFlag !== undefined && storeFlag !== 'keychain' && storeFlag !== 'file') throw usageError('invalid_flag', '--store 只能是 keychain 或 file。');
  const store: StoreKind = (storeFlag as StoreKind | undefined) ?? defaultStoreKind();
  if (ctx.env.SEEWOW_TOKEN) out.warn('检测到 SEEWOW_TOKEN 环境变量：之后的命令会优先用它，而不是这次登录存下的令牌。');
  // 先确认能存得下，免得拿到令牌却存不了（钥匙串锁着在非交互 shell 里很常见）。
  if (store === 'keychain') assertKeychainUsable();
  // 同一个 profile 重新登录：记下旧令牌，新令牌存好后在服务端撤掉它（尽力而为），不留没人管的令牌。
  let previous: { record: StoredProfile; token: string | null } | null = null;
  try {
    const record = readProfile(profile, ctx.env);
    if (record) previous = { record, token: record.store === 'keychain' ? keychainGet(profile) : record.token ?? null };
  } catch {
    previous = null;
  }

  const apiUrl = requestedApiUrl(ctx, null);
  const client = new ApiClient({ apiUrl, out });
  const scopes: CliScope[] = args.flags['no-submit'] ? [CLI_SCOPE_DRAFTS_WRITE] : [...CLI_DEFAULT_SCOPES];
  const codeBody: Record<string, unknown> = { scopes, clientName: CLI_CLIENT_NAME, clientVersion: CLI_VERSION, hostname: hostname().slice(0, 128) };
  if (as) codeBody.principal = as;
  const { data: device } = await client.json<CliDeviceCodeResponse>('POST', '/api/cli/device/code', { body: codeBody, auth: false });
  registerSecret(device.deviceCode);
  const url = authorizeUrl(apiUrl, device);
  const minutes = Math.max(1, Math.round((device.expiresIn || 600) / 60));
  out.event('device_code', {
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    verificationUriComplete: url,
    expiresIn: device.expiresIn,
    requestedScopes: device.requestedScopes ?? scopes,
  }, [
    '请在任意已登录 Seewow 的手机或电脑打开：',
    `  ${url}`,
    `或打开 ${device.verificationUri || url.split('?')[0]} 输入确认码：${device.userCode}（${minutes} 分钟内有效）`,
    `这次申请的权限：${describeScopes(device.requestedScopes ?? scopes)}${as ? `；身份：${as === 'platform' ? '平台自营' : '合作伙伴'}` : ''}`,
    '等待确认中…（Ctrl+C 取消）',
  ].join('\n'));
  if (!ctx.options.json && !args.flags['no-browser'] && !ctx.env.SEEWOW_NO_BROWSER) tryOpenBrowser(url);

  let intervalMs = Math.max(100, (typeof device.interval === 'number' ? device.interval : 5) * 1000);
  const deadline = Date.now() + (device.expiresIn || 600) * 1000;
  let issued: CliDeviceTokenResponse | null = null;
  while (!issued) {
    if (Date.now() > deadline) throw new CliError(EXIT.AUTH, 'expired_token', '确认码已过期。', { hint: '重新运行 seewow auth login。' });
    await sleep(intervalMs);
    try {
      ({ data: issued } = await client.json<CliDeviceTokenResponse>('POST', '/api/cli/device/token', { body: { deviceCode: device.deviceCode }, auth: false }));
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      if (error.code === 'authorization_pending') continue;
      if (error.code === 'slow_down') {
        intervalMs += 5000;
        out.debug(`服务端要求放慢轮询，间隔改为 ${intervalMs / 1000} 秒`);
        continue;
      }
      throw error;
    }
  }
  registerSecret(issued.accessToken);

  const record: StoredProfile = {
    schemaVersion: 1,
    profile,
    apiUrl,
    store,
    tokenId: issued.tokenId,
    tokenPrefix: issued.tokenPrefix || tokenDisplay(issued.accessToken).slice(0, 12),
    expiresAt: issued.expiresAt,
    scopes: issued.scopes,
    principal: issued.principal,
    user: issued.user,
    savedAt: new Date().toISOString(),
  };
  try {
    if (store === 'keychain') keychainSet(profile, issued.accessToken);
    else record.token = issued.accessToken;
    writeProfile(record, ctx.env);
  } catch (error) {
    // 存不下就把刚签发的令牌在服务端撤掉，不留一把没人管的令牌。
    try {
      await new ApiClient({ apiUrl, token: issued.accessToken, out }).json('POST', '/api/cli/token/revoke', { body: {} });
    } catch {
      out.warn(`令牌没存下来，服务端撤销也失败了；请到网页「已授权的 Seewow CLI」撤销前缀为 ${record.tokenPrefix} 的令牌。`);
    }
    throw error;
  }
  if (previous?.token && previous.token !== issued.accessToken) {
    try {
      await new ApiClient({ apiUrl: normalizeApiUrl(previous.record.apiUrl), token: previous.token, out }).json('POST', '/api/cli/token/revoke', { body: {} });
      out.info(`已在服务端撤销这个 profile 之前的令牌 ${previous.record.tokenPrefix}…`);
    } catch {
      out.warn(`这个 profile 之前的令牌 ${previous.record.tokenPrefix}… 没能自动撤销，可到网页「已授权的 Seewow CLI」手动撤销。`);
    }
    if (previous.record.store === 'keychain' && store === 'file') {
      try {
        keychainDelete(profile);
      } catch {
        // 钥匙串删不掉不影响新令牌。
      }
    }
  }
  const canSubmit = issued.scopes.includes('drafts:submit');
  out.result({
    profile, apiUrl, store, storeLocation: storeLocation(record, ctx.env), tokenPrefix: record.tokenPrefix, tokenId: record.tokenId,
    expiresAt: record.expiresAt, scopes: record.scopes, principal: record.principal, user: record.user,
  }, `✓ 已授权：${record.user.name ?? record.user.id}（${describePrincipal(record.principal)}），${canSubmit ? '可提交审核' : '只能读写草稿（不能提交审核）'}，令牌 ${record.tokenPrefix}… ${record.expiresAt} 过期（存放：${storeLocation(record, ctx.env)}）`);
  return EXIT.OK;
}

export async function authStatus(ctx: CommandContext): Promise<number> {
  const session = requireSession(ctx);
  const { data: who } = await session.client.json<CliWhoami>('GET', '/api/cli/whoami');
  const location = session.source === 'env' ? '环境变量 SEEWOW_TOKEN' : storeLocation(session.profile as StoredProfile, ctx.env);
  const submitGranted = who.scopes.includes('drafts:submit');
  const submitEffective = who.effectiveScopes.includes('drafts:submit');
  ctx.out.result({
    profile: session.source === 'env' ? null : ctx.options.profile, source: session.source, apiUrl: session.client.apiUrl, storeLocation: location,
    tokenPrefix: who.tokenPrefix, tokenId: who.tokenId, expiresAt: who.expiresAt, user: who.user, principal: who.principal, scopes: who.scopes, effectiveScopes: who.effectiveScopes,
  }, [
    `账号：${who.user.name ?? who.user.id}`,
    `身份：${describePrincipal(who.principal)}`,
    `权限：${describeScopes(who.scopes)}${submitGranted && !submitEffective ? '（提审功能目前未开放）' : ''}`,
    `令牌：${who.tokenPrefix}…（${who.expiresAt} 过期）`,
    `存放：${location}`,
    `服务：${session.client.apiUrl}`,
  ].join('\n'));
  return EXIT.OK;
}

export async function authLogout(ctx: CommandContext): Promise<number> {
  const { out } = ctx;
  if (ctx.env.SEEWOW_TOKEN) throw usageError('logout_env_token', '当前令牌来自环境变量 SEEWOW_TOKEN，logout 不会动它。', '到网页「已授权的 Seewow CLI」撤销，再从环境里删掉 SEEWOW_TOKEN。');
  const profile = assertProfileName(ctx.options.profile);
  const stored = readProfile(profile, ctx.env);
  if (!stored) {
    out.result({ profile, revoked: false, removed: false }, `profile「${profile}」本来就没有登录。`);
    return EXIT.OK;
  }
  let serverError: CliError | null = null;
  let session: ReturnType<typeof requireSession> | null = null;
  try {
    session = requireSession(ctx);
  } catch (error) {
    // 本地已过期：服务端也不认了，直接删本地；其余（钥匙串锁着、文件权限过宽）原样报，不删任何东西。
    if (!(error instanceof CliError) || error.code !== 'cli_token_expired') throw error;
  }
  if (session) {
    try {
      await session.client.json('POST', '/api/cli/token/revoke', { body: {} });
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      // 401（已撤销/过期/无效）= 服务端本来就不认它了，照常删本地。
      if (error.status !== 401) serverError = error;
    }
  }
  if (stored.store === 'keychain') {
    try {
      keychainDelete(profile);
    } catch (error) {
      out.warn(error instanceof Error ? error.message : String(error));
    }
  }
  deleteProfile(profile, ctx.env);
  if (serverError) {
    throw new CliError(serverError.exitCode, serverError.code, `本地凭据已删除，但服务端撤销没有成功：${serverError.message}`, {
      hint: `请到网页「已授权的 Seewow CLI」手动撤销前缀为 ${stored.tokenPrefix} 的令牌。${serverError.hint ? ` ${serverError.hint}` : ''}`,
      status: serverError.status,
    });
  }
  out.result({ profile, revoked: true, removed: true, tokenPrefix: stored.tokenPrefix }, `✓ 已退出：令牌 ${stored.tokenPrefix}… 已在服务端撤销，本地凭据已删除。`);
  return EXIT.OK;
}
