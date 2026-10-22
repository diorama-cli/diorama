# 实施说明：diff 的三种读法与改动间导航

> 记录于 2026-10-22。用户要求：**git diff / git 历史除了纯 diff 文本，还支持切换到整个文件
> 内容展示变更（单栏，支持展开）、新旧两栏对照（旧栏显示删除、新栏显示新增），并加导航按钮
> 在变更块之间跳转**。契约不升号（§6）：`ctx.git` 的签名、上限与错误码不变，
> `seats.git-diff` / `seats.git-commit` 的 props 不变；变更清单在 contract.md **§23**。

## 1. 现象与出发点

diff 一直是 unified 文本一行一行着色（contract §3.2：`ctx.git` 给的就是文本，渲染器分层着色）。
这有两个真实的阅读问题：

- **改动脱离了上下文**。`@@ -18,5 +18,6 @@` 里只有 3 行前文，一个函数改了第 30 行而读者想看
  它所在的整个函数，diff 里没有答案——那是「文件」才有的东西；
- **多处改动没有地图**。一个文件 7 处 `@@`，读者只能滚动找色块；「下一处改动」应该是一个键、
  一个按钮，而不是一次滚动。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 三档读法 | **「改动」**（行内 unified diff）、**「整个文件」**（单栏）、**「新旧对照」**（双栏） | 三种是互补的阅读姿势：行内看「git 说改了什么」，单栏看「这个函数现在长什么样、哪里变了」，双栏看「删了什么、换成了什么」；各是一个图标按钮 |
| 双栏的两侧从哪来 | **只读一次文件**：未改动行两栏取同一份文本（本来就是同一行，只是行号不同），删除行取 diff 自己的文本（它不在当前文件里） | 旧文件在工作区可能已经不存在（新增文件的 `git diff` 里它没有旧版本）；再读一次 `HEAD:<path>` 既多一次 RPC 又要新接口，而未改动行的文本两栏本来就一样 |
| 双栏的对齐规则 | 一个变更里的删除与插入**按位置配对**（`-` 与 `+` 同行，先用完的一侧留空白格） | git 把一个变更里的删除全部排在插入之前，按位置配对就是读者对「这两行是一对」的预期；逐词对齐（intra-line diff）是另一个工程，先不做 |
| 提交座位读什么 | **`blob()`**——那个提交时的文件 | 不是可能已经完全不同的工作区 |
| 折叠发生在哪 | **纯前端状态**：整文件行都在内存里，未改动的长段折成一条横带，点开即展开；双栏的横带**跨两栏**（一行横带 = 两栏各折一段） | 不追加任何 RPC（`ctx.git` 没有按行取数的接口，也不该有）；展开是即时的、可逆的 |
| 折多少 | 变更行前后各留 3 行 + 文件头 2 行；≤2 行的空档不折（一条横带比两行代码更贵） | 折叠是省眼力的，不是省行数的；两行也要点一下，读者会烦 |
| 未跟踪文件 | 合成**一个真 hunk**（`@@ -0,0 +1,n @@`） | 三种模式都解析 diff；一条画法，三档模式自动同时成立 |
| 模式按钮画什么 | **图标**（arrows-diff / file-text / columns-2），`aria-label` 与 tooltip 说明 | 三档并排放文字太宽；图标与 html 渲染器的「预览 / 源码」同族（contract §5.1 的先例） |
| 模式记在哪 | `localStorage`（`diorama.git.diffMode`），对页面**所有** diff 面生效 | 它是阅读偏好（同 `diorama.theme` 的口径），不是某个 tab 的状态；两处 diff 是同一双眼睛在看 |
| 模式不可用 | 二进制 / 超限 / 读取失败：保持「改动」模式 + 一行说明，按钮不消失 | 说明真相比隐藏按钮好；diff 本身仍然可读 |
| 导航的单位 | `@@` hunk（解析自 diff 文本本身） | `ctx.git` 不结构化 diff（m4/spec 的既定取舍），渲染器解析一次就有了地图；hunk 也是「改动块」的自然定义 |
| 导航的形式 | 头部 ‹ › 按钮 + 「n / 总数」+ ↑ / ↓（焦点在 diff 面内时），**循环**（最后一处的「下一处」是第一处） | find-next 的通用语义是循环，到头即停反而让「再按一次」变成陷阱 |
| 键注册在哪 | **diff 面元素自己的 `onKeyDown`**，不是 `ctx.commands` | 页面上可以同时有两个 diff 面（一个工作区 tab + 一个提交座位）；命令面是全局的，两个面会抢同一个键，而「哪个面在焦点里」只有面自己知道 |
| 滚动 | `scrollIntoView({ block: 'center' })` | 变化块应在视线中央，不贴边 |

