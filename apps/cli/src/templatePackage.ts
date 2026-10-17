// 模板包（方案 §4.2）：<目录>/seewow-template.json + media/ + .seewow/state.json。
// 清单字段与 TemplateSubmissionContent 一一对应，素材 id 换成包内相对路径：
//   coverAssetId → cover、sampleVideoAssetId → sampleVideo、slots[].assetId → slots[].image。
// 严格白名单：任何多余键（videoModel / provider / params / fixedCredits / durationSeconds / nodeOverrides /
// submitPromptTemplate、槽位 kind 等）→ field_not_allowed，不上传。路径只能在包内（拒 ..、绝对路径、符号链接逃逸）；
// MIME 按文件头判断；大小上限沿用 TEMPLATE_SUBMISSION_MEDIA_LIMITS。
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import {
  TEMPLATE_SUBMISSION_MEDIA_LIMITS,
  type TemplateSubmissionContent,
  type TemplateSubmissionIssue,
} from '../../../packages/contracts/templateSubmissionRules.ts';
import { CliError, EXIT, type CliIssue } from './errors.ts';

export const MANIFEST_FILE = 'seewow-template.json';

const TOP_KEYS = ['title', 'industryId', 'catalogIndustryId', 'categoryId', 'script', 'lines', 'slots', 'sampleVideo', 'cover', 'remark'] as const;
const LINE_KEYS = ['text', 'speaker', 'maxChars'] as const;
const SLOT_KEYS = ['label', 'typeId', 'replaceable', 'hint', 'image'] as const;
/** 这些键只在管理端批准时由运营填，或由服务端写回，清单里出现就点名提示。 */
const SERVER_OWNED_KEYS = new Set(['videoModel', 'provider', 'params', 'fixedCredits', 'durationSeconds', 'nodeOverrides', 'submitPromptTemplate', 'kind', 'model', 'credits', 'price']);
const ASSET_ID_RENAMES: Record<string, string> = { coverAssetId: 'cover', sampleVideoAssetId: 'sampleVideo', assetId: 'image' };

export type ManifestLine = { text: string; speaker?: string; maxChars?: number };
export type ManifestSlot = { label: string; typeId: string | null; replaceable: boolean; hint: string; image: string | null };
export type Manifest = {
  title: string;
  industryId: string;
  catalogIndustryId: string | null;
  categoryId: string | null;
  script: string;
  lines: ManifestLine[];
  slots: ManifestSlot[];
  sampleVideo: string | null;
  cover: string | null;
  remark: string;
};

export type MediaRef = { field: string; path: string; expect: 'image' | 'video' };
export type MediaFile = MediaRef & { absPath: string; mimeType: string; sizeBytes: number; sha256: string; durationSeconds?: number };

export type LoadedPackage = {
  dir: string;
  manifest: Manifest;
  manifestHash: string;
  media: MediaFile[];
  /** 形状、白名单、路径、类型、大小问题——有任何一条就不联网、不上传。 */
  issues: CliIssue[];
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

const notAllowed = (field: string, key: string): CliIssue => {
  const rename = ASSET_ID_RENAMES[key];
  let message = `清单里不能出现「${key}」。`;
  if (rename) message += `素材请写包内相对路径，字段名用「${rename}」。`;
  else if (SERVER_OWNED_KEYS.has(key)) message += '模型、provider、时长、定价、节点参数等只由运营在管理端批准时填写；槽位类型请用 typeId。';
  return { code: 'field_not_allowed', message, field: field ? `${field}.${key}` : key };
};

const checkKeys = (value: Record<string, unknown>, allowed: readonly string[], field: string, issues: CliIssue[]) => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.push(notAllowed(field, key));
};

const optionalString = (value: unknown, field: string, issues: CliIssue[], fallback: string | null): string | null => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') {
    issues.push({ code: 'manifest_invalid', message: `${field} 必须是字符串。`, field });
    return fallback;
  }
  return value;
};

