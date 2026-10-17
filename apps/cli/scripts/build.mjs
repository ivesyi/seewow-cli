// 打包成单个 dist/seewow.mjs（零运行时依赖）。可复现：不写时间戳、不压缩、不带 sourcemap、法律注释去掉；
// 同一提交两次构建 sha256 必须一致（prepublish-check 会核）。
//   node scripts/build.mjs [--outfile <路径>]
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(cliRoot, 'package.json'), 'utf8'));
const outIndex = process.argv.indexOf('--outfile');
const outfile = outIndex >= 0 ? resolve(process.argv[outIndex + 1]) : resolve(cliRoot, 'dist/seewow.mjs');

await build({
  absWorkingDir: cliRoot,
  entryPoints: ['src/main.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'warning',
  banner: { js: '#!/usr/bin/env node' },
  define: { __SEEWOW_CLI_VERSION__: JSON.stringify(pkg.version) },
});
console.log(outfile);
