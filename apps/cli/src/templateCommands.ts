// seewow template init / options / validate / push / submit / withdraw / list / show（方案 §4.1–§4.3）。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  CLI_IDEMPOTENCY_KEY_HEADER,
  CLI_TEMPLATE_DRAFTS_PATH,
  type CliTemplateDraftUploadedMedia,
  type CliTemplateDraftUploadIntent,
  type CliWhoami,
} from '../../../packages/contracts/cli.ts';
import {
  TEMPLATE_SUBMISSION_STATUS_LABELS,
  validateTemplateSubmission,
  type TemplateSubmissionDetail,
  type TemplateSubmissionIssue,
  type TemplateSubmissionSlotTypeOption,
  type TemplateSubmissionStatus,
  type TemplateSubmissionSummary,
} from '../../../packages/contracts/templateSubmissionRules.ts';
import type { ParsedArgs } from './args.ts';
import { requireSession, type CommandContext } from './context.ts';
import { CliError, EXIT, cliWording, describePrincipalName, hintForApiError, usageError, type CliIssue } from './errors.ts';
import type { ApiClient } from './http.ts';
import type { Output } from './output.ts';
import {
  buildContent,
  canonicalJson,
  contentHash,
  loadPackage,
  MANIFEST_FILE,
  sha256Text,
  toWireContent,
  type LoadedPackage,
  type Manifest,
  type MediaFile,
} from './templatePackage.ts';
import { emptyState, readState, STATE_DIR, writeState, type PackageState } from './state.ts';

/** GET /api/cli/template-drafts/options（= templateSlotTypes.ts::TemplateSubmissionOptions）。 */
export type DraftOptions = { industries: { id: string; name: string; slotTypes: TemplateSubmissionSlotTypeOption[] }[] };
type Detail = TemplateSubmissionDetail;

const DRAFT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const draftPath = (id: string, suffix = '') => `${CLI_TEMPLATE_DRAFTS_PATH}/${encodeURIComponent(id)}${suffix}`;
const statusLabel = (status: string) => TEMPLATE_SUBMISSION_STATUS_LABELS[status as TemplateSubmissionStatus] ?? status;
export const principalKeyOf = (principal: CliWhoami['principal']) => (principal.kind === 'platform' ? 'platform' : `partner:${principal.partnerChannelId}`);

const EMPTY_MANIFEST: Manifest = {
  title: '', industryId: '', catalogIndustryId: null, categoryId: null, script: '', lines: [], slots: [], sampleVideo: null, cover: null, remark: '',
};

const formatIssues = (issues: CliIssue[], prefix = '  ') => issues.map((issue) => `${prefix}- ${issue.field ? `${issue.field}：` : ''}${cliWording(issue.message)}（${issue.code}）`).join('\n');

const fetchWhoami = async (client: ApiClient) => (await client.json<CliWhoami>('GET', '/api/cli/whoami')).data;
const fetchOptions = async (client: ApiClient) => (await client.json<DraftOptions>('GET', `${CLI_TEMPLATE_DRAFTS_PATH}/options`)).data;
const fetchDetail = async (client: ApiClient, id: string) => (await client.json<Detail>('GET', draftPath(id))).data;

// ─── 本地校验 ────────────────────────────────────────────────────────────────
export type LocalValidation = { errors: CliIssue[]; warnings: CliIssue[]; offline: boolean };

/** 本地同款校验：直接用打包进来的 validateTemplateSubmission；联网时带上行业与素材类型字典。 */
export const validateLocally = (pkg: LoadedPackage, options: DraftOptions | null): LocalValidation => {
  const present = new Set(pkg.media.map((file) => file.path));
  const content = buildContent(pkg.manifest, (rel) => (present.has(rel) ? `local:${rel}` : null));
  const sample = pkg.media.find((file) => file.field === 'sampleVideo');
  const errors: CliIssue[] = [];
  const warnings: CliIssue[] = [];
  let industryName: string | undefined;
  let slotTypes: TemplateSubmissionSlotTypeOption[] | undefined;
  if (options) {
    slotTypes = options.industries.flatMap((industry) => industry.slotTypes ?? []);
    const industry = options.industries.find((item) => item.id === pkg.manifest.industryId);
    industryName = industry?.name;
    if (pkg.manifest.industryId && !industry) {
      errors.push({
        code: 'industry_not_allowed',
        message: `行业「${pkg.manifest.industryId}」不在当前身份可投的行业里（可投：${options.industries.map((item) => `${item.id}=${item.name}`).join('、') || '无'}）。`,
        field: 'industryId',
      });
    }
  }
  const result = validateTemplateSubmission(content, {
    durationSeconds: sample?.durationSeconds ?? null,
    industryId: pkg.manifest.industryId || undefined,
    industryName,
    slotTypes,
  });
  errors.push(...result.errors);
  warnings.push(...result.warnings);
  if (!options) warnings.push({ code: 'slot_types_unchecked', message: '离线校验：没有核对行业归属和素材类型（登录后联网校验会带上）。' });
  return { errors, warnings, offline: !options };
};

