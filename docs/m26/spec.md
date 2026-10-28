# 实施说明：历史视图的仓库切换改成下拉

> 记录于 2026-10-28。用户要求：**git 历史窗格中 git 仓库切换改成下拉切换，而不是分组**。
>
> 契约不升号（§6）：没有新增内核服务、没有加座位、没有改 `ctx.*` 签名。契约正文改在
> **§5.2**（多出一条「视图里的『一栏选一』用下拉」），变更清单是 **§37**；`features.md` 的 P16 同步。

## 1. 出发点

v0.10 让一个挂载里的多个仓库都能看历史，做法与变更视图一样：**同屏并列的分组，组头可折叠**。
对变更视图这是对的——那是一棵可以同时浏览的树，读者会跨仓库比较「这次改了什么」。

历史视图不是。那里一次只需要**一个**仓库的提交：读者点开「历史」，是来看某一个仓库最近发生了什么。
把 N 份列表堆在一栏里，每换一次仓库都要在滚动里重新找位置，而组头折叠只是把「找不到」变成
「要记住自己折过谁」。要的是一个**选择器**：换仓库 = 换列表，头部与位置都不动。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 多个仓库怎么切换 | 顶部一行**原生 `<select>`**，一次只画一个仓库 | 菜单、键盘、`Esc`、平台浮层都免费；自绘弹出层要重做定位 / 越界翻转 / 关闭规则，而那套东西已经有一个 `ContextMenu` |
| 分组还在不在 | **不在**（历史视图里） | 同屏并列正是要摆脱的东西 |
| 折叠状态 | 删掉 | 没有组要折 |
| 只有一个仓库时 | **不画**选择行 | 它只会重复这一栏已经是什么（与 v0.10「单仓库不出组头」同一条） |
| 选了哪一个 | 视图自己的 `useState<string \| null>`；`null` = 第一个 | 「这个视图正在看哪个仓库」不是页面状态：不进 URL、不进 `localStorage` |
| 选中的仓库消失了 | 退回第一个 | `find(...) ?? groups[0]`，刷新历史时不会白屏 |
| 选项写什么 | `仓库路径（提交数）` | 路径是读者认仓库的方式，计数回答「这里还有多少」 |
| 变更视图 | **不动** | 那里的分组是「同时浏览」，不是「换着看」 |
| `#history` | **不动** | 它记的是**提交**（以及它属于哪个仓库）；换仓库不该清掉右侧正在看的提交 |

## 3. 实现

### 3.1 视图（`plugins/git-changes/src/index.tsx`）

- `HistoryView` 去掉 `collapsed` / `toggle` 与整段分组渲染，改成一个 `picked` state；
- `const current = (history.groups.find(group => group.repo === picked) ?? history.groups[0])!`——
  非空断言在这里是**由上面的 `total === 0` 提前返回**保证的（`groups` 非空），
  `noUncheckedIndexedAccess` 才不报 `possibly undefined`；
- 选择行：`div.diorama-changes__picker` 里一个 `FileIcon`（文件夹 glyph）+ `select`
  （`data-testid="git-history-picker"`、`aria-label="仓库"`、`value={current.repo}`）；
- 列表只画 `current.commits`；`data-testid="git-history-repo"` 保留，但现在**只有一条**，
  `data-repo` 仍是当前仓库的挂载相对路径（`''` = 挂载目录）；
- 新的纯函数 `repoLabel(repo)`：`''` → `(挂载目录)`，图标与选项共用同一份拼法。

### 3.2 样式（`ui/src/styles.css`）

`.diorama-changes__picker`（`width: max-content; min-width: 100%`，与一栏里其它行同一条横向规则）
与 `.diorama-changes__select`（`border: 1px solid var(--dio-border)`、`border-radius: 4px`、
`background: var(--dio-bg)`、`font: inherit`、`:focus-visible` 用 `--dio-accent`）。
**没有新 token**，light / dark 不需要各写一份。

### 3.3 e2e（`apps/web/tests/m14-repos.spec.ts`）

- 「the history view groups commits by repository」→「switches between repositories with a picker」：
  断言只有一条 `git-history-repo`、`data-repo` 是 `apps/api`、选择行可见；
  `selectOption('apps/web')` 之后 `data-repo` 变成 `apps/web`，列表也换成那一个仓库的提交；
- 「a commit picked in a subdirectory repository…」：改成先 `selectOption`、等 `data-repo` 落定，
  再点第一行提交（`git-history-repo` 现在只有一条，不能再按 `hasText` 找组）。

