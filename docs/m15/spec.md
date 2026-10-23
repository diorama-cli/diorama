# 实施说明：可拖动的窗格，与看得全的长名字

> 记录于 2026-10-23。用户要求：**文件导航、diff 文件列表、git history 文件列表、commit 列表、
> 搜索结果列表等窗格内容都不支持左右滑动，文件名一长就看不全；窗格也要支持鼠标拉动扩大缩小**，
> 并明确要求**把这个记下来，以后实现类似窗格都要支持**。契约不升号（§6）：没有新增服务、
> 没有改 `ctx.*` 与座位签名；变的是**页面怎么画一条栏**，以及 `diorama-ui` 多了一个原语。
> 契约正文补在 **§5.2**，变更清单在 contract.md **§25**。

## 1. 现象与出发点

左栏是一条 260px 的固定栏（docs/m4/spec.md §6.4 当时写的就是「未做拖拽」）。每一行都用了

```css
.diorama-tree__row { width: 100%; }
.diorama-tree__name { overflow: hidden; text-overflow: ellipsis; }
```

于是长名字**不是被截断就是被省略号吃掉**，而窗格本身是 `overflow: auto`——纵向能滚、横向滚不动，
因为每一行都被钉成了容器的宽度。这在四类真实内容上同时发作：

- 文件树：`packages/plugins/git-changes/src/...` 这种深度路径；
- 变更 / 历史：同样的路径，外加仓库分组头；
- 搜索结果：**一行的命中文本**（`diorama-search__text` 也是 `overflow: hidden` + 省略号），
  读者恰恰是来找这一行的，截断等于没找到；
- 提交座位左侧的文件清单：`minmax(180px, 260px)` 的固定列，路径一长就只剩前半截。

第二条是**宽度不能改**：260px 是写死的，读者想看清楚只能去开文件本身——那就不是「在栏里读」了。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 窗格宽度 | **可拖**：左栏与提交座位的文件清单各有一条可拖的边 | 用户要的就是这个；两条边是同一个手势，所以是同一段代码 |
| 行的宽度 | `width: max-content; min-width: 100%` | 行按内容长，短内容仍铺满（选中底色不残缺），长内容把窗格撑出横向滚动 |
| 名字元素 | **不再** `overflow: hidden` / `text-overflow: ellipsis`，加 `flex: none` | 名字不再参与收缩；要读全就滚，而不是猜 |
| 拖拽时谁更新 | 只有 `onPreview` 写 CSS 变量；**松手才进 React state** | 每一帧 setState 会重渲染整棵树（几百行），拖动会卡；变量只触发重排 |
| 宽度记在哪 | `localStorage`（`diorama.layout.sidebarWidth`、`diorama.git.commitFilesWidth`） | 与主题、diff 读法同一条口径：这是**阅读偏好**，不是页面状态 |
| 边界 | `MIN_PANE_PX` 160 / `MAX_PANE_PX` 720，**一个原语一套数** | 两处各写一套数，第三个窗格就会出现第三套 |
| 键盘 | 分隔条可聚焦：← → 16px，Shift 64px，Home / End 到边界 | 宽度不该只有鼠标能改 |
| 分隔条的位置 | **自己占一个网格列**（5px，两侧负 margin 让可见部分很窄） | 压在内容上会挡住一行的开头；占列则永远不遮内容、也不在悬停时挤动布局 |
| 新窗格怎么办 | 契约 §5.2 写明：**列表窗格必须横向可滚**，宽度可拖的用 `diorama-ui` 的 `Splitter` + `usePaneSize` | 用户明确要求「后面实现类似窗格都要支持」，所以这是规则，不是这一档的补丁 |

## 3. 语义细则

- **`clampPane`**：`NaN` → 最小值（拖拽算出非数时不能把宽度变成 `NaN`）；`±Infinity` 与普通
  数字一样按边界夹紧；结果取整（CSS 像素就是单位）。
- **`readPaneSize` 夹紧而不是丢弃**：窗口变小过之后再回来，上次的宽度还在。
- **`storePaneSize` 静默失败**：`localStorage` 被禁（隐私模式、嵌入宿主）时宽度仍对本页生效，
  只是不跨刷新。
- **`usePaneSize` 的 setter 只写一次**：同一个值重复提交不写盘，也不触发多余渲染。
- **指针捕获**：`setPointerCapture` + `pointercancel` / `lostpointercapture` 都收尾，
  指针飞出窗口也不会留下 `body.diorama-resizing` 的 `col-resize` 光标。
- **`body.diorama-resizing`**：拖动期间整页 `cursor: col-resize` + `user-select: none`，
  否则拖过文件名会顺手选中一串文本。
- **分隔条是 `role="separator"`**：`aria-valuenow/min/max` + `aria-label`（「调整侧栏宽度」/
  「调整文件列表宽度」），读屏能读到当前宽度。
- **两处调用同一个原语**：`layout`（左栏，`side: 'start'`）与 `git-changes` 的提交座位
  （文件清单，`side: 'start'`）；`side` 存在的意义是「被调宽的那一栏在边的哪一侧」。
