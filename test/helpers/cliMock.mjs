// seewow CLI 测试用：本地 mock API（node:http，按 packages/contracts/cli.ts 与 apps/api/routes/cli.ts 的契约回放
// T1 设备授权 + T3 草稿/素材/提审接口）、构建/定位 CLI 单文件、跑 CLI 子进程、造假素材文件、假 macOS security 命令。
// 不联网、不碰生产、不碰真钥匙串：所有凭据落在每个用例自己的临时 HOME / XDG_CONFIG_HOME。
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const cliRoot = join(repoRoot, 'apps/cli');

/** 一眼看出是假的令牌：swc_ + 43 位（拼出来，不在源码里留完整字面量，免得泄密扫描误报）。 */
export const fakeToken = (label = 'CANARY') => ['swc', `${label}-FAKE-TOKEN-NOT-REAL-${'0'.repeat(43)}`.slice(0, 43)].join('_');
export const FAKE_DEVICE_CODE = `DEVICECODE-FAKE-NOT-REAL-${'x'.repeat(40)}`.slice(0, 43);

let bundlePromise = null;
/** CLI 单文件：优先用 SEEWOW_CLI_BUNDLE（发布前检查传入 dist），否则现场构建到临时目录（每个测试进程一次）。 */
export const ensureBundle = () => {
  if (process.env.SEEWOW_CLI_BUNDLE) return Promise.resolve(resolve(process.env.SEEWOW_CLI_BUNDLE));
  bundlePromise ??= new Promise((done, fail) => {
    const out = join(mkdtempSync(join(tmpdir(), 'seewow-cli-bundle-')), 'seewow.mjs');
    const result = spawnSync(process.execPath, [join(cliRoot, 'scripts/build.mjs'), '--outfile', out], { cwd: cliRoot, encoding: 'utf8' });
    if (result.status !== 0) fail(new Error(`构建 CLI 失败：${result.stderr || result.stdout}`));
    else done(out);
  });
  return bundlePromise;
};

/** 每个用例一个干净的家目录（凭据、配置都落这里）。 */
export const makeHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'seewow-cli-home-'));
  mkdirSync(join(home, 'config'), { recursive: true });
  return home;
};

/** 跑一次 CLI（异步子进程，mock server 在本进程里，不能用 spawnSync）。 */
export const runCli = async (args, { home, env = {}, cwd, input } = {}) => {
  const bundle = await ensureBundle();
  return new Promise((done) => {
    const child = spawn(process.execPath, [bundle, ...args], {
      cwd: cwd ?? home ?? tmpdir(),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home ?? tmpdir(),
        XDG_CONFIG_HOME: join(home ?? tmpdir(), 'config'),
        SEEWOW_NO_BROWSER: '1',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end(input ?? '');
    child.on('close', (code) => done({ code, stdout, stderr, all: `${stdout}\n${stderr}` }));
  });
};

/** --json 的 stdout：每行一个 JSON。 */
export const ndjson = (stdout) => stdout.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));

// ─── 假素材 ──────────────────────────────────────────────────────────────────
export const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
export const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const box = (type, payload) => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
};
/** 最小 MP4：ftyp + moov/mvhd（version 0，timescale 1000，duration = seconds*1000）。 */
export const fakeMp4 = (seconds = 15) => {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 16);
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2', 'latin1')), box('moov', box('mvhd', mvhd)), box('mdat', Buffer.alloc(64, 7))]);
};
export const fakeJpeg = (salt = '') => Buffer.concat([JPEG_HEAD, Buffer.from(`fake-jpeg-${salt}`), Buffer.from([0xff, 0xd9])]);

/** 一份能过本地校验的模板包。 */
export const validManifest = (overrides = {}) => ({
  title: '测试模板：新车到店',
  industryId: 'auto',
  catalogIndustryId: null,
  categoryId: null,
  script: '镜头一：【素材：车】缓缓驶入展厅，店员说【台词：1】',
  lines: [{ text: '欢迎来看新车' }],
  slots: [{ label: '车', typeId: 'auto.car', replaceable: true, hint: '换成你的车', image: 'media/car.jpg' }],
  sampleVideo: 'media/sample.mp4',
  cover: 'media/cover.jpg',
  remark: '',
  ...overrides,
});

