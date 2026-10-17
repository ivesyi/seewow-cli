/**
 * 伙伴模板投稿的校验规则 —— 唯一真源（2026-09-28 实施契约 §2，前后端共用同一份代码）。
 *
 * `validateTemplateSubmission(payload, ctx)` 在三处被调用，判定逐字一致：
 *   1. 用户端投稿编辑器实时提示（红 = errors，黄 = warnings）；
 *   2. 伙伴接口保存 / 提交（提交时 errors 必须为 0，否则 400 并列出）；
 *   3. 管理端批准（事务内重跑，errors 必须为 0）。
 *
 * 文件里还有一段「模板正文引号台词改写规则」（DIALOGUE_MARK / rewriteDialogueQuotes /
 * markUnquotedDialogue / rewriteCueQuotes …）：原先写在 scripts/ops/template-dialogue-quote-rules.ts，
 * 2026-09-28 抽到这里当唯一真源，那个运维脚本改为 import 本文件（不许出两份）。
 * 背景：cmu7yd8wy 字幕排查（deliverables/字幕排查-cmu7yd8wy/模板引号台词审计.md）——引号包住的
 * 台词、裸写的负面词清单、聊天 AI 残留都会让 Seedance 把字幕画进画面。
 *
 * 硬性约束（与 templateLines.ts / pricing.ts 同一套）：
 *   - **零 import**（含 type-only）：apps/ui 的生成物是整文件平铺复制，跨契约相对 import 解析不到。
 *     所以台词上限用到的 `allocateLineSeconds` / `lineMaxCharsForSeconds` / `countTemplateLineChars`
 *     在下面**手抄**了一份（`submissionAllocateLineSeconds` 等），与 templateLines.ts 逐字一致由
 *     test/templateSubmissionRules.test.mjs 断住。
 *   - 不使用 `@/` 路径别名；纯函数无副作用。
 *
 * ⚠️ 改本文件 = 必须在同一个 PR 里跑 `npm run gen:contracts` 并提交生成物。
 */

// ═══════════════════════════════════════════════════════════════════════════
// 一、模板正文「引号包台词 / 字幕暗示词」通用改写规则（原 scripts/ops/template-dialogue-quote-rules.ts）
// ═══════════════════════════════════════════════════════════════════════════
//
// 两类通用改写，按顺序执行（按模板定制的精确替换 TEMPLATE_CUSTOM_REWRITES 仍留在运维脚本里）：
//   1. 切镜时点引用台词原文（`说到“{{line2}}”时`）→ `说到第2句台词时`。
//   2. 台词引导语后的引号对去掉，引导语统一成 `XX（仅配音，不上屏）：台词`，台词后
//      紧跟动作描述就断到新行；原本不带引号的台词同样补标记（owner 2026-09-19 拍板）。
// 改写幂等（跑两遍结果不变）。

export const DIALOGUE_MARK = '（仅配音，不上屏）';
export const NO_ON_SCREEN_TEXT_SENTENCE = '画面中不要出现任何字幕、底部文字条、贴纸或水印。';

const QUOTE_CHARS = '“”"「」『』‘’';
const QUOTE_CLASS = '[“”"「」『』‘’]';
const NON_QUOTE_CLASS = '[^“”"「」『』‘’\\n]';
const isQuote = (ch: string | undefined): boolean => ch !== undefined && QUOTE_CHARS.includes(ch);

/**
 * 「这是一句台词的引导语」的判据：引导语所在分句里出现说话类动词 / 语气描述，或者引导语
 * 本身就是一个说话人槽位（`{{slot:s1}} ：“…”`）。判不出来的引号一律不动（例如
 * `做“克制”状`、`发出“咚咚咚”的声音` 这类非台词引号）。
 */
const SPEECH_HINT = /说|问|喊|答|道|讲|台词|对白|旁白|独白|画外音|吐槽|打趣|抱怨|嘶吼|口播|念|唱|语气|语速|颤音|叹气|吼|叫|开口/;

/**
 * 计划里按「引导语变体」分别计数用：分句里**最靠近冒号**的那个说话类关键词。
 * 顺序无关（取出现位置最靠后的），长词写在前面只是为了让同位置时优先认长词。
 */
const VARIANT_KEYWORDS = ['口型同步台词', '台词', '对白', '旁白', '独白', '画外音', '说道', '说', '道', '喊', '吼', '叫', '问', '答', '讲', '吐槽', '打趣', '抱怨', '口播', '开口'];

export const dialogueVariantOf = (clause: string, viaParen: boolean): string => {
  if (/\{\{slot:s\d+\}\}[ \t]*$/.test(clause)) return '说话人槽位：“…”';
  if (viaParen) return '（语气说明）“…”';
  if (/[)）][ \t]*$/.test(clause)) return '（语气说明）：“…”';
  let best = '';
  let bestAt = -1;
  for (const keyword of VARIANT_KEYWORDS) {
    const at = clause.lastIndexOf(keyword);
    if (at >= 0 && at + keyword.length > bestAt + best.length) { best = keyword; bestAt = at; }
  }
  return `${best || '其他引导语'}：“…”`;
};
const CLAUSE_BOUNDARIES = ['。', '！', '？', '!', '?', '；', ';', '\n'];

export type RewriteEditKind =
  | 'dialogue_placeholder' // 引号包住台词占位（审计 Q1）
  | 'dialogue_fixed' // 引号包住写死的台词（审计 Q2）
  | 'dialogue_unquoted' // 原本不带引号的台词，补标记（审计清单二，2026-09-19 owner 定统一）
  | 'cue_quote' // 切镜时点里引用台词原文（审计 Q4）
  | 'custom'; // 按模板定制（裸词清单 / 屏幕 UI 暗示 / AI 残留 / 个例）

export interface RewriteEdit {
  kind: RewriteEditKind;
  ruleId?: string;
  /** 台词类改写的引导语变体（说：“…” / 口型同步台词：“…” / 说话人槽位 …），计划按它分别计数。 */
  variant?: string;
  before: string;
  after: string;
  note?: string;
}

export interface TemplateLineRef {
  index: number;
  text?: string;
}

/** 去掉标点与空白后比较，用于把时点里写死的台词原文对应到第 N 句。 */
const normalizeForMatch = (value: string): string => value.replace(/[\s\p{P}\p{S}]/gu, '');

const CUE_REGEX = new RegExp(`说到[ \\t]*${QUOTE_CLASS}(${NON_QUOTE_CLASS}{1,160})${QUOTE_CLASS}(?=[ \\t]*时)`, 'g');

export const rewriteCueQuotes = (
  text: string,
  lines: readonly TemplateLineRef[] = [],
): { text: string; edits: RewriteEdit[]; warnings: string[] } => {
  const edits: RewriteEdit[] = [];
  const warnings: string[] = [];
  const next = text.replace(CUE_REGEX, (whole: string, body: string) => {
    const trimmed = body.trim();
    let indices: number[] | null = null;
    if (/^(\{\{line\d+\}\})+$/.test(trimmed)) {
      indices = [...trimmed.matchAll(/\{\{line(\d+)\}\}/g)].map((m) => Number(m[1]));
    } else if (!trimmed.includes('{{')) {
      const target = normalizeForMatch(trimmed);
      const hits = target.length >= 4
        ? lines.filter((line) => typeof line.text === 'string' && normalizeForMatch(line.text) === target)
        : [];
      if (hits.length === 1) indices = [hits[0].index];
    }
    if (!indices) {
      warnings.push(`切镜时点里的引文对不上任何一句台词，未改：${whole}`);
      return whole;
    }
    const after = `说到第${indices.join('、')}句台词`;
    edits.push({ kind: 'cue_quote', before: whole, after });
    return after;
  });
  return { text: next, edits, warnings };
};

