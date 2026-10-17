// seewow 命令行入口。第一行先装脱敏层（S10），之后任何输出都经过它。
import { parseArgs, type FlagSpec } from './args.ts';
import { authLogin, authLogout, authStatus } from './authCommands.ts';
import type { CommandContext } from './context.ts';
import { CliError, EXIT, usageError } from './errors.ts';
import { Output } from './output.ts';
import { installRedaction } from './redact.ts';
import { templateInit, templateList, templateOptions, templatePush, templateShow, templateSubmit, templateValidate, templateWithdraw } from './templateCommands.ts';
import { CLI_VERSION } from './version.ts';

const GLOBAL_FLAGS: FlagSpec = { 'api-url': 'string', profile: 'string', json: 'boolean', quiet: 'boolean', verbose: 'boolean', help: 'boolean', version: 'boolean' };

type CommandDef = { flags: FlagSpec; usage: string; run: (ctx: CommandContext, args: ReturnType<typeof parseArgs>) => Promise<number> };

const COMMANDS: Record<string, CommandDef> = {
  'auth login': {
    flags: { 'no-submit': 'boolean', as: 'string', store: 'string', 'no-browser': 'boolean' },
    usage: 'seewow auth login [--no-submit] [--as partner|platform] [--store keychain|file] [--no-browser]',
    run: authLogin,
  },
  'auth status': { flags: {}, usage: 'seewow auth status', run: (ctx) => authStatus(ctx) },
  'auth logout': { flags: {}, usage: 'seewow auth logout', run: (ctx) => authLogout(ctx) },
  'template init': { flags: {}, usage: 'seewow template init <目录>', run: templateInit },
  'template options': { flags: {}, usage: 'seewow template options', run: (ctx) => templateOptions(ctx) },
  'template validate': { flags: { offline: 'boolean' }, usage: 'seewow template validate <目录> [--offline]', run: templateValidate },
  'template push': {
    flags: { new: 'boolean', force: 'boolean', 'dry-run': 'boolean', 'allow-incomplete': 'boolean', submit: 'boolean', yes: 'boolean' },
    usage: 'seewow template push <目录> [--new] [--force] [--dry-run] [--allow-incomplete] [--submit [--yes]]',
    run: templatePush,
  },
  'template submit': { flags: { yes: 'boolean', 'dry-run': 'boolean' }, usage: 'seewow template submit <目录|草稿id> [--yes] [--dry-run]', run: templateSubmit },
  'template withdraw': { flags: { yes: 'boolean', 'dry-run': 'boolean' }, usage: 'seewow template withdraw <草稿id|目录> [--yes] [--dry-run]', run: templateWithdraw },
  'template list': { flags: { status: 'string' }, usage: 'seewow template list [--status draft,pending,rejected,approved]', run: templateList },
  'template show': { flags: {}, usage: 'seewow template show <草稿id|目录>', run: templateShow },
};

const HELP = `seewow ${CLI_VERSION} —— Seewow 命令行：授权登录、上传模板草稿、提交审核

用法：
${Object.values(COMMANDS).map((command) => `  ${command.usage}`).join('\n')}

全局参数：
  --api-url <地址>   服务地址（默认 https://api.seewow.cc；也可用环境变量 SEEWOW_API_URL）
  --profile <名字>   多账号，令牌按 profile 分开存放（默认 default）
  --json             stdout 只输出 NDJSON（最后一行是结果），进度走 stderr
  --quiet            不打印进度
  --verbose          打印请求日志（令牌同样打码）
  -h, --help         帮助    -v, --version  版本

退出码：0 成功；1 未知错误；2 用法错误/缺确认（--yes）；3 本地或服务端校验没过；4 未登录/令牌失效/钥匙串不可用；
5 权限不足或功能未开放；6 冲突（版本、锁定）；7 网络或服务端 5xx（可重试）；8 限流或配额。
环境变量 SEEWOW_TOKEN 优先于本机存放的令牌（给 CI/沙箱用，注意别打印它）。`;

const commandKey = (positionals: string[]): string | null => {
  if (positionals.length < 2) return null;
  const key = `${positionals[0]} ${positionals[1]}`;
  return COMMANDS[key] ? key : null;
};

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  installRedaction();
  const json = argv.includes('--json');
  const out = new Output({ json, quiet: argv.includes('--quiet'), verbose: argv.includes('--verbose') });
  try {
    // 先只认全局参数找到子命令，再按子命令的参数表完整解析一遍。
    const loose: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === '--api-url' || arg === '--profile') index += 1;
      else if (!arg.startsWith('-') || arg === '-') loose.push(arg);
    }
    const key = commandKey(loose);
    if (!key) {
      if (argv.includes('--version') || argv.includes('-v')) {
        out.result({ version: CLI_VERSION }, CLI_VERSION);
        return EXIT.OK;
      }
      if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
        process.stdout.write(`${HELP}\n`);
        return EXIT.OK;
      }
      throw usageError('unknown_command', `不认识的命令：${loose.slice(0, 2).join(' ') || argv.join(' ')}`, '运行 seewow --help 查看全部命令。');
    }
    out.command = key;
    const def = COMMANDS[key];
    const args = parseArgs(argv, { ...GLOBAL_FLAGS, ...def.flags });
    if (args.flags.help) {
      process.stdout.write(`用法：${def.usage}\n`);
      return EXIT.OK;
    }
    args.positionals.splice(0, 2);
    const ctx: CommandContext = {
      out,
      env,
      options: {
        apiUrl: typeof args.flags['api-url'] === 'string' ? args.flags['api-url'] : undefined,
        profile: typeof args.flags.profile === 'string' ? args.flags.profile : env.SEEWOW_PROFILE || 'default',
        json,
        quiet: args.flags.quiet === true,
        verbose: args.flags.verbose === true,
      },
      interactive: !json && !!process.stdin.isTTY && !!process.stderr.isTTY,
    };
    return await def.run(ctx, args);
  } catch (error) {
    return out.error(error instanceof CliError || error instanceof Error ? error : new Error(String(error)));
  }
}

const fatal = (error: unknown) => {
  const message = error instanceof Error ? `${error.message}${process.argv.includes('--verbose') && error.stack ? `\n${error.stack}` : ''}` : String(error);
  process.stderr.write(`✗ 意外错误：${message}\n`);
  process.exit(EXIT.UNKNOWN);
};

if (!process.env.SEEWOW_CLI_NO_AUTORUN) {
  installRedaction();
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, fatal);
}
