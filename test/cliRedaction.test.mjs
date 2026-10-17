// S10 金丝雀：注入一枚已知的假令牌，把 seewow CLI 的全部命令、失败路径、网络错误、崩溃路径、坏服务端回显都跑一遍，
// 断言完整令牌（以及 deviceCode）在任何 stdout / stderr 里出现 0 次；只允许出现前 12 位。
// 同时核 S9：令牌不进模板包目录，凭据文件 0600。
// 跑的是打包后的单文件（SEEWOW_CLI_BUNDLE 指定，或现场构建），也会同步到公开仓库由发布流水线跑。
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  FAKE_DEVICE_CODE, fakeToken, makeFakeSecurity, makeHome, runCli, startMockApi, validManifest, writeFileCredentials, writePackage,
} from './helpers/cliMock.mjs';

const CANARY = fakeToken('CANARY');
const PREFIX = CANARY.slice(0, 12);
const outputs = [];

const record = (label, result) => {
  outputs.push({ label, text: result.all });
  return result;
};
const countIn = (text, needle) => text.split(needle).length - 1;
const assertClean = (label, result) => {
  assert.equal(countIn(result.all, CANARY), 0, `${label}：输出里出现了完整令牌`);
  assert.equal(countIn(result.all, FAKE_DEVICE_CODE), 0, `${label}：输出里出现了完整 deviceCode`);
};

/** 递归读一个目录下全部文件文本（判断令牌有没有写进模板包）。 */
const allText = (dir) => readdirSync(dir, { withFileTypes: true }).map((entry) => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? allText(path) : readFileSync(path, 'latin1');
}).join('\n');