export const writePackage = (dir, manifest = validManifest()) => {
  mkdirSync(join(dir, 'media'), { recursive: true });
  writeFileSync(join(dir, 'seewow-template.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, 'media/car.jpg'), fakeJpeg('car'));
  writeFileSync(join(dir, 'media/cover.jpg'), fakeJpeg('cover'));
  writeFileSync(join(dir, 'media/sample.mp4'), fakeMp4(15));
  return dir;
};

/** 假 macOS security：把「钥匙串」存在 FAKE_KEYCHAIN_DIR；FAKE_KEYCHAIN_LOCKED=36 模拟锁住。 */
export const makeFakeSecurity = (home) => {
  const bin = join(home, 'fakebin');
  mkdirSync(bin, { recursive: true });
  const script = `#!/bin/sh
store="$FAKE_KEYCHAIN_DIR/item"
case "$1" in
  show-keychain-info) exit \${FAKE_KEYCHAIN_LOCKED:-0} ;;
  -i) line=$(cat); token=$(printf '%s' "$line" | sed -n 's/.*-w "\\([^"]*\\)".*/\\1/p'); printf '%s' "$token" > "$store"; exit 0 ;;
  find-generic-password) [ -f "$store" ] || exit 44; cat "$store"; echo; exit 0 ;;
  delete-generic-password) [ -f "$store" ] || exit 44; rm -f "$store"; exit 0 ;;
esac
exit 1
`;
  writeFileSync(join(bin, 'security'), script);
  chmodSync(join(bin, 'security'), 0o755);
  mkdirSync(join(home, 'keychain'), { recursive: true });
  return { PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_KEYCHAIN_DIR: join(home, 'keychain') };
};

// ─── mock API ────────────────────────────────────────────────────────────────
const DEFAULT_OPTIONS = {
  industries: [{
    id: 'auto', name: '汽车',
    slotTypes: [
      { id: 'auto.car', industryId: 'auto', label: '汽车', example: '整车外观', baseKind: 'reference', enabled: true, sortOrder: 1 },
      { id: 'auto.person', industryId: 'auto', label: '人物', example: '销售顾问', baseKind: 'person', enabled: true, sortOrder: 2 },
    ],
  }],
};

const readBody = (request) => new Promise((done) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => done(Buffer.concat(chunks)));
});

/**
 * 起一个 mock API。opts：
 *   token：签发的令牌；pendingPolls：批准前回几次 authorization_pending；slowDownOnce；deviceResult：'approve'|'deny'|'expire'
 *   scopes / effectiveScopes：whoami 的权限；principal；inject：{ [路由名]: { status, code, message, retryAfter, once } } 注入错误
 *   echoSecrets：错误消息里故意回显 Authorization 头与 deviceCode（金丝雀：坏服务端回显也不能漏）
 */