/**
 * 通用：台词引导语后的引号对 → `引导语（仅配音，不上屏）：台词`。
 *
 * 开引号必须紧跟在「冒号（可隔空白/一个换行）」或「右括号（语气说明，如
 * `（语气突然拔高）“…”`）」之后，且引导语分句像在说话（SPEECH_HINT）或本身是说话人槽位；
 * 闭引号取同一行里的下一个引号字符（上游数据里 `”…“`、`“…“` 这类错配很常见，不区分方向）。
 */
export const rewriteDialogueQuotes = (text: string): { text: string; edits: RewriteEdit[]; warnings: string[] } => {
  const edits: RewriteEdit[] = [];
  const warnings: string[] = [];
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (!isQuote(ch)) {
      out += ch;
      i += 1;
      continue;
    }
    const colonIntro = out.match(/[：:][ \t]*\n?[ \t]*$/);
    const parenIntro = colonIntro ? null : out.match(/[)）][ \t]*$/);
    const intro = colonIntro ?? parenIntro;
    if (!intro) {
      out += ch;
      i += 1;
      continue;
    }
    // 引导语（不含冒号与其后空白；右括号保留）
    const introText = colonIntro ? out.slice(0, out.length - colonIntro[0].length) : out.replace(/[ \t]*$/, '');
    const boundaryAt = Math.max(...CLAUSE_BOUNDARIES.map((c) => introText.lastIndexOf(c)));
    const clause = introText.slice(boundaryAt + 1);
    const isSpeech = SPEECH_HINT.test(clause) || /\{\{slot:s\d+\}\}[ \t]*$/.test(introText);
    if (!isSpeech) {
      out += ch;
      i += 1;
      continue;
    }
    const lineEnd = text.indexOf('\n', i + 1) === -1 ? text.length : text.indexOf('\n', i + 1);
    let close = -1;
    for (let j = i + 1; j < lineEnd; j += 1) {
      if (isQuote(text[j])) { close = j; break; }
    }
    if (close < 0) {
      warnings.push(`台词开引号未闭合，未改：${text.slice(Math.max(0, i - 20), Math.min(text.length, i + 30))}`);
      out += ch;
      i += 1;
      continue;
    }
    const body = text.slice(i + 1, close);
    let cursor = close + 1;
    // 行尾多出来的孤立闭引号（上游 `{{line6}}””`）一并吞掉。
    const stray = text.slice(cursor, lineEnd).match(/^[“”"」』’]+(?=[ \t]*$)/);
    if (stray) cursor += stray[0].length;
    const rest = text.slice(cursor, lineEnd);

    let lead = introText.replace(/[ \t]+$/, '');
    if (/\}\}$/.test(lead)) lead += ' ';
    if (lead.endsWith('口型同步台词')) lead = lead.slice(0, -'台词'.length);
    // 已是新写法（引导语已带标记、只剩引号没去）就不重复加。
    const marked = lead.endsWith(DIALOGUE_MARK) ? lead : `${lead}${DIALOGUE_MARK}`;

    let tail = '';
    let consumedRest = 0;
    if (/^[ \t]*$/.test(rest)) {
      consumedRest = rest.length;
    } else if (/^[；;，,。.]+[ \t]*$/.test(rest)) {
      tail = rest.replace(/[ \t]+$/, '');
      consumedRest = rest.length;
    } else {
      // 台词后紧跟动作/镜头描述：断到新行，免得去掉引号后台词和描述粘在一起。
      const leadingWs = rest.match(/^[ \t]*/)![0].length;
      tail = '\n';
      consumedRest = leadingWs;
    }
    const replacement = `${marked}：${body}${tail}`;
    edits.push({
      kind: /\{\{line\d+\}\}/.test(body) ? 'dialogue_placeholder' : 'dialogue_fixed',
      variant: dialogueVariantOf(clause, Boolean(parenIntro)),
      // 从引导语所在分句开头截到闭引号（含被吞掉的空白），方便人工对照。
      before: out.slice(boundaryAt + 1) + text.slice(i, cursor + consumedRest),
      after: replacement.slice(boundaryAt + 1),
    });
    out = replacement;
    i = cursor + consumedRest;
  }
  return { text: out, edits, warnings };
};

const placeholders = (text: string, pattern: RegExp): string[] => [...text.matchAll(pattern)].map((m) => m[0]).sort();
const SLOT_OR_OTHER_PLACEHOLDER = /\{\{(?!line\d+\}\})[^{}]*\}\}/g;
export const LINE_PLACEHOLDER = /\{\{line\d+\}\}/g;

/**
 * 占位符守恒：素材槽等非台词占位符的多重集合必须逐个相同；台词占位符的**集合**必须相同
 * （每句台词至少还被引用一次——否则 editable 的那句客户改了也不进 prompt），且多重集合
 * 只允许少掉「切镜时点」改写里被换成「第N句台词」的那几个，一个不多一个不少。
 */
export const assertPlaceholdersPreserved = (before: string, after: string, cueRemoved: readonly string[], code: string): void => {
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  if (!same(placeholders(before, SLOT_OR_OTHER_PLACEHOLDER), placeholders(after, SLOT_OR_OTHER_PLACEHOLDER))) {
    throw new Error(`${code}: 改写改动了素材槽占位符（{{slot:sN}}），拒绝。`);
  }
  const beforeLines = placeholders(before, LINE_PLACEHOLDER);
  const afterLines = placeholders(after, LINE_PLACEHOLDER);
  if (!same([...new Set(beforeLines)], [...new Set(afterLines)])) {
    throw new Error(`${code}: 改写后有台词占位符不再被引用（或多出了新的），拒绝。`);
  }
  if (!same([...afterLines, ...cueRemoved].sort(), beforeLines)) {
    throw new Error(`${code}: 台词占位符的增减与切镜时点改写对不上，拒绝。`);
  }
};

/** 改写后仍残留的「引号贴着台词占位」「冒号后跟引号」——给人看，不自动改。 */
export const residualQuoteWarnings = (text: string): string[] => {
  const warnings: string[] = [];
  const nearLine = new RegExp(`${QUOTE_CLASS}\\{\\{line\\d+\\}\\}|\\{\\{line\\d+\\}\\}${QUOTE_CLASS}`, 'g');
  for (const m of text.matchAll(nearLine)) warnings.push(`仍有引号贴着台词占位：${text.slice(Math.max(0, m.index! - 15), m.index! + m[0].length + 15)}`);
  return warnings;
};

/**
 * 通用：原本不带引号的台词补标记。两种引导形态，后面必须**紧跟台词占位**（`{{lineK}}` 一个或连续几个）：
 *   - 冒号：`台词：{{line1}}`、`{{slot:s2}} ：{{line1}}`、`（皱眉恼火）：⏎{{line2}}`（冒号后可隔空白/一个换行）；
 *   - 括号语气后直接接台词：`博主（严厉质问） {{line1}}`。
 * 台词占位只会是台词，所以「冒号/语气括号 + 占位」不需要再判说话类动词；占位前没有这两种引导的
 * （如 `站在{{slot:s3}} {{line1}}车头前` 把台词当场景描述）一律不动、只提示。
 * 冒号后先接写死文字再接占位的（`：对呀！心动？！{{line6}}`）判不出台词边界，走按模板定制。
 */
