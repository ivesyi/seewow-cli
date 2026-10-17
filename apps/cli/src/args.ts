// 极简参数解析（零依赖）：--flag、--flag=value、--flag value、-h/-v；未知参数报用法错（退出码 2）。
import { usageError } from './errors.ts';

export type FlagType = 'boolean' | 'string';
export type FlagSpec = Record<string, FlagType>;
export type ParsedArgs = { positionals: string[]; flags: Record<string, string | boolean> };

const SHORT: Record<string, string> = { h: 'help', v: 'version', y: 'yes', q: 'quiet' };

export const parseArgs = (argv: string[], spec: FlagSpec): ParsedArgs => {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      const type = spec[name];
      if (!type) throw usageError('unknown_flag', `不认识的参数：--${name}`, '运行 seewow --help 查看用法。');
      if (type === 'boolean') {
        if (eq >= 0) throw usageError('invalid_flag', `--${name} 不带值。`);
        flags[name] = true;
      } else {
        const value = eq >= 0 ? arg.slice(eq + 1) : argv[index + 1];
        if (value === undefined || (eq < 0 && value.startsWith('--'))) throw usageError('missing_flag_value', `--${name} 需要一个值。`);
        if (eq < 0) index += 1;
        flags[name] = value;
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length === 2 && SHORT[arg[1]]) {
      const name = SHORT[arg[1]];
      if (spec[name] !== 'boolean') throw usageError('unknown_flag', `不认识的参数：${arg}`);
      flags[name] = true;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') throw usageError('unknown_flag', `不认识的参数：${arg}`, '运行 seewow --help 查看用法。');
    positionals.push(arg);
  }
  return { positionals, flags };
};
