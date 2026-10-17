// 输出：人看的文字与给 agent 的 NDJSON 分流（方案 §4.4）。
// --json：stdout 只出 NDJSON（中间可有事件行，最后一行是结果），所有进度与提示走 stderr。
// 非 --json：结果文字走 stdout，进度与提示走 stderr。--quiet 只压进度/提示，不压结果与错误。
// 所有出口最终都经 redact.ts 包过的 process.stdout/stderr.write。
import { CliError, EXIT, cliWording } from './errors.ts';

export type OutputOptions = { json: boolean; quiet: boolean; verbose: boolean };

export class Output {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly verbose: boolean;
  command = '';

  constructor(options: OutputOptions) {
    this.json = options.json;
    this.quiet = options.quiet;
    this.verbose = options.verbose;
  }

  /** 进度、提示（stderr）。 */
  info(message: string): void {
    if (!this.quiet) process.stderr.write(`${message}\n`);
  }

  /** 警告（stderr，--quiet 也显示）。 */
  warn(message: string): void {
    process.stderr.write(`! ${message}\n`);
  }

  /** --verbose 才打的调试信息（stderr，同样脱敏）。 */
  debug(message: string): void {
    if (this.verbose) process.stderr.write(`[debug] ${message}\n`);
  }

  /** 中间事件：--json 时写一行 NDJSON 到 stdout；否则把 human 文字写到 stderr。 */
  event(name: string, data: Record<string, unknown>, human?: string): void {
    if (this.json) process.stdout.write(`${JSON.stringify({ event: name, ...data })}\n`);
    else if (human) process.stderr.write(`${human}\n`);
  }

  /** 最终结果：--json 时写一行 {ok:true,...}；否则 human 文字写到 stdout。 */
  result(data: Record<string, unknown>, human?: string): void {
    if (this.json) process.stdout.write(`${JSON.stringify({ ok: true, command: this.command, ...data })}\n`);
    else if (human) process.stdout.write(`${human}\n`);
  }

  /** 错误：--json 时 stdout 最后一行是 {ok:false,error}，同时 stderr 给人看。返回退出码。 */
  error(error: unknown): number {
    const cliError = error instanceof CliError ? error : null;
    const exitCode = cliError ? cliError.exitCode : EXIT.UNKNOWN;
    const code = cliError ? cliError.code : 'unexpected_error';
    const message = error instanceof Error ? error.message : String(error);
    if (this.json) {
      const payload: Record<string, unknown> = { code, message, exitCode };
      if (cliError?.hint) payload.hint = cliError.hint;
      if (cliError?.retryAfter !== undefined) payload.retryAfter = cliError.retryAfter;
      if (cliError?.status !== undefined) payload.status = cliError.status;
      if (cliError?.issues?.length) payload.issues = cliError.issues;
      if (cliError?.extra) Object.assign(payload, cliError.extra);
      process.stdout.write(`${JSON.stringify({ ok: false, command: this.command, error: payload })}\n`);
    }
    const lines = [`✗ ${message}${code && code !== 'unexpected_error' ? `（${code}）` : ''}`];
    if (cliError?.issues?.length) for (const issue of cliError.issues) lines.push(`  - ${issue.field ? `${issue.field}：` : ''}${cliWording(issue.message)}（${issue.code}）`);
    if (cliError?.hint) lines.push(`  提示：${cliError.hint}`);
    if (!cliError && this.verbose && error instanceof Error && error.stack) lines.push(error.stack);
    if (!cliError && !this.verbose) lines.push('  提示：加 --verbose 查看详细信息。');
    process.stderr.write(`${lines.join('\n')}\n`);
    return exitCode;
  }
}