export const markUnquotedDialogue = (text: string): { text: string; edits: RewriteEdit[]; warnings: string[] } => {
  const edits: RewriteEdit[] = [];
  const warnings: string[] = [];
  let out = '';
  let pos = 0;
  for (const m of text.matchAll(/(?:[：:]|([)）]))[ \t]*\n?[ \t]*((?:\{\{line\d+\}\})+)/g)) {
    const at = m.index!;
    if (at < pos) continue;
    const introEnd = m[1] ? at + 1 : at;
    if (text.slice(0, introEnd).endsWith(DIALOGUE_MARK)) continue;
    const bodyEnd = at + m[0].length;
    const body = m[2];
    const lineEnd = text.indexOf('\n', bodyEnd) === -1 ? text.length : text.indexOf('\n', bodyEnd);
    const rest = text.slice(bodyEnd, lineEnd);
    let tail = '';
    let consumed = 0;
    if (/^[ \t]*$/.test(rest)) {
      consumed = rest.length;
    } else if (/^[；;，,。.！!？?]+[ \t]*$/.test(rest)) {
      tail = rest.replace(/[ \t]+$/, '');
      consumed = rest.length;
    } else if (/^[，,、]/.test(rest)) {
      // 台词后接逗号还在往下说，边界判不出：不断行，原样接上并提示。
      warnings.push(`无引号台词后紧跟逗号，未断行：${text.slice(Math.max(0, at - 15), Math.min(lineEnd, bodyEnd + 20))}`);
    } else {
      tail = '\n';
      consumed = rest.match(/^[ \t]*/)![0].length;
    }
    let lead = text.slice(pos, introEnd).replace(/[ \t]+$/, '');
    if (/\}\}$/.test(lead)) lead += ' ';
    const leadInText = text.slice(0, introEnd).replace(/[ \t]+$/, '');
    // 分句从上一个句读/换行算起，但不越过上一处改写（同一行里前一句台词已断行）。
    const clauseStart = Math.max(pos, 1 + Math.max(...CLAUSE_BOUNDARIES.map((c) => leadInText.lastIndexOf(c))));
    const clause = leadInText.slice(clauseStart);
    const replacement = `${lead}${DIALOGUE_MARK}：${body}${tail}`;
    const quotedVariant = dialogueVariantOf(clause, Boolean(m[1]));
    edits.push({
      kind: 'dialogue_unquoted',
      variant: `${quotedVariant.replace('“…”', '…')}（原无引号）`,
      before: text.slice(clauseStart, bodyEnd + consumed),
      after: `${clause}${clause.endsWith('}}') ? ' ' : ''}${DIALOGUE_MARK}：${body}${tail}`,
    });
    out += replacement;
    pos = bodyEnd + consumed;
  }
  return { text: out + text.slice(pos), edits, warnings };
};

/**
 * 改写后仍没落在「（仅配音，不上屏）：…」同一行里的台词占位——要么是规则判不出的写法，要么是
 * 把台词当场景描述用（`站在{{slot:s3}} {{line1}}车头前`），列出来给人看。
 */
export const unmarkedLineWarnings = (text: string): string[] => {
  const unmarked: string[] = [];
  for (const m of text.matchAll(/\{\{line\d+\}\}/g)) {
    const before = text.slice(0, m.index!);
    if (before.lastIndexOf(DIALOGUE_MARK) > before.lastIndexOf('\n')) continue;
    unmarked.push(text.slice(Math.max(0, m.index! - 15), m.index! + m[0].length + 8).replace(/\n/g, '⏎'));
  }
  return unmarked.length ? [`仍有 ${unmarked.length} 处台词占位没落在「${DIALOGUE_MARK}」标记行里：${unmarked.join('；')}`] : [];
};

/** 仍保留的引号片段（非台词引号，如 `做“克制”状`），列进计划供人工复核。 */
export const listRemainingQuotes = (text: string): string[] => {
  const found: string[] = [];
  for (const m of text.matchAll(new RegExp(`${QUOTE_CLASS}${NON_QUOTE_CLASS}{0,30}${QUOTE_CLASS}`, 'g'))) {
    found.push(text.slice(Math.max(0, m.index! - 8), m.index! + m[0].length + 4));
  }
  return found;
};

// ═══════════════════════════════════════════════════════════════════════════
// 二、台词字数上限（手抄 templateLines.ts 的同名口径；零 import 逼出来的，测试断住逐字一致）
// ═══════════════════════════════════════════════════════════════════════════

/** = templateLines.ts::TEMPLATE_LINE_CHARS_PER_SECOND。 */
export const SUBMISSION_LINE_CHARS_PER_SECOND = 4;

/** = templateLines.ts::lineMaxCharsForSeconds。 */
export const submissionLineMaxCharsForSeconds = (seconds: number): number =>
  Math.ceil(seconds * SUBMISSION_LINE_CHARS_PER_SECOND);

/** = templateLines.ts::countTemplateLineChars（先 trim、按码点数）。 */
export const countSubmissionChars = (text: string): number => Array.from(text.trim()).length;

/** = templateLines.ts::allocateLineSeconds（逐字手抄，改一边必须改另一边）。 */
export const submissionAllocateLineSeconds = (lines: string[], totalSeconds: number): number[] => {
  const count = lines.length;
  if (count === 0) return [];

  const total = Math.round(totalSeconds);
  if (total <= count) {
    const flat: number[] = [];
    for (let i = 0; i < count; i += 1) flat.push(1);
    return flat;
  }

  const weights = lines.map((line) => Math.max(1, countSubmissionChars(line)));
  let weightSum = 0;
  for (const weight of weights) weightSum += weight;

  const remaining = total - count;
  const shares = weights.map((weight) => (remaining * weight) / weightSum);
  const floors = shares.map((share) => Math.floor(share));
  let assigned = 0;
  for (const value of floors) assigned += value;

  let leftover = remaining - assigned;
  const order: number[] = [];
  for (let i = 0; i < count; i += 1) order.push(i);
  order.sort((left, right) => {
    const diff = shares[right] - Math.floor(shares[right]) - (shares[left] - Math.floor(shares[left]));
    if (diff !== 0) return diff;
    return left - right;
  });
  const bonus: number[] = [];
  for (let i = 0; i < count; i += 1) bonus.push(0);
  for (let i = 0; i < order.length && leftover > 0; i += 1) {
    bonus[order[i]] = 1;
    leftover -= 1;
  }

  return floors.map((value, index) => 1 + value + bonus[index]);
};

/** 还不知道时长（没传样片）时按 15 秒算上限。 */
export const TEMPLATE_SUBMISSION_FALLBACK_DURATION_SECONDS = 15;

/**
 * 每句台词的字数上限 = max(原句字数, 按字数比例分到的秒数 × 4)（owner 9-28 拍板，与线上
 * build_payloads.py 的 max_chars、导入脚本同一口径）。顺序与 `lines` 一致。
 */
export const templateSubmissionLineMaxChars = (lines: string[], durationSeconds?: number | null): number[] => {
  const seconds = typeof durationSeconds === 'number' && isFinite(durationSeconds) && durationSeconds > 0
    ? durationSeconds : TEMPLATE_SUBMISSION_FALLBACK_DURATION_SECONDS;
  const allocated = submissionAllocateLineSeconds(lines, seconds);
  return lines.map((line, index) => Math.max(countSubmissionChars(line), submissionLineMaxCharsForSeconds(allocated[index])));
};

// ═══════════════════════════════════════════════════════════════════════════
// 三、投稿内容与接口形状（伙伴端 / 管理端共用）
// ═══════════════════════════════════════════════════════════════════════════

export const TEMPLATE_SUBMISSION_SLOT_KINDS = ['person', 'scene', 'car', 'car_interior', 'prop'] as const;
export type TemplateSubmissionSlotKind = (typeof TEMPLATE_SUBMISSION_SLOT_KINDS)[number];
export const TEMPLATE_SUBMISSION_SLOT_KIND_LABELS: Record<TemplateSubmissionSlotKind, string> = {
  person: '人物', scene: '场景', car: '汽车', car_interior: '内饰', prop: '道具',
};

export const TEMPLATE_SUBMISSION_TITLE_MAX = 40;
export const TEMPLATE_SUBMISSION_LABEL_MAX = 20;
export const TEMPLATE_SUBMISSION_MAX_SLOTS = 9;
export const TEMPLATE_SUBMISSION_MAX_LINES = 60;
export const TEMPLATE_SUBMISSION_LINE_TEXT_MAX = 200;
export const TEMPLATE_SUBMISSION_SPEAKER_MAX = 60;
export const TEMPLATE_SUBMISSION_HINT_MAX = 300;
export const TEMPLATE_SUBMISSION_SCRIPT_MAX = 30000;
export const TEMPLATE_SUBMISSION_REMARK_MAX = 500;