- **横向滚动的边界**：窗格自己的 `overflow: auto` 负责；行只负责「不收缩」。所以**不会**出现
  嵌套的横向滚动条——一个窗格一条。
- **diff 正文本来就能横滚**：`.diorama-diff__text` 的 `white-space: pre` + `overflow: auto`
  已经是这个行为，这一档没有动它。

## 4. 改动清单

| 包 | 改动 |
|---|---|
| `ui/src/splitpane.ts` | 新文件（**纯函数**，无 JSX，`node --test` 直接测）：`MIN_PANE_PX` / `MAX_PANE_PX` / `PANE_STEP_PX`、`clampPane`、`readPaneSize`、`storePaneSize`、`usePaneSize` |
| `ui/src/splitter.tsx` | 新文件：`Splitter`（`role="separator"`、指针拖拽、方向键 / Home / End、指针捕获、`body.diorama-resizing`）。**故意与 `splitpane.ts` 不同名**：同名 `.ts` + `.tsx` 会在声明 bundle 里撞名 |
| `ui/src/index.ts` | 导出上面两半 |
| `ui/src/styles.css` | `.diorama-splitter`（占列、悬停/拖动/聚焦三态）、`body.diorama-resizing`；`.diorama-layout--split` 与 `.diorama-git-commit__body` 改成「自定义属性 + 分隔条列 + `minmax(0,1fr)`」；树 / 变更 / 历史 / 搜索 / 提交文件清单的行改 `max-content` + `min-width: 100%`，名字元素去省略号 |
| `plugins/layout/src/index.tsx` | `SplitFrame` 持有宽度（`SIDEBAR_WIDTH_KEY`、`SIDEBAR_DEFAULT_PX`），写 `--dio-sidebar-width`，画 `Splitter` |
| `plugins/git-changes/src/index.tsx` | 提交座位的文件清单同上（`COMMIT_FILES_WIDTH_KEY`、`COMMIT_FILES_DEFAULT_PX`、`--dio-commit-files-width`） |
| `ui/test/splitpane.test.ts` | 新文件 7 条：边界、取整、`NaN` / 无穷、存取、读不回来时回落、没有 `localStorage` 不抛错 |
| `apps/web/tests/m15-panes.spec.ts` | 新文件 4 条 e2e：拖动 + 刷新记住 + 键盘；长名字不省略且窗格可横滚；变更 / 历史 / 搜索三处同样；提交座位文件清单可拖 |
| `package.json` | `test:unit` 加 `packages/ui/test/splitpane.test.ts`（原本只收 `packages/ui/test/*.test.ts`，通配已覆盖，无需改） |
| `docs/contract.md` | §5.2 补规则；新 **§25** 变更清单 |
| `docs/features.md` | U16（可拖动窗格）、U17（长名字靠滚动） |
| `docs/m4/spec.md` | §6.4 的「左栏宽度固定 260px」改成指向本档 |

## 5. 验证

1. `pnpm build`（含 `packages/ui` 的 `tsc --noEmit`）。
2. `pnpm test:unit`：**310 条全绿**（303 旧 + 7 新）。
3. `pnpm -r --no-sort run typecheck` 全绿。
4. `node scripts/assemble-package.mjs` 后
   `pnpm --filter diorama-web exec playwright test`：**124 条全绿**（120 旧 + 4 新）。

## 6. 坑

1. **hook 在提前 `return` 之后**。`CommitSeat` 有 `loading` / `error` 两个早返回；把
   `usePaneSize` 写在它们之后，加载态与就绪态的 hook 数量不同，React 直接抛错，整个提交座位
   渲染不出来（症状是「点了提交什么都没发生」，e2e 里是 `git-commit-files-splitter` 找不到）。
   **所有 hook 写在任何条件返回之前**。
2. **同名 `.ts` + `.tsx` 会撞声明**。`splitpane.ts` 与 `splitpane.tsx` 在 tsdown 的声明
   bundle 里同名，报的是 `MISSING_EXPORT … is not exported by src/splitpane.d.ts`——看着像
   导出写错，其实是两个文件抢一个 `.d.ts`。拆成 `splitpane.ts` + `splitter.tsx`。
3. **`width: 100%` 的行永远横滚不动**。行必须先 `width: max-content`（再 `min-width: 100%`
   保住铺满），否则 `overflow: auto` 的窗格没有可滚的内容——省略号其实是被这一条撑住的。
4. **`Number.isFinite` 会把无穷当非法值**。第一版用它兜底，`clampPane(Infinity)` 返回最小值；
   无穷本身夹紧就够了，只有 `NaN` 需要特殊照顾。
5. **`node --test` 没有 `localStorage`**。它是页面 API，单测要自己装一个 `Map` 版本
   （见 `ui/test/splitpane.test.ts` 的 `MemoryStorage`）；模块在**调用时**读
   `globalThis.localStorage`，正是为了这一点。
