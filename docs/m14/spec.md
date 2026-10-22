# 实施说明：一个目录里的多个 git 仓库

> 记录于 2026-10-22。用户要求：**支持目录下多 git 仓库**。范围两条都做——并列的多个仓库，
> 以及外层仓库里嵌套的仓库；向下扫描 `.git`，跳过 `node_modules` 且忽略目录可配置；
> `ctx.git` 按推荐走多实例；变更视图**按仓库分组、分组可折叠**。契约不升号（§6）：
> `ctx.git` 的方法名与上限、错误码都不变，只加 `repos()` 与可选的 `repo` 参数；变更清单在
> contract.md **§24**。

## 1. 现象与出发点

`ctx.git` 自 v0.5 起是「一个 mount = 一个仓库」：`onMount` 里跑一次
`git rev-parse --show-toplevel`，得到一个工作区根，`GitService` 的每个方法都围着它转。
这个假设在两类真实目录上都不成立：

- **workspace 目录**（`apps/api`、`apps/web` 各是一个仓库，外层目录本身不是仓库）。
  旧实现里 `rev-parse` 失败 → **整个 mount 没有 `git` 服务** → 左栏「变更」「历史」两个视图
  根本不出现，尽管下面有五个仓库；
- **外层仓库里嵌套仓库**（submodule、vendored 依赖、`git worktree` 里的检出）。旧实现只看得见
  外层：内层仓库要么是一个巨大的未跟踪目录，要么按 submodule 显示成一条，内层自己的
  status / diff / log 完全看不到。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 服务形状 | **仍是每个 mount 一个 `ctx.git`**，内部按仓库分派（`GitService` 门面 + 每仓库一个 `GitRepoView`） | 一个 mount 一个服务名（`MOUNT_SERVICES` 的隔离机制不变），插件用 `inject: { optional: ['git'] }` 探测的写法不变；多实例会让「有没有 git」变成「有几个 git」，反而要改所有调用方 |
| 仓库怎么发现 | **向下走查目录项**（不调 git）+ `rev-parse` 找**包含**挂载的仓库 | 每个候选目录跑一次 git 进程，代价远高于一次 `readdir`；而「挂载是某个仓库的子目录」（v0.5 的语义）只有 git 自己知道 |
| 什么算仓库根 | 有 `.git`（目录**或 gitfile**），或裸仓库的 `HEAD` + `objects` + `refs` | submodule / worktree / `--separate-git-dir` 都是 gitfile；裸仓库没有 `.git`，但它就是 git 目录 |
| 走查的边界 | `[git] maxDepth`（默认 **3**）、`maxRepos`（默认 32）、`[git] ignore`（缺省沿用挂载的 `ignore`） | 深度默认 3 覆盖「`apps/*`、`packages/*`」这类布局；再深就是 `node_modules` 形状的噪声。两个上限都可配，因为深 monorepo 与宽 workspace 想要的值不同 |
| 嵌套仓库怎么处理 | **继续走进去**，把它记成内层仓库；外层视图**不报**内层子树里的路径 | 这正是用户要的第二件事。若不剪枝，内层文件会同时出现在两套 status 里（外层是未跟踪目录，内层是真改动），同一个文件两行 |
| 挂载自己的仓库 | `repo` 缺省 = 仓库根正好是挂载根、或**包含**挂载根的那个；都没有时是发现到的第一个 | 保住 v0.5 的语义（挂载是仓库的子目录）——那时「挂载的仓库」就是包含它的那个 |
| `repo` 怎么传 | 每个方法一个**可选的尾参数**；`diff({ path })` 这类调用由路径决定仓库（最深的那个） | 调用方几乎总是从一条 `status` 行出发，那里已经带着 `repo`；按路径再解析一次只是兜底 |
| UI 分组 | 变更 / 历史都**按仓库分组**，组头是仓库路径 + 计数，可折叠 | 用户明确要分组与折叠。折叠键用 `repo:<path>`，与目录折叠共用一个 `collapsed` 集合（键空间不重叠） |
| 只有一个仓库时 | **不出组头** | 组头只会重复「这一栏本来就是那个仓库」；单仓库挂载的观感与 v0.9 完全一致 |
| 仓库名怎么写 | 挂载相对路径（`apps/api`）；仓库根就是挂载根时写 `(挂载目录)` | 与文件树同一套路径口径（contract §3.1） |