export type TemplateSubmissionSlot = {
  label: string;
  /** 底层行为枚举。v2 起由服务端按所选类型（typeId）的字典条目写回，伙伴端只看类型。 */
  kind: TemplateSubmissionSlotKind;
  /**
   * 素材类型（行业字典条目 id，如 `auto.car`、`auto.c_ab12cd34`）。服务端返回时总是带（null = 没选且
   * 按「行业 + kind」也兜底不出）；请求体里可不带（旧前端），服务端按兜底规整。
   */
  typeId?: string | null;
  replaceable: boolean;
  hint: string;
  /** 默认图（伙伴上传的 SystemAsset id）；null = 还没传。 */
  assetId: string | null;
};
export type TemplateSubmissionLine = {
  text: string;
  speaker?: string;
  /** 客户可填字数；缺省兼容旧自动算法。显式设置必须为 1–200 的整数，不随原文增长。 */
  maxChars?: number;
};

/** 伙伴可编辑的全部内容（契约 §4）。台词序号 = 数组下标 + 1，对应脚本里的【台词：N】。 */
export type TemplateSubmissionContent = {
  catalogIndustryId?: string | null;
  categoryId?: string | null;
  title: string;
  /** 只能是伙伴名下行业；默认第一个。 */
  industryId: string;
  /** 【素材：label】/【台词：N】语法。 */
  script: string;
  lines: TemplateSubmissionLine[];
  slots: TemplateSubmissionSlot[];
  sampleVideoAssetId: string | null;
  coverAssetId: string | null;
  /** 给审核的备注。 */
  remark?: string;
};

export const emptyTemplateSubmissionContent = (industryId = ''): TemplateSubmissionContent => ({
  title: '', industryId, catalogIndustryId: null, categoryId: null, script: '', lines: [], slots: [], sampleVideoAssetId: null, coverAssetId: null, remark: '',
});

/**
 * `retired`（v2）：模板被平台彻底删除后，已上架投稿与未结修改稿进入此态；终态只读，
 * 只能「基于它重新投稿」（clone）或删除。下架（enabled=false）不算下线。
 */
export type TemplateSubmissionStatus = 'draft' | 'pending' | 'rejected' | 'approved' | 'superseded' | 'retired';
/** 伙伴侧状态标签（owner 9-28：伙伴侧叫「我的投稿」，不做「作者」语义）。 */
export const TEMPLATE_SUBMISSION_STATUS_LABELS: Record<TemplateSubmissionStatus, string> = {
  draft: '草稿', pending: '审核中', rejected: '已驳回', approved: '已上架', superseded: '已被新版本替换', retired: '已下线',
};

/** 伙伴投稿接口路径（v2 起新接口的路径常量；老路径前端各自有常量，不强制迁）。 */
export const TEMPLATE_SUBMISSIONS_API = '/api/partners/template-submissions';
/** GET：伙伴名下行业 + 素材类型字典（TemplateSubmissionOptions，见 templateSlotTypes.ts）。 */
export const TEMPLATE_SUBMISSION_OPTIONS_API = `${TEMPLATE_SUBMISSIONS_API}/options`;
/** POST：基于已下线的投稿重新投稿 → 201 TemplateSubmissionDetail（新草稿）。 */
export const submissionClonePath = (id: string): string => `${TEMPLATE_SUBMISSIONS_API}/${encodeURIComponent(id)}/clone`;

/** 已下线 / 旧版本被删时给伙伴看的默认说明（服务端写 retiredReason 用，前端兜底文案用）。 */
export const TEMPLATE_SUBMISSION_RETIRED_REASON = '平台已删除这条模板。';
export const TEMPLATE_SUBMISSION_REVISION_CLOSED_REASON = '对应的线上模板已被平台删除，这份修改已关闭。';
export const TEMPLATE_SUBMISSION_RETIRED_LOCKED_MESSAGE = '这条模板已下线，不能再修改；可以点「基于它重新投稿」。';

/** 被删模板的快照（删除前留的；存量补登的为 null，前端用投稿标题兜底）。 */
export type TemplateSubmissionRetiredTemplate = { id: string; code: string; title: string };

export type TemplateSubmissionIssue = { code: string; message: string; field?: string };

export type TemplateSubmissionValidation = {
  errors: TemplateSubmissionIssue[];
  warnings: TemplateSubmissionIssue[];
  /** 自动修正后的脚本（幂等）；与 script 相同表示没有可修正的地方。 */
  normalizedScript: string;
  /** 每句台词的有效字数上限，顺序同 lines。 */
  lineMaxChars: number[];
  /** 全视频时长按台词字数权重 × 4 字/秒的自动参考；不解析脚本时码。 */
  lineRecommendedMaxChars: number[];
};

export type TemplateSubmissionMedia = { url: string; kind: 'image' | 'video'; mimeType: string };

export type TemplateSubmissionTestRunSummary = {
  runId: string; status: string; createdAt: string; contentRevision: number; videoUrl: string | null;
  /** videoUrl 是哪种产物：final_video = 成片；generated_clip = 未合成的原片（合成没成时兜底）。没视频时不带。 */
  videoKind?: 'final_video' | 'generated_clip';
};

export type TemplateSubmissionSummary = {
  id: string;
  title: string;
  status: TemplateSubmissionStatus;
  rejectReason: string | null;
  liveTemplateId: string | null;
  revisionOfId: string | null;
  coverUrl: string | null;
  updatedAt: string;
  submittedAt: string | null;
  /** 已下线时间（retired；以及 superseded 且对应模板已被删时也有）。 */
  retiredAt: string | null;
  /** 伙伴可见的下线说明。 */
  retiredReason: string | null;
  /** 「基于它重新投稿」的来源投稿 id。 */
  clonedFromId: string | null;
};

/** 伙伴端 / 审核页下拉用的素材类型（= templateSlotTypes.ts::TemplateSlotTypeOption，零 import 手抄，测试锁）。 */
export type TemplateSubmissionSlotTypeOption = {
  id: string;
  industryId: string;
  label: string;
  example: string;
  baseKind: 'person' | 'reference';
  enabled: boolean;
  sortOrder: number;
};

export type TemplateSubmissionDetail = {
  id: string;
  status: TemplateSubmissionStatus;
  content: TemplateSubmissionContent;
  /** content 里引用到的全部素材（默认图、样片、封面），按 assetId 查。 */
  media: Record<string, TemplateSubmissionMedia>;
  validation: { errors: TemplateSubmissionIssue[]; warnings: TemplateSubmissionIssue[] };
  normalizedScript: string;
  lineMaxChars: number[];
  lineRecommendedMaxChars: number[];
  /** 试跑一次要扣的积分（算法价，按后台默认配置）。 */
  testCredits: number;
  rejectReason: string | null;
  liveTemplateId: string | null;
  revisionOfId: string | null;
  /** 乐观锁：PUT / submit / withdraw 带回来。 */
  version: number;
  testRuns: TemplateSubmissionTestRunSummary[];
  sampleDurationSeconds: number | null;
  contentRevision: number;
  submittedAt: string | null;
  updatedAt: string;
  retiredAt: string | null;
  retiredReason: string | null;
  clonedFromId: string | null;
  retiredTemplate: TemplateSubmissionRetiredTemplate | null;
  /** 当前 content.industryId 的全部字典条目（含停用项；停用项只用于显示名字与标红）。 */
  slotTypes: TemplateSubmissionSlotTypeOption[];
  /** 修改稿对应线上模板里已在用的类型 id：即使已停用也算可选。新投稿为 []。 */
  grandfatheredSlotTypeIds: string[];
};

/** PUT /api/partners/template-submissions/:id 的请求体。 */
export type TemplateSubmissionSaveInput = {
  version: number;
  content: TemplateSubmissionContent;
  /** 可不传；服务端一律以样片上传时 ffprobe 读出的时长为准（忽略这个值）。 */
  sampleDurationSeconds?: number | null;
};

