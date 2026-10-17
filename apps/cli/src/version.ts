// 构建时由 esbuild define 注入 package.json 的 version；直接跑源码（测试）时是开发版本号。
declare const __SEEWOW_CLI_VERSION__: string | undefined;

export const CLI_VERSION: string = typeof __SEEWOW_CLI_VERSION__ === 'string' ? __SEEWOW_CLI_VERSION__ : '0.0.0-dev';
export const CLI_CLIENT_NAME = 'seewow-cli';
