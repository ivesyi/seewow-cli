// 本机令牌存放（S9）。
// - macOS 默认系统钥匙串：服务名固定 seewow-cli、账户 = profile；写入走 `security -i` 从标准输入读命令，
//   令牌不出现在命令行参数里（ps 看不到）。钥匙串锁着/不可用 → 退出码 4 + 提示 --store file，不静默失败。
// - `--store file` 或非 macOS：令牌写进 <XDG_CONFIG_HOME|~/.config>/seewow/cli/<profile>.json，目录 0700、文件 0600，
//   临时文件 + rename；读时发现权限比 0600 宽就拒绝读取。
// - 两种方式都会写这个 profile 文件（钥匙串方式不含令牌，只记元数据和存放位置）。
// - SEEWOW_TOKEN 环境变量优先（给 CI/沙箱）。令牌绝不写进项目目录。
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLI_TOKEN_PATTERN, type CliPrincipal, type CliScope } from '../../../packages/contracts/cli.ts';
import { CliError, EXIT } from './errors.ts';
import { registerSecret } from './redact.ts';

export const KEYCHAIN_SERVICE = 'seewow-cli';
export type StoreKind = 'keychain' | 'file';
const PROFILE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export type StoredProfile = {
  schemaVersion: 1;
  profile: string;
  apiUrl: string;
  store: StoreKind;
  tokenId: string;
  tokenPrefix: string;
  expiresAt: string;
  scopes: CliScope[];
  principal: CliPrincipal;
  user: { id: string; name: string | null };
  savedAt: string;
  /** 只有 store=file 时才有。 */
  token?: string;
};

export const assertProfileName = (profile: string): string => {
  if (!PROFILE_PATTERN.test(profile) || profile === '.' || profile === '..') {
    throw new CliError(EXIT.USAGE, 'invalid_profile', '--profile 只能用字母、数字、点、下划线、连字符（最长 64 位）。');
  }
  return profile;
};

export const configDir = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() ? env.XDG_CONFIG_HOME : join(homedir(), '.config'), 'seewow', 'cli');

export const profilePath = (profile: string, env: NodeJS.ProcessEnv = process.env): string => join(configDir(env), `${assertProfileName(profile)}.json`);

export const defaultStoreKind = (): StoreKind => (process.platform === 'darwin' ? 'keychain' : 'file');

/** 读 profile 文件；不存在返回 null。权限比 0600 宽 → 拒绝读取（退出码 4）。 */
export const readProfile = (profile: string, env: NodeJS.ProcessEnv = process.env): StoredProfile | null => {
  const path = profilePath(profile, env);
  if (!existsSync(path)) return null;
  if (process.platform !== 'win32') {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      throw new CliError(EXIT.AUTH, 'credentials_permissions_too_open', `凭据文件权限过宽（${mode.toString(8)}），为安全起见拒绝读取：${path}`, {
        hint: `运行 chmod 600 "${path}" 后重试，或删掉它重新 seewow auth login。`,
      });
    }
  }
  let parsed: StoredProfile;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as StoredProfile;
  } catch {
    throw new CliError(EXIT.AUTH, 'credentials_corrupt', `凭据文件读不出来：${path}`, { hint: '删掉它后重新运行 seewow auth login。' });
  }
  if (parsed.token) registerSecret(parsed.token);
  return parsed;
};

/** 原子写 profile 文件：目录 0700、文件 0600、临时文件 + rename。 */
export const writeProfile = (data: StoredProfile, env: NodeJS.ProcessEnv = process.env): string => {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
  const path = profilePath(data.profile, env);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(temp, 0o600);
  renameSync(temp, path);
  return path;
};

export const deleteProfile = (profile: string, env: NodeJS.ProcessEnv = process.env): void => {
  rmSync(profilePath(profile, env), { force: true });
};

// ─── macOS 钥匙串 ──────────────────────────────────────────────────────────────
const keychainUnavailable = (detail: string) => new CliError(EXIT.AUTH, 'keychain_unavailable', `系统钥匙串不可用：${detail}`, {
  hint: '钥匙串可能锁着（非交互终端里很常见）。先解锁钥匙串再试，或改用文件存放：seewow auth login --store file。',
});

const runSecurity = (args: string[], input?: string) => {
  const result = spawnSync('security', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
  if (result.error) throw keychainUnavailable(`找不到或无法运行 security 命令（${(result.error as NodeJS.ErrnoException).code ?? 'error'}）`);
  return { status: result.status ?? -1, stdout: result.stdout ?? '' };
};

/** 登录前先探一下钥匙串能不能用（锁着时 security 返回 36），免得拿到令牌却存不下。 */
export const assertKeychainUsable = (): void => {
  if (process.platform !== 'darwin') throw new CliError(EXIT.USAGE, 'keychain_not_supported', '系统钥匙串只在 macOS 上支持。', { hint: '改用 --store file。' });
  const result = runSecurity(['show-keychain-info']);
  if (result.status !== 0) throw keychainUnavailable(`security 返回 ${result.status}`);
};

export const keychainSet = (profile: string, token: string): void => {
  assertProfileName(profile);
  if (!CLI_TOKEN_PATTERN.test(token)) throw new CliError(EXIT.AUTH, 'cli_token_invalid', '服务端返回的令牌格式不对，没有保存。');
  // profile 与令牌都只含安全字符（上面两道正则），可以直接放进双引号。
  const result = runSecurity(['-i'], `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "${profile}" -w "${token}"\n`);
  if (result.status !== 0) throw keychainUnavailable(`写入失败（security 返回 ${result.status}）`);
  if (keychainGet(profile) !== token) throw keychainUnavailable('写入后读不回来');
};

export const keychainGet = (profile: string): string | null => {
  assertProfileName(profile);
  const result = runSecurity(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', profile, '-w']);
  if (result.status === 44) return null;
  if (result.status !== 0) throw keychainUnavailable(`读取失败（security 返回 ${result.status}）`);
  const token = result.stdout.trim();
  registerSecret(token);
  return token || null;
};

export const keychainDelete = (profile: string): void => {
  assertProfileName(profile);
  const result = runSecurity(['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', profile]);
  if (result.status !== 0 && result.status !== 44) throw keychainUnavailable(`删除失败（security 返回 ${result.status}）`);
};

export const storeLocation = (data: Pick<StoredProfile, 'store' | 'profile'>, env: NodeJS.ProcessEnv = process.env): string =>
  data.store === 'keychain' ? `macOS 钥匙串（服务 ${KEYCHAIN_SERVICE}，账户 ${data.profile}）` : profilePath(data.profile, env);