## 3. 语义细则

- **仓库之间不重叠**：`GitRepoView.status()` 过滤掉落在内层仓库子树里的路径。注意 git 对未跟踪
  目录**带尾斜杠**（`?? vendor/lib/`），比较前要先去掉。
- **`repoPath` 有两种含义**，但对外是同一个字符串：仓库在挂载里 → 它是仓库相对挂载的路径；
  仓库**包含**挂载 → 它是 `''`（整个挂载都属于它）。`GitRepoView` 内部用 `mountInRepo`
  （挂载相对仓库）还是 `repoPath`（仓库相对挂载）二选一，**恰好有一个**存在。
- **路径翻译双向**：`toRepoPath` / `toMountPath` 在两种方向下各做一次前缀增删，
  调用方（`status` / `diff` / `log` / `show` / `blob`）不必知道是哪种。
- **`repos()` 的顺序**：浅的在前，同深度按路径字典序。这是稳定顺序，视图的分组顺序与 RPC 的
  可读性都靠它。
- **`truncated`**：走查因 `maxRepos` 提前停止时为 true，挂在 `repos()` 的每一项上（它们是同一份
  清单）。
- **发现失败不致命**：某个仓库的 `GitRepoView` 构造失败（工作树不含它自己）只跳过它并记一条
  日志；其余仓库照常回答。全部失败才算「没有可用仓库」。
- **没有仓库时仍然探测原因**：先用 `rev-parse` 区分「这里没有仓库」与「机器上没有 git」，
  后者是要让读者听见的机器问题。

## 4. 改动清单

| 包 | 改动 |
|---|---|
| `kernel/src/server/repos.ts` | 新文件：`discoverRepositories`（按层 `readdir`、`WALK_CONCURRENCY` 分批、ignore 剪枝、深度/数量上限）、`nestedPaths`、`repoRootOf`、`readGitFile`；`DEFAULT_GIT_MAX_DEPTH = 3`、`DEFAULT_GIT_MAX_REPOS = 32` |
| `kernel/src/server/git.ts` | `GitService` 变成门面（`repos()` / `status(repo?)` / `diff` / `log` / `show` / `showCommit` / `blob`，内部 `viewOf` / `viewOfPath` 分派）；新增 `GitRepoView`（原 `GitService` 的实现 + `repoPath` / `owns()` / 嵌套剪枝 + 双向路径翻译）；`openMount()` 负责发现 + 构造视图；`enclosingRepository()` 处理「挂载是仓库子目录」 |
| `kernel/src/shared/types.ts` | `GitRepoInfo`；`GitStatusEntry.repo` / `DiffEntry.repo` / `CommitDetail.repo`；`DiffScope.repo` |
| `kernel/src/client/git.ts` | `GIT_METHODS` 加 `repos`；`GitClient` 加 `repos()` 与各方法的 `repo` 参数；`hasGit()` 改看 `repos()` |
| `kernel/src/server/config.ts` | `[git]` 表：`maxDepth`（0–64，默认 3）、`maxRepos`（1–4096，默认 32）、`ignore`；`knownKeys` / `patchFileConfig` / `formatFileConfig` / `readConfigValue` 一并支持 `git.*` |
| `kernel/test/repos.test.ts` | 新文件 14 条：并列、根即仓库、`node_modules` 剪枝、可配置 ignore、深度边界、`maxRepos` 截断、gitfile、裸仓库、`nestedPaths`、多仓库 `status`/`diff`、嵌套剪枝、挂载在仓库子目录、零仓库、`repos()` 可代理 |
| `kernel/test/git.test.ts` / `fork.test.ts` / `config.test.ts` | 构造方式改为 `GitService(root, [view])`；默认配置多出 `git` 一项；symlink 断言走 realpath |
| `plugins/git-changes/src/index.tsx` | 变更视图与历史视图都按仓库分组（`RepoGroup` / 组内 `useHistory`），组头可折叠；`useHistory` 每仓库取一页 |
| `ui/src/styles.css` | `.diorama-changes__repo` / `__repo-head` / `__repo-name`；无新 token |
| `apps/web/tests/m14-repos.spec.ts` | 新文件 5 条 e2e：`git.repos()` 列全部仓库、分组与折叠、嵌套仓库不混进外层、历史按仓库分组、**子目录仓库的提交能打开**（回归，见 §7） |
| `plugins/slots/src/types.ts` | `CommitSeatProps` 加可选 `repo` |
| `plugins/tabs/src/index.tsx` | 解析 `#history` 的 `<repo>:<sha>`，把 `repo` 交给 `seats.git-commit` |
| `plugins/git-changes/src/index.tsx` | `historyHashValue` / `parseHistoryHash`；点提交写仓库；`CommitSeat` 的 `showCommit` / `show` / `blob` 全部带 `repo`；历史分组补 `data-testid="git-history-repo"` |
| `docs/contract.md` | §3.2 重写（多仓库、`repos()`、`repo` 参数、嵌套剪枝、发现规则）；§4.1 加 `[git]`；新 **§24** 变更清单 |
| `docs/features.md` | K9 / P12 / P16 |

