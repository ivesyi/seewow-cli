# @seewow/cli

Seewow 命令行：在终端里授权登录、把模板草稿（脚本、台词、素材、样片、封面）上传到 Seewow，并直接提交审核。
适合合作伙伴批量投稿，也适合让 agent / CI 帮你维护模板。

- 单文件、零运行时依赖，需要 Node.js 20 及以上。
- 不会自动更新，运行时不下载任何代码。每个版本都由公开仓库的 GitHub Actions 发布，带 npm provenance。
- 上架仍由 Seewow 运营在管理端审核、填写模型与定价；草稿授权只用于草稿和提审，生成消费另行授权。

## 安装与运行

请锁定版本使用（把 `0.1.0` 换成你要用的版本）：

```bash
npx @seewow/cli@0.1.0 --help
# 或全局安装
npm install -g @seewow/cli@0.1.0
seewow --help
```

每个版本的 release 说明里附了 `dist/seewow.mjs` 的 sha256，可以自己核对。

## 登录

```bash
seewow auth login
```

命令行会打印一个确认页地址和 8 位确认码（例如 `WDJB-MJHT`，10 分钟内有效），并尽量帮你打开浏览器。
在任意**已登录 Seewow** 的手机或电脑上打开地址、核对确认码和申请的权限，点「允许」。

- 默认申请两档权限：读写模板草稿、**直接提交审核**。
- `--no-submit`：只申请草稿读写，不能提审。**给 agent / CI 长期用的令牌建议加这个**，提审留给人来做。
- `--as partner|platform`：指定这把令牌代表哪个身份（合作伙伴 / 平台自营，后者只有被授权的平台运营有）。
- `--profile <名字>`：多账号，各存各的。
- 令牌 30 天固定有效、不续期，到期重新 `auth login`。不是你本人刚发起的登录，请在确认页点「拒绝」。

```bash
seewow auth status     # 账号、身份、权限、令牌前 12 位、存放位置、过期时间
seewow auth logout     # 服务端撤销 + 删除本地令牌
```

网页上「已授权的 Seewow CLI」可以随时查看和撤销令牌。

### 令牌存在哪

- macOS：默认存系统钥匙串（服务名 `seewow-cli`，账户 = profile 名）。钥匙串锁着时（非交互终端常见）会直接报错（退出码 4），
  可以先解锁，或改用 `--store file`。
- 其他系统或 `--store file`：`~/.config/seewow/cli/<profile>.json`（遵守 `XDG_CONFIG_HOME`），目录 0700、文件 0600；
  权限被改宽了会拒绝读取。
- 环境变量 `SEEWOW_TOKEN` 优先于本机存放（给 CI / 沙箱用）。注意它会出现在进程环境里：别 `echo`、别写进日志。
- 命令行任何输出（包括 `--verbose`、`--json`、报错）都只显示令牌前 12 位。令牌**不会**写进你的模板目录。

## 模板包

```bash
seewow template init my-template
```

生成的目录：

```
my-template/
  seewow-template.json   # 清单
  media/                 # 素材：封面、样片、每个槽位的默认图
  .seewow/state.json     # 草稿 id、版本、已上传文件的哈希（自动生成，已写进 .gitignore，不含令牌）
```

清单示例（字段与网页投稿一一对应，素材写包内相对路径）：

```json
{
  "title": "新车到店",
  "industryId": "auto",
  "catalogIndustryId": null,
  "categoryId": null,
  "script": "镜头一：【素材：车】缓缓驶入展厅，店员说【台词：1】",
  "lines": [{ "text": "欢迎来看新车" }],
  "slots": [{ "label": "车", "typeId": "auto.car", "replaceable": true, "hint": "换成你的车", "image": "media/car.jpg" }],
  "sampleVideo": "media/sample.mp4",
  "cover": "media/cover.jpg",
  "remark": ""
}
```

- 只认上面这些字段。出现模型、provider、时长、积分、节点参数等任何其他字段（如 `videoModel`、`fixedCredits`、
  `durationSeconds`、槽位 `kind`）会直接报 `field_not_allowed`，什么都不上传——这些由运营在管理端批准时填。
- `industryId`、`slots[].typeId` 的可选值用 `seewow template options` 查。
- 素材路径只能在包内（不能 `..`、不能经符号链接指到包外）；按文件头判断类型：图片 JPEG/PNG/WebP ≤ 15MB，样片 MP4/MOV ≤ 50MB。

## 命令

```
seewow template options                    # 可投行业 + 素材类型
seewow template validate <目录> [--offline] # 本地校验（与服务端同一份规则；登录后联网校验行业与素材类型）
seewow template push <目录>                 # 新建或更新草稿，只重传变了的文件
    --dry-run            只打印将做什么
    --allow-incomplete   校验还有错也先存草稿
    --force              服务端草稿被网页改过时，用本地覆盖（先列出会被覆盖的字段）
    --new                不管 .seewow/state.json，新建一份草稿
    --submit [--yes]     推完直接提交审核
seewow template submit <目录|草稿id> [--yes] [--dry-run]
seewow template withdraw <草稿id|目录> [--yes] [--dry-run]   # 审核中 → 草稿
seewow template list [--status draft,pending,rejected,approved]
seewow template show <草稿id|目录>
```