const assertNoPackageIssues = (pkg: LoadedPackage) => {
  if (pkg.issues.length) {
    throw new CliError(EXIT.VALIDATION, pkg.issues[0].code, `模板包有 ${pkg.issues.length} 处问题，没有上传任何东西。`, { issues: pkg.issues });
  }
};

// ─── 交互确认 ────────────────────────────────────────────────────────────────
const askYes = async (question: string): Promise<boolean> => {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((done) => rl.question(question, done));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
};

const requireConfirmation = async (ctx: CommandContext, yes: boolean, question: string, retryHint = '确认无误后加 --yes 重跑；先看看会提交什么可以加 --dry-run。'): Promise<void> => {
  if (yes) return;
  if (!ctx.interactive) {
    throw new CliError(EXIT.USAGE, 'confirmation_required', '这一步要人确认：非交互环境或 --json 下必须带 --yes。', { hint: retryHint });
  }
  if (!(await askYes(`${question}输入 y 确认：`))) throw new CliError(EXIT.USAGE, 'cancelled', '已取消，什么都没提交。');
};

const assertCanSubmit = (who: CliWhoami, apiHost: string) => {
  if (!who.scopes.includes('drafts:submit')) {
    throw new CliError(EXIT.PERMISSION, 'cli_scope_missing', '这把令牌没有提审权限（登录时用了 --no-submit，或确认页去掉了『可以直接提交审核』）。', { hint: hintForApiError(403, 'cli_scope_missing', apiHost) });
  }
  if (!who.effectiveScopes.includes('drafts:submit')) {
    throw new CliError(EXIT.PERMISSION, 'cli_submit_disabled', '提审功能目前没有开放。', { hint: '服务端提审开关关着：可以先 push 草稿，开放后再 submit。' });
  }
};

/** <dir|draftId>：是包含清单的目录就按目录，否则按草稿 id。 */
const resolveTarget = (target: string | undefined): { kind: 'dir'; dir: string } | { kind: 'id'; id: string } => {
  if (!target) throw usageError('missing_argument', '缺少参数：模板包目录或草稿 id。');
  if (existsSync(join(resolve(target), MANIFEST_FILE))) return { kind: 'dir', dir: target };
  if (existsSync(resolve(target))) throw new CliError(EXIT.VALIDATION, 'manifest_missing', `目录里没有 ${MANIFEST_FILE}：${target}`);
  if (!DRAFT_ID_PATTERN.test(target)) throw usageError('invalid_draft_id', `不是模板包目录，也不像草稿 id：${target}`);
  return { kind: 'id', id: target };
};

const describeDetail = (detail: Detail, options: DraftOptions | null, who: CliWhoami | null) => {
  const industry = options?.industries.find((item) => item.id === detail.content.industryId);
  return [
    `标题：${detail.content.title || '（未填）'}`,
    `行业：${industry ? `${industry.name}（${industry.id}）` : detail.content.industryId || '（未选）'}`,
    `素材：${detail.content.slots.length} 个；台词：${detail.content.lines.length} 句；样片时长：${detail.sampleDurationSeconds ? `${Math.round(detail.sampleDurationSeconds * 10) / 10} 秒` : '未知'}`,
    ...(who ? [`身份：${describePrincipalName(who.principal)}`] : []),
    `草稿：${detail.id}（状态：${statusLabel(detail.status)}，version ${detail.version}，contentRevision ${detail.contentRevision}）`,
  ].join('\n');
};

// ─── 提审（八关，§4.3）────────────────────────────────────────────────────────
type SubmitPin = { version: number; expectedContentRevision: number };

/**
 * 关 1（权限）由调用方先做；这里做：关 2 服务端校验结果 errors=0（本地同款校验由调用方在目录模式先跑）、
 * 状态必须可提审、关 3 钉 version + expectedContentRevision、关 4 人确认（或 --dry-run 只打印）、再发请求
 * （关 5 服务端重校验、关 6 限流配额、关 7 审计都在服务端；失败按 code 映射退出码）。
 */