export const startMockApi = async (opts = {}) => {
  const token = opts.token ?? fakeToken('MOCK');
  const state = {
    token,
    revoked: false,
    /** 之前签发过、仍有效的令牌（测试重新登录时撤销旧令牌）。 */
    olderTokens: [],
    revokedTokens: [],
    polls: 0,
    slowDownSent: false,
    scopes: opts.scopes ?? ['drafts:write', 'drafts:submit'],
    effectiveScopes: opts.effectiveScopes,
    principal: opts.principal ?? { kind: 'partner', partnerChannelId: 'pc_test', name: '测试汽车服务' },
    options: opts.options ?? DEFAULT_OPTIONS,
    drafts: new Map(),
    idempotency: new Map(),
    intents: new Map(),
    serverErrors: [],
    inject: { ...(opts.inject ?? {}) },
    requests: [],
    nextId: 1,
  };
  const now = () => new Date('2026-10-16T08:00:00.000Z').toISOString();
  const detailOf = (row) => ({
    id: row.id, status: row.status, content: row.content, media: {},
    validation: { errors: state.serverErrors, warnings: [] }, normalizedScript: row.content.script ?? '', lineMaxChars: [], lineRecommendedMaxChars: [],
    testCredits: 0, rejectReason: row.rejectReason ?? null, liveTemplateId: null, revisionOfId: null, version: row.version, testRuns: [],
    sampleDurationSeconds: row.content.sampleVideoAssetId ? 15 : null, contentRevision: row.contentRevision, submittedAt: row.submittedAt ?? null,
    updatedAt: now(), retiredAt: null, retiredReason: null, clonedFromId: null, retiredTemplate: null, slotTypes: [], grandfatheredSlotTypeIds: [],
  });
  const normalizeContent = (content = {}) => ({
    title: '', industryId: '', catalogIndustryId: null, categoryId: null, script: '', lines: [], sampleVideoAssetId: null, coverAssetId: null, remark: '',
    ...content,
    slots: (content.slots ?? []).map((slot) => ({ kind: 'prop', typeId: null, replaceable: true, hint: '', assetId: null, ...slot })),
  });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://mock');
    const path = url.pathname;
    const method = request.method;
    const raw = await readBody(request);
    const isJson = String(request.headers['content-type'] ?? '').includes('application/json');
    let body = null;
    if (isJson && raw.length) body = JSON.parse(raw.toString('utf8'));
    const auth = String(request.headers.authorization ?? '');
    state.requests.push({ method, path, auth, headers: request.headers, body, bytes: raw.length });
    const send = (status, payload, headers = {}) => {
      response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      response.end(JSON.stringify(payload));
    };
    const error = (status, code, message, extra = {}) => {
      const echoed = opts.echoSecrets ? `${message}（回显：${auth} ${body?.deviceCode ?? ''}）` : message;
      send(status, { error: { message: echoed, code, ...extra } }, extra.retryAfter ? { 'Retry-After': String(extra.retryAfter) } : {});
    };
    const route = (() => {
      if (path === '/api/cli/device/code') return 'deviceCode';
      if (path === '/api/cli/device/token') return 'deviceToken';
      if (path === '/api/cli/whoami') return 'whoami';
      if (path === '/api/cli/token/revoke') return 'revoke';
      if (path === '/api/cli/template-drafts/options') return 'options';
      if (path === '/api/cli/template-drafts') return method === 'POST' ? 'create' : 'list';
      const m = path.match(/^\/api\/cli\/template-drafts\/([^/]+)(?:\/(submit|withdraw|media\/upload-intents|media\/complete|media\/([^/]+)\/content))?$/);
      if (!m) return 'unknown';
      if (!m[2]) return method === 'PUT' ? 'save' : 'get';
      if (m[2] === 'submit' || m[2] === 'withdraw') return m[2];
      if (m[2] === 'media/upload-intents') return 'intent';
      if (m[2] === 'media/complete') return 'complete';
      return 'content';
    })();
    const injected = state.inject[route];
    if (injected) {
      if (injected.once) delete state.inject[route];
      if (injected.raw) {
        response.writeHead(injected.status ?? 200, { 'Content-Type': 'application/json' });
        response.end(injected.raw);
        return;
      }
      return error(injected.status, injected.code, injected.message ?? `注入的错误 ${injected.code}`, injected.retryAfter ? { retryAfter: injected.retryAfter } : {});
    }
    const requireToken = () => {
      if (!auth.startsWith('Bearer ')) { error(401, 'cli_token_missing', '缺少命令行令牌，请先运行 seewow auth login。'); return false; }
      if (auth.slice(7) !== state.token && !state.olderTokens.includes(auth.slice(7))) { error(401, 'cli_token_invalid', '命令行令牌无效，请重新运行 seewow auth login。'); return false; }
      if (state.revoked) { error(401, 'cli_token_revoked', '命令行令牌已被撤销，请重新运行 seewow auth login。'); return false; }
      return true;
    };
    const draftId = path.split('/')[4] ? decodeURIComponent(path.split('/')[4]) : null;
    const row = draftId ? state.drafts.get(draftId) : null;

    switch (route) {
      case 'deviceCode':
        state.deviceRequest = body;
        return send(200, {
          deviceCode: FAKE_DEVICE_CODE, userCode: 'WDJB-MJHT', verificationUri: `${state.url}/cli/authorize`,
          verificationUriComplete: `${state.url}/cli/authorize?code=WDJB-MJHT`, interval: 0, expiresIn: 600, requestedScopes: body?.scopes ?? [],
        });
      case 'deviceToken': {
        if (body?.deviceCode !== FAKE_DEVICE_CODE) return error(400, 'invalid_grant', '设备码无效。');
        if (opts.deviceResult === 'deny') return error(400, 'access_denied', '对方在确认页点了拒绝。');
        if (opts.deviceResult === 'expire') return error(400, 'expired_token', '确认码已过期，请重新登录。');
        if (opts.slowDownOnce && !state.slowDownSent) { state.slowDownSent = true; return error(400, 'slow_down', '轮询太快，请放慢。'); }
        if (state.polls < (opts.pendingPolls ?? 1)) { state.polls += 1; return error(400, 'authorization_pending', '等待确认中。'); }
        const requested = state.deviceRequest?.scopes ?? ['drafts:write'];
        state.scopes = opts.scopes ?? requested;
        if (state.deviceRequest?.principal === 'platform') state.principal = { kind: 'platform', name: '平台自营' };
        return send(200, {
          accessToken: state.token, tokenType: 'Bearer', tokenId: 'tok_1', tokenPrefix: state.token.slice(0, 12),
          expiresAt: '2099-01-01T00:00:00.000Z', scopes: state.scopes, principal: state.principal, user: { id: 'u_1', name: '张三' },
        });
      }
      case 'whoami':
        if (!requireToken()) return;
        return send(200, {
          user: { id: 'u_1', name: '张三' }, principal: state.principal, scopes: state.scopes, effectiveScopes: state.effectiveScopes ?? state.scopes,
          tokenId: 'tok_1', tokenPrefix: state.token.slice(0, 12), expiresAt: '2099-01-01T00:00:00.000Z',
        });
      case 'revoke':
        if (!requireToken()) return;
        state.revokedTokens.push(auth.slice(7));
        if (auth.slice(7) === state.token) state.revoked = true;
        else state.olderTokens = state.olderTokens.filter((item) => item !== auth.slice(7));
        return send(200, { revoked: true });
      case 'options':
        if (!requireToken()) return;
        return send(200, state.options);
      case 'list':
        if (!requireToken()) return;
        return send(200, { items: [...state.drafts.values()].map((item) => ({ id: item.id, title: item.content.title, status: item.status, rejectReason: item.rejectReason ?? null, liveTemplateId: null, revisionOfId: null, coverUrl: null, updatedAt: now(), submittedAt: null, retiredAt: null, retiredReason: null, clonedFromId: null })) });
      case 'create': {
        if (!requireToken()) return;
        const key = request.headers['idempotency-key'];
        if (key && state.idempotency.has(key)) return send(200, detailOf(state.drafts.get(state.idempotency.get(key))), { 'Idempotent-Replayed': 'true' });
        const id = `sub_${state.nextId++}`;
        const created = { id, status: 'draft', version: 1, contentRevision: 1, content: normalizeContent(body?.content) };
        state.drafts.set(id, created);
        if (key) state.idempotency.set(key, id);
        return send(201, detailOf(created));
      }
      case 'get':
        if (!requireToken()) return;
        if (!row) return error(404, 'template_submission_not_found', '投稿不存在。');
        return send(200, detailOf(row));
      case 'save':
        if (!requireToken()) return;
        if (!row) return error(404, 'template_submission_not_found', '投稿不存在。');
        if (body?.version !== row.version) return error(409, 'draft_version_conflict', '草稿已被修改，请重新拉取后再保存。');
        if (row.status !== 'draft' && row.status !== 'rejected') return error(409, 'template_submission_locked', '审核中的投稿不能修改。');
        row.content = normalizeContent(body.content);
        row.version += 1;
        row.contentRevision += 1;
        return send(200, detailOf(row));
      case 'intent': {
        if (!requireToken()) return;
        if (!row) return error(404, 'template_submission_not_found', '投稿不存在。');
        const intentId = `asset_${state.nextId++}`;
        state.intents.set(intentId, { ...body, received: 0 });
        return send(201, { uploadUrl: `/api/cli/template-drafts/${encodeURIComponent(draftId)}/media/${intentId}/content`, headers: { 'Content-Type': body.mimeType }, intentId });
      }
      case 'content': {
        if (!requireToken()) return;
        const intentId = path.split('/')[6];
        const intent = state.intents.get(intentId);
        if (!intent) return error(404, 'upload_intent_not_found', '上传记录不存在。');
        if (raw.length !== intent.sizeBytes) return error(400, 'template_submission_invalid', '文件没有传完整，请重新上传。');
        intent.received = raw.length;
        return send(200, { ok: true });
      }
      case 'complete': {
        if (!requireToken()) return;
        const intent = state.intents.get(body?.intentId);
        if (!intent || !intent.received) return error(400, 'template_submission_invalid', '素材还没上传。');
        return send(200, { assetId: body.intentId, url: `https://media.example.invalid/${body.intentId}`, kind: intent.mimeType.startsWith('video/') ? 'video' : 'image', mimeType: intent.mimeType });
      }
      case 'submit':
        if (!requireToken()) return;
        if (!(state.effectiveScopes ?? state.scopes).includes('drafts:submit')) return error(404, 'not_found', 'Route not found.');
        if (!row) return error(404, 'template_submission_not_found', '投稿不存在。');
        if (row.contentRevision !== body?.expectedContentRevision) return error(409, 'draft_content_changed', '内容已变。');
        if (row.version !== body?.version) return error(409, 'draft_version_conflict', '版本已变。');
        if (row.status !== 'draft' && row.status !== 'rejected') return error(409, 'template_submission_locked', '这条投稿已经在审核中。');
        row.status = 'pending';
        row.version += 1;
        row.rejectReason = null;
        row.submittedAt = now();
        return send(200, detailOf(row));
      case 'withdraw':
        if (!requireToken()) return;
        if (!row) return error(404, 'template_submission_not_found', '投稿不存在。');
        if (row.status !== 'pending') return error(409, 'template_submission_locked', '只有审核中的投稿可以撤回。');
        if (row.version !== body?.version) return error(409, 'draft_version_conflict', '版本已变。');
        row.status = 'draft';
        row.version += 1;
        return send(200, detailOf(row));
      default:
        return error(404, 'not_found', 'Route not found.');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  state.url = `http://127.0.0.1:${server.address().port}`;
  return {
    url: state.url,
    state,
    /**
     * 模拟运营驳回（同服务端 rejectTemplateSubmission：只认审核中，status → rejected、version +1，contentRevision 不动）。
     * 驳回后可以直接改了再 push / 再提审。
     */
    reject(id, reason = '样片和脚本对不上') {
      const draft = state.drafts.get(id);
      if (!draft || draft.status !== 'pending') throw new Error(`mock reject：${id} 不在审核中`);
      draft.status = 'rejected';
      draft.rejectReason = reason;
      draft.version += 1;
    },
    /** 模拟有人在网页上改了草稿内容（version 与 contentRevision 都前进）。 */
    webEdit(id, patch = {}) {
      const draft = state.drafts.get(id);
      draft.content = { ...draft.content, ...patch };
      draft.version += 1;
      draft.contentRevision += 1;
    },
    requestsFor(route) {
      return state.requests.filter((item) => route(item));
    },
    close: () => new Promise((done) => server.close(done)),
  };
};

/** 直接写一份 file 存放的凭据（跳过登录流程）。 */
export const writeFileCredentials = (home, { apiUrl, token, profile = 'default', scopes = ['drafts:write', 'drafts:submit'] }) => {
  const dir = join(home, 'config', 'seewow', 'cli');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${profile}.json`);
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1, profile, apiUrl, store: 'file', tokenId: 'tok_1', tokenPrefix: token.slice(0, 12), expiresAt: '2099-01-01T00:00:00.000Z',
    scopes, principal: { kind: 'partner', partnerChannelId: 'pc_test', name: '测试汽车服务' }, user: { id: 'u_1', name: '张三' }, savedAt: '2026-10-16T00:00:00.000Z', token,
  }), { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
};
