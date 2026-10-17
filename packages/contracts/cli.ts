/**
 * seewow CLI 授权契约 —— 唯一真源。方案见 deliverables/2026-10-14-taskforge/seewow-cli-design.md（§1 S1–S14、§2.1、§7），
 * 架构说明见 docs/architecture/seewow-cli.md。
 *
 * 约束同其它契约：**零 import**（含 type-only）、浏览器/Node 双端可用、无副作用。
 * 用户端确认页（T4）需要时在 scripts/gen-shared-contracts.mjs 登记并生成到 apps/ui。
 */

/** 令牌权限两档：草稿读写（必带）+ 提审/撤回。不存在的能力一律没有。 */
export const CLI_SCOPES = ['drafts:write', 'drafts:submit'] as const;
export type CliScope = (typeof CLI_SCOPES)[number];
export const CLI_SCOPE_DRAFTS_WRITE: CliScope = 'drafts:write';
export const CLI_SCOPE_DRAFTS_SUBMIT: CliScope = 'drafts:submit';
/** 默认两档都申请（owner 决策 2）；`auth login --no-submit` 只申请草稿档。 */
export const CLI_DEFAULT_SCOPES: readonly CliScope[] = CLI_SCOPES;
export const isCliScope = (value: unknown): value is CliScope =>
  typeof value === 'string' && (CLI_SCOPES as readonly string[]).includes(value);

/** 一把令牌只代表一个主体：伙伴（绑 partnerChannelId）或平台自营池。签发时冻结。 */
export const CLI_PRINCIPAL_KINDS = ['partner', 'platform'] as const;
export type CliPrincipalKind = (typeof CLI_PRINCIPAL_KINDS)[number];
export const isCliPrincipalKind = (value: unknown): value is CliPrincipalKind =>
  typeof value === 'string' && (CLI_PRINCIPAL_KINDS as readonly string[]).includes(value);

/** 令牌形态：`swc_` + 32 字节随机 base64url（43 字符）。 */
export const CLI_TOKEN_PREFIX = 'swc_';
export const CLI_TOKEN_BYTES = 32;
export const CLI_TOKEN_PATTERN = /^swc_[A-Za-z0-9_-]{43}$/;
export const isCliTokenShape = (value: unknown): value is string => typeof value === 'string' && CLI_TOKEN_PATTERN.test(value);
/** 展示/审计用的明文前缀长度（swc_ + 8 位）。 */
export const CLI_TOKEN_DISPLAY_PREFIX_LENGTH = 12;
/** 30 天固定，不续期（owner 答 4）。 */
export const CLI_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 每个用户最多这么多把有效令牌，满了先撤旧的。 */
export const CLI_MAX_ACTIVE_TOKENS_PER_USER = 10;

/** 设备码：32 字节随机（只存哈希）；确认码 8 位，去掉元音与易混字符，约 2.6e10 种。 */
export const CLI_DEVICE_CODE_BYTES = 32;
export const CLI_DEVICE_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const CLI_USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const CLI_USER_CODE_LENGTH = 8;
/** 展示形态 `WDJB-MJHT`；用户端登录回跳精确放行用的就是这个正则。 */
export const CLI_USER_CODE_DISPLAY_PATTERN = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
export const CLI_DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
export const CLI_DEVICE_POLL_INTERVAL_SECONDS = 5;

/** 去掉连字符/空白，统一大写；不合法返回 null。 */
export const normalizeCliUserCode = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/[\s-]/g, '').toUpperCase();
  if (compact.length !== CLI_USER_CODE_LENGTH) return null;
  for (const char of compact) if (!CLI_USER_CODE_ALPHABET.includes(char)) return null;
  return compact;
};
export const formatCliUserCode = (compact: string) => `${compact.slice(0, 4)}-${compact.slice(4)}`;

/** 确认页落点（独立页面，不挂 /app、/m 外壳，§2.2）。 */
export const CLI_AUTHORIZE_PAGE_PATH = '/cli/authorize';