const submitDetail = async (ctx: CommandContext, client: ApiClient, detail: Detail, pin: SubmitPin, opts: { yes: boolean; dryRun: boolean; who: CliWhoami; options: DraftOptions | null }) => {
  const { out } = ctx;
  if (detail.validation.errors.length) {
    throw new CliError(EXIT.VALIDATION, 'server_validation_failed', `服务端校验还有 ${detail.validation.errors.length} 处错误，不能提交审核。`, { issues: detail.validation.errors });
  }
  if (detail.status !== 'draft' && detail.status !== 'rejected') {
    throw new CliError(EXIT.CONFLICT, 'draft_not_submittable', `草稿当前状态是「${statusLabel(detail.status)}」，只有草稿或已驳回的才能提交审核。`);
  }
  const summary = describeDetail(detail, opts.options, opts.who);
  if (detail.validation.warnings.length) out.info(`提醒（不挡提交）：\n${formatIssues(detail.validation.warnings)}`);
  if (opts.dryRun) {
    out.result({ dryRun: true, action: 'submit', draftId: detail.id, version: pin.version, expectedContentRevision: pin.expectedContentRevision, status: detail.status }, `（--dry-run，未提交）将提交审核：\n${summary}`);
    return null;
  }
  out.info(`将提交审核：\n${summary}`);
  await requireConfirmation(ctx, opts.yes, '确认把这份草稿提交审核？');
  const { data } = await client.json<Detail>('POST', draftPath(detail.id, '/submit'), { body: { version: pin.version, expectedContentRevision: pin.expectedContentRevision } });
  return data;
};