describe('S10 金丝雀：完整令牌在任何输出里出现 0 次', () => {
  let api;
  let echoApi;
  let home;
  let pkg;
  before(async () => {
    api = await startMockApi({ token: CANARY, pendingPolls: 1, slowDownOnce: true });
    echoApi = await startMockApi({ token: CANARY, echoSecrets: true, inject: { whoami: { status: 400, code: 'validation_error', message: '坏服务端把请求头回显出来了' } } });
    home = makeHome();
    pkg = writePackage(join(home, 'pkg'));
  });
  after(async () => {
    await api?.close();
    await echoApi?.close();
  });

  test('登录（文件存放、--verbose）与 --json 登录', async () => {
    for (const extra of [['--verbose'], ['--json', '--verbose']]) {
      const result = record(`login ${extra.join(' ')}`, await runCli(['auth', 'login', '--store', 'file', '--api-url', api.url, ...extra], { home }));
      assert.equal(result.code, 0, result.all);
      assertClean('login', result);
    }
    const file = join(home, 'config/seewow/cli/default.json');
    assert.equal(statSync(file).mode & 0o777, 0o600, '凭据文件必须 0600');
    assert.equal(statSync(join(home, 'config/seewow/cli')).mode & 0o777, 0o700, '凭据目录必须 0700');
  });

  test('全部命令的成功路径（--verbose 与 --json 各跑一遍）', async () => {
    const runs = [
      ['auth', 'status'],
      ['template', 'init', join(home, 'fresh')],
      ['template', 'options'],
      ['template', 'validate', pkg],
      ['template', 'push', pkg, '--dry-run'],
      ['template', 'push', pkg],
      ['template', 'push', pkg],
      ['template', 'list'],
      ['template', 'show', pkg],
      ['template', 'submit', pkg, '--dry-run'],
      ['template', 'submit', pkg, '--yes'],
      ['template', 'withdraw', pkg, '--yes'],
    ];
    for (const args of runs) {
      for (const mode of [['--verbose'], ['--json', '--verbose']]) {
        if (args[1] === 'init' && mode[0] === '--json') continue;
        const result = record(args.join(' '), await runCli([...args, ...mode], { home }));
        assertClean(args.join(' '), result);
      }
    }
    const status = await runCli(['auth', 'status'], { home });
    assert.equal(status.code, 0, status.all);
    assert.ok(status.stdout.includes(PREFIX), 'auth status 应显示令牌前 12 位');
    assertClean('status', status);
    assert.equal(countIn(allText(pkg), CANARY), 0, '令牌不能写进模板包目录（含 .seewow/）');
  });

  test('失败路径：冲突、确认缺失、白名单拒绝、权限、限流、服务端 5xx、404', async () => {
    const draftId = [...api.state.drafts.keys()][0];
    api.webEdit(draftId, { title: '网页上改过' });
    const cases = [
      ['template', 'push', pkg],
      ['template', 'push', pkg, '--force', '--verbose'],
      ['template', 'submit', pkg],
      ['template', 'submit', 'no_such_draft', '--yes', '--verbose'],
      ['template', 'withdraw', draftId, '--json'],
    ];
    for (const args of cases) assertClean(args.join(' '), record(args.join(' '), await runCli(args, { home })));

    const bad = writePackage(join(home, 'bad'), { ...validManifest(), videoModel: 'seedance', provider: 'ark' });
    assertClean('field_not_allowed', record('field_not_allowed', await runCli(['template', 'push', bad, '--json', '--verbose'], { home })));

    for (const [route, status, code] of [['options', 500, 'api_error'], ['whoami', 429, 'rate_limited'], ['list', 403, 'cli_scope_missing'], ['get', 404, 'not_found']]) {
      api.state.inject[route] = { status, code, once: true, retryAfter: status === 429 ? 60 : undefined };
      const args = route === 'list' ? ['template', 'list'] : route === 'get' ? ['template', 'show', 'sub_1'] : route === 'options' ? ['template', 'options'] : ['auth', 'status'];
      for (const mode of [['--verbose'], ['--json', '--verbose']]) {
        api.state.inject[route] = { status, code, once: true, retryAfter: status === 429 ? 60 : undefined };
        const result = record(`${route} ${status}`, await runCli([...args, ...mode], { home }));
        assert.notEqual(result.code, 0);
        assertClean(`${route} ${status}`, result);
      }
    }
  });

  test('坏服务端把 Authorization 头和 deviceCode 回显进错误消息，也不能漏', async () => {
    const echoHome = makeHome();
    writeFileCredentials(echoHome, { apiUrl: echoApi.url, token: CANARY });
    for (const mode of [['--verbose'], ['--json', '--verbose']]) {
      const result = record('echo whoami', await runCli(['auth', 'status', ...mode], { home: echoHome }));
      assert.notEqual(result.code, 0);
      assertClean('echo whoami', result);
    }
    const login = record('echo login', await runCli(['auth', 'login', '--store', 'file', '--api-url', echoApi.url, '--verbose'], { home: makeHome(), env: {} }));
    assertClean('echo login', login);
  });

  test('网络错误、坏 JSON、崩溃路径、SEEWOW_TOKEN 环境变量', async () => {
    const envHome = makeHome();
    const closed = record('network', await runCli(['auth', 'status', '--verbose', '--api-url', 'http://127.0.0.1:9'], { home: envHome, env: { SEEWOW_TOKEN: CANARY } }));
    assert.equal(closed.code, 7, closed.all);
    assertClean('network', closed);

    api.state.inject.whoami = { status: 200, raw: 'not json at all', once: true };
    const garbage = record('garbage', await runCli(['auth', 'status', '--verbose'], { home }));
    assert.equal(garbage.code, 7, garbage.all);
    assertClean('garbage', garbage);

    // 崩溃路径：options 返回缺字段的 JSON → 代码里 TypeError，--verbose 会打堆栈。
    api.state.inject.options = { status: 200, raw: '{}', once: true };
    const crash = record('crash', await runCli(['template', 'push', pkg, '--verbose'], { home }));
    assert.equal(crash.code, 1, crash.all);
    assertClean('crash', crash);

    for (const mode of [['--verbose'], ['--json', '--verbose']]) {
      const viaEnv = record('env token', await runCli(['auth', 'status', '--api-url', api.url, ...mode], { home: envHome, env: { SEEWOW_TOKEN: CANARY } }));
      assertClean('env token', viaEnv);
    }
    const badEnv = record('bad env token', await runCli(['auth', 'status', '--verbose'], { home: envHome, env: { SEEWOW_TOKEN: `${CANARY}x` } }));
    assert.equal(badEnv.code, 4);
    assertClean('bad env token', badEnv);
    assert.equal(countIn(badEnv.all, `${CANARY}x`), 0);
  });

  test('凭据文件权限过宽时拒绝读取，提示里也不带令牌', async () => {
    const looseHome = makeHome();
    const file = writeFileCredentials(looseHome, { apiUrl: api.url, token: CANARY });
    const { chmodSync } = await import('node:fs');
    chmodSync(file, 0o644);
    const result = record('loose perms', await runCli(['auth', 'status', '--verbose'], { home: looseHome }));
    assert.equal(result.code, 4, result.all);
    assert.ok(result.all.includes('credentials_permissions_too_open'));
    assertClean('loose perms', result);
  });

  test('macOS 钥匙串存放（假 security 命令）：登录、状态、退出都不漏；钥匙串锁着 → 退出码 4', { skip: process.platform !== 'darwin' }, async () => {
    const kcApi = await startMockApi({ token: CANARY });
    try {
      const kcHome = makeHome();
      const env = makeFakeSecurity(kcHome);
      const login = record('kc login', await runCli(['auth', 'login', '--api-url', kcApi.url, '--verbose'], { home: kcHome, env }));
      assert.equal(login.code, 0, login.all);
      assertClean('kc login', login);
      const meta = readFileSync(join(kcHome, 'config/seewow/cli/default.json'), 'utf8');
      assert.equal(countIn(meta, CANARY), 0, '钥匙串方式的 profile 文件里不能有令牌');
      assert.equal(readFileSync(join(kcHome, 'keychain/item'), 'utf8'), CANARY, '令牌应写进（假）钥匙串');
      for (const args of [['auth', 'status', '--verbose'], ['auth', 'status', '--json'], ['auth', 'logout', '--verbose']]) {
        const result = record(args.join(' '), await runCli(args, { home: kcHome, env }));
        assert.equal(result.code, 0, result.all);
        assertClean(args.join(' '), result);
      }
      assert.equal(existsSync(join(kcHome, 'keychain/item')), false, 'logout 要删掉钥匙串条目');
      const locked = record('kc locked', await runCli(['auth', 'login', '--api-url', kcApi.url], { home: makeHome(), env: { ...makeFakeSecurity(kcHome), FAKE_KEYCHAIN_LOCKED: '36' } }));
      assert.equal(locked.code, 4, locked.all);
      assert.ok(locked.all.includes('keychain_unavailable') && locked.all.includes('--store file'));
    } finally {
      await kcApi.close();
    }
  });

  test('汇总：全部输出合计出现完整令牌 0 次', () => {
    assert.ok(outputs.length >= 40, `至少跑 40 次命令，实际 ${outputs.length}`);
    const total = outputs.reduce((sum, item) => sum + countIn(item.text, CANARY), 0);
    assert.equal(total, 0);
    writeFileSync(join(home, 'canary-summary.txt'), `${outputs.length} runs, 0 leaks\n`);
  });
});
