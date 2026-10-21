# 发版流程

> 一条命令升号，一个 tag 触发发布。**版本号由人决定，发布由 CI 执行。**
> 打包细节见 [m8/spec.md](m8/spec.md)，契约号规则见 [contract.md §6](contract.md)。

## 1. 全景

```text
pnpm release next          ① 升号 + 写 CHANGELOG + 跑四件套 + commit + tag（本地）
git push origin main --follow-tags
        ↓ tag v0.0.3
GitHub Actions             ② 校验 tag ↔ 所有 manifest ↔ tarball 一致
        ↓                  ③ 再跑一遍四件套，组装包
npm trusted publishing     ④ OIDC 换临时凭证 → npm publish（带 provenance）
        ↓                  ⑤ 建 GitHub Release（notes 取自 CHANGELOG）
```

本地一步、CI 一步。本地**不做**任何发布动作，所以没有 token 落在开发者机器上；
CI **不做**任何版本决策，所以不会出现"merge 就自动发一版"。

## 2. 为什么不是一个版本号

仓库里有六类"版本"，语义不同，漏一个都是**静默失败**——包照样能打出来，问题只在装上之后
或 npmjs.com 上才显形：

| # | 是什么 | 在哪 | 谁改 | 漏了会怎样 |
|---|---|---|---|---|
| 1 | **npm 发布版本** | `packages/cli/package.json` | `pnpm release` | npm 上是旧号，`npm i -g` 装到旧包 |
| 2 | 内部包版本（19 个） | `packages/**/package.json` | `pnpm release` | 无功能影响，但仓库内版本对不上 |
| 3 | **契约版本** | `kernel/src/contract.ts` 的 `CONTRACT_VERSION` / `CONTRACT_RANGE` | `pnpm release` | 内核仍自称旧版本 |
| 4 | **manifest 契约范围**（17 个） | 每个 `diorama.contract` | `pnpm release` | **新内核拒绝加载自己的内置插件**（最致命） |
| 5 | 文档里的号 | `contract.md` / `features.md` / `AGENTS.md` / `README.md` | `pnpm release` | 读者看到旧号；README 会发布到 npm |
| 6 | `bin/` 里的号 | `bin/diorama` / `bin/diorama-beta` | 无需改 | 已改成从 `package.json` 读 |

第 3 与第 1 是**同一个号**：`docs/m8/spec.md` 定的"同源同节奏"，pre-1.0 阶段每次发版都算破环，
所以契约号跟着包版本走。想分开的话要改 contract.md §6，那是另一个决定。

`apps/web` 的 `0.0.0` 不在其中——它是页面壳，从不发布。

## 3. 日常发版

```bash
pnpm release next          # 0.0.2 → 0.0.3，也可以写死 pnpm release 0.0.3
```

脚本按顺序做六件事，任何一步失败就停：

1. **要求干净的工作树**——否则散落的改动会被一起提交，tag 指向没人审过的 commit。
2. **算出全部改动**：24 个文件（20 个 manifest + `contract.ts` + 4 个文档）。
3. **写 `CHANGELOG.md`**：从上一个 tag 以来的提交生成，conventional-commit 类型分节，
   解析不了的归到 "Other" 而不是丢掉。
4. **跑四件套**：`pnpm build`、`pnpm test:unit`、`pnpm -r --no-sort run typecheck`。
   e2e 留给 CI（本地跑要 Chromium，慢）。
5. **commit**：`chore(release): 0.0.3`。
6. **打 annotated tag**：`v0.0.3`。

然后：

```bash
git push origin main --follow-tags
```

先看一眼再推：

```bash
pnpm release next --dry-run    # 只打印要改哪些文件
git show --stat v0.0.3         # 推之前审一遍
```

## 4. 发布前的手工检查

`pnpm release` 会跑自动校验，但有两件事只有人能做：

1. **契约变更清单**（`docs/contract.md` §20 起）：把"自上次发版以来的条款"归到新版本号名下。
   脚本改不了这一段——它需要判断哪些条款属于这一版。现状是 §20/§21/§22 都标着
   「未发版，下一个 `0.0.x`」，发版时把标题改成 `## 20. v0.0.2 → v0.0.3 变更清单` 并去掉
   "未发版"字样。
2. **`docs/features.md` 的档位表**：能力从"未来"变成"✅"要人写。

这两件应该在**打 tag 之前**做完，作为普通提交进 `main`，然后才跑 `pnpm release`。

## 5. CI 做什么

`.github/workflows/release.yml`，tag 触发（`workflow_dispatch` 可手动跑一次 dry run）：

| 步骤 | 判据 |
|---|---|
| `verify --tag v0.0.3` | tag 指向 HEAD，且 20 个 manifest + 契约号都等于 `0.0.3` |
| 四件套 | build / 单测 / typecheck / e2e 全绿 |
| `assemble-package.mjs` | 把 `plugins/`、`web/`、`README.md`、`LICENSE` 装进包目录 |
| `verify --tarball` | 包里必须有 README / LICENSE / web/index.html / 插件 manifest 与 client half；`dependencies` 只许第三方 |
| `npm publish` | OIDC，自动带 provenance |
| `gh release create` | notes 取自 `CHANGELOG.md` 对应段落 |