// ─── init ────────────────────────────────────────────────────────────────────
export async function templateInit(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const dir = args.positionals[0];
  if (!dir) throw usageError('missing_argument', '用法：seewow template init <目录>');
  const abs = resolve(dir);
  if (existsSync(join(abs, MANIFEST_FILE))) throw usageError('already_initialized', `${dir} 里已经有 ${MANIFEST_FILE}，不覆盖。`);
  if (existsSync(abs) && readdirSync(abs).filter((name) => name !== '.git' && name !== '.gitignore' && name !== '.DS_Store').length) {
    throw usageError('directory_not_empty', `${dir} 不是空目录。`, '换一个新目录，或在空目录里 init。');
  }
  mkdirSync(join(abs, 'media'), { recursive: true });
  writeFileSync(join(abs, MANIFEST_FILE), `${JSON.stringify(EMPTY_MANIFEST, null, 2)}\n`);
  const gitignore = join(abs, '.gitignore');
  const existing = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  if (!existing.split(/\r?\n/).includes(`${STATE_DIR}/`)) writeFileSync(gitignore, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${STATE_DIR}/\n`);
  ctx.out.result({ dir: abs, manifest: join(abs, MANIFEST_FILE) }, [
    `✓ 已创建模板包：${abs}`,
    `  1. 素材放进 media/，在 ${MANIFEST_FILE} 里用相对路径引用（cover、sampleVideo、slots[].image）；`,
    '  2. seewow template options 看可投行业和素材类型（industryId、slots[].typeId）；',
    `  3. seewow template validate ${dir} 本地校验，seewow template push ${dir} 上传草稿。`,
  ].join('\n'));
  return EXIT.OK;
}

// ─── options ─────────────────────────────────────────────────────────────────
export async function templateOptions(ctx: CommandContext): Promise<number> {
  const { client } = requireSession(ctx);
  const options = await fetchOptions(client);
  const lines: string[] = [];
  for (const industry of options.industries) {
    lines.push(`${industry.id}  ${industry.name}`);
    for (const type of industry.slotTypes ?? []) {
      lines.push(`  ${type.id}  ${type.label}${type.baseKind === 'person' ? '（人物）' : ''}${type.enabled ? '' : '（已停用）'}${type.example ? `  例：${type.example}` : ''}`);
    }
  }
  ctx.out.result({ industries: options.industries }, lines.length ? lines.join('\n') : '当前身份没有可投的行业。');
  return EXIT.OK;
}

// ─── validate ────────────────────────────────────────────────────────────────
export async function templateValidate(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const dir = args.positionals[0];
  if (!dir) throw usageError('missing_argument', '用法：seewow template validate <目录>');
  const pkg = loadPackage(dir);
  assertNoPackageIssues(pkg);
  let options: DraftOptions | null = null;
  if (!args.flags.offline) {
    try {
      options = await fetchOptions(requireSession(ctx).client);
    } catch (error) {
      if (!(error instanceof CliError) || (error.code !== 'not_logged_in' && error.exitCode !== EXIT.NETWORK)) throw error;
      ctx.out.info(`（${error.code === 'not_logged_in' ? '没有登录' : '连不上服务'}，改为离线校验）`);
    }
  }
  const result = validateLocally(pkg, options);
  if (result.warnings.length) ctx.out.info(`提醒：\n${formatIssues(result.warnings)}`);
  if (result.errors.length) {
    throw new CliError(EXIT.VALIDATION, 'local_validation_failed', `本地校验有 ${result.errors.length} 处错误。`, { issues: result.errors, extra: { warnings: result.warnings, offline: result.offline } });
  }
  ctx.out.result({ valid: true, offline: result.offline, errors: [], warnings: result.warnings, media: pkg.media.map((file) => ({ path: file.path, mimeType: file.mimeType, sizeBytes: file.sizeBytes })) },
    `✓ 校验通过${result.offline ? '（离线）' : ''}${result.warnings.length ? `，${result.warnings.length} 条提醒` : ''}。`);
  return EXIT.OK;
}

// ─── push ────────────────────────────────────────────────────────────────────
const CONTENT_FIELDS = ['title', 'industryId', 'catalogIndustryId', 'categoryId', 'script', 'lines', 'slots', 'sampleVideoAssetId', 'coverAssetId', 'remark'] as const;
/**
 * 比 slots 前规整类型口径：服务端只存「不等于 行业 + kind 兜底值」的 typeId（storedSlotTypeId，纯兜底存 null），
 * 本地清单写的是 options 给的预置 id（如 auto.car）。两边都换成「实际生效的 typeId」（typeId ?? 行业.kind）再去掉 kind，
 * 这样只用预置类型时 --force 不再误报 slots；网页把类型改了（kind 变了）照样能比出来。
 */
const effectiveSlots = (slots: unknown, industryId: unknown) => (Array.isArray(slots) ? slots.map((slot) => {
  if (!slot || typeof slot !== 'object') return slot;
  const copy = { ...(slot as Record<string, unknown>) };
  if (!copy.typeId && typeof copy.kind === 'string' && copy.kind && typeof industryId === 'string' && industryId) copy.typeId = `${industryId}.${copy.kind}`;
  copy.typeId ??= null;
  delete copy.kind;
  return copy;
}) : slots);

/** --force：列出服务端当前内容里将被本地覆盖的字段（PUT 是整份替换，清单没写的会被清空）。 */
export const overwrittenFields = (server: Record<string, unknown>, local: Record<string, unknown>) => CONTENT_FIELDS.filter((field) => {
  const a = field === 'slots' ? effectiveSlots(server[field], server.industryId) : server[field];
  const b = field === 'slots' ? effectiveSlots(local[field], local.industryId) : local[field];
  const empty = (value: unknown) => value === undefined || value === null || value === '';
  if (empty(a) && empty(b)) return false;
  return canonicalJson(a) !== canonicalJson(b);
}).map((field) => ({ field, cleared: (local[field] === null || local[field] === '' || (Array.isArray(local[field]) && !(local[field] as unknown[]).length)) && !(server[field] === null || server[field] === '' || server[field] === undefined) }));

const formatBytes = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`);

const uploadMedia = async (out: Output, client: ApiClient, draftId: string, file: MediaFile): Promise<CliTemplateDraftUploadedMedia> => {
  const { data: intent } = await client.json<CliTemplateDraftUploadIntent>('POST', draftPath(draftId, '/media/upload-intents'), {
    body: { fileName: basename(file.path).slice(0, 200), mimeType: file.mimeType, sizeBytes: file.sizeBytes, sha256: file.sha256 },
  });
  let lastShown = -1;
  let announced = false;
  const onProgress = (sent: number) => {
    const percent = Math.floor((sent / file.sizeBytes) * 100);
    const step = Math.floor(percent / 10) * 10;
    if (step > lastShown && file.sizeBytes >= 512 * 1024) {
      lastShown = step;
      out.info(`  ${file.path}  ${step}%（${formatBytes(sent)} / ${formatBytes(file.sizeBytes)}）`);
    }
    if (sent >= file.sizeBytes && !announced) {
      announced = true;
      out.info(`  ${file.path} 已传完，服务器转存中${file.sizeBytes >= 5 * 1024 * 1024 ? '（大文件要等几分钟，请别中断）' : ''}…`);
    }
  };
  try {
    await client.upload(intent.uploadUrl, file.absPath, file.sizeBytes, intent.headers ?? {}, onProgress);
    const { data } = await client.json<CliTemplateDraftUploadedMedia>('POST', draftPath(draftId, '/media/complete'), { body: { intentId: intent.intentId } });
    return data;
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    throw new CliError(error.exitCode, error.code, `上传 ${file.path} 失败：${error.message}`, {
      hint: `${error.hint ? `${error.hint} ` : ''}重新 push 会跳过已传完的文件。`, status: error.status, retryAfter: error.retryAfter, extra: error.extra,
    });
  }
};

export async function templatePush(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const { out } = ctx;
  const dir = args.positionals[0];
  if (!dir) throw usageError('missing_argument', '用法：seewow template push <目录>');
  const submit = args.flags.submit === true;
  const dryRun = args.flags['dry-run'] === true;
  const force = args.flags.force === true;
  const yes = args.flags.yes === true;
  if (submit && args.flags['allow-incomplete']) throw usageError('flags_conflict', '--submit 和 --allow-incomplete 不能一起用：提交审核要求校验 0 错误。');
  if (args.flags.yes && !submit) throw usageError('flags_conflict', '--yes 只和 --submit 一起用。');
  // 非交互要提审却没带 --yes：在推任何东西之前就停下。
  if (submit && !yes && !dryRun && !ctx.interactive) {
    throw new CliError(EXIT.USAGE, 'confirmation_required', 'push --submit 要人确认：非交互环境或 --json 下必须带 --yes。', { hint: '确认无误后加 --yes；先看看会做什么可以加 --dry-run。' });
  }

  const pkg = loadPackage(dir);
  assertNoPackageIssues(pkg);
  const { client } = requireSession(ctx);
  const who = await fetchWhoami(client);
  if (submit) assertCanSubmit(who, client.apiHost);
  const options = await fetchOptions(client);
  const local = validateLocally(pkg, options);
  if (local.warnings.length) out.info(`提醒：\n${formatIssues(local.warnings)}`);
  if (local.errors.length && !args.flags['allow-incomplete']) {
    throw new CliError(EXIT.VALIDATION, 'local_validation_failed', `本地校验有 ${local.errors.length} 处错误，没有上传。`, {
      issues: local.errors, hint: submit ? undefined : '还没做完想先存草稿，加 --allow-incomplete。',
    });
  }

  const principalKey = principalKeyOf(who.principal);
  const previousState = readState(pkg.dir);
  let state: PackageState = args.flags.new ? emptyState() : previousState;
  if (!args.flags.new && state.draftId && (state.apiUrl !== client.apiUrl || state.principalKey !== principalKey)) {
    throw new CliError(EXIT.CONFLICT, 'state_principal_mismatch', `这个包上次推到的是 ${state.apiUrl ?? '?'} 的「${state.principalKey ?? '?'}」，和当前登录（${client.apiUrl} 的「${principalKey}」）不一样。`, {
      hint: '要在当前身份下新建一份草稿（会重传素材）就加 --new。',
    });
  }
  if (!state.draftId) state = { ...emptyState(), apiUrl: client.apiUrl, principalKey };

  const existing = state.draftId ? await fetchDetail(client, state.draftId) : null;
  const plannedContent = buildContent(pkg.manifest, (rel) => {
    const file = pkg.media.find((item) => item.path === rel);
    return file && state.assets[file.sha256] ? state.assets[file.sha256].assetId : file ? '(待上传)' : null;
  });
  // 冲突判据（服务端口径，partnerTemplateSubmissionStore.ts）：version 是所有写入都 +1 的乐观锁（提审、撤回、驳回、批准也涨），
  // contentRevision 只在内容写入时 +1。所以「网页上有人改过内容」= contentRevision 变了；只有 version 变 = 状态流转
  // （比如提审后被驳回、撤回），不算冲突，以服务端当前 version 为基整份替换即可。
  let baseVersion: number | null = existing ? existing.version : null;
  let overwritten: { field: string; cleared: boolean }[] = [];
  let contentConflict = false;
  if (existing) {
    if (existing.status !== 'draft' && existing.status !== 'rejected') {
      throw new CliError(EXIT.CONFLICT, 'template_submission_locked', `草稿当前状态是「${statusLabel(existing.status)}」，不能修改。`, { hint: hintForApiError(409, 'template_submission_locked', client.apiHost) });
    }
    contentConflict = existing.contentRevision !== state.contentRevision;
    if (contentConflict) {
      // 列的是「服务端当前内容 vs 本地清单」不同的字段：PUT 是整份替换，这些字段上服务端的值会被本地的值顶掉。
      overwritten = overwrittenFields(existing.content as unknown as Record<string, unknown>, toWireContent(plannedContent));
      if (!force) {
        throw new CliError(EXIT.CONFLICT, 'draft_version_conflict', `你上次推送之后，草稿内容在别处被改过（本地记录 contentRevision ${state.contentRevision ?? '?'}，服务端 ${existing.contentRevision}，最近更新 ${existing.updatedAt}），没有覆盖。${overwritten.length ? `和本地清单不同的字段：${overwritten.map((item) => item.field).join('、')}。` : ''}`, {
          hint: hintForApiError(409, 'draft_version_conflict', client.apiHost),
          extra: { localContentRevision: state.contentRevision, serverContentRevision: existing.contentRevision, serverVersion: existing.version, differingFields: overwritten.map((item) => item.field) },
        });
      }
      out.warn(overwritten.length
        ? `--force：下面这些字段服务端的内容和本地清单不同，会被本地内容整份覆盖：\n${overwritten.map((item) => `  - ${item.field}${item.cleared ? '（服务端有值，本地没写，会被清空）' : ''}`).join('\n')}`
        : '--force：服务端内容被改过，但字段内容与本地清单一致，覆盖不会丢东西。');
    } else if (existing.version !== state.version) {
      out.info(`草稿状态有变化（${statusLabel(existing.status)}，version ${state.version ?? '?'} → ${existing.version}），内容没被别处改过，按服务端当前版本推送。`);
    }
  }
  const uniqueMedia = pkg.media.filter((file, index, all) => all.findIndex((other) => other.sha256 === file.sha256) === index);
  const toUpload = uniqueMedia.filter((file) => !state.assets[file.sha256]);
  const skipped = uniqueMedia.filter((file) => state.assets[file.sha256]);

  if (dryRun) {
    const plan = {
      action: existing ? 'update' : 'create', draftId: existing?.id ?? null, force, contentConflict, overwrittenFields: overwritten,
      upload: toUpload.map((file) => ({ path: file.path, mimeType: file.mimeType, sizeBytes: file.sizeBytes })),
      skip: skipped.map((file) => file.path), submit, localErrors: local.errors.length, localWarnings: local.warnings.length,
    };
    out.result({ dryRun: true, plan }, [
      '（--dry-run，什么都没改）将会：',
      `  ${existing ? `更新草稿 ${existing.id}（version ${existing.version}）` : '新建一份草稿'}${force && overwritten.length ? `，覆盖字段：${overwritten.map((item) => item.field).join('、')}` : ''}`,
      `  上传 ${toUpload.length} 个文件${toUpload.length ? `：${toUpload.map((file) => `${file.path}（${formatBytes(file.sizeBytes)}）`).join('、')}` : ''}`,
      `  跳过 ${skipped.length} 个已传过的文件`,
      ...(submit ? ['  然后提交审核（需确认）'] : []),
    ].join('\n'));
    return EXIT.OK;
  }

  // 1) 新建（幂等键 = sha256(包目录绝对路径 + 清单哈希 + 主体 + --new 时被替换的旧草稿 id)：
  //    网络重试/崩溃重跑回放同一条；--new 或换主体时自然是新键，不会被回放成旧草稿）
  let created = false;
  if (!existing) {
    const replacedDraftId = args.flags.new ? previousState.draftId ?? '' : '';
    const idempotencyKey = `seewow-cli-${sha256Text(`${pkg.dir}\n${pkg.manifestHash}\n${principalKey}\n${replacedDraftId}`)}`;
    const response = await client.json<Detail>('POST', CLI_TEMPLATE_DRAFTS_PATH, {
      body: { content: toWireContent(buildContent(pkg.manifest, () => null)) },
      headers: { [CLI_IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    });
    created = response.status === 201;
    state = { ...state, draftId: response.data.id, version: response.data.version, contentRevision: response.data.contentRevision, apiUrl: client.apiUrl, principalKey };
    baseVersion = response.data.version;
    writeState(pkg.dir, state);
    out.info(`${created ? '已新建草稿' : '已找回上次新建的草稿'}：${response.data.id}`);
  }
  const draftId = state.draftId as string;

  // 2) 只传哈希变了的文件；每传完一个就记进 state，失败重跑会跳过
  const uploaded: { path: string; assetId: string }[] = [];
  for (const file of toUpload) {
    out.info(`上传 ${file.path}（${formatBytes(file.sizeBytes)}）…`);
    const media = await uploadMedia(out, client, draftId, file);
    state.assets[file.sha256] = { assetId: media.assetId, mimeType: media.mimeType, sizeBytes: file.sizeBytes, kind: media.kind, uploadedAt: new Date().toISOString() };
    writeState(pkg.dir, state);
    uploaded.push({ path: file.path, assetId: media.assetId });
  }

  // 3) 整份替换，钉服务端当前 version（刚读到的；读到之后又有人写，服务端 409 兜住）
  const content = buildContent(pkg.manifest, (rel) => {
    const file = pkg.media.find((item) => item.path === rel);
    return file ? state.assets[file.sha256]?.assetId ?? null : null;
  });
  const { data: saved } = await client.json<Detail>('PUT', draftPath(draftId), { body: { version: baseVersion, content: toWireContent(content) } });
  state = { ...state, version: saved.version, contentRevision: saved.contentRevision, lastPushedContentHash: contentHash(content) };
  writeState(pkg.dir, state);
  const pushResult = {
    draftId, created, version: saved.version, contentRevision: saved.contentRevision, status: saved.status,
    uploaded, skipped: skipped.map((file) => file.path), validation: saved.validation,
  };
  const pushSummary = `✓ 已推送草稿 ${draftId}（version ${saved.version}），上传 ${uploaded.length} 个文件、跳过 ${skipped.length} 个；服务端校验 ${saved.validation.errors.length} 错误 / ${saved.validation.warnings.length} 提醒。`;
  if (saved.validation.errors.length) out.info(`服务端校验错误：\n${formatIssues(saved.validation.errors)}`);
  if (!submit) {
    out.result(pushResult, pushSummary);
    return EXIT.OK;
  }

  out.info(pushSummary);
  const submitted = await submitDetail(ctx, client, saved, { version: saved.version, expectedContentRevision: saved.contentRevision }, { yes, dryRun: false, who, options });
  if (submitted) {
    writeState(pkg.dir, { ...state, version: submitted.version, contentRevision: submitted.contentRevision });
    out.result({ ...pushResult, submitted: true, status: submitted.status, version: submitted.version }, `${pushSummary}\n✓ 已提交审核（状态：${statusLabel(submitted.status)}）。`);
  }
  return EXIT.OK;
}

// ─── submit ──────────────────────────────────────────────────────────────────
export async function templateSubmit(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const target = resolveTarget(args.positionals[0]);
  const yes = args.flags.yes === true;
  const dryRun = args.flags['dry-run'] === true;
  const { client } = requireSession(ctx);
  // 关 1：权限与开关
  const who = await fetchWhoami(client);
  assertCanSubmit(who, client.apiHost);
  const options = await fetchOptions(client);
  let detail: Detail;
  let pin: SubmitPin;
  if (target.kind === 'dir') {
    // 关 2：本地同款校验 errors 必须为 0；目录内容必须与服务端草稿一致（不一致先 push）
    const pkg = loadPackage(target.dir);
    assertNoPackageIssues(pkg);
    const local = validateLocally(pkg, options);
    if (local.errors.length) throw new CliError(EXIT.VALIDATION, 'local_validation_failed', `本地校验有 ${local.errors.length} 处错误，不能提交审核。`, { issues: local.errors });
    const state = readState(pkg.dir);
    if (!state.draftId) throw new CliError(EXIT.CONFLICT, 'draft_not_pushed', '这个包还没推送过。', { hint: `先运行 seewow template push ${target.dir}（或 push --submit）。` });
    if (state.apiUrl !== client.apiUrl || state.principalKey !== principalKeyOf(who.principal)) {
      throw new CliError(EXIT.CONFLICT, 'state_principal_mismatch', '这个包上次推到的服务或身份和当前登录不一样。', { hint: '用当时的 --profile 提交，或 push --new 在当前身份下新建。' });
    }
    const missing = pkg.media.filter((file) => !state.assets[file.sha256]);
    const content = buildContent(pkg.manifest, (rel) => {
      const file = pkg.media.find((item) => item.path === rel);
      return file ? state.assets[file.sha256]?.assetId ?? null : null;
    });
    if (missing.length || contentHash(content) !== state.lastPushedContentHash) {
      throw new CliError(EXIT.CONFLICT, 'draft_out_of_sync', `目录内容和上次推送的不一致${missing.length ? `（${missing.length} 个文件没传过）` : ''}，没有提交。`, {
        hint: `先运行 seewow template push ${target.dir}，或直接 push --submit。`,
      });
    }
    detail = await fetchDetail(client, state.draftId);
    if (detail.contentRevision !== state.contentRevision) {
      throw new CliError(EXIT.CONFLICT, 'draft_content_changed', `推送之后草稿内容在别处被改过（本地 contentRevision ${state.contentRevision}，服务端 ${detail.contentRevision}），不会把你没看过的内容送审。`, { hint: hintForApiError(409, 'draft_content_changed', client.apiHost) });
    }
    // 只有 version 变（驳回、撤回等状态流转）不拦：内容版本上面已经对过。
    // 关 3：钉服务端当前 version + CLI 推上去的那版内容（服务端两样都校）
    pin = { version: detail.version, expectedContentRevision: state.contentRevision as number };
    const submitted = await submitDetail(ctx, client, detail, pin, { yes, dryRun, who, options });
    if (!submitted) return EXIT.OK;
    writeState(pkg.dir, { ...state, version: submitted.version, contentRevision: submitted.contentRevision });
    ctx.out.result({ draftId: submitted.id, status: submitted.status, version: submitted.version, contentRevision: submitted.contentRevision }, `✓ 已提交审核：${submitted.content.title || submitted.id}（状态：${statusLabel(submitted.status)}）`);
    return EXIT.OK;
  }
  detail = await fetchDetail(client, target.id);
  // 关 3：钉住刚读到的那一版
  pin = { version: detail.version, expectedContentRevision: detail.contentRevision };
  const submitted = await submitDetail(ctx, client, detail, pin, { yes, dryRun, who, options });
  if (!submitted) return EXIT.OK;
  ctx.out.result({ draftId: submitted.id, status: submitted.status, version: submitted.version, contentRevision: submitted.contentRevision }, `✓ 已提交审核：${submitted.content.title || submitted.id}（状态：${statusLabel(submitted.status)}）`);
  return EXIT.OK;
}

// ─── withdraw ────────────────────────────────────────────────────────────────
export async function templateWithdraw(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const target = resolveTarget(args.positionals[0]);
  const yes = args.flags.yes === true;
  const dryRun = args.flags['dry-run'] === true;
  const { client } = requireSession(ctx);
  const who = await fetchWhoami(client);
  assertCanSubmit(who, client.apiHost);
  let pkgDir: string | null = null;
  let draftId: string;
  if (target.kind === 'dir') {
    pkgDir = resolve(target.dir);
    const state = readState(pkgDir);
    if (!state.draftId) throw new CliError(EXIT.CONFLICT, 'draft_not_pushed', '这个包还没推送过，没有可撤回的草稿。');
    draftId = state.draftId;
  } else draftId = target.id;
  const detail = await fetchDetail(client, draftId);
  if (detail.status !== 'pending') throw new CliError(EXIT.CONFLICT, 'draft_not_pending', `草稿当前状态是「${statusLabel(detail.status)}」，只有审核中的才能撤回。`);
  const summary = describeDetail(detail, null, who);
  if (dryRun) {
    ctx.out.result({ dryRun: true, action: 'withdraw', draftId, version: detail.version }, `（--dry-run，未撤回）将撤回审核：\n${summary}`);
    return EXIT.OK;
  }
  ctx.out.info(`将撤回审核（回到草稿）：\n${summary}`);
  await requireConfirmation(ctx, yes, '确认撤回审核？', '确认要撤回后加 --yes 重跑。');
  const { data } = await client.json<Detail>('POST', draftPath(draftId, '/withdraw'), { body: { version: detail.version } });
  if (pkgDir) {
    // 只跟 version；contentRevision 保持「上次推送的那一版」——服务端内容若在别处被改过，下次 push 才会按冲突拦住，
    // 不能在这里把服务端的 contentRevision 抄进来把冲突抹掉。
    const state = readState(pkgDir);
    writeState(pkgDir, { ...state, version: data.version });
    if (data.contentRevision !== state.contentRevision) {
      ctx.out.warn(`注意：服务端草稿内容和你上次推送的不一样（本地 contentRevision ${state.contentRevision ?? '?'}，服务端 ${data.contentRevision}），下次 push 会按冲突处理。`);
    }
  }
  ctx.out.result({ draftId, status: data.status, version: data.version, contentRevision: data.contentRevision }, `✓ 已撤回：${data.content.title || draftId}（状态：${statusLabel(data.status)}）`);
  return EXIT.OK;
}

// ─── list / show ─────────────────────────────────────────────────────────────
export async function templateList(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const { client } = requireSession(ctx);
  const { data } = await client.json<{ items: TemplateSubmissionSummary[] }>('GET', CLI_TEMPLATE_DRAFTS_PATH);
  const wanted = typeof args.flags.status === 'string' ? args.flags.status.split(',').map((item) => item.trim()).filter(Boolean) : null;
  const items = wanted ? data.items.filter((item) => wanted.includes(item.status)) : data.items;
  ctx.out.result({ items }, items.length
    ? items.map((item) => `${item.id}  ${statusLabel(item.status)}  ${item.title || '（未命名）'}  ${item.updatedAt}${item.rejectReason ? `\n    驳回原因：${item.rejectReason}` : ''}`).join('\n')
    : '没有草稿。');
  return EXIT.OK;
}

export async function templateShow(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const target = resolveTarget(args.positionals[0]);
  const { client } = requireSession(ctx);
  let draftId: string;
  if (target.kind === 'dir') {
    const state = readState(resolve(target.dir));
    if (!state.draftId) throw new CliError(EXIT.CONFLICT, 'draft_not_pushed', '这个包还没推送过。');
    draftId = state.draftId;
  } else draftId = target.id;
  const detail = await fetchDetail(client, draftId);
  const issues = [
    ...(detail.validation.errors.length ? [`校验错误：\n${formatIssues(detail.validation.errors as TemplateSubmissionIssue[])}`] : []),
    ...(detail.validation.warnings.length ? [`提醒：\n${formatIssues(detail.validation.warnings as TemplateSubmissionIssue[])}`] : []),
    ...(detail.rejectReason ? [`驳回原因：${detail.rejectReason}`] : []),
  ];
  ctx.out.result({ draft: detail }, [describeDetail(detail, null, null), ...issues].join('\n'));
  return EXIT.OK;
}
