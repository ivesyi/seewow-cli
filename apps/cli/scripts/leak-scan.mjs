// 泄密扫描（方案 S11）。发布前检查（扫打包产物与待发文件）和公开仓库同步脚本（扫待同步源码）共用这一份。
// 注意：每条正则的「源码文本」都写成不会匹配自己的样子（例如 -{5}BEGIN、DATABASE_(?:URL)），
// 这样扫描器自己被同步、被扫描时不会误报。主仓库另有一份私有补充规则（生产 IP、ssh 别名等），
// 放在 scripts/cli/leak-patterns.private.mjs，不进公开仓库；存在时自动加载。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 所有扫描都用。 */
export const SECRET_PATTERNS = [
  { name: 'seewow 命令行令牌（swc_…）', re: /swc_[A-Za-z0-9_-]{20,}/ },
  { name: 'API 密钥（sk-…）', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'AWS 访问密钥', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: '私钥 / 证书块', re: /-{5}BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-{5}/ },
  { name: '云存储 / 密钥类环境变量名', re: /\b(?:R2|COS|TENCENT|ARK|XAI|TRAE|OVERSEAS_FETCH|BETTER_AUTH|SMTP|AWS|ALIBABA|ALIYUN)_[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|ACCESS|BUCKET|ENDPOINT)\b/ },
  { name: '数据库 / Redis 连接串变量', re: /\b(?:DATABASE|REDIS|DIRECT)_(?:URL)\b/ },
  { name: '连接串（带账号密码）', re: /\b(?:postgres(?:ql)?|redis|mysql|mongodb):\/\/[^\s:/@]+:[^\s@]+@/ },
  { name: '.env 赋值片段', re: /^\s*(?:export\s+)?[A-Z][A-Z0-9_]{2,}=["']?[A-Za-z0-9+/_.:@-]{16,}/m },
  { name: '内网地址 10.x', re: /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/ },
  { name: '内网地址 192.168.x', re: /\b192\.168\.\d{1,3}\.\d{1,3}\b/ },
  { name: '内网地址 172.16–31.x', re: /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/ },
  { name: 'Tailscale / CGNAT 地址 100.64–127.x', re: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/ },
  { name: 'ssh 私钥路径', re: /\.ssh\/(?:id_[A-Za-z0-9_]+|[A-Za-z0-9_-]+\.pem)/ },
  { name: '服务器目录', re: /\/(?:www\/wwwroot|root\/\.config|root\/bin|etc\/seewow)\b/ },
];

/** 只扫打包产物与待发文件（源码注释里提到管理端路径不算泄密，但发出去的包里不该有）。 */
export const BUNDLE_PATTERNS = [
  { name: '管理端接口路径', re: /\/api\/admin\b/ },
];

/** 主仓库私有补充规则（不进公开仓库）。 */
export const loadPrivatePatterns = async (repoRoot) => {
  const file = resolve(repoRoot, 'scripts/cli/leak-patterns.private.mjs');
  if (!existsSync(file)) return [];
  const mod = await import(pathToFileURL(file).href);
  return Array.isArray(mod.PRIVATE_PATTERNS) ? mod.PRIVATE_PATTERNS : [];
};

/** 命中的片段只显示前后几个字符、中间打码，扫描报告本身不再把秘密打出来。 */
const maskHit = (text) => (text.length <= 8 ? `${text.slice(0, 2)}****` : `${text.slice(0, 6)}****${text.slice(-2)}`);

export const scanText = (text, patterns) => {
  const hits = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    for (const { name, re } of patterns) {
      const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
      for (const match of line.matchAll(new RegExp(re.source, flags))) hits.push({ rule: name, line: index + 1, match: maskHit(match[0]) });
    }
  });
  return hits;
};

/** files: [{ path（展示用）, abs }] → 命中列表。 */
export const scanFiles = (files, patterns) => files.flatMap((file) => scanText(readFileSync(file.abs, 'utf8'), patterns).map((hit) => ({ file: file.path, ...hit })));

export const formatHits = (hits) => hits.map((hit) => `  ${hit.file}:${hit.line}  ${hit.rule}  ${hit.match}`).join('\n');