**校验脚本是同一份**（`scripts/release/verify.mjs`）：本地 `pnpm release` 与 CI 用同一套判据，
两边不可能对"可发布"有不同理解。

## 6. 一次性配置（只做一次）

### npm 侧：trusted publisher

npmjs.com → `@diorama-cli/diorama` → Settings → Trusted publishing → 添加：

| 字段 | 值 |
|---|---|
| Provider | GitHub Actions |
| Owner | `diorama-cli` |
| Repository | `diorama` |
| Workflow filename | `release.yml` |
| Environment | 留空 |

配好之后这个包**只接受**这个 workflow 的发布，其他来源一律拒绝。

### GitHub 侧：无需 secret

OIDC 不需要 `NPM_TOKEN`。workflow 自己声明 `permissions: id-token: write` 就够。
**不要在仓库里加 npm token**——加了反而会让 npm 走 token 认证、绕过 OIDC。

### 首次发布要手工 bootstrap

trusted publisher 只能给**已存在**的包配置。如果包还没发过，第一次得用 token 手工发：

```bash
pnpm pack:prepare
cd packages/cli && npm publish --access public
```

`@diorama-cli/diorama` 已经发过 `0.0.1`，所以现在直接配 trusted publisher 即可。

## 7. 踩过的坑

| 症状 | 根因 | 规则 |
|---|---|---|
| 注册表上 README 是 "No README data found!" | npm 只从**包目录**找 README/LICENSE，`files` 字段管不着 | `assemble-package.mjs` 拷进去；判据看 `npm pack --dry-run` 的清单（m8 §5.6） |
| README 里链接全 404 | npmjs.com 上渲染，相对链接的基准是包页面 | 发布副本改写链接（`scripts/readme-for-npm.mjs`） |
| 新内核拒绝加载自己的内置插件 | 某个 manifest 的 `contract` 范围没跟着升 | `verify` 逐个比对 17 个 manifest |
| 升级后 `diorama-beta --version` 报旧号 | `bin/diorama-beta` 曾硬编码 `'0.0.1-beta'` | 已改成从 `package.json` 读 |
| CI 报 `need auth` | 配了 `registry-url`，它会写 token 占位符，让 npm 走 token 认证 | `setup-node` 不写 `registry-url` |
| CI 里 `verify --tag` 说 tag 不指向 HEAD | `checkout` 默认 `fetch-depth: 1` | `fetch-depth: 0` |
| **推了 tag，Actions 毫无反应** | 引入 workflow 的那次 push **不会**触发它自己：GitHub 要在 push 之后才注册 `.github/workflows/*.yml` | 首次推 workflow 之后，再打一次 tag（`git tag -d v0.0.3 && git push origin :v0.0.3` 后重推，或用 `workflow_dispatch` 跑一次确认） |
| **CI 里 `pnpm build` 报 `Failed to import module "unrun"`，本地却正常** | tsdown 按 `process.features.typescript` 选配置加载器：Node ≥ 22.18 用内置的 `native`，更早的版本回退到 `unrun`（一个 **可选** peerDependency，`pnpm install` 不会装它）。本地 Node 22.20 走了 native，CI 的 22.14 走了 unrun | `unrun` 写进根 `devDependencies`；CI 的 Node 也钉到 `22.20.0`，两边走同一条路 |
| 发了同版本号两次 | npm 不允许覆盖已发布版本 | `concurrency` 按 ref 串行；重发只能升号 |
| 文档里残留旧版本号 | 正则锚定错了（行尾、`> ` 前缀、全角标点） | `packages/cli/test/release.test.ts` 用真实文件断言"一处都不许剩" |
| **`npm publish` 报 `ENEEDAUTH`，但 npmjs.com 上明明配了 trusted publisher** | npm 的 `oidc()` 把**所有**失败都吞掉（`log.silly` / `log.verbose` 级别），publish 随后看到没有凭证就报 `ENEEDAUTH`——"没配"与"配错了"给出同一个错误。且 npm < 11.5.1 完全没有 OIDC 代码（Node 22.20 自带 npm 10.9.3） | 先跑 workflow 里的 `Check the trusted-publishing prerequisites`：它手工做一次 id-token 交换并打印 HTTP 状态。`404 package not found` = npm 侧没有匹配的 publisher；`200` 但 publish 仍失败 = 别的问题 |
| OIDC 交换返回 `404 {"message":"OIDC token exchange error - package not found"}` | trusted publisher 的四个字段与这次运行对不上。最常见的是 **Owner 填成个人账号而不是组织**（本仓库属于组织 `diorama-cli`，不是 `zimmem`） | Owner=`diorama-cli`、Repo=`diorama`、Workflow=`release.yml`（只写文件名）、Environment **留空**（workflow 里没有 `environment:`，填了反而匹配不上） |

## 8. 回滚

npm **不允许**删除或覆盖已发布版本（发布 72 小时内可 unpublish，之后只能 deprecate）。
所以"回滚"是发一个新版本：

```bash
# 代码回到上一个 tag，然后正常发一版
git revert <bad-commit>
pnpm release next
```

下架一个坏版本：

```bash
npm deprecate '@diorama-cli/diorama@0.0.3' 'Broken on Node 22: use 0.0.4'
```