/** POST /api/partners/template-submissions/media/upload-intents */
export type TemplateSubmissionUploadIntentInput = { fileName: string; mimeType: string; sizeBytes: number; sha256?: string };
export type TemplateSubmissionUploadIntent = {
  /** 浏览器用 PUT 把原始字节传到这里（可能是同源地址，也可能是对象存储预签名地址）。 */
  uploadUrl: string;
  /** PUT 时原样带上的请求头。 */
  headers: Record<string, string>;
  intentId: string;
};
export type TemplateSubmissionUploadedMedia = {
  assetId: string; url: string; kind: 'image' | 'video'; mimeType: string;
  /** 视频才有：服务端 ffprobe 读出的时长（秒）。 */
  durationSeconds?: number;
};

/** 伙伴上传素材的格式与大小上限（服务端 /media/complete 以此为准）。视频 50MB：生产经 newapi 转发约 180KB/s × nginx 300s 超时 ≈ 54MB 实际上限。 */
export const TEMPLATE_SUBMISSION_MEDIA_LIMITS: Record<string, { kind: 'image' | 'video'; maxBytes: number }> = {
  'image/jpeg': { kind: 'image', maxBytes: 15 * 1024 * 1024 },
  'image/png': { kind: 'image', maxBytes: 15 * 1024 * 1024 },
  'image/webp': { kind: 'image', maxBytes: 15 * 1024 * 1024 },
  'video/mp4': { kind: 'video', maxBytes: 50 * 1024 * 1024 },
  'video/quicktime': { kind: 'video', maxBytes: 50 * 1024 * 1024 },
};

// ── 管理端 ────────────────────────────────────────────────────────────────

/** 投稿主人（seewow CLI 方案 §3.2）：partner = 伙伴投稿；platform = 平台自营草稿（运营经 CLI 上传）。 */
export type TemplateSubmissionOwnerKind = 'partner' | 'platform';
/** 管理端审核页的主人信息：平台自营显示为「平台自营 · 提交人 XX · 来自 CLI」。 */
export type AdminTemplateSubmissionOwnerInfo = {
  ownerKind: TemplateSubmissionOwnerKind;
  /** 提交人（最后提交审核的账号）显示名；查不到为 null。 */
  submittedByName: string | null;
  /** 平台自营草稿只能经 CLI 创建 → true；伙伴投稿 → false。 */
  fromCli: boolean;
  /** 平台自营且提交人/创建人 = 当前登录的审核人：批准必须带 confirmSelfApproval: true（服务端强制，缺则 409 self_approval_confirmation_required）。 */
  selfSubmitted: boolean;
};
/** partnerName：伙伴投稿 = 伙伴名；平台自营 = 「平台自营」。 */
export type AdminTemplateSubmissionSummary = TemplateSubmissionSummary & AdminTemplateSubmissionOwnerInfo & { partnerName: string; isRevision: boolean };
/**
 * GET /api/admin/template-submissions[?status=]：不带 status = 全部非草稿（pending/rejected/approved/superseded），
 * 草稿对管理端永不出现；带 status 按值过滤（status=draft 返回空）。pendingCount 始终返回。
 */
export type AdminTemplateSubmissionList = { items: AdminTemplateSubmissionSummary[]; pendingCount: number };

export type TemplateSubmissionConfigOptions = {
  models: { videoModel: string; label: string; resolutions: string[]; maxDurationSeconds: number }[];
  aspectRatios: string[];
};

/** 修改稿审核时给运营逐字段对比的线上版摘要（脚本已还原成【素材】/【台词】写法）。 */
export type TemplateSubmissionLiveSummary = {
  catalogIndustryId?: string | null;
  categoryId?: string | null;
  catalogIndustryName?: string | null;
  catalogIndustrySortOrder?: number;
  categoryName?: string | null;
  version?: number;
  updatedAt?: string;
  id: string;
  code: string;
  title: string;
  enabled: boolean;
  industryId: string;
  category: string;
  sortOrder: number;
  fixedCredits: number;
  subtitleEnabled: boolean;
  config: { videoModel: string; videoResolution: string; aspectRatio: string; durationSeconds: number };
  /** 线上模板带深度视频输入（算法价按「含输入视频」档、输入秒数计入 token）。 */
  hasDepthVideo: boolean;
  /** 线上模板深度视频的时长（秒）；没有深度视频或查不到时长 → null（查不到时算不出价，不许批准）。 */
  depthVideoSeconds?: number | null;
  script: string;
  lines: TemplateSubmissionLine[];
  slots: { label: string; kind: string; typeId: string | null; typeLabel: string | null; replaceable: boolean; hint: string; defaultUrl: string | null }[];
  coverUrl: string;
  sampleVideoUrl: string | null;
};

/**
 * 运营批准时改行业的素材类型重映射（v2，主会话 9-28 定：与伙伴端默认 a 同口径）：服务端在批准事务里用契约
 * templateSlotTypes.ts::remapSlotTypesOnIndustryChange 按「同名 **且** 同归属」把每个槽的 typeId 对到目标行业的
 * 启用条目；对不上的（matched=false）批准 400，列出是哪些素材。行业没变时 from = to。
 */
export type TemplateSubmissionSlotTypeRemapItem = {
  /** 槽在 content.slots 里的下标。 */
  index: number;
  label: string;
  fromTypeId: string | null;
  fromTypeLabel: string | null;
  /** 目标行业里对上的条目；对不上为 null。 */
  toTypeId: string | null;
  toTypeLabel: string | null;
  matched: boolean;
};
/** 某个目标行业下整份投稿的重映射预览（ok = 全部对得上）。 */
export type TemplateSubmissionIndustryRemap = {
  industryId: string;
  industryName: string;
  ok: boolean;
  slots: TemplateSubmissionSlotTypeRemapItem[];
};

export type AdminTemplateSubmissionDetail = TemplateSubmissionDetail & AdminTemplateSubmissionOwnerInfo & {
  partnerName: string;
  internalNote: string | null;
  /** 批准表单每个可选行业（全部启用行业，含投稿当前行业）的素材类型重映射预览，供运营改行业时即时展示。 */
  industryRemaps: TemplateSubmissionIndustryRemap[];
  /** 新投稿：按样片时长算的默认配置；修改稿：线上当前 params 的四项。 */
  defaultConfig: { videoModel: string; videoResolution: string; aspectRatio: string; durationSeconds: number };
  configOptions: TemplateSubmissionConfigOptions;
  liveTemplate?: TemplateSubmissionLiveSummary;
  suggestedSortOrder: number;
};

export type TemplateSubmissionApproveInput = {
  catalogIndustryId?: string | null;
  categoryId?: string | null;
  expectedLiveVersion?: number;
  expectedLiveUpdatedAt?: string;
  version: number;
  /** 审核最终上限；缺省使用投稿设置/旧算法。给出时必须与台词句数一致，每项 1–200 整数。 */
  lineMaxChars?: number[];
  config: { videoModel: string; videoResolution: string; aspectRatio: string; durationSeconds: number };
  category: string;
  industryId: string;
  sortOrder: number;
  subtitleEnabled: boolean;
  /** 批准自己提交的平台自营稿时必须为 true（二次确认，服务端强制）。 */
  confirmSelfApproval?: boolean;
};
export type TemplateSubmissionApproveResult = {
  templateId: string; code: string; fixedCredits: number;
  /** 批准时每个槽的素材类型重映射结果（行业没变时 from = to）。 */
  slotTypeRemap: TemplateSubmissionSlotTypeRemapItem[];
};
export type TemplateSubmissionRejectInput = { version: number; reason: string; internalNote?: string };

// ═══════════════════════════════════════════════════════════════════════════
// 四、脚本引用解析、自动修正与校验
// ═══════════════════════════════════════════════════════════════════════════

/** 脚本里的素材引用 `【素材：label】`（全角/半角冒号都认）。 */
export const createSubmissionSlotReferenceRegex = (): RegExp => /【素材[:：]([^【】]+)】/g;
/** 脚本里的台词引用 `【台词：N】`。 */
export const createSubmissionLineReferenceRegex = (): RegExp => /【台词[:：](\d+)】/g;