## 4. 改动清单

| 包 / 文件 | 改动 |
|---|---|
| `plugins/git-changes/src/index.tsx` | `HistoryView` 改下拉切换（删分组与折叠）、`repoLabel` |
| `ui/src/styles.css` | `.diorama-changes__picker` / `.diorama-changes__select`；组头注释说明只属于变更视图 |
| `apps/web/tests/m14-repos.spec.ts` | 两条用例改成走选择行 |
| `docs/contract.md` | §5.2 多一条「一栏选一用下拉」；§37；§24 的历史行标注被取代 |
| `docs/features.md` | P16 补一句 |
| `AGENTS.md` | 「最近一档」指向本文件 |

## 5. 没做的（明确）

- **不给选择行做快捷键**：`mod+alt+3` 已经是「显示历史视图」，再给「换仓库」一条键位没有读者会记住。
- **不把选择持久化**：不进 URL、不进 `localStorage`。要分享「某个仓库的历史」得先有「仓库」这个
  URL 概念，那是另一件事（与 `#history` 的语义也会打架）。
- **不改造变更视图**：那里的分组是「同时浏览」，是 v0.10 拍过的决定（`docs/m14/spec.md` §3）。
- **不抽成通用组件**：目前只有这一处需要「一栏里选一个」，原语等第二处出现再抽。

## 6.5 追补：选择行的三处观感（2026-10-28，截图反馈）

用户截图报了三条，都改了（`ui/src/styles.css` + `git-changes` 的标记）：

| 反馈 | 改法 |
|---|---|
| 「图标跟下拉框可能换行」 | 图标与 `select` 合成**一个控件**：外层是 `label.diorama-changes__picker`（盒子），图标在盒内（`flex: none`），`select` 占余下的宽度。图标随当前仓库换（`FileIcon name={current.repo}`），不再另起一行 |
| 「图标能不能放下拉框里」 | **第二版才对**：原生 `select` 装不下 SVG，第一版只做到「图标在盒子左边」，边框仍画在 `select` 上，所以读起来还是两个东西。现在**边框画在外层 `label.diorama-changes__selectbox` 上**，`select` 自己 `border: 0; background: transparent`，图标就在那个盒子里、文字左侧；点图标等于点开下拉（label 转发点击） |
| 「下拉框与下面的面板要有层次」 | 选择行 `position: sticky; top: 0`：列表从它**底下**滚过；行自带 `--dio-panel` 背景 + 底边框 + 向下的阴影。阴影进了 token（light `0.35` / dark `0.55`，成对），主题可以重新调色 |

**不动的**：testid（`git-history-picker` 仍在 `select` 上）、`aria-label`、
`width: max-content; min-width: 100%`（横向可滚的既有规则）。`label` 包着 `select` 对
无障碍是净改进：点图标 = 点开下拉。

### 6.5.1 为什么「改了没生效」：壳是**组装产物**，不是 `pnpm build` 的输出

第一次改完样式，用户截图反馈「没有改变呀」。原因不是 CSS 写错，而是**根本没被加载**：

- `assetsRoot()`（`cli/src/run.ts`）**先看 `packages/cli/web/`**（发布包里那一条），只有它不存在时
  才回退到 `apps/web/dist`；
- `pnpm build` 只刷新 `apps/web/dist`；`packages/cli/web/` 由 `node scripts/assemble-package.mjs`
  写，是 `.gitignore` 里的**组装产物**；
- 于是插件 JS（`git-changes/lib/client.cjs`，经 `/plugins/<id>/?h=<hash>` 取）是新的、页面 CSS 是旧的：
  testid 全在、e2e 全绿，只有样式没变。这正好是 AGENTS §5 里那条「改了壳/样式后要重新 assemble」
  的坑，这次踩的是**样式**那一半。

**改法**：改 `ui/src/styles.css` 之后跑一次 `node scripts/assemble-package.mjs`，再刷新页面。

**并且加了一条会失败的 e2e**（`m14-repos.spec.ts`）：读选择行的**计算样式**——`position` 是
`sticky`、有阴影、有不透明背景；**边框在不透明背景的 `label` 上**、`select` 自己是
`border-width: 0` 且背景透明；图标与 `select` 在**同一行**、图标在**那个带边框的盒子内**、
且在 `select` 左侧。负向对照做过两次，都失败、恢复后都通过：