## 3. 语义细则

- **解析一次，处处使用**：`model.ts` 是纯函数模块（无 React、无 IO），`node --test` 直接测；
  组件只消费 `parseDiff` / `diffHunks` / `diffStat` / `buildFileRows` / `collapseFileRows` /
  `buildSplitRows` / `collapseSplitRows`。
- **整文件的行号有两列**：未改动与新增行显示新文件的行号，删除行显示旧文件的（它在新文件里
  没有位置）；上下文行**从当前文件取原文**（`fileLines[newLine - 1]`），删除行从 diff 取——
  它不在任何「当前文件」里。
- **双栏行的两侧是独立单元**：一行 = `{old?, next?, change}`，任一侧可以缺（纯插入的左栏是
  空白格，底色 `--dio-surface-alt`，不是空字符串）；两栏中间一条 `--dio-border` 竖线，行头
  有「旧 / 新」的 sticky 标题。
- **双栏的行号各是各的**：左栏是旧文件的行号，右栏是新文件的行号——同一个未改动行在两栏的
  行号可以不同（中间插过行），这不是 bug。
- **hunk 的锚点是第一行有编号的行**：一个纯删除（`-0` 侧没有新行号）锚在它删除的旧行号上，
  导航跳到那里仍然有意义。
- **尾部的空档**：最后一个变更之后的未改动段没有「后面的行」可挂横带，作为 trailing band 画在
  最后一行之后——它同样可以展开。
- **焦点样式克制**：diff 面收焦点（为了接 ↑/↓），但 `outline` 只在 `focus-visible` 时画；
  鼠标点击滚动面不闪边框。
- **计数 `+a −r` 用 token 色**（`--dio-status-added` / `--dio-danger`），不新增颜色 token
  （§5.3 的既有规则：颜色一律进 token 表）。

## 4. 改动清单

| 包 | 改动 |
|---|---|
| `plugins/git-changes/src/model.ts` | 新文件：`parseDiff` / `diffHunks` / `diffStat` / `buildFileRows` / `collapseFileRows` / `labelHunks`（单栏）；`buildSplitRows` / `collapseSplitRows`（双栏，纯函数） |
| `plugins/git-changes/src/index.tsx` | `DiffView` 统一了工作区 tab 与提交座位两条 diff 通路（头部：徽标、计数、三档模式图标、导航、刷新；正文：三种模式）；`useDiffMode` / `useFileText` / `useCommitText` / `useHunkNav`；未跟踪文件合成单 hunk |
| `plugins/git-changes/test/model.test.ts` | 新文件 11 条：tone、hunk 头解析、双侧行号、跨 hunk 编号、`diffStat`、整文件穿插与删除文件回退 |
| `plugins/git-changes/test/fold.test.ts` | 新文件 5 条：折叠保留区、横带归属（`openedBy`）、按需展开、hunk 计数、`labelHunks` |
| `plugins/git-changes/test/split.test.ts` | 新文件 5 条：删除/插入配对、单侧空白、未改动行取自文件、删除文件回退、双栏折叠与按需展开 |
| `package.json` | `test:unit` 加 `packages/plugins/git-changes/test/*.test.ts`（`node --test` 不认 `.tsx`，纯函数单独成模块） |
| `scripts/generate-icons.mjs` | `caret-up`（chevron-up）、`unfold`（arrows-vertical）、`diff`（arrows-diff）、`columns`（columns-2）四个按钮图标；`pnpm icons` 重新生成 |
| `ui/src/styles.css` | 行模型（双列行号 `--dio-muted` + `--dio-diff-*-bg/text` 着色）、横带（`--dio-surface-alt` + 虚线边）、头部导航组、双栏网格（两列 `1fr 1fr`、中缝 `--dio-border`、空白格 `--dio-surface-alt`）；无新 token |
| `apps/web/tests/m4-git.spec.ts` | 新 2 条 e2e（三种读法 + 横带展开 + 双栏配对与单侧空白 + 偏好跨刷新；导航循环）；未跟踪文件的断言改为「一个 hunk + 一个加行」 |
| `apps/web/tests/m4-history.spec.ts` | 「提交时的内容」改走 `DiffView`（testid 不变的是 `git-commit-mode-content`，`git-commit-blob-text` → `git-commit-diff-text`） |
| `docs/contract.md` | 新 **§23**；O8 待定项更新 |
| `docs/features.md` | P12 补三种读法与导航；U8 改「✅」（并排已做）；U6 补 diff 的三档；C8 测试计数 |
| `README.md` | 测试计数（289 单测 / 114 端到端）与「已实现」里的 diff 三档读法 |