/** 清单 JSON → Manifest（形状 + 严格白名单）。不读文件。 */
export const parseManifest = (raw: unknown): { manifest: Manifest; issues: CliIssue[] } => {
  const issues: CliIssue[] = [];
  const root = isPlainObject(raw) ? raw : {};
  if (!isPlainObject(raw)) issues.push({ code: 'manifest_invalid', message: `${MANIFEST_FILE} 顶层必须是一个 JSON 对象。` });
  checkKeys(root, TOP_KEYS, '', issues);
  const lines: ManifestLine[] = [];
  if (root.lines !== undefined && !Array.isArray(root.lines)) issues.push({ code: 'manifest_invalid', message: 'lines 必须是数组。', field: 'lines' });
  (Array.isArray(root.lines) ? root.lines : []).forEach((item, index) => {
    const field = `lines[${index}]`;
    if (!isPlainObject(item)) {
      issues.push({ code: 'manifest_invalid', message: `${field} 必须是对象（{ "text": "…" }）。`, field });
      return;
    }
    checkKeys(item, LINE_KEYS, field, issues);
    const line: ManifestLine = { text: optionalString(item.text, `${field}.text`, issues, '') ?? '' };
    const speaker = optionalString(item.speaker, `${field}.speaker`, issues, null);
    if (speaker) line.speaker = speaker;
    if (item.maxChars !== undefined) {
      if (typeof item.maxChars !== 'number') issues.push({ code: 'manifest_invalid', message: `${field}.maxChars 必须是数字。`, field: `${field}.maxChars` });
      else line.maxChars = item.maxChars;
    }
    lines.push(line);
  });
  const slots: ManifestSlot[] = [];
  if (root.slots !== undefined && !Array.isArray(root.slots)) issues.push({ code: 'manifest_invalid', message: 'slots 必须是数组。', field: 'slots' });
  (Array.isArray(root.slots) ? root.slots : []).forEach((item, index) => {
    const field = `slots[${index}]`;
    if (!isPlainObject(item)) {
      issues.push({ code: 'manifest_invalid', message: `${field} 必须是对象。`, field });
      return;
    }
    checkKeys(item, SLOT_KEYS, field, issues);
    if (item.replaceable !== undefined && typeof item.replaceable !== 'boolean') issues.push({ code: 'manifest_invalid', message: `${field}.replaceable 必须是 true 或 false。`, field: `${field}.replaceable` });
    slots.push({
      label: optionalString(item.label, `${field}.label`, issues, '') ?? '',
      typeId: optionalString(item.typeId, `${field}.typeId`, issues, null) || null,
      replaceable: typeof item.replaceable === 'boolean' ? item.replaceable : true,
      hint: optionalString(item.hint, `${field}.hint`, issues, '') ?? '',
      image: optionalString(item.image, `${field}.image`, issues, null) || null,
    });
  });
  const manifest: Manifest = {
    title: optionalString(root.title, 'title', issues, '') ?? '',
    industryId: optionalString(root.industryId, 'industryId', issues, '') ?? '',
    catalogIndustryId: optionalString(root.catalogIndustryId, 'catalogIndustryId', issues, null) || null,
    categoryId: optionalString(root.categoryId, 'categoryId', issues, null) || null,
    script: optionalString(root.script, 'script', issues, '') ?? '',
    lines,
    slots,
    sampleVideo: optionalString(root.sampleVideo, 'sampleVideo', issues, null) || null,
    cover: optionalString(root.cover, 'cover', issues, null) || null,
    remark: optionalString(root.remark, 'remark', issues, '') ?? '',
  };
  return { manifest, issues };
};

export const collectMediaRefs = (manifest: Manifest): MediaRef[] => {
  const refs: MediaRef[] = [];
  if (manifest.sampleVideo) refs.push({ field: 'sampleVideo', path: manifest.sampleVideo, expect: 'video' });
  if (manifest.cover) refs.push({ field: 'cover', path: manifest.cover, expect: 'image' });
  manifest.slots.forEach((slot, index) => {
    if (slot.image) refs.push({ field: `slots[${index}].image`, path: slot.image, expect: 'image' });
  });
  return refs;
};