export const formatSlotReference = (label: string): string => `【素材：${label}】`;
export const formatLineReference = (index: number): string => `【台词：${index}】`;

export type TemplateScriptReferences = {
  /** 按出现顺序，含重复。 */
  slotLabels: string[];
  lineIndexes: number[];
  /** 有不完整的引用（如缺右括号、【台词：abc】）。 */
  incomplete: boolean;
};

export const parseTemplateScriptReferences = (script: string): TemplateScriptReferences => {
  const slotLabels: string[] = [];
  const lineIndexes: number[] = [];
  const slotRegex = createSubmissionSlotReferenceRegex();
  let match = slotRegex.exec(script);
  while (match !== null) {
    slotLabels.push(match[1].trim());
    match = slotRegex.exec(script);
  }
  const lineRegex = createSubmissionLineReferenceRegex();
  match = lineRegex.exec(script);
  while (match !== null) {
    lineIndexes.push(Number(match[1]));
    match = lineRegex.exec(script);
  }
  const rest = script.replace(createSubmissionSlotReferenceRegex(), '').replace(createSubmissionLineReferenceRegex(), '');
  return { slotLabels, lineIndexes, incomplete: /【(?:素材|台词)[:：]/.test(rest) };
};

/**
 * 引用后面紧跟非空白字符时补一个空格（对抗审 G3：`【素材：X】的` 会粘成 `@Image1的`）。
 * 只动【素材】/【台词】引用的右括号，别的【…】不碰；已有空白不再补 → 幂等。
 */
export const insertReferenceSpacing = (script: string): string =>
  script.replace(/(【(?:素材|台词)[:：][^【】]*】)(?=[^\s])/g, '$1 ');

/**
 * 自动修正（幂等）：
 *   1. 引号包住的 `「【台词：N】」` / 切镜时点里的台词引文，按上面的通用改写规则改成线上写法
 *      `XX（仅配音，不上屏）：【台词：N】`；
 *   2. 引用后面紧跟非空白字符时补一个空格。
 * 脚本里若本来就有 `{{`/`}}`（校验会报错），第 1 步跳过（占位符往返会串）。
 */
export const normalizeTemplateSubmissionScript = (script: string, lines: TemplateSubmissionLine[] = []): string => {
  if (typeof script !== 'string' || !script) return '';
  if (/\{\{|\}\}/.test(script)) return insertReferenceSpacing(script);
  const labels: string[] = [];
  const placeholderText = script
    .replace(createSubmissionSlotReferenceRegex(), (_whole: string, label: string) => {
      const key = label.trim();
      let index = labels.indexOf(key);
      if (index < 0) { labels.push(key); index = labels.length - 1; }
      return `{{slot:s${index + 1}}}`;
    })
    .replace(createSubmissionLineReferenceRegex(), (_whole: string, index: string) => `{{line${Number(index)}}}`);
  let rewritten = placeholderText;
  try {
    const refs: TemplateLineRef[] = lines.map((line, index) => ({ index: index + 1, text: line.text }));
    const cue = rewriteCueQuotes(placeholderText, refs);
    const dialogue = rewriteDialogueQuotes(cue.text);
    rewritten = markUnquotedDialogue(dialogue.text).text;
  } catch (_error) {
    rewritten = placeholderText;
  }
  const back = rewritten
    .replace(/\{\{slot:s(\d+)\}\}/g, (_whole: string, index: string) => formatSlotReference(labels[Number(index) - 1]))
    .replace(/\{\{line(\d+)\}\}/g, (_whole: string, index: string) => formatLineReference(Number(index)));
  return insertReferenceSpacing(back);
};

/** 聊天 AI / 飞书粘贴残留：出现即硬拦（Seedance 没有负面通道，这些字全进正向提示词）。 */
export const TEMPLATE_SUBMISSION_AI_RESIDUE_MARKERS: string[] = [
  '负向词：', '负向词:', '负面词：', '负面词:', '复制粘贴', '精简短版', '纯粘贴版', '需要我帮你', '我建议直接把提示词改成',
];
/** 负面提示词清单写法：只提醒（改成「画面中不要出现……」的明确禁止句更稳）。 */
export const TEMPLATE_SUBMISSION_NEGATIVE_LIST_MARKERS: string[] = ['负向提示词', '负面提示词', '负面规避词'];

/** 台词里容易被配音读错的字（可扩展）。 */
export const TEMPLATE_SUBMISSION_MISREAD_CHARS: { char: string; advice: string }[] = [
  { char: '悬', advice: '「悬」容易被配音读错（如「悬架」读成「环架」），建议换个说法，比如「底盘」。' },
];

/** = templateSlotTypes.ts::AUTO_INDUSTRY_ID（手抄）。「写死车身颜色」提醒只对汽车行业出。 */
export const TEMPLATE_SUBMISSION_AUTO_INDUSTRY_ID = 'auto';
const CAR_COLOR_PATTERN = /(?:[白黑红蓝银灰金绿黄紫橙棕粉]色|香槟色|珍珠白|曜石黑|宝石蓝|哑光黑|亮黑)的?[ \t]*(?:车身|车漆|轮毂|轮圈|SUV|suv|轿车|汽车|跑车|MPV|mpv|皮卡|车)/g;
const TEXT_ON_SCREEN_PATTERN = /字幕|文字/;
const NEGATION_PATTERN = /禁止|不要|不得|不能|不许|不出现|不可|无|没有|避免|去掉|别/;
const SENTENCE_SPLIT = /[。！？!?；;\n]/;
const REPEAT_MIN_CHARS = 20;

const snippet = (text: string, at: number, length: number): string =>
  text.slice(Math.max(0, at - 6), Math.min(text.length, at + length + 6)).replace(/\n/g, ' ');

/** 校验用的素材类型最小结构（TemplateSubmissionSlotTypeOption 的子集）。 */
export type TemplateSubmissionValidationSlotType = { id: string; industryId: string; label: string; baseKind: 'person' | 'reference'; enabled: boolean };

export type TemplateSubmissionValidationContext = {
  /** 出片时长（秒）：决定台词上限与「句数不能多于秒数」。没传按 15 秒。 */
  durationSeconds?: number | null;
  /** 按哪个行业判类型、判车身颜色提醒。没传取 content.industryId。 */
  industryId?: string;
  /** 行业名（错误文案用）。没传用 industryId。 */
  industryName?: string;
  /**
   * 素材类型字典（至少含 industryId 行业的全部条目，含停用项；给全量也行）。
   * 给了 → 按字典判 slot_type_*；**没给 → 退回旧的五值 kind 检查（仅为兼容；服务端所有调用点必须给）**。
   */
  slotTypes?: TemplateSubmissionValidationSlotType[];
  /** 修改稿对应线上模板里已在用的类型 id：停用了也放行。 */
  grandfatheredSlotTypeIds?: string[];
};

/** = templateSlotTypes.ts::resolveSlotTypeId（零 import 手抄，测试断住逐字一致）。 */
export const submissionResolveSlotTypeId = (
  slot: { typeId?: string | null; kind?: string | null },
  industryId: string,
  types: ReadonlyArray<{ id: string }>,
): string | null => {
  if (slot && typeof slot.typeId === 'string' && slot.typeId) return slot.typeId;
  if (!slot || typeof slot.kind !== 'string' || !slot.kind || !industryId) return null;
  const legacy = `${industryId}.${slot.kind}`;
  for (const type of types) if (type.id === legacy) return legacy;
  return null;
};

/**
 * 投稿校验（契约 §2）。**保存永远不因 errors 失败**，只有提交 / 批准要求 errors 为 0。
 * 入参是伙伴端原样的 content（可能残缺，函数对任何形状都不抛异常）。
 */
