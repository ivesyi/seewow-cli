// 模板包状态 .seewow/state.json：草稿 id、version / contentRevision、文件 sha256 → 素材 id。
// 只放这些，**不放令牌**（S9）。init 时会把 .seewow/ 写进包目录的 .gitignore。
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, EXIT } from './errors.ts';

export const STATE_DIR = '.seewow';
export const STATE_FILE = 'state.json';

export type StateAsset = { assetId: string; mimeType: string; sizeBytes: number; kind: 'image' | 'video'; uploadedAt: string };
export type PackageState = {
  schemaVersion: 1;
  apiUrl: string | null;
  /** partner:<partnerChannelId> / platform——素材归属按主体，换主体后旧素材 id 不能用。 */
  principalKey: string | null;
  draftId: string | null;
  version: number | null;
  contentRevision: number | null;
  /** 最近一次 push 成功写上去的内容哈希（键排序 JSON 的 sha256）。 */
  lastPushedContentHash: string | null;
  assets: Record<string, StateAsset>;
};

export const emptyState = (): PackageState => ({
  schemaVersion: 1, apiUrl: null, principalKey: null, draftId: null, version: null, contentRevision: null, lastPushedContentHash: null, assets: {},
});

export const statePath = (pkgDir: string): string => join(pkgDir, STATE_DIR, STATE_FILE);

export const readState = (pkgDir: string): PackageState => {
  const path = statePath(pkgDir);
  if (!existsSync(path)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PackageState>;
    const base = emptyState();
    return {
      ...base,
      ...parsed,
      schemaVersion: 1,
      assets: parsed.assets && typeof parsed.assets === 'object' ? parsed.assets : {},
    };
  } catch {
    throw new CliError(EXIT.VALIDATION, 'state_corrupt', `${STATE_DIR}/${STATE_FILE} 读不出来。`, { hint: '删掉它会丢掉草稿关联（下次 push 会新建草稿、重传素材）。' });
  }
};

export const writeState = (pkgDir: string, state: PackageState): void => {
  const dir = join(pkgDir, STATE_DIR);
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new CliError(EXIT.VALIDATION, 'path_outside_package', `${STATE_DIR} 不能是符号链接。`);
  mkdirSync(dir, { recursive: true });
  const path = statePath(pkgDir);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, path);
};