/** 设备码轮询（RFC 8628 语义）的错误码。HTTP 一律 400。 */
export const CLI_DEVICE_TOKEN_ERRORS = ['authorization_pending', 'slow_down', 'access_denied', 'expired_token', 'invalid_grant'] as const;
export type CliDeviceTokenError = (typeof CLI_DEVICE_TOKEN_ERRORS)[number];

export type CliPrincipal =
  | { kind: 'partner'; partnerChannelId: string; name: string }
  | { kind: 'platform'; name: string };

/** POST /api/cli/device/code 的响应。deviceCode 只在这里出现一次。 */
export type CliDeviceCodeResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  interval: number;
  expiresIn: number;
  requestedScopes: CliScope[];
};

/** POST /api/cli/device/token 成功响应。accessToken 明文只在这里出现一次。 */
export type CliDeviceTokenResponse = {
  accessToken: string;
  tokenType: 'Bearer';
  tokenId: string;
  tokenPrefix: string;
  expiresAt: string;
  scopes: CliScope[];
  principal: CliPrincipal;
  user: { id: string; name: string | null };
};

/** GET /api/cli/device/:userCode（确认页）。永不返回 deviceCode。 */
export type CliDeviceReview = {
  userCode: string;
  clientName: string;
  clientVersion: string;
  /** 对方自报，不可信。 */
  hostname: string | null;
  requestIp: string;
  sameIpAsViewer: boolean;
  createdAt: string;
  expiresAt: string;
  requestedScopes: CliScope[];
  requestedPrincipal: CliPrincipalKind | null;
  principalOptions: CliPrincipal[];
  canApprove: boolean;
  cannotApproveReason: string | null;
};

/** POST /api/cli/device/:userCode/approve 入参：scopes 只能是申请的子集且必含 drafts:write（只能减不能加）。 */
export type CliDeviceApproveRequest = { principal: CliPrincipalKind; scopes?: CliScope[] };

/** GET /api/cli/tokens 列表项。 */
export type CliAccessTokenSummary = {
  id: string;
  tokenPrefix: string;
  principal: CliPrincipal | { kind: CliPrincipalKind; name: string };
  scopes: CliScope[];
  clientName: string;
  hostname: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
};

/** GET /api/cli/whoami。effectiveScopes = 令牌权限 ∩ 当前开关。 */
export type CliWhoami = {
  user: { id: string; name: string | null };
  principal: CliPrincipal;
  scopes: CliScope[];
  effectiveScopes: CliScope[];
  tokenId: string;
  tokenPrefix: string;
  expiresAt: string;
};

// ─── 草稿 / 素材 / 提审接口（T3，§7 接口 8–17）────────────────────────────────────
// 草稿内容、详情、选项、上传记录的形状沿用伙伴投稿契约 packages/contracts/templateSubmissionRules.ts
// （TemplateSubmissionContent / TemplateSubmissionDetail / TemplateSubmissionSummary）与 templateSlotTypes.ts
// （TemplateSubmissionOptions）。本文件零 import，所以下面用类型参数承接，CLI 本体（T5）把那几个类型代进来即可。

/** 令牌接口下的草稿路径前缀。 */
export const CLI_TEMPLATE_DRAFTS_PATH = '/api/cli/template-drafts';
/** 新建草稿的幂等键请求头；同主体 + 同键 24 小时内重复请求返回同一条草稿，不建第二条。 */
export const CLI_IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
/** 重放时响应带这个头（值 `true`），状态码 200（首次新建是 201）。 */
export const CLI_IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';
export const CLI_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:\-]{8,200}$/;
export const CLI_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const isCliIdempotencyKey = (value: unknown): value is string => typeof value === 'string' && CLI_IDEMPOTENCY_KEY_PATTERN.test(value);

