# 实施说明：历史视图里选多个提交来对比

> 记录于 2026-11-06。用户要求：「git history 支持选择多个 commit 来展示这几个 commit 的变更」。
> 契约不升号（§6）：新增一个内核方法（`ctx.git.range`）与一个座位的**可选** prop（`CommitSeatProps.commits`），
> 没有改任何已有签名。契约正文改的是 **§3.2**（新方法与它的三条边界）、**§3.8**（值里的结构归插件）、
> **§5**（座位 props）、**§5.2**（历史视图怎么多选），变更清单是新写的 **§45**。

## 1. 出发点

历史视图（v0.6）一次只能看**一个**提交：点一行，右侧就是那一个提交对它父提交的改动。读者的下一个问题
很自然——「这三个提交合起来，代码变成了什么样」。要回答它，需要两件事：

1. **一次能选好几个提交**，并且知道哪两个是这段历史的**两端**；
2. **一段历史有一个「净改动」**：不是把每个提交的改动拼起来，而是「从最旧那个到最新那个，文件差了什么」。

第 2 条是关键。把三个提交的 patch 拼在一起会冒出**中间先加后删**的东西：它确实出现过，但它已经不在
代码里了，而读者要看的是「现在是什么样」。`git diff <old> <new>` 做的正是这件事——一次**两树比较**。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 谁算「这几个提交的变更」 | `git diff <from^> <to>`：起点是**最旧提交的父提交** | 这样「选 1 个」与「选 N 个」对同一个提交说的是同一件事（`git show <c>` 就是 `git diff <c^> <c>`）。第一版用 `git diff <from> <to>`，结果**选 4 个只看得到 3 个**——最旧那个提交的改动被静默丢掉 |
| 怎么选 | 每个列表都有的规则：**单击**选这一行、**Shift 单击**选整段、**⌘ / Ctrl 单击**加减一行 | 第一版是「对比开关 + 修饰键加选」，实测别扭：单击永远只选它自己，想选一段得先找到开关。标准语义**没有要先打开的状态**，第一次单击看一个提交，第二次 Shift 单击就是对比 |
| 哪两个是端 | 选中里**最旧与最新**的两个（按列表位置） | 列表本身就是时间序；按点击顺序会让「先点新的再点旧的」与反过来产生不同的 diff。端只是**边界**，画出来的是这一段每个提交的改动合起来 |
| root 提交 | 起点退回**空树**（`4b825dc642cb6eb9a060e54bf8d69288fbee4904`） | 第一个提交没有父提交，`<root>^` 解析不出来；`git diff <空树> <root>` 打印的就是 `git show <root>` |
| 中间没选的提交 | 标成「这段覆盖了它」（`data-covered` / `.diorama-history__row--between`），但**不算选中** | 这段**覆盖**它们：`a → c` 的效果就是它们合起来的效果。不标会让人以为「只比了那两行」；算进选中集则「再点一下取消」会变成不可能 |
| 「选中」与「覆盖」 | 两个独立的概念：`aria-selected` / `#history` 只说选中，覆盖由两端的列表位置算出来 | `⌘` 点首尾 → 选中 2 个、覆盖 3 个；Shift 选整段 → 全部选中。合成一个的话两种情形就分不开了 |
| 状态放哪 | `#history` 的值，旧的在前：`<repo>:<oldest>,…,<newest>` | 已有的槽位、已有的刷新恢复路径；sha 里没有逗号，不需要转义；单提交的值一字不变 |
| 座位怎么知道 | `CommitSeatProps.commits?: string[]` | 可选字段：只认识 `{ commit, repo }` 的条目照旧能画（`commit` 仍是其中最新的一个） |
| 服务端排序吗 | 不排，方向由调用方给 | 服务端不知道读者的列表哪头朝上；猜错就是「diff 反了」，而且看不出来 |

## 3. 实现

### 3.1 内核（`packages/kernel/src/server/git.ts`、`shared/types.ts`、`client/git.ts`）

`GitRepoView.range(from, to)` 与 `GitService.range(from, to, repo?)`：

```ts
const first = await this.resolveRevision(normalizeCommit(from))
const second = await this.resolveRevision(normalizeCommit(to))
// 起点：最旧提交的父提交；root 提交没有父提交，退回空树。
const before = await this.parentOf(first)
const names = await this.run(['diff', '--name-status', '-z', '--no-ext-diff', '-M', before, second])
// 每个文件一次 git diff <before> <second> -- <path>，形状照 toEntry（与 diff()/showCommit 同源）
```

`parentOf(sha)` 先试 `rev-parse --verify --quiet <sha>^`，失败就回 `EMPTY_TREE`。

