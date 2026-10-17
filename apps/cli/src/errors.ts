// 退出码（方案 §4.4）与错误码 → 退出码映射。错误码沿用服务端中文接口的 code，CLI 只补 hint。

export const EXIT = {
  OK: 0,
  UNKNOWN: 1,
  USAGE: 2,
  VALIDATION: 3,
  AUTH: 4,
  PERMISSION: 5,
  CONFLICT: 6,
  NETWORK: 7,
  RATE_LIMIT: 8,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export type CliIssue = { code: string; message: string; field?: string };

export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly code: string;
  readonly hint?: string;
  readonly retryAfter?: number;
  readonly status?: number;
  readonly issues?: CliIssue[];
  readonly extra?: Record<string, unknown>;

  constructor(exitCode: ExitCode, code: string, message: string, options: { hint?: string; retryAfter?: number; status?: number; issues?: CliIssue[]; extra?: Record<string, unknown> } = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.code = code;
    this.hint = options.hint;
    this.retryAfter = options.retryAfter;
    this.status = options.status;
    this.issues = options.issues;
    this.extra = options.extra;
  }
}

export const usageError = (code: string, message: string, hint?: string) => new CliError(EXIT.USAGE, code, message, { hint });

const AUTH_CODES = new Set([
  'unauthorized', 'cli_token_missing', 'cli_token_invalid', 'cli_token_revoked', 'cli_token_expired',
  'cli_token_principal_invalid', 'cli_token_partner_changed',
  'authorization_pending', 'access_denied', 'expired_token', 'invalid_grant',
]);
const PERMISSION_CODES = new Set(['cli_scope_missing', 'cli_principal_unavailable', 'forbidden', 'partner_required', 'cli_feature_disabled', 'cli_submit_disabled']);
/** 服务端「不暴露存在」的 404：草稿/上传记录不存在、属于他人或他主体，一律当权限不足（退出码 5）。 */
const NOT_OWNED_CODES = new Set(['template_submission_not_found', 'upload_intent_not_found']);
const CONFLICT_CODES = new Set([
  'draft_version_conflict', 'draft_content_changed', 'template_submission_version_conflict', 'template_submission_locked',
  'idempotency_key_reused', 'idempotency_in_progress', 'state_principal_mismatch', 'draft_out_of_sync', 'draft_not_pushed',
  'draft_not_submittable', 'draft_not_pending',
]);
const VALIDATION_CODES = new Set([
  'validation_error', 'template_submission_invalid', 'body_too_large', 'local_validation_failed', 'server_validation_failed',
  'field_not_allowed', 'manifest_invalid', 'manifest_missing', 'path_outside_package', 'media_missing', 'media_type_unsupported',
  'media_kind_mismatch', 'media_too_large',
]);
const RATE_CODES = new Set(['rate_limited', 'cli_quota_exceeded', 'cli_token_limit']);

/** 服务端错误（HTTP 状态 + code）→ 退出码。先认 code，再按状态兜底。 */
export const exitCodeForApiError = (status: number, code: string | undefined): ExitCode => {
  const c = code ?? '';
  if (RATE_CODES.has(c) || status === 429) return EXIT.RATE_LIMIT;
  if (AUTH_CODES.has(c) || status === 401) return EXIT.AUTH;
  if (PERMISSION_CODES.has(c) || NOT_OWNED_CODES.has(c) || status === 403) return EXIT.PERMISSION;
  if (CONFLICT_CODES.has(c) || status === 409) return EXIT.CONFLICT;
  if (status >= 500 || status === 0) return EXIT.NETWORK;
  if (status === 404 && c === 'not_found') return EXIT.PERMISSION;
  if (VALIDATION_CODES.has(c) || status === 400 || status === 413 || status === 422) return EXIT.VALIDATION;
  return EXIT.UNKNOWN;
};

/** 「放行」提示里的协议与端口：按实际 --api-url 生成；host 自带端口时只写协议（端口已在 host 里）。 */
const portLabel = (apiHost: string, protocol = 'https:'): string => {
  const scheme = protocol === 'http:' ? 'HTTP' : 'HTTPS';
  if (/:\d+$/.test(apiHost)) return scheme;
  return `${scheme} ${scheme === 'HTTP' ? 80 : 443}`;
};