/** 草稿接口新增的错误码（其余沿用服务端已有 code：validation_error、template_submission_not_found、template_submission_locked 等）。 */
export const CLI_TEMPLATE_DRAFT_ERRORS = [
  /** 409：带的 version 与服务端不一致（网页上有人改过/提审过），先重新拉取。 */
  'draft_version_conflict',
  /** 409：提审时 expectedContentRevision 与服务端内容版本不一致——不会把你没看过的内容送审。 */
  'draft_content_changed',
  /** 429：主体配额满（未结草稿 / 审核中 / 未完成上传登记 / 每日上传数或体积），响应带 quota、limit、retryAfter。 */
  'cli_quota_exceeded',
  /** 409：同一个 Idempotency-Key 换了请求内容。 */
  'idempotency_key_reused',
  /** 409：同一个 Idempotency-Key 的上一次请求还没处理完，稍后重试。 */
  'idempotency_in_progress',
  /** 403：令牌没带该权限（提审档被去掉）。 */
  'cli_scope_missing',
  /** 429：限流，响应带 retryAfter。 */
  'rate_limited',
] as const;
export type CliTemplateDraftError = (typeof CLI_TEMPLATE_DRAFT_ERRORS)[number];

/** 主体配额（S8）的种类；默认值见 docs/architecture/seewow-cli.md，env SEEWOW_CLI_QUOTA_* 可调。 */
export const CLI_QUOTA_KINDS = ['open_drafts', 'pending_submissions', 'unfinished_uploads', 'daily_uploads', 'daily_upload_bytes'] as const;
export type CliQuotaKind = (typeof CLI_QUOTA_KINDS)[number];

/** 错误响应体。429 时带 retryAfter（秒，另有 Retry-After 头）；配额超限另带 quota 与 limit。 */
export type CliErrorResponse = {
  error: { message: string; code: string; retryAfter?: number; quota?: CliQuotaKind; limit?: number };
};

/** POST /api/cli/template-drafts（可带 Idempotency-Key 头）。content 即 TemplateSubmissionContent（可缺字段，草稿）。 */
export type CliTemplateDraftCreateRequest<TContent = Record<string, unknown>> = { content: Partial<TContent> };
/** PUT /api/cli/template-drafts/:id：整份替换，必须带当前 version；不一致 409 draft_version_conflict。 */
export type CliTemplateDraftSaveRequest<TContent = Record<string, unknown>> = { version: number; content: TContent };
/** POST …/:id/submit：钉住 version + 内容版本（详情里的 contentRevision）。 */
export type CliTemplateDraftSubmitRequest = { version: number; expectedContentRevision: number };
/** POST …/:id/withdraw：pending → draft。 */
export type CliTemplateDraftWithdrawRequest = { version: number };
/** POST …/:id/media/upload-intents。体积上限沿用伙伴口径（图片 15MB、视频 50MB）。 */
export type CliTemplateDraftUploadIntentRequest = { fileName: string; mimeType: string; sizeBytes: number; sha256?: string };
/** upload-intents 响应：同源模式下 uploadUrl = `/api/cli/template-drafts/:id/media/:intentId/content`（相对路径，拼 API 根）。 */
export type CliTemplateDraftUploadIntent = { uploadUrl: string; headers: Record<string, string>; intentId: string };
/** POST …/:id/media/complete 入参。 */
export type CliTemplateDraftCompleteRequest = { intentId: string };
/** complete 响应：素材 id 可直接填进草稿内容（coverAssetId / sampleVideoAssetId / slots[].assetId）。 */
export type CliTemplateDraftUploadedMedia = { assetId: string; url: string; kind: 'image' | 'video'; mimeType: string; durationSeconds?: number };
/** GET /api/cli/template-drafts。TSummary = TemplateSubmissionSummary。 */
export type CliTemplateDraftList<TSummary = Record<string, unknown>> = { items: TSummary[] };
/**
 * GET/POST/PUT 草稿与 submit/withdraw 的响应 = TemplateSubmissionDetail（含 version、contentRevision、validation）。
 * 这里只钉 CLI 依赖的字段，其余随伙伴契约。
 */
export type CliTemplateDraftDetail<TContent = Record<string, unknown>> = {
  id: string;
  status: 'draft' | 'pending' | 'rejected' | 'approved' | 'superseded' | 'retired';
  version: number;
  contentRevision: number;
  content: TContent;
  validation: { errors: unknown[]; warnings: unknown[] };
  rejectReason: string | null;
  submittedAt: string | null;
  updatedAt: string;
};
