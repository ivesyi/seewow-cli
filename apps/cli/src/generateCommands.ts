import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ParsedArgs } from './args.ts';
import { requireSession, type CommandContext } from './context.ts';
import { CliError, EXIT, usageError } from './errors.ts';

type Task = { id: string; kind: string; apiName: string; status: string; upstreamTaskId: string | null; failureCode?: string | null; failureMessage?: string | null; manualRequired?: boolean; lastQueryFailureCode?: string | null; createdAt: string; frozenCredits: number; settledCredits: number; resultUrls: string[] };
// 对旧服务响应也只输出用户积分与用量，不透出运营成本列。
const publicTask = (task: Task): Task => Object.fromEntries([
  'id','kind','apiName','status','upstreamTaskId','failureCode','failureMessage','createdAt','settledAt',
  'frozenCredits','settledCredits','shortfallCredits','estimatedTokens','frozenTokens','actualTokens',
  'actualInputImages','actualImages','billingBasis','resultUrls','manualRequired','lastQueryFailureCode','lastQueryFailureAt',
].filter(key => key in task).map(key => [key, task[key as keyof Task]])) as Task;
const prefix = '/api/cli/generate';
const taskText = (task: Task) => [`任务：${task.id}（${task.status}）`, `冻结 ${task.frozenCredits} 积分，已扣 ${task.settledCredits} 积分`, ...(task.failureMessage ? [task.failureMessage] : []), ...(task.failureCode ? [`原因：${task.failureCode}`] : []), ...(task.manualRequired ? ['任务已超过7天，请联系管理员人工核对。'] : []), ...task.resultUrls].join('\n');
export const generationFlags = { model: 'string', prompt: 'string', resolution: 'string', ratio: 'string', duration: 'string', image: 'string', video: 'string', 'audio-url': 'string', audio: 'boolean', 'no-audio': 'boolean', 'json-body': 'string', 'no-wait': 'boolean', download: 'string' } as const;
async function waitFor(ctx: CommandContext, path: string, task: Task): Promise<Task> {
  const { client } = requireSession(ctx);
  while (task.status === 'running' || task.status === 'submitting') {
    ctx.out.info(`任务 ${task.id}：${task.status}（Ctrl+C 后可用 status 查询，任务仍会结算）`);
    await new Promise(resolve => setTimeout(resolve, 5000));
    ({ data: task } = await client.json<Task>('GET', `${path}/${encodeURIComponent(task.id)}`));
  }
  return task;
}
export async function generationCreate(ctx: CommandContext, args: ParsedArgs, kind: 'video' | 'image'): Promise<number> {
  if (args.positionals.length) throw usageError('invalid_argument', 'create 不接受位置参数。');
  let body: Record<string, unknown>;
  if (typeof args.flags['json-body'] === 'string') {
    const mixed = Object.keys(args.flags).filter(key => Object.keys(generationFlags).includes(key) && !['json-body','no-wait','download'].includes(key));
    if (mixed.length) throw usageError('invalid_flag', '--json-body 不能与模型或内容参数同用。');
    try { body = JSON.parse(await readFile(args.flags['json-body'], 'utf8')); }
    catch { throw usageError('invalid_json_body', '无法读取 JSON 请求文件。'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw usageError('invalid_json_body', 'JSON 请求文件必须包含一个对象。');
  } else {
    if (!args.flags.model) throw usageError('missing_model', '请用 --model 指定模型，运行 seewow models 查看。');
    body = { api_name: args.flags.model };
    for (const [flag, key] of [['prompt','prompt'],['resolution','resolution'],['ratio','aspect_ratio']]) if (args.flags[flag] !== undefined) body[key] = args.flags[flag];
    if (args.flags.duration !== undefined) {
      const duration = Number(args.flags.duration);
      if (!Number.isInteger(duration)) throw usageError('invalid_duration', '--duration 必须是整数秒。');
      body.duration = duration;
    }
    for (const [flag,key] of [['image','image_urls'],['video','video_urls'],['audio-url','audio_urls']]) if (args.repeated?.[flag]) body[key] = args.repeated[flag];
    if (args.flags.audio && args.flags['no-audio']) throw usageError('invalid_flag', '--audio 与 --no-audio 不能同用。');
    if (args.flags.audio || args.flags['no-audio']) body.kwargs = { generate_audio: !args.flags['no-audio'] };
  }
  if (args.flags['no-wait'] && args.flags.download) throw usageError('invalid_flag', '--download 需要等待生成完成。');
  const { client } = requireSession(ctx);
  let { data: task } = await client.json<Task>('POST', `${prefix}/${kind}`, { body });
  if (!args.flags['no-wait']) task = await waitFor(ctx, `${prefix}/${kind}`, task);
  const downloads: string[] = [];
  if (typeof args.flags.download === 'string' && task.status === 'completed') {
    await mkdir(args.flags.download, { recursive: true });
    for (const [index, url] of task.resultUrls.entries()) {
      // 成品域名独立请求，绝不携带 Seewow 令牌。
      const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!response.ok) throw new CliError(EXIT.NETWORK, 'download_failed', `下载失败，链接可能已过期。任务：${task.id}`);
      const mime = response.headers.get('content-type') ?? '';
      const ext = kind === 'video' ? 'mp4' : mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
      const target = join(args.flags.download, `${task.id.replace(/[^a-zA-Z0-9_-]/g,'_')}-${index+1}.${ext}`);
      await writeFile(target, new Uint8Array(await response.arrayBuffer()));
      downloads.push(target);
    }
  }
  ctx.out.result({ ...publicTask(task), downloads }, `${taskText(task)}${downloads.length ? `\n已保存：${downloads.join('、')}` : ''}`);
  return task.status === 'failed' ? EXIT.VALIDATION : task.status === 'needs_reconcile' ? EXIT.CONFLICT : EXIT.OK;
}
export async function generationStatus(ctx: CommandContext, args: ParsedArgs, kind: 'video' | 'image' | 'asset-audit'): Promise<number> {
  if (args.positionals.length !== 1) throw usageError('missing_id', '请提供任务 id。');
  const { data: task } = await requireSession(ctx).client.json<Task>('GET', `${prefix}/${kind}/${encodeURIComponent(args.positionals[0])}`);
  ctx.out.result(publicTask(task), taskText(task));
  return EXIT.OK;
}
export async function assetAudit(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  if (args.positionals.length !== 1 || (args.flags.type !== undefined && !['image','video'].includes(String(args.flags.type)))) throw usageError('invalid_argument', '请提供素材 URL，--type 只能是 image 或 video。');
  const { data: submitted } = await requireSession(ctx).client.json<Task>('POST', `${prefix}/asset-audit`, { body: { url: args.positionals[0], AssetType: args.flags.type === 'video' ? 'Video' : 'Image' } });
  const task = args.flags['no-wait'] ? submitted : await waitFor(ctx, `${prefix}/asset-audit`, submitted);
  ctx.out.result(publicTask(task), taskText(task));
  return task.status === 'failed' ? EXIT.VALIDATION : task.status === 'needs_reconcile' ? EXIT.CONFLICT : EXIT.OK;
}
export async function generationUsage(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  if (args.positionals.length) throw usageError('invalid_argument', 'usage 不接受位置参数。');
  const query = new URLSearchParams();
  if (typeof args.flags.since === 'string') query.set('since', args.flags.since);
  if (typeof args.flags.cursor === 'string') query.set('cursor', args.flags.cursor);
  const { data } = await requireSession(ctx).client.json<{ items: Task[]; nextCursor: string | null }>('GET', `${prefix}/usage?${query}`);
  ctx.out.result({ ...data, items: data.items.map(publicTask) }, data.items.map(task => `${task.createdAt} ${task.apiName} ${task.kind}\n${taskText(task)}\n上游任务号：${task.upstreamTaskId ?? '未确认'}`).join('\n\n') + (data.nextCursor ? `\n下一页：seewow usage --cursor ${data.nextCursor}` : ''));
  return EXIT.OK;
}
export async function generationModels(ctx: CommandContext): Promise<number> {
  const { data } = await requireSession(ctx).client.json<{ items: unknown[] }>('GET', `${prefix}/models`);
  ctx.out.result(data, JSON.stringify(data, null, 2));
  return EXIT.OK;
}