/** 服务端校验消息是网页口吻（「点『应用自动修正』」）；CLI 里没这个按钮，只在展示侧改写，不动服务端消息。 */
export const cliWording = (message: string): string =>
  message.replace(/点[「『]应用自动修正[」』]即可/g, '按提示手动改清单后重新 push 即可').replace(/[「『]应用自动修正[」』]/g, '手动修正');

/** 主体展示：平台主体名字本身就是「平台自营」时不再括号重复。 */
export const describePrincipalName = (principal: { kind: string; name: string }): string => {
  if (principal.kind !== 'platform') return `伙伴：${principal.name}`;
  return principal.name && principal.name !== '平台自营' ? `平台自营（${principal.name}）` : '平台自营';
};

/** 按错误码补一句「下一步怎么办」。apiHost 用于网络类提示「放行 api.seewow.cc」。 */
export const hintForApiError = (status: number, code: string | undefined, apiHost: string, extra: { retryAfter?: number; quota?: string; limit?: number; protocol?: string } = {}): string | undefined => {
  const c = code ?? '';
  switch (c) {
    case 'cli_token_missing':
    case 'cli_token_invalid':
    case 'cli_token_revoked':
    case 'cli_token_expired':
    case 'cli_token_principal_invalid':
    case 'cli_token_partner_changed':
    case 'unauthorized':
      return '运行 seewow auth login 重新登录（多账号加 --profile <名字>）。';
    case 'cli_scope_missing':
      return '这把令牌登录时去掉了提审权限：重新运行 seewow auth login（不带 --no-submit），确认页保持勾选「可以直接提交审核」。';
    case 'cli_principal_unavailable':
      return '当前账号没有对应身份的命令行权限（伙伴投稿权限或平台运营的「CLI 草稿权限」），请联系平台运营。';
    case 'not_found':
      return '命令行功能或提审功能目前没有开放（服务端开关关着），请联系平台运营。';
    case 'draft_version_conflict':
    case 'template_submission_version_conflict':
      return '网页上有人改过这份草稿。先用 seewow template show <草稿id> 看最新内容；确认要用本地覆盖就 push --force（会先列出将被覆盖的字段）。';
    case 'draft_content_changed':
      return '推送之后内容又被改过，不会把你没看过的内容送审。请先重新 push，再提交审核。';
    case 'template_submission_locked':
      return '草稿正在审核或已上架，不能修改；审核中的可以先 seewow template withdraw <草稿id> 撤回。';
    case 'idempotency_in_progress':
      return '上一次新建请求还没处理完，稍等几秒再重试。';
    case 'idempotency_key_reused':
      return '同一个包目录的新建请求内容变了。删掉 .seewow/state.json 里的 draftId 或加 --new 再试。';
    case 'template_submission_not_found':
      return '草稿不存在或不属于当前主体（看 seewow auth status 的主体）。包目录里记录的草稿被删了的话，加 --new 新建。';
    case 'upload_intent_not_found':
      return '上传记录不存在或不属于当前主体（看 seewow auth status 的主体）；重新 push 会重新登记上传。';
    case 'cli_quota_exceeded':
      return `已到配额上限${extra.quota ? `（${extra.quota}${extra.limit !== undefined ? ` ≤ ${extra.limit}` : ''}）` : ''}${extra.retryAfter ? `，约 ${extra.retryAfter} 秒后可重试` : ''}。`;
    case 'rate_limited':
      return `请求太频繁${extra.retryAfter ? `，${extra.retryAfter} 秒后再试` : '，稍后再试'}。`;
    case 'cli_token_limit':
      return '有效令牌已满 10 把：到网页「已授权的 Seewow CLI」撤销不用的，再重新登录。';
    case 'access_denied':
      return '确认页点了拒绝。如果是你本人发起的，重新运行 seewow auth login。';
    case 'expired_token':
    case 'invalid_grant':
      return '确认码已失效，重新运行 seewow auth login。';
    default:
      break;
  }
  if (status === 0 || status >= 500) return `网络或服务暂时不可用，可以直接重试；在沙箱或公司网络里运行时，请放行 ${apiHost}（${portLabel(apiHost, extra.protocol)}）。`;
  if (status === 429) return extra.retryAfter ? `${extra.retryAfter} 秒后再试。` : '稍后再试。';
  return undefined;
};