## 5. 验证

1. `pnpm build`（含 kernel 的 `tsc -p tsconfig.emit.json`，否则下游看到的是旧声明）。
2. `pnpm test:unit`：303 条全绿（289 旧 + 14 新）。
3. `pnpm -r --no-sort run typecheck` 全绿。
4. `pnpm build` + `node scripts/assemble-package.mjs` 后
   `pnpm --filter diorama-web exec playwright test`：118 条全绿（114 旧 + 4 新）。
5. 手工：在一个 `apps/*` 各有仓库的 workspace 目录 `diorama-beta .` → 变更栏出现两个组头，
   各自列出自己的文件；点组头折叠/展开；再在其中一个仓库里嵌一个仓库，确认内层文件只出现在
   内层组里。

## 6. 踩到的坑

1. **走查原本在认领一个仓库后就 `continue`**，于是嵌套仓库根本发现不了——而「嵌套」正是需求
   的一半。改成认领后**继续走进去**，让外层把内层记成自己的 `nested`。
2. **`GitRepoView` 的构造假设了「挂载在仓库里」**：`isInside(root, repoRoot)` 为假时抛
   `ENOTREPO`。并列多仓库时恰好反过来（仓库在挂载里），于是每个视图都构造失败，服务只剩
   `no usable git repository`。改成两个方向二选一，恰好一个成立。
3. **`repoPath` 的语义一开始写错**：把「仓库相对挂载的路径」写成了「挂载相对仓库的路径」，
   于是挂载是仓库子目录时 `repoPath` 成了 `../..` 形状，`owns()` 全部为假、`diff({path})`
   报 `ENOTREPO`。正确规则：仓库**包含**挂载时 `repoPath` 是 `''`。
4. **未跟踪目录带尾斜杠**：外层仓库对嵌套仓库报的是 `?? vendor/lib/`，`nested` 存的是
   `vendor/lib`，直接比较永远不相等。比较前去掉尾斜杠。
5. **嵌套路径的坐标系**：`nestedPaths()` 给的是**仓库**空间，`GitRepoView` 收到的却是**挂载**
   空间（调用方按挂载路径问它）。第一版两边混用，`isNested` 永远为假。现在统一在挂载空间比较，
   翻译只在 `toRepoPath` / `toMountPath` 里做。
6. **RPC 的 arity 是白名单**：`show` 加了第三个参数后，`describe()` 里还是 `arity: 2`，
   多传一个参数会被 `EBADREQUEST` 拒掉。每个加参数的方法都要同步改 `METHODS`。
7. **`node --test` 不认 `.tsx`**（既有条目）：分组逻辑放在 `.tsx` 里，单测只能测到
   `repos.ts` 与 `GitService`；UI 的分组/折叠由 e2e 覆盖。
8. **e2e 的侧栏切换要走 `data-view`**：`getByRole('button', { name: '变更' })` 找不到切换器
   （按钮的可访问名来自图标 + title），既有 spec 用的是
   `getByTestId('sidebar-switcher').locator('[data-view="changes"]')`。

## 7. 后续修复：子目录仓库里的提交打不开（2026-10-22）

用户报告：在历史视图里点开**子目录仓库**的提交，右侧报
`ENOENT: no such commit: a1f963eed13e0570ba060e22d291bf60497b47ff`。