/** ISO-BMFF（ftyp）主品牌白名单：只有这些才当视频；HEIF/AVIF 是图片；其余未知品牌不猜，按不支持处理。 */
const MP4_VIDEO_BRANDS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4VH', 'M4VP', 'dash', 'f4v ', 'MSNV', 'XAVC']);
const QUICKTIME_BRANDS = new Set(['qt  ']);
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);
const AVIF_BRANDS = new Set(['avif', 'avis']);
/** 通用 HEIF 主品牌：看兼容品牌里有没有 avif 决定是 AVIF 还是 HEIC。 */
const GENERIC_HEIF_BRANDS = new Set(['mif1', 'msf1']);
/** sniffMime 需要的文件头字节数（ftyp 兼容品牌列表要多读一点）。 */
export const SNIFF_BYTES = 64;

const sniffFtyp = (head: Uint8Array, ascii: (from: number, to: number) => string): string | null => {
  const major = ascii(8, 12);
  if (QUICKTIME_BRANDS.has(major)) return 'video/quicktime';
  if (MP4_VIDEO_BRANDS.has(major)) return 'video/mp4';
  if (HEIC_BRANDS.has(major)) return 'image/heic';
  if (AVIF_BRANDS.has(major)) return 'image/avif';
  if (GENERIC_HEIF_BRANDS.has(major)) {
    const boxSize = ((head[0] << 24) >>> 0) + (head[1] << 16) + (head[2] << 8) + head[3];
    const end = Math.min(head.length, boxSize >= 16 ? boxSize : head.length);
    const compatible: string[] = [];
    for (let offset = 16; offset + 4 <= end; offset += 4) compatible.push(ascii(offset, offset + 4));
    return compatible.some((brand) => AVIF_BRANDS.has(brand)) ? 'image/avif' : 'image/heic';
  }
  return null;
};

