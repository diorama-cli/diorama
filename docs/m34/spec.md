# 实施说明：历史视图的提交树

> 记录于 2026-11-06。用户要求：「git history 上用彩色点和连线画出提交树」。这是**新能力**，
> 但**不升契约号**（§6）：没有新增内核服务、没有加座位、没有改 `ctx.*` 的方法签名。变的是
> **§3.2 里 `GitLogEntry` 多一个 `parents`**（图的边）与 **§5.2 里历史视图每一行的形态**
> （行左侧多一列树）。变更清单是新写的 **§46**（与 §45「选多个提交来对比」同一档，计入 `0.0.11`）。
>
> 与 §45 是**同一栏的两种改法**，合起来才是这一栏现在的样子：§45 给了每一行的选中语义（单击 / Shift /
> ⌘），§46 给了每一行左侧的树。两边的冲突都在 `HistoryView` 的行渲染里，解法见 §7。

## 1. 出发点

历史视图是一栏提交列表：每行两行文字（说明 / sha + 作者 + 时间），提交之间的**关系**完全看不见。
读者要靠「分支从哪来、合并把哪条并进去了」去猜，而这恰恰是看图一眼就明白的东西。

要画树，先得有**边**。在此之前 `log()` 只报 `sha / shortSha / subject / author / at`——没有任何字段
说明这个提交的父提交是谁。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 边从哪来 | `log()` 的 `--format` 多读一列 `%P`，写进 `GitLogEntry.parents: string[]` | 同一次 git 调用就有这条信息，没有理由让视图再跑一遍 `rev-list`；`parents` **必填**（root 提交是 `[]`），因为「不知道父提交」这个状态对图没有意义 |
| 图怎么画 | 每行一个**自己的** `<svg>`，viewBox 是 `0 0 <道数> 100`，`preserveAspectRatio="none"` | 行的宽度是 `max-content`（横向滚动规则），一列一张大图要么猜总高（行高不齐）、要么量完再画（两帧闪烁）。每行一段，行与行天然对齐 |
| 线的形状 | 同一条道是直线；跨道用**贝塞尔曲线**（控制点在纵向中点） | 正交折线要给「拐点落在哪一行」再立一套规则；曲线只要起点、终点、中点三个量 |
| 线的粗细 | `stroke-width: 1.5` + `vector-effect="non-scaling-stroke"` | `preserveAspectRatio="none"` 会把横向与纵向各自缩放，不加这条，线宽会被拉成一头粗一头细 |
| 颜色 | 6 个 token `--dio-graph-1..6`，**按道**（lane）分配，循环使用 | 一条分支从头到尾一个颜色，读者才追得下来；按边轮换的话，一次合并就是一团彩线 |
| 点的样式 | 直径 7px 的圆，外圈 1.5px 的**行底色**（`box-shadow` 画） | 两条道交叉处线从点底下穿过，没有圈点就化了；圈用行底色而不是页面背景——悬停与选中的底色是半透明的，圈跟着换成 `--dio-hover-strong` / `--dio-selected` |
| 一页装不下的父提交 | 最后一行的道**向下出画**（`span: 'bottom'` 到 `y=100`） | 与「加载更多」同义：下面还有，点一下就来 |
| 行的布局 | 行本身改成 `flex-direction: row`（图 | 文字），纵向内边距挪到文字那一段 | 图列要占满**整行高度**（含内边距），否则每行上下各短 5px，连线在行边界处断开、整棵树看起来是一串短横 |
| 状态 | 没有新的页面状态 | 树是 `log()` 结果的纯函数；选中仍是 `#history`，与树无关 |

## 3. 实现

### 3.1 内核（`packages/kernel/src/server/git.ts`、`shared/types.ts`）

```ts
'--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct%x1f%P',
```

`%P` 是父提交的**完整 sha**，第一父提交在前，用空格分隔；root 提交是空串，`split(' ')` 得到
`['']`，所以过滤掉空串就是 `[]`。

```ts
parents: (parents ?? '').split(' ').filter(parent => parent !== ''),
```

### 3.2 布局（`packages/plugins/git-changes/src/graph.ts`，纯函数）

`layoutGraph(commits)` 一次扫过一页提交，维护「每条道在等谁」：