- 复用 `parseCommitFiles` / `toEntry` / `MAX_DIFF_BYTES` / `MAX_DIFF_LINES` / `clip`：形状与账都和
  `showCommit().files` **同一套**，渲染器不需要知道这份 diff 是「一个提交对它父提交」还是「两个提交互相比」。
- `METHODS` 加 `{ name: 'range', arity: 3 }`（`from` / `to` / 可选 `repo`）；`GIT_METHODS` 同步。
- `RangeResult` 回 `from` / `to` 的**完整 sha**（最旧 / 最新），座位据此写出「覆盖的是哪一段」。

### 3.2 历史视图（`packages/plugins/git-changes/src/index.tsx`）

- **没有开关**：头部只有「N 个提交 · 已选 M 个」与刷新按钮。多选就是列表本身的行为。
- 点击走 `choose(sha, event)`，把 `shiftKey` / `metaKey` / `ctrlKey` 原样交给纯函数；**锚点**（上次点击的行）
  是这个视图自己的 `useState`，不进 URL——刷新后下一次点击从新的一行开始，与任何列表一致。
- 决定「点了之后选中什么」的是纯函数 `pickCommits`（`src/history.ts`），所以排序、整段、移出都有单测。
- 渲染时把**选中**（`picked`，即 `aria-selected`）与**覆盖**（`covered`，由两端算出的区间）分开：端用
  `.diorama-changes__row--selected`，选中但不是端用 `--picked`，只是被覆盖用 `--between`。

### 3.3 纯函数（`packages/plugins/git-changes/src/history.ts`，新文件）

`historyHashValue` / `parseHistoryHash` / `pickCommits` 从 `index.tsx` 搬到这里并扩展：

- 值：`<repo>:<a>,<b>`，旧的在前；单提交解码出的对象**没有** `commits` 键（v0.6–v0.24 的形状）。
- `pickCommits(chosen, anchor, sha, order, { shift, toggle })`：单击 = 只要这一行；Shift = `order` 里
  从锚点到这一行的**切片**（两端都含，所以中间的行一次就选上了）；⌘ / Ctrl = 加入或移出。答案一律按
  `order` 排成旧的在前（`order` 是新的在前，所以是**降序**）。
- 锚点由调用方保存并回传：Shift 连点时锚点不动，于是整段从同一起点长出来。

搬到 `.ts` 的理由是 `node --test` 不认 `.tsx`（m4/spec §12 的老坑）：这两件事都是决策，值得单独测。

### 3.4 座位（`packages/plugins/git-changes/src/index.tsx`）

`CommitSeat` 拿到 `commits` 且长度 > 1 时：

- 调 `git.range(from, to, repo)`，把结果装成 `CommitDetail`（`rangeDetail`）：`sha` 是最新那个，
  `subject` 写成 `<old7> … <new7>`，`files` 就是 range 的文件清单；
- 头部不再画提交说明（一段历史没有说明），画两端；`data-range=""` 让 e2e 与样式能区分两种座位；
- 清单里的每一条都画出来（`files` 是完整的）；`truncated` 为真时**不画任何提示**——清单完整、缺的只是
  内联正文，而「点开时再读」本来就是座位的常态（没有 `text` 的行就是普通行）。提示只会把实现细节讲给读者；
- 「整个文件」那一档读的仍是**最新那个提交**的正文（`blob(detail.sha, path)`）——range 的右端就是它。

### 3.5 样式（`packages/ui/src/styles.css`）

- `.diorama-changes__actions`：头部右侧那一簇按钮（现在只有刷新），`margin-left: auto`。
- 三种行态，与三种「身份」一一对应：
  - `.diorama-changes__row--selected`（端）：强调色左边框 + 选中底色；
  - `.diorama-history__row--picked`（选中但不是端）：弱边框 + 弱底色；
  - `.diorama-history__row--between`（只是被这段覆盖）：只有弱文字，没有底色——读者没选它。

## 4. 测试

- **内核单测**（`packages/kernel/test/git.test.ts`）：`range` 的形状、两端回 sha、**最旧提交的改动也在**
  （首个提交创建的文件读作 `added`、内容里有它那一版）、`range(c, c)` 与 `showCommit(c).files` 一致、
  从 root 开始的段、`ENOENT` / `EINVAL`；dispatcher 的三参形态（多给一个参数是 `EBADREQUEST`）；
  以及**清单完整性**——40 个大文件的一次提交，`files` 仍是 40 条，超账的那些没有 `text` 也不是 `binary`，
  用 `show()` 能单独读出来（`range` 同样验一遍）。