export const validateTemplateSubmission = (
  payload: Partial<TemplateSubmissionContent> | null | undefined,
  ctx: TemplateSubmissionValidationContext = {},
): TemplateSubmissionValidation => {
  const errors: TemplateSubmissionIssue[] = [];
  const warnings: TemplateSubmissionIssue[] = [];
  const error = (code: string, message: string, field?: string) => { errors.push(field ? { code, message, field } : { code, message }); };
  const warn = (code: string, message: string, field?: string) => { warnings.push(field ? { code, message, field } : { code, message }); };
  const content = payload && typeof payload === 'object' ? payload : {};
  const industryId = typeof ctx.industryId === 'string' && ctx.industryId ? ctx.industryId : typeof content.industryId === 'string' ? content.industryId.trim() : '';
  const industryName = typeof ctx.industryName === 'string' && ctx.industryName ? ctx.industryName : industryId;
  const slotTypes = Array.isArray(ctx.slotTypes) ? ctx.slotTypes : null;
  const grandfathered = Array.isArray(ctx.grandfatheredSlotTypeIds) ? ctx.grandfatheredSlotTypeIds : [];
  const title = typeof content.title === 'string' ? content.title.trim() : '';
  const script = typeof content.script === 'string' ? content.script : '';
  const lines: TemplateSubmissionLine[] = Array.isArray(content.lines)
    ? content.lines.map((line) => ({
      text: line && typeof line.text === 'string' ? line.text : '',
      ...(line && typeof line.speaker === 'string' && line.speaker.trim() ? { speaker: line.speaker } : {}),
      ...(line && line.maxChars !== undefined ? { maxChars: line.maxChars } : {}),
    }))
    : [];
  const slots: TemplateSubmissionSlot[] = Array.isArray(content.slots) ? content.slots.filter((slot) => slot && typeof slot === 'object') : [];

  // ── 基本信息 ──
  if (!title) error('title_required', '请填写模板标题。', 'title');
  else if (countSubmissionChars(title) > TEMPLATE_SUBMISSION_TITLE_MAX) error('title_too_long', `模板标题最多 ${TEMPLATE_SUBMISSION_TITLE_MAX} 个字，现在 ${countSubmissionChars(title)} 个字。`, 'title');
  if (!(typeof content.industryId === 'string' && content.industryId.trim())) error('industry_required', '请选择模板所属行业。', 'industryId');
  if (typeof content.remark === 'string' && countSubmissionChars(content.remark) > TEMPLATE_SUBMISSION_REMARK_MAX) {
    error('remark_too_long', `给审核的备注最多 ${TEMPLATE_SUBMISSION_REMARK_MAX} 个字。`, 'remark');
  }

  // ── 素材 ──
  if (slots.length === 0) error('slots_required', '至少要有 1 个素材。', 'slots');
  if (slots.length > TEMPLATE_SUBMISSION_MAX_SLOTS) error('slots_too_many', `素材最多 ${TEMPLATE_SUBMISSION_MAX_SLOTS} 个，现在 ${slots.length} 个。`, 'slots');
  const seenLabels: string[] = [];
  slots.forEach((slot, index) => {
    const field = `slots[${index}]`;
    const label = typeof slot.label === 'string' ? slot.label.trim() : '';
    const name = label ? `素材「${label}」` : `第 ${index + 1} 个素材`;
    if (!label) error('slot_label_required', `第 ${index + 1} 个素材还没起名字。`, `${field}.label`);
    else {
      if (countSubmissionChars(label) > TEMPLATE_SUBMISSION_LABEL_MAX) error('slot_label_too_long', `${name}的名字最多 ${TEMPLATE_SUBMISSION_LABEL_MAX} 个字。`, `${field}.label`);
      if (/[【】@＠{}]/.test(label)) error('slot_label_forbidden_chars', `${name}的名字里不能有【】@{} 这些符号。`, `${field}.label`);
      if (seenLabels.indexOf(label) >= 0) error('slot_label_duplicate', `素材名字「${label}」重复了，请用不同的名字区分。`, `${field}.label`);
      seenLabels.push(label);
    }
    let isPerson = slot.kind === 'person';
    if (slotTypes) {
      // v2：素材类型来自行业字典（typeId；老槽位按「行业 + kind」兜底）。
      const typeId = submissionResolveSlotTypeId(slot, industryId, slotTypes);
      let entry: TemplateSubmissionValidationSlotType | null = null;
      for (const type of slotTypes) if (type.id === typeId) entry = type;
      if (!typeId) error('slot_type_required', `请给${name}选类型。`, `${field}.typeId`);
      else if (!entry || entry.industryId !== industryId) {
        error('slot_type_not_in_industry', `${name}的类型${entry ? `「${entry.label}」` : ''}不属于「${industryName}」行业，请重选。`, `${field}.typeId`);
      } else if (!entry.enabled && grandfathered.indexOf(entry.id) < 0) {
        error('slot_type_disabled', `${name}的类型「${entry.label}」已停用，请换一个。`, `${field}.typeId`);
      }
      if (entry) isPerson = entry.baseKind === 'person';
    } else if ((TEMPLATE_SUBMISSION_SLOT_KINDS as readonly string[]).indexOf(slot.kind) < 0) {
      error('slot_kind_invalid', `请给${name}选类型。`, `${field}.kind`);
    }
    if (!(typeof slot.assetId === 'string' && slot.assetId)) error('slot_image_required', `请给${name}上传默认图。`, `${field}.assetId`);
    const hint = typeof slot.hint === 'string' ? slot.hint.trim() : '';
    if (countSubmissionChars(hint) > TEMPLATE_SUBMISSION_HINT_MAX) error('slot_hint_too_long', `${name}的换图提示最多 ${TEMPLATE_SUBMISSION_HINT_MAX} 个字。`, `${field}.hint`);
    if (isPerson && !hint) warn('person_hint_missing', `人物${label ? `「${label}」` : ''}没写换图提示，客户不知道该换什么样的人像。`, `${field}.hint`);
  });

  // ── 台词 ──
  const lineTexts = lines.map((line) => line.text);
  const lineRecommendedMaxChars = templateSubmissionLineMaxChars(lineTexts, ctx.durationSeconds);
  const lineMaxChars = lines.map((line, index) => line.maxChars !== undefined ? line.maxChars : lineRecommendedMaxChars[index]);
  if (lines.length > TEMPLATE_SUBMISSION_MAX_LINES) error('lines_too_many', `台词最多 ${TEMPLATE_SUBMISSION_MAX_LINES} 句。`, 'lines');
  const duration = typeof ctx.durationSeconds === 'number' && isFinite(ctx.durationSeconds) && ctx.durationSeconds > 0 ? Math.round(ctx.durationSeconds) : null;
  if (duration !== null && lines.length > duration) error('lines_exceed_duration', `台词有 ${lines.length} 句，比视频秒数（${duration} 秒）还多，念不完。`, 'lines');
  lines.forEach((line, index) => {
    const field = `lines[${index}]`;
    const count = countSubmissionChars(line.text);
    if (line.maxChars !== undefined && (!Number.isInteger(line.maxChars) || line.maxChars < 1 || line.maxChars > TEMPLATE_SUBMISSION_LINE_TEXT_MAX)) {
      error('line_max_chars_invalid', `第 ${index + 1} 句的客户字数上限要填 1–${TEMPLATE_SUBMISSION_LINE_TEXT_MAX} 的整数。`, `${field}.maxChars`);
    }
    if (count === 0) error('line_empty', `第 ${index + 1} 句台词是空的，请填上或删掉这句。`, `${field}.text`);
    else if (count > TEMPLATE_SUBMISSION_LINE_TEXT_MAX) error('line_text_too_long', `第 ${index + 1} 句台词太长了（最多 ${TEMPLATE_SUBMISSION_LINE_TEXT_MAX} 字）。`, `${field}.text`);
    else if (count > lineMaxChars[index]) error('line_too_long', `第 ${index + 1} 句最多 ${lineMaxChars[index]} 字，现在 ${count} 字。`, `${field}.text`);
    if (/[【】{}@＠]/.test(line.text)) error('line_forbidden_chars', `第 ${index + 1} 句台词里不能有【】{}@ 这些符号。`, `${field}.text`);
    if (line.speaker && countSubmissionChars(line.speaker) > TEMPLATE_SUBMISSION_SPEAKER_MAX) error('line_speaker_too_long', `第 ${index + 1} 句的说话人名字太长了。`, `${field}.speaker`);
    for (const item of TEMPLATE_SUBMISSION_MISREAD_CHARS) {
      if (line.text.indexOf(item.char) >= 0) warn('line_misread_char', `第 ${index + 1} 句：${item.advice}`, `${field}.text`);
    }
  });

  // ── 镜头脚本 ──
  const normalizedScript = normalizeTemplateSubmissionScript(script, lines);
  if (!script.trim()) {
    error('script_required', '请填写镜头脚本。', 'script');
  } else {
    if (script.length > TEMPLATE_SUBMISSION_SCRIPT_MAX) error('script_too_long', `镜头脚本太长了（最多 ${TEMPLATE_SUBMISSION_SCRIPT_MAX} 字）。`, 'script');
    const refs = parseTemplateScriptReferences(normalizedScript);
    if (refs.incomplete) error('script_incomplete_reference', '脚本里有不完整的素材或台词引用，请删掉后用「插入素材」「插入台词」按钮重新插入。', 'script');
    const unknownLabels: string[] = [];
    for (const label of refs.slotLabels) {
      if (seenLabels.indexOf(label) < 0 && unknownLabels.indexOf(label) < 0) unknownLabels.push(label);
    }
    if (unknownLabels.length) error('script_unknown_slot', `脚本引用了不存在的素材：${unknownLabels.map((label) => `「${label}」`).join('、')}。`, 'script');
    const unknownLines: number[] = [];
    for (const index of refs.lineIndexes) {
      if ((index < 1 || index > lines.length) && unknownLines.indexOf(index) < 0) unknownLines.push(index);
    }
    if (unknownLines.length) error('script_unknown_line', `脚本引用了不存在的台词：第 ${unknownLines.join('、')} 句（现在只有 ${lines.length} 句）。`, 'script');
    const unusedSlots = seenLabels.filter((label) => refs.slotLabels.indexOf(label) < 0);
    if (unusedSlots.length) error('slot_unreferenced', `这些素材在脚本里一次都没用到：${unusedSlots.map((label) => `「${label}」`).join('、')}。要么在脚本里插入，要么删掉这个素材。`, 'script');
    const unusedLines: number[] = [];
    for (let i = 1; i <= lines.length; i += 1) if (refs.lineIndexes.indexOf(i) < 0) unusedLines.push(i);
    if (unusedLines.length) error('line_unreferenced', `第 ${unusedLines.join('、')} 句台词在脚本里没用到。要么在脚本里插入，要么删掉这句。`, 'script');
    const masked = normalizedScript.replace(createSubmissionSlotReferenceRegex(), ' ').replace(createSubmissionLineReferenceRegex(), ' ');
    if (/[@＠]/.test(masked)) error('script_bare_at', '脚本里不要直接写「@」，引用素材请用「插入素材」按钮。', 'script');
    if (/\{\{|\}\}/.test(masked)) error('script_raw_placeholder', '脚本里不要出现「{{」「}}」，引用素材和台词请用插入按钮。', 'script');
    const residues = TEMPLATE_SUBMISSION_AI_RESIDUE_MARKERS.filter((marker) => masked.indexOf(marker) >= 0);
    if (residues.length) error('script_ai_residue', `脚本里有从聊天工具粘贴过来的多余内容（${residues.map((item) => `「${item}」`).join('、')}），请删掉，只留镜头描述。`, 'script');

    // 提醒
    const negativeLists = TEMPLATE_SUBMISSION_NEGATIVE_LIST_MARKERS.filter((marker) => masked.indexOf(marker) >= 0);
    if (negativeLists.length) warn('script_negative_list', '视频模型没有单独的「负面词」通道，列在这里的词会被当成画面要求。建议改成「画面中不要出现……」这样的明确说法。', 'script');
    const colorHits: string[] = [];
    const colorRegex = new RegExp(CAR_COLOR_PATTERN.source, 'g');
    let colorMatch = colorRegex.exec(masked);
    while (colorMatch !== null) {
      if (colorHits.indexOf(colorMatch[0]) < 0) colorHits.push(colorMatch[0]);
      colorMatch = colorRegex.exec(masked);
    }
    if (colorHits.length && industryId === TEMPLATE_SUBMISSION_AUTO_INDUSTRY_ID) warn('script_fixed_car_color', `脚本写死了车的颜色（${colorHits.map((item) => `「${item}」`).join('、')}）：客户换成自己的车后颜色会对不上，建议删掉颜色。`, 'script');
    const bareTextClauses: string[] = [];
    for (const clause of masked.split(SENTENCE_SPLIT)) {
      if (TEXT_ON_SCREEN_PATTERN.test(clause) && !NEGATION_PATTERN.test(clause)) {
        const at = clause.search(TEXT_ON_SCREEN_PATTERN);
        bareTextClauses.push(snippet(clause, at, 2).trim());
      }
    }
    if (bareTextClauses.length) warn('script_bare_subtitle_word', `脚本里直接写了「字幕」「文字」（${bareTextClauses.slice(0, 3).map((item) => `「${item}」`).join('、')}），模型可能真的把字画进画面。不需要字就删掉；要禁止就写成「画面中不要出现任何字幕」。`, 'script');
    const seenSentences: string[] = [];
    const repeated: string[] = [];
    for (const raw of normalizedScript.split(SENTENCE_SPLIT)) {
      const sentence = raw.trim();
      if (countSubmissionChars(sentence) < REPEAT_MIN_CHARS) continue;
      if (seenSentences.indexOf(sentence) >= 0) { if (repeated.indexOf(sentence) < 0) repeated.push(sentence); } else seenSentences.push(sentence);
    }
    if (repeated.length) warn('script_repeated_sentence', `脚本里有重复出现的段落（${repeated.slice(0, 2).map((item) => `「${Array.from(item).slice(0, 20).join('')}…」`).join('、')}），可能是粘贴了好几个版本，请只留一版。`, 'script');
    if (normalizedScript !== script) warn('script_auto_fix_available', '脚本有几处可以自动修正的写法（台词引号、引用后补空格），点「应用自动修正」即可。', 'script');
  }

  // ── 样片与封面 ──
  if (!(typeof content.sampleVideoAssetId === 'string' && content.sampleVideoAssetId)) error('sample_video_required', '请上传样片。', 'sampleVideoAssetId');
  if (!(typeof content.coverAssetId === 'string' && content.coverAssetId)) error('cover_required', '请上传封面（也可以从样片里截一帧）。', 'coverAssetId');

  return { errors, warnings, normalizedScript, lineMaxChars, lineRecommendedMaxChars };
};

/** 一条问题的 message 汇总成一句话（API 400 的 message 用）。 */
export const describeTemplateSubmissionIssues = (issues: TemplateSubmissionIssue[]): string =>
  issues.map((issue) => issue.message).join(' ');

/**
 * 线上模板的编译后正文（`{{slot:sN}}` / `{{lineN}}`）还原成投稿脚本写法，供「申请修改」
 * 复制线上内容成新草稿、以及审核页逐字段对比用。找不到 label 的槽保留占位（校验会报错）。
 */
export const decompileTemplateScript = (prompt: string, slots: { slotKey: string; label: string }[]): string =>
  prompt
    .replace(/\{\{slot:(s\d+)\}\}/g, (whole: string, key: string) => {
      for (const slot of slots) if (slot.slotKey === key) return formatSlotReference(slot.label);
      return whole;
    })
    .replace(/\{\{line(\d+)\}\}/g, (_whole: string, index: string) => formatLineReference(Number(index)));