- 这个提交在某条道里被等着 → 就是那条道（`awaited`），并且**有**一条线从上方到达它；
- 没人等它（一页的第一个，或历史的第一条）→ 占第一条空道，**没有**上方来线；
- 上面那些道：自己那条到点为止（`span: 'top'`），其余穿过整行（`'full'`）；
- 父提交：第一父提交**留着当前道**（直历史就是一条直线），其余各占一条新道，各画一段
  `span: 'bottom'` 的线从点出发；父提交若已在某条道上等着，线就跨到那条道；
- 道空了就回收（尾部裁剪），跨道跳转因此不会让图越来越宽。

### 3.3 绘制（`graphview.tsx`）与样式

```tsx
<svg viewBox={`0 0 ${lanes} 100`} preserveAspectRatio="none">
  <path d={linePath(line)} stroke={graphColor(line.color)} vectorEffect="non-scaling-stroke" />
</svg>
```

`linePath` 把 `(from, to, span)` 换成 `d`：同道是 `M x y1 L x y2`，跨道是 `C`（控制点在纵向中点）。
颜色用 `var(--dio-graph-N)`，所以主题能整体换色而不用改组件。

## 4. 测试

- `packages/plugins/git-changes/test/graph.test.ts`（8 条）：直历史、合并、跨道回收、criss-cross
  （两个子提交指向同一个父提交）、父提交不在本页、`parents` 缺省、颜色范围、空列表。每条都顺手
  断一次**相邻行首尾相接**（上行下边缘的道集合 = 下行上边缘的道集合）——线断在行边界上是这类图
  最容易出的错，而它对任何文本断言都是隐形的。
- `apps/web/tests/m34-history-graph.spec.ts`（3 条）：直历史一条道；有分支时两条道、线有颜色
  （`getComputedStyle(path).stroke` 不是 `none`，且不止一种颜色）；图列与行**同高**（差 < 1px）。

## 5. 验证

```bash
pnpm build
pnpm test:unit                                   # 472 条（+8）
pnpm -r --no-sort run typecheck
node scripts/assemble-package.mjs                # 改了 styles.css，e2e 的壳要重装
pnpm --filter diorama-web exec playwright test   # 195 条（+3）
```

## 6. 坑

1. **行内边距会把图列截短**。第一版沿用旧的 `padding: 5px 10px`，图列只占内容区高度，于是每行
   的线在上下各短 5px——树上出现一排均匀的缺口。改成「行 `padding: 0 10px`，文字那一段自己
   `padding: 5px 0`」之后才对齐。e2e 用「图列高度 = 行高度」锁住这一条（差 < 1px）。
2. **`preserveAspectRatio="none"` 会把线宽一起拉**。没有 `vector-effect="non-scaling-stroke"`
   时，一条竖线在横向被压缩、纵向被拉伸之后，粗细与横线不一致。
3. **线色不能用 `currentColor` 或继承**。`<path>` 没有 `stroke` 时默认是 `none`，图上什么都
   不出现，而所有文本断言照样全绿——所以 e2e 读的是 `getComputedStyle(path).stroke`。
4. **别按边轮换颜色**。按边换色看起来更「多彩」，但一条分支会在每次合并处变色，读者失去追踪的
   线索。颜色属于**道**。
5. **`%P` 与 `%p` 不一样**：`%P` 是完整 sha，`%p` 是缩写。图要比较 sha 是否相等，必须用完整
   的那个（缩写长度受仓库规模影响）。
6. **改 `styles.css` 要重装壳**（m26/spec §6.5.1、m32/spec §6 坑 3）：e2e 的 CSS 来自
   `packages/cli/web/`，`pnpm build` 只刷 `apps/web/dist`。本档的样式改动同时落在历史行与
   token 表上，忘了这一步，测试里的图列宽度与颜色都还是旧的。

## 7. 与 §45（多选对比）的合并

§45 与 §46 是**同一天、同一栏**的两次改动，落地顺序上 §45 先进了 `main`。合并时冲突只有三处，
都落在「一行怎么画」上：

| 位置 | 两边的写法 | 合起来 |
|---|---|---|
| `HistoryView` 的 `graph` / `choose` | §45 在这里算 `chosen` 与 `choose()`，§46 在这里算 `layoutGraph(current.commits)` | 两个都留：`graph` 是常量，`choose` 是回调，互不相干 |
| 每一行的局部变量 | §45 算 `picked` / `covered` / `end`，§46 取 `graphRow` | 三个判断 + 一个 `graphRow`，都在 `return` 之前 |
| 行内的结构 | §45 只改 `aria-selected` 与 `className`，§46 在文字前插了一列 `<svg>` | 行仍是 §45 的 `<button>`，里面先是图列、再是 §45 的文字块 |