## 5. 验证

1. `pnpm test:unit`：289 条全绿（268 旧 + 16 单栏/解析 + 5 双栏）。
2. `pnpm -r --no-sort run typecheck` 全绿。
3. `pnpm build` + `node scripts/assemble-package.mjs` 后 `playwright test`：114 条全绿
   （112 旧 + 2 新；老的 23 个 spec 只改了 2 个断言的 testid/计数）。
4. 手工：`diorama-beta .` → 变更 → 打开一个多行改动的文件 → 三个图标按钮依次切换：
   「整个文件」长段折成横带、点开展开；「新旧对照」左旧右新、删除在左、插入在右、空白格补位；
   ‹ › 在两处改动之间循环，`n / 总数` 跟着走；刷新后仍停在切换后的那一档。

## 6. 踩到的坑

1. **`buildFileRows` 的上下文行要从**新**文件的行号取**。第一版按 hunk 的旧行号
   （`fileLines[oldLine - 1]`）取上下文：在一个「插入了 2 行」的 hunk 之后，所有上下文行都
   错位两行。旧行号在第一处插入后就已经漂移，新行号才是「当前文件」的坐标系。
2. **双栏最初想读两次文件**（`HEAD:<path>` + 工作区）。`ctx.git` 没有按路径取旧版本内容的
   接口（`blob()` 是按提交的，工作区 tab 没有提交号），而且未改动行的文本两栏本来就一样——
   读一次文件、左栏只换行号，就把第二次 RPC 和新接口都省了。
3. **横带挂在前面的变更上，而不是「属于自己」**。第一版把横带记给横带**里的**变更；但横带是
   两处变更**之间**的行，把它给前一处变更后，「展开这一处」才知道该打开哪条横带（后面那段
   空档由 trailing band 兜底）。
4. **untracked 文件没有 diff 文本，但三种模式都解析 diff**。老的画法（每行手贴一个 `+` 前缀）
   在行模型下变成第二条特判路径——干脆在读取端合成一个真 hunk（`@@ -0,0 +1,n @@`），
   「整个文件」「新旧对照」两个模式于是免费成立。
5. **`node --test` 不认 `.tsx`**（docs/m4/spec §6.2 既有条目）。模型一开始写在
   `index.tsx` 里，拆成 `model.ts` 才能被单测 import；这也是它保持零依赖纯函数的额外理由。
6. **循环导航**：到头即停的第一版让「下一处」按钮在最末一处变成死按钮（e2e 红）；改成
   `(current + delta + count) % count`，与 find-next 的通用语义一致。
7. **改了 `ui/src/styles.css` 只重跑 `pnpm build` 不够**（m9/spec §5.1 既有条目）：壳的 CSS
   是 `apps/web` 的 Vite 构建产物，必须 `pnpm --filter diorama-web run build` +
   `assemble-package.mjs` 才进 e2e 的壳——第一版双栏截图里两栏叠成了一栏，就是这个原因。
8. **双栏的空白格不能用空字符串代替**：一行里「这一侧没有行」与「这一侧是空行」是两件事，
   前者是 `undefined`（画底色 + 不显示行号），后者是 `''`（画一个 `\u00a0`）。