1. 删掉组装产物里的 picker 规则 → `Expected: "sticky", Received: "static"`；
2. 把边框挪回 `select` 上（旧的「图标在盒子旁边」形状）→ `Expected: not "0px"`（对
   `select` 的 `border-width` 断言）。

## 6.6 坑

1. **`noUncheckedIndexedAccess` 会把 `groups[0]` 变成 `HistoryGroup | undefined`**。`find(...) ?? groups[0]`
   因此整体是可能 `undefined` 的，下面每一处 `current.repo` 都要报 `TS18048`。真正的保证来自
   上面那句 `if (total === 0) return …`（`total` 是各组长度之和，为 0 才返回，所以走到这里
   `groups` 非空）。用 `!` 断言把这个「提前返回已经证明了」的事实写下来，别在下面写一层
   `current === undefined` 的分支——那会把一条不可能的状态画成界面。
2. **`data-testid="git-history-repo"` 从「每个仓库一条」变成「只有一条」**。按 `hasText` 找组的写法
   （`.filter({ hasText: 'apps/web' })`）会找**不到**——组里已经不含仓库名了（名字在选择行上）。
   改法是先 `selectOption`，再断言 `data-repo`，最后按 testid 拿行。
3. **换仓库不清 `#history`**：这是刻意的（§2 最后一行）。右侧提交详情属于读者刚点的那一个，
   换仓库只是换列表。反过来若清了，读者「看一眼别的仓库再回来」就会发现自己的提交没了。

## 7. 验证

1. `pnpm build`
2. `pnpm test:unit`（**413 条**，其中 1 条是本档之后补的 unborn 仓库用例，见 §8）
3. `pnpm -r --no-sort run typecheck`
4. `pnpm --filter diorama-web exec playwright test`（**165 条**，其中 `m14-repos` 的用例按 §3.3 改过，
   另加 2 条 unborn 仓库用例，见 §8）

## 8. 追补：还没提交过的仓库（2026-10-28）

用户试用后报：**第一层目录不是 git 仓库时会报**
`EIO: git failed: fatal: your current branch 'master' does not have any commits yet`。

| 现象 | 根因 | 改法 |
|---|---|---|
| 历史视图整个变成错误框 | `git log` 在**没有提交**的仓库上退出码非 0（"your current branch … does not have any commits yet"），`log()` 把它当 `EIO` 抛出 | 先 `rev-parse --verify --quiet HEAD^{commit}` 问一句「有没有 HEAD」，没有就回 `[]` |
| 点开文件报 `bad revision 'HEAD'` | `diff` 默认基准是 `HEAD`，unborn 仓库里 `HEAD` 解析不了，每一项都带 `error: EIO` | 同样先问：没有 HEAD 时每一项就是 `kind: 'added'`、无 `text`（照未跟踪文件那条路，渲染器读文件本身） |
| 「暂存了什么」也一起坏 | `git diff --cached HEAD` 显式写了 `HEAD` | 去掉那个参数：`--cached` 的缺省比较对象就是 HEAD（没有 HEAD 时是空树），两种仓库都对 |

细节：

- **判据是退出码，不是 stderr 文本**：`log` 的失败信息是本地化的（`LC_ALL=C` 让它在这里稳定，
  但按文本匹配仍然是脆的）。一次额外的 `rev-parse` 换掉一条正则。
- **`show` / `showCommit` / `blob` 的 `ENOENT` 不动**：那里问的是「某个提交」，没有提交就是没有；
  改成空答案会把「点了一个不存在的提交」和「这个仓库还没有提交」混在一起。
- **历史视图多一个空态**（`git-history-empty`）：一个挂载里有多个仓库时，没提交的那一个仍在下拉里，
  选中时写「这个仓库还没有提交」——否则选择行看起来像坏了。
- **e2e 用例**（`m14-repos.spec.ts`，两条）：一条是挂载本身就是 unborn 仓库——变更视图列出两行、
  历史视图说「还没有提交」、点开文件看到的是它自己的内容（`+two`）而不是 `bad revision`；
  另一条是用户实际遇到的形状——挂载不是仓库、里面**一个仓库已提交、另一个还没提交**：历史视图
  照常显示（不再整栏一个错误框），没提交的那个是空态，下拉切到另一个仍有提交。
- **单测**（`kernel/test/git.test.ts`）：`log` 回 `[]`、`diff` 的两项都是 `added` 且无 `text` 无
  `error`、`diff({ base: 'index' })` 仍给真实的新增 diff、`showCommit('HEAD')` 是 `ENOENT`，
  再 commit 一次后同一个服务立刻恢复正常。
