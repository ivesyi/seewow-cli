// 发布前检查（方案 §5 / S11）。任何一步不过 → 退出码 1，不许发。
//   1. package.json 形态：bin、files 白名单、零运行时依赖、无安装脚本、engines、publishConfig
//   2. 构建，并在临时目录再构建两次：三份 sha256 必须一致（可复现构建）
//   3. npm pack --dry-run --json 的文件清单与白名单逐字一致
//   4. 泄密扫描：待发的每个文件（含打包产物）
//   5. 干净临时目录里单独 `node seewow.mjs --help` 退出 0
//   6. 金丝雀测试（S10）：test/cliRedaction.test.mjs 对这份产物全绿
// 用法：node scripts/prepublish-check.mjs（在 apps/cli 下；公开仓库的发布 workflow 也跑它）
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLE_PATTERNS, formatHits, loadPrivatePatterns, scanFiles, SECRET_PATTERNS } from './leak-scan.mjs';

export const EXPECTED_PACK_FILES = ['LICENSE', 'README.md', 'dist/seewow.mjs', 'package.json'];
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack', 'prepublish', 'prepublishOnly'];

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(cliRoot, '../..');
const dist = join(cliRoot, 'dist/seewow.mjs');
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });

let failed = 0;
const step = async (title, fn) => {
  try {
    const detail = await fn();
    console.log(`✓ ${title}${detail ? `\n${detail}` : ''}`);
  } catch (error) {
    failed += 1;
    console.log(`✗ ${title}\n  ${error instanceof Error ? error.message : String(error)}`);
  }
};

const work = mkdtempSync(join(tmpdir(), 'seewow-cli-check-'));
try {
  await step('package.json 形态', () => {
    const pkg = JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8'));
    const problems = [];
    if (pkg.name !== '@seewow/cli') problems.push(`name 应为 @seewow/cli，现在 ${pkg.name}`);
    if (pkg.bin?.seewow !== 'dist/seewow.mjs' || Object.keys(pkg.bin ?? {}).length !== 1) problems.push('bin 只能是 { seewow: dist/seewow.mjs }');
    if (JSON.stringify([...(pkg.files ?? [])].sort()) !== JSON.stringify(['LICENSE', 'README.md', 'dist/seewow.mjs'])) problems.push(`files 白名单不对：${JSON.stringify(pkg.files)}`);
    if (!pkg.dependencies || Object.keys(pkg.dependencies).length) problems.push('运行时 dependencies 必须是 {}（依赖全部打进单文件）');
    for (const key of ['optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) if (pkg[key] && Object.keys(pkg[key]).length) problems.push(`不许有 ${key}`);
    for (const name of INSTALL_SCRIPTS) if (pkg.scripts?.[name]) problems.push(`不许有安装/打包钩子脚本 ${name}`);
    if (pkg.engines?.node !== '>=20') problems.push('engines.node 应为 >=20');
    if (pkg.publishConfig?.access !== 'public' || pkg.publishConfig?.provenance !== true) problems.push('publishConfig 应为 { access: public, provenance: true }');
    for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`构建依赖要锁精确版本：${name}@${version}`);
    if (problems.length) throw new Error(problems.join('\n  '));
  });

  let digest = '';
  await step('构建 + 两次独立构建 sha256 一致', () => {
    const builds = [dist, join(work, 'a.mjs'), join(work, 'b.mjs')];
    for (const out of builds) {
      const result = run(process.execPath, [join(cliRoot, 'scripts/build.mjs'), '--outfile', out], { cwd: cliRoot });
      if (result.status !== 0) throw new Error(`构建失败：${result.stderr || result.stdout}`);
    }
    const sums = builds.map(sha256);
    if (new Set(sums).size !== 1) throw new Error(`三次构建 sha256 不一致：${sums.join(' / ')}`);
    digest = sums[0];
    return `  dist/seewow.mjs sha256 ${digest}`;
  });

  let packFiles = [];
  await step('npm pack --dry-run 文件清单 = 白名单', () => {
    const result = run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: cliRoot });
    if (result.status !== 0) throw new Error(`npm pack 失败：${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    packFiles = parsed[0].files.map((file) => file.path).sort();
    if (JSON.stringify(packFiles) !== JSON.stringify(EXPECTED_PACK_FILES)) throw new Error(`清单不一致：\n  实际 ${JSON.stringify(packFiles)}\n  期望 ${JSON.stringify(EXPECTED_PACK_FILES)}`);
    return `  ${packFiles.join('\n  ')}`;
  });

  await step('泄密扫描（待发文件）', async () => {
    const patterns = [...SECRET_PATTERNS, ...BUNDLE_PATTERNS, ...(await loadPrivatePatterns(repoRoot))];
    const files = (packFiles.length ? packFiles : EXPECTED_PACK_FILES).map((path) => ({ path, abs: join(cliRoot, path) })).filter((file) => existsSync(file.abs));
    const hits = scanFiles(files, patterns);
    if (hits.length) throw new Error(`命中 ${hits.length} 处：\n${formatHits(hits)}`);
    return `  扫了 ${files.length} 个文件、${patterns.length} 条规则，0 命中`;
  });

  await step('干净目录 node seewow.mjs --help', () => {
    const clean = mkdtempSync(join(work, 'clean-'));
    copyFileSync(dist, join(clean, 'seewow.mjs'));
    const result = run(process.execPath, ['seewow.mjs', '--help'], { cwd: clean, env: { PATH: process.env.PATH ?? '', HOME: clean, XDG_CONFIG_HOME: join(clean, 'config') } });
    if (result.status !== 0) throw new Error(`退出码 ${result.status}：${result.stderr}`);
    if (!result.stdout.includes('seewow')) throw new Error('--help 没有输出用法');
  });

  await step('金丝雀测试（S10 令牌永不打印）', () => {
    const test = join(repoRoot, 'test/cliRedaction.test.mjs');
    if (!existsSync(test)) throw new Error(`找不到 ${test}`);
    const result = run(process.execPath, ['--test', '--test-reporter=tap', test], { cwd: repoRoot, env: { ...process.env, SEEWOW_CLI_BUNDLE: dist } });
    const summary = (result.stdout.match(/^# (?:pass|fail) \d+$/gm) ?? []).join('，');
    if (result.status !== 0) throw new Error(`没过（${summary || `退出码 ${result.status}`}）\n${result.stdout.split('\n').filter((line) => /not ok|Error|expected|actual/.test(line)).slice(0, 20).join('\n')}`);
    return `  ${summary}`;
  });

  if (digest && !failed) console.log(`\n发布产物 dist/seewow.mjs sha256：${digest}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (failed) {
  console.log(`\n${failed} 项没过，不能发布。`);
  process.exit(1);
}
console.log('\n全部通过。');