全局参数：`--api-url`（默认 `https://api.seewow.cc`）、`--profile`、`--json`、`--quiet`、`--verbose`。

### 提交审核前会检查什么

1. 令牌带提审权限、提审功能已开放；
2. 本地校验 0 错误；传目录时，目录内容必须和上次推送的一致（不一致先 `push`）；
3. 钉住刚推上去的版本：推完之后有人在网页上改过，会拒绝提交，不会把你没看过的内容送审；
4. 终端里要你输入 `y` 确认；非交互环境或 `--json` 必须带 `--yes`；`--dry-run` 只打印将提交什么。

误提了可以 `seewow template withdraw <草稿id>` 撤回。

### 大文件

50MB 样片上传到 100% 后，服务器还要几分钟转存，命令行会提示「服务器转存中」，请别中断（客户端超时 15 分钟）。
失败了直接重新 `push`，已传完的文件会跳过。

## 给 agent / CI：`--json` 与退出码

`--json` 时 stdout 只输出 NDJSON：中间可能有事件行（如登录时的 `{"event":"device_code",...}`，把地址和确认码转给人），
**最后一行是结果**：成功 `{"ok":true,"command":"…",...}`，失败 `{"ok":false,"command":"…","error":{"code","message","hint","exitCode","retryAfter?"}}`。
进度和提示都在 stderr。

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 未知错误（加 `--verbose` 看详情） |
| 2 | 用法错误，或缺确认（`confirmation_required`：加 `--yes`） |
| 3 | 本地或服务端校验没过 |
| 4 | 未登录、令牌失效/过期/被撤销、钥匙串不可用 |
| 5 | 权限不足或功能未开放（如令牌没有提审权限）；草稿/上传记录不存在或不属于当前主体（服务端 404 不暴露存在） |
| 6 | 冲突：草稿内容在别处被改过、草稿被锁定、目录与草稿不一致 |
| 7 | 网络或服务端 5xx，可重试 |
| 8 | 限流或配额（看 `retryAfter`） |

## 常见错误

- `keychain_unavailable`：钥匙串锁着。解锁后重试，或 `seewow auth login --store file`。
- `cli_token_expired` / `cli_token_revoked`：重新 `seewow auth login`。
- `cli_scope_missing`：令牌登录时去掉了提审权限，重新登录（不带 `--no-submit`），确认页保持勾选「可以直接提交审核」。
- `not_found`（退出码 5）：命令行功能或提审功能还没对你开放，联系平台运营。
- `draft_version_conflict`：你上次推送之后，草稿**内容**在网页上被改过（按 `contentRevision` 判）。`seewow template show <id>` 看看，确认要覆盖再 `push --force`（会先列出服务端与本地清单不同的字段）。只是被驳回、撤回这类状态变化不算冲突，改完直接 `push` 即可。
- `template_submission_not_found` / `upload_intent_not_found`（退出码 5）：草稿或上传记录不存在，或不属于当前主体——看 `seewow auth status` 的主体是不是推这个包时用的那个。
- `draft_content_changed`：推送后内容又被改过，重新 `push` 再提审。
- `field_not_allowed`：清单里有不该出现的字段，按提示删掉。
- `network_error`（退出码 7）：在沙箱或公司网络里运行时，请放行 `api.seewow.cc`（HTTPS 443）。
- `rate_limited` / `cli_quota_exceeded`（退出码 8）：按 `retryAfter` 秒数稍后再试。

## 生视频、生图片和素材审核

```bash
seewow auth login --generate
seewow models
seewow video create --model doubao_seedance_2_mini --prompt '一只橘猫在窗台上伸懒腰' --resolution 480p --duration 4 --download ./成片
seewow image create --model doubao_seedream_5_pro --prompt '一只橘猫，白色背景' --download ./图片
seewow asset audit https://example.com/参考.jpg --type image
seewow usage --since 2026-10-26 --json
```

网页核对确认码并选择付费工作空间。生成权限与草稿权限分开授权，可用不同 `--profile` 保存。需要该空间的自由创作权限。

`--image URL`、`--video URL`、`--audio-url URL` 可重复，顺序保留；`--audio` / `--no-audio` 控制视频声音。`--json-body 请求.json` 接收可定价的原生请求体，提示词与参数原样发送，不能与模型或内容参数混用。默认等待完成，`--no-wait` 只提交，随后 `video status <id>` / `image status <id>` / `asset status <id>` 查询。

提交前冻结积分，成功按实际消耗结算，多退少补，明确失败全退。Pro首张实际参考免费，其余收费参考单价尚未核实，目前按每张0.36元成本上界补收并与已知成本分列。缺实际用量时保留冻结，不拿冻结额当实收。`needs_reconcile` 保留冻结，请将任务id交给管理员核对，避免重复提交。失败会显示中文原因，排队满请稍后重试。在网页设置「已授权的 Seewow CLI」可撤销对应机器/空间令牌，或运行 `seewow auth logout`。关掉终端不取消任务。结果链接有时效，请及时 `--download` 保存；下载不携带账号令牌。