/** 按文件头判断 MIME（不信扩展名）。ftyp 按主品牌白名单判，未知品牌返回 null（不猜）。 */
export const sniffMime = (head: Uint8Array): string | null => {
  const at = (index: number) => head[index];
  const ascii = (from: number, to: number) => String.fromCharCode(...Array.from(head.subarray(from, to)));
  if (head.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (head.length >= 8 && at(0) === 0x89 && ascii(1, 4) === 'PNG' && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return 'image/png';
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (head.length >= 12 && ascii(4, 8) === 'ftyp') return sniffFtyp(head, ascii);
  return null;
};

/** 读 MP4/MOV 的 moov/mvhd 时长（秒）；解析不了返回 undefined（只用于本地校验的台词字数口径）。 */
export const readMp4DurationSeconds = (absPath: string): number | undefined => {
  let fd: number | null = null;
  try {
    fd = openSync(absPath, 'r');
    const size = statSync(absPath).size;
    const header = Buffer.alloc(16);
    const readBox = (offset: number) => {
      if (offset + 8 > size) return null;
      readSync(fd as number, header, 0, 16, offset);
      let boxSize = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      let headerSize = 8;
      if (boxSize === 1) {
        boxSize = Number(header.readBigUInt64BE(8));
        headerSize = 16;
      } else if (boxSize === 0) boxSize = size - offset;
      if (boxSize < headerSize) return null;
      return { type, start: offset, headerSize, end: offset + boxSize };
    };
    const findChild = (from: number, to: number, type: string) => {
      let offset = from;
      for (let guard = 0; offset < to && guard < 10_000; guard += 1) {
        const box = readBox(offset);
        if (!box) return null;
        if (box.type === type) return box;
        offset = box.end;
      }
      return null;
    };
    const moov = findChild(0, size, 'moov');
    if (!moov) return undefined;
    const mvhd = findChild(moov.start + moov.headerSize, moov.end, 'mvhd');
    if (!mvhd) return undefined;
    const body = Buffer.alloc(32);
    readSync(fd, body, 0, 32, mvhd.start + mvhd.headerSize);
    const version = body[0];
    const timescale = version === 1 ? body.readUInt32BE(20) : body.readUInt32BE(12);
    const duration = version === 1 ? Number(body.readBigUInt64BE(24)) : body.readUInt32BE(16);
    if (!timescale || !duration) return undefined;
    return duration / timescale;
  } catch {
    return undefined;
  } finally {
    if (fd !== null) closeSync(fd);
  }
};

const sha256File = (absPath: string): string => createHash('sha256').update(readFileSync(absPath)).digest('hex');
export const sha256Text = (text: string): string => createHash('sha256').update(text).digest('hex');

/** 键排序的稳定 JSON（内容哈希、幂等键用）。 */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
};

/** 解析一个包内相对路径；任何逃逸（绝对路径、..、符号链接指到包外）都报 path_outside_package。 */
export const resolveInPackage = (pkgRealDir: string, rel: string, field: string): { absPath: string } | { issue: CliIssue } => {
  if (isAbsolute(rel) || rel.includes('\\') || rel.includes('\0')) return { issue: { code: 'path_outside_package', message: `${field} 必须是包内相对路径（例如 media/cover.jpg）：${rel}`, field } };
  const normalized = normalize(rel);
  if (normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.split(sep).includes('..')) {
    return { issue: { code: 'path_outside_package', message: `${field} 不能用 .. 指到包外：${rel}`, field } };
  }
  const candidate = resolve(pkgRealDir, normalized);
  if (!existsSync(candidate)) return { issue: { code: 'media_missing', message: `${field} 指向的文件不存在：${rel}`, field } };
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return { issue: { code: 'media_missing', message: `${field} 指向的文件读不了：${rel}`, field } };
  }
  if (!real.startsWith(`${pkgRealDir}${sep}`)) return { issue: { code: 'path_outside_package', message: `${field} 经符号链接指到了包外：${rel}`, field } };
  if (!statSync(real).isFile()) return { issue: { code: 'media_missing', message: `${field} 不是普通文件：${rel}`, field } };
  return { absPath: real };
};

export const inspectMedia = (pkgRealDir: string, ref: MediaRef): MediaFile | { issue: CliIssue } => {
  const resolved = resolveInPackage(pkgRealDir, ref.path, ref.field);
  if ('issue' in resolved) return resolved;
  const head = Buffer.alloc(SNIFF_BYTES);
  const fd = openSync(resolved.absPath, 'r');
  let read = 0;
  try {
    read = readSync(fd, head, 0, SNIFF_BYTES, 0);
  } finally {
    closeSync(fd);
  }
  const mimeType = sniffMime(head.subarray(0, read));
  if (!mimeType) return { issue: { code: 'media_type_unsupported', message: `${ref.field} 的文件类型不支持（按文件头判断，只收 JPEG/PNG/WebP 图片与 MP4/MOV 视频）：${ref.path}`, field: ref.field } };
  const limit = TEMPLATE_SUBMISSION_MEDIA_LIMITS[mimeType];
  if (!limit) return { issue: { code: 'media_type_unsupported', message: `${ref.field} 的文件类型 ${mimeType} 不支持${mimeType === 'image/heic' || mimeType === 'image/avif' ? '（请先导出为 JPEG/PNG/WebP）' : ''}：${ref.path}`, field: ref.field } };
  if (limit.kind !== ref.expect) {
    return { issue: { code: 'media_kind_mismatch', message: `${ref.field} 需要${ref.expect === 'video' ? '视频' : '图片'}，但文件头显示是 ${mimeType}：${ref.path}`, field: ref.field } };
  }
  const sizeBytes = statSync(resolved.absPath).size;
  if (sizeBytes === 0) return { issue: { code: 'media_missing', message: `${ref.field} 是空文件：${ref.path}`, field: ref.field } };
  if (sizeBytes > limit.maxBytes) {
    return { issue: { code: 'media_too_large', message: `${ref.field} 太大了：${(sizeBytes / 1024 / 1024).toFixed(1)}MB，上限 ${Math.round(limit.maxBytes / 1024 / 1024)}MB：${ref.path}`, field: ref.field } };
  }
  const file: MediaFile = { ...ref, absPath: resolved.absPath, mimeType, sizeBytes, sha256: sha256File(resolved.absPath) };
  if (limit.kind === 'video') {
    const duration = readMp4DurationSeconds(resolved.absPath);
    if (duration !== undefined) file.durationSeconds = duration;
  }
  return file;
};