**根因**：提交座位只拿到一个 sha。`CommitSeat` 调 `showCommit(commit)` 时不带 `repo`，
于是 `GitService.viewOf(undefined)` 落回「挂载自己的仓库」——挂载根不是仓库时是发现到的**第一个**
仓库，那个 sha 自然不在里面。同一个漏点还在两处：`CommitFileDiff` 的 `show()` 与
`useCommitText()` 的 `blob()`。也就是说修好 `showCommit` 之后，点文件还会再报一次。

**为什么第一轮没发现**：e2e 的分组用例只断言「有 2 个分组」，没有点进去；而单仓库挂载里
「挂载自己的仓库」恰好就是唯一那个仓库，所以 m4-history 的既有用例全绿。

**修法**（契约 §24 最后两行）：

- `#history` 的值带上仓库：`<repo>:<sha>`，仓库就是挂载根时仍写裸 sha——v0.6–v0.9 的 URL
  原样有效。仓库路径不含 `:`（POSIX 挂载路径，§3.1），第一个 `:` 即分隔符。
- `tabs` 解出这两半，把 `repo` 交给 `seats.git-commit`（`CommitSeatProps.repo` 可选：不认识的
  老 piece 仍按 v0.6 的语义工作）。
- `CommitSeat` 的三个读点全部带 `repo`：`showCommit(commit, repo)`、`show(commit, path, repo)`、
  `blob(commit, path, repo)`。

**回归测试** `apps/web/tests/m14-repos.spec.ts` 的最后一条：两个仓库、挂载根不是仓库，点第二个
分组的提交，断言座位可见、无错误、列出该仓库的文件，并且刷新后仍在（`#history` 里带
`apps/web:`）。**验证过它抓得住**：把 `showCommit(commit, repo)` 临时改回 `showCommit(commit)`，
这条用例立刻失败；改回来即通过。

**新坑**：e2e 里 `getByTestId('git-changes-repo').nth(1)` 会**跨视图**选中隐藏但仍在挂载的
「变更」视图的分组（`sidebar.views` 非活动视图隐藏不卸载，AGENTS §5 既有条目）。历史分组
因此有了自己的 `data-testid="git-history-repo"`；定位器要按视图的 testid + 文本过滤，
不要用全局 `nth()`。

## 8. 后续修复：提交座位的「新旧对照」按钮没反应（2026-10-22）

用户报告：历史视图里打开一个提交，diff 界面上点「新旧对照」两栏按钮**没有分成两栏**。

**根因**：一行门槛条件。`CommitFileDiff` 只在 `mode === 'file'` 时才去读文件正文：

```tsx
const whole = useCommitText(commit, file.file, mode === 'file' && file.binary !== true, repo)
```

而 `DiffView` 画双栏的条件是 `mode === 'split' && whole.status === 'ready'`。于是 `split`
模式下 `whole` 永远是 `idle`，双栏分支不成立，画面上什么都没有——按钮看起来「没反应」。
工作区那条通路写的是 `mode !== 'inline'`（m13 §2 的既定语义：两种内容模式都要文件正文），
提交座位当初只抄了 `file` 一种。

**修法**：

```tsx
const whole = useCommitText(commit, file.file, mode !== 'inline' && file.binary !== true, repo)
```

`split` 需要的是**未改动的行**（两栏共用的那一份文本），与 `file` 需要的完全一样，所以
一个条件就够，不需要第二次读取。

**回归测试** `apps/web/tests/m4-history.spec.ts` 的「the commit seat reads a diff three ways,
split included」：依次点「整个文件」（断言 `data-mode="file"`）与「新旧对照」（断言
`data-mode="split"`、两栏标题「旧」「新」、左右两侧分别是旧行与新行、有分栏行），再点回
「改动」。**验证过它抓得住**：把条件改回 `mode === 'file'`，这条用例立刻失败。

**教训**：同一个渲染器有两处调用点（工作区 tab / 提交座位），门槛条件必须一致。这两条
通路在 m13 就被合成一个 `DiffView` 了，但**取数**仍各写各的；`DiffView` 的 props 让调用方
决定 `whole` 是什么，条件写错时组件本身无从报错——只会静默地少画一块。
