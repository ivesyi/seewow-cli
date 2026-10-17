// 统一脱敏层（S10）：任何写到 stdout / stderr 的内容都先过这里。
// - 形如 swc_ 的令牌一律只留前 12 位（swc_ + 8 位），后面换成 ****；
// - 运行中拿到的其他秘密（deviceCode、SEEWOW_TOKEN 等）登记后整串替换，只留前 4 位；
// - Authorization / Bearer 后面的值一律打码。
// installRedaction() 在入口第一行把 process.stdout.write / process.stderr.write 包起来，
// 所以 console.*、报错堆栈、--verbose 请求日志、--json 输出都走同一道闸。

const TOKEN_LIKE = /swc_[A-Za-z0-9_-]{9,}/g;
const BEARER_VALUE = /\b(Bearer\s+)(?!swc_\*\*\*\*)(?!swc_[A-Za-z0-9_-]{8}\*\*\*\*)[^\s"',;\])}]+/gi;
const SHOWN_TOKEN_CHARS = 12;

const secrets = new Set<string>();

const maskSecret = (secret: string): string =>
  secret.startsWith('swc_') ? `${secret.slice(0, SHOWN_TOKEN_CHARS)}****` : `${secret.slice(0, 4)}****`;

/** 登记一个运行中拿到的秘密；之后任何输出里出现它都会被打码。太短的值不登记（避免把普通字词打码）。 */
export const registerSecret = (value: unknown): void => {
  if (typeof value === 'string' && value.length >= 8) secrets.add(value);
};

/** 令牌展示形态：前 12 位 + ****。 */
export const tokenDisplay = (token: string): string => maskSecret(token);

export const redact = (text: string): string => {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(maskSecret(secret));
  }
  return out
    .replace(TOKEN_LIKE, (match) => `${match.slice(0, SHOWN_TOKEN_CHARS)}****`)
    .replace(BEARER_VALUE, (_match, prefix: string) => `${prefix}swc_****`);
};

type WriteFn = (chunk: unknown, encoding?: unknown, callback?: unknown) => boolean;

const wrapStream = (stream: NodeJS.WriteStream): void => {
  const original = stream.write.bind(stream) as WriteFn;
  const wrapped: WriteFn = (chunk, encoding, callback) => {
    let text: unknown = chunk;
    if (typeof chunk === 'string') text = redact(chunk);
    else if (chunk instanceof Uint8Array) text = redact(Buffer.from(chunk).toString('utf8'));
    if (typeof encoding === 'function') return original(text, encoding);
    return original(text, typeof chunk === 'string' ? encoding : undefined, callback);
  };
  (stream as unknown as { write: WriteFn }).write = wrapped;
};

let installed = false;
/** 入口第一行调用；幂等。 */
export const installRedaction = (): void => {
  if (installed) return;
  installed = true;
  wrapStream(process.stdout);
  wrapStream(process.stderr);
};