/** 读包：清单 + 白名单 + 全部素材的路径/类型/大小/哈希。不联网。 */
export const loadPackage = (dir: string): LoadedPackage => {
  const absDir = resolve(dir);
  if (!existsSync(absDir) || !lstatSync(absDir).isDirectory()) throw new CliError(EXIT.USAGE, 'package_not_found', `模板包目录不存在：${dir}`, { hint: '先运行 seewow template init <目录>。' });
  const pkgRealDir = realpathSync(absDir);
  const manifestPath = join(pkgRealDir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) throw new CliError(EXIT.VALIDATION, 'manifest_missing', `目录里没有 ${MANIFEST_FILE}：${dir}`, { hint: '先运行 seewow template init <目录>。' });
  const text = readFileSync(manifestPath, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new CliError(EXIT.VALIDATION, 'manifest_invalid', `${MANIFEST_FILE} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  const { manifest, issues } = parseManifest(raw);
  const media: MediaFile[] = [];
  for (const ref of collectMediaRefs(manifest)) {
    const inspected = inspectMedia(pkgRealDir, ref);
    if ('issue' in inspected) issues.push(inspected.issue);
    else media.push(inspected);
  }
  return { dir: pkgRealDir, manifest, manifestHash: sha256Text(canonicalJson(manifest)), media, issues };
};

/** 清单 → 草稿内容（TemplateSubmissionContent）；assetIdFor 把包内路径换成服务端素材 id（换不到给 null）。 */
export const buildContent = (manifest: Manifest, assetIdFor: (relPath: string) => string | null): TemplateSubmissionContent => {
  const content: TemplateSubmissionContent = {
    title: manifest.title,
    industryId: manifest.industryId,
    catalogIndustryId: manifest.catalogIndustryId,
    categoryId: manifest.categoryId,
    script: manifest.script,
    lines: manifest.lines.map((line) => ({ ...line })),
    // kind 不让填：服务端按 typeId 的字典条目写回；这里只为满足类型给个占位，发出去前删掉。
    slots: manifest.slots.map((slot) => ({
      label: slot.label,
      kind: 'prop',
      typeId: slot.typeId,
      replaceable: slot.replaceable,
      hint: slot.hint,
      assetId: slot.image ? assetIdFor(slot.image) : null,
    })),
    sampleVideoAssetId: manifest.sampleVideo ? assetIdFor(manifest.sampleVideo) : null,
    coverAssetId: manifest.cover ? assetIdFor(manifest.cover) : null,
    remark: manifest.remark,
  };
  return content;
};

/** 发给服务端的内容：去掉占位 kind（服务端按 typeId 写回）。 */
export const toWireContent = (content: TemplateSubmissionContent): Record<string, unknown> => ({
  ...content,
  slots: content.slots.map((slot) => {
    const copy: Record<string, unknown> = { ...slot };
    delete copy.kind;
    return copy;
  }),
});

export const contentHash = (content: TemplateSubmissionContent): string => sha256Text(canonicalJson(toWireContent(content)));

export const issuesFromValidation = (issues: TemplateSubmissionIssue[]): CliIssue[] => issues.map((issue) => ({ ...issue }));