- **纯函数单测**（`packages/plugins/git-changes/test/history.test.ts`，7 条）：单提交值的兼容、一段值的
  编解码、空 / 畸形值；单击替换、Shift 取整段（上下两个方向、锚点不动）、没有锚点时 Shift 等于单击、
  ⌘ 加选 / 取消 / 取消到空。
- **e2e**（`apps/web/tests/m33-history-range.spec.ts`，5 条）：Shift 选整段 → 座位画这一段的改动且值是
  最旧→最新；刷新后仍是一段；单击回到单提交；⌘ 加减单行且中间那行「被覆盖但没选中」；**选中的每个提交
  自己的改动都在**（最旧那个创建的文件读作新增，且单选与多选对同一个提交给同样的答案）。

## 5. 验证

```bash
pnpm build
pnpm test:unit                                   # 464 条
pnpm -r --no-sort run typecheck
node scripts/assemble-package.mjs                # 改了 styles.css，e2e 的壳要重装
pnpm --filter diorama-web exec playwright test   # 192 条
```

## 6. 坑

1. **`export … from` 不绑定本地名字**。把 `historyHashValue` 搬到 `history.ts` 之后，`index.tsx` 里
   `export { historyHashValue } from './history.ts'` 只做转发，同一文件的函数**用不了**这个名字——
   要再写一行 `import { … } from './history.ts'`。
2. **座位链路上少传一环，整段静默不生效**。`TabsView` → `CommitColumn` → `Slot props` → 条目，
   四处都要带上 `commits`。第一版漏了 `TabsView` 那一处，页面照常工作、`data-sha` 也对，只有
   `data-range` 永远不出现——e2e 的 `toHaveAttribute('data-range', '')` 抓到的正是这种「看起来没事」。
3. **hash 的值会被 `encodeURIComponent` 编码**：`a,b` 在地址栏里是 `a%2Cb`。断言要比
   `decodeURIComponent(hash)`，或者写 `%2C`——两种都对，但别以为浏览器会保留逗号。
4. **排序方向容易写反**。列表是**新的在前**，所以「按列表位置排成旧的在前」是**降序**。
   单测里专门有一条「先点新的再点旧的」的用例守着它（第一版写成了升序，两个端的 diff 反了）。
5. **一段 ≠ 中间每一行都选中**。选中集只放读者点过的提交，**覆盖范围**由两端算出来；把中间的提交也塞进
   选中集会让「再点一下把它移出」变成不可能（它本来就不在选中集里）。两种身份要分别落到 DOM 上
   （`data-picked` / `data-covered`），否则测试没法区分「⌘ 点了首尾」与「Shift 选了整段」。
6. **清单不能跟着正文一起截断**。`showCommit` / `range` 原来在**建清单的同一个循环里**读每个文件的
   diff 正文，账一超就 `break`——于是文件清单本身变成前缀，界面还写着「改动的文件过多，只列出了一部分」。
   两件事要分开：`files` 是读者**挑文件**的目录（少一行就是少一个答案），`text` 是这次调用**读进来多少**。
   现在账用完之后剩下的条目只列行、不带 `text`，座位点开时用 `show(commit, path)` 读那一份——这条路
   本来就有（未跟踪文件、二进制都走它），不需要新的取数方式。
   另一个教训：**提示语要说真话**。原话暗示「有些文件不在列表里」，读者会去找一个其实就在那儿的东西。
7. **多选的语义差点做错：选 4 个只看得到 3 个**。第一版用 `git diff <最旧> <最新>`（两个端直接比），
   于是最旧那个提交自己的改动被静默丢掉——而只选它一个时又看得见（`git show` 是 `git diff <c^> <c>`）。
   同一份数据两种答案，读者没法信任。改成起点取**最旧提交的父提交**之后，两个动作对同一个提交说的是同一
   件事。教训：**多选是单选的自然延伸**，它的答案必须包含每一个被选中的东西；否则读者会以为自己的选择
   被吞了。另外，主流 IDE（IntelliJ「Compare Versions」、GitLens）走的是两树比较，但它们**只能选两个**
   且把动作叫「两个提交之间」——我们做成连续多选手势，就不能照抄那个语义。
8. **第一版的交互做错了，是读者反馈出来的**。最初是「头部一个对比开关，开着时点击才加选」——单击永远
   只选它自己，想选一段得先去找那个开关。改成标准列表语义之后，多选这件事**没有需要先打开的状态**。
   教训：列表里的多选不该发明新范式，读者手上的肌肉记忆就是规范；新范式只在它确实更省事时才值得引入。