两处**看起来像冲突、其实不是**的地方，值得记一笔：

- **`data-testid` 没有冲突**：§45 加的是 `data-picked` / `data-covered`，§46 加的是
  `git-history-graph` / `git-history-dot` / `git-history-line`，名字不撞。
- **样式冲突只有一个选择器**：`.diorama-history__row--selected .diorama-graph__dot` 与 §45 的
  `--picked` / `--between` 落在同一段。做法是**每一种行底色各给点一个圈**（`--dio-bg` /
  `--dio-hover-strong` / `--dio-selected` / `--dio-selected-soft`），而不是让 §46 覆盖 §45 的类。

合并后 `pnpm test:unit` 472 条、e2e 195 条全绿；`m24-tree-toolbar` 在整轮里超时过一次（单独跑通过），
与这两档无关——它不碰 git 视图。

## 8. 缺陷修复：提交图的断线（`log()` 不再按路径过滤）

> 2026-11-06 补记，来自用户报的「为什么会出现这种没有合并的线」。

### 8.1 症状

历史视图里有一条线连不到任何提交——它从某个点出发，向下走到一半就没了。

### 8.2 根因：pathspec 打开的历史简化

`log()` 的调用**每一次**都带 pathspec：

```ts
path === undefined ? this.mountInRepo || '.' : this.toRepoPath(path)
```

挂载是仓库根时传 `.`，是仓库子目录时传那个子树。git 拿到 pathspec 之后做的**不只是过滤输出**，
它还打开**历史简化**：走历史时，相对父提交没有改动这个路径的提交被静默省略——**合并提交也照删**——
而 `%P` 里记的 sha 仍然指向它们。

扁平列表时代（v0.6–v0.25）这只是列表短几行，读者看不出来；本档给 `GitLogEntry` 加了 `parents`
之后，缺失的父提交立刻变成图上一条**指向不存在的行**的线。

实测（用户提供的仓库，21 个提交）：

| 调用 | 返回 |
|---|---|
| `git log -- .` | 18 个，3 个合并提交被简化掉 |
| `git log`（不带 pathspec） | 21 个，全部 |

### 8.3 一个被证伪的猜想

「在子目录里跑 `git log` 会只显示影响该目录的提交，所以用 `cwd` 就能限定范围、不必传 pathspec」——
**这条是错的**，实测 git 2.54 / Apple Git-157：在 `src/` 里直接跑 `git log`，**仍然报整个仓库**。
（那条记忆对应的是 `--relative` 一类选项，不是默认行为。）

所以「按子树收窄」和「保持历史完整」在这里**互斥**：想收窄只能用 pathspec，而 pathspec 必然触发简化。
本档选了后者——历史视图本来就是「选一个仓库，看这个仓库根目录的完整历史」。

### 8.4 修法

1. **`log()` 不再传 pathspec**（`packages/kernel/src/server/git.ts`）：参数只剩 `{ limit, repo }`，
   `GitLogService` 也不再按 `path` 路由到某个仓库。
2. **`layoutGraph` 不画指向虚空的线**（`packages/plugins/git-changes/src/graph.ts`）：父提交不在本页
   （分页没加载到）时，那条道画到**最后一行的下边缘**——「下面还有」，与「加载更多」说的一致。

第 2 条同时补上了原实现里注释写了、代码没写的一段：`graph.ts` 顶部说「最后一行的道要画到底边」，
但循环结束后并没有补这一段，于是开着的道停在行边界上，看起来是死胡同。

### 8.5 测法（这次的教训）

原来的 e2e 与单测都是「干净的直历史 + 一次合并」，**构造不出「父提交被简化掉」的形状**，所以缺陷
一路绿灯。新增的用例直接用能复现的仓库形状：

- `packages/kernel/test/git.test.ts`：只改 `src/` 的分支 + 只改 README 的主线 + 一次真合并。
  断言**每个提交都报出来**，并且**每个 `parents` 里的 sha 都在同一份答案里**。
- `packages/plugins/git-changes/test/graph.test.ts`：父提交缺失时**不画**指向不存在的行的线；
  开着的道走到最后一行下边缘。

**教训**：给一个扁平列表加「结构」（这里是 `parents`）时，必须回头检查**取数那一步是否足以支撑
这个结构**。列表短几行没人看得出来，图的边少一条就是断线。
