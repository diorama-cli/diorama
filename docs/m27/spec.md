# 实施说明：行号、`:行号` 与跳转到行

> 记录于 2026-10-29。用户要求四件事，其实是**同一条链**：① 文本渲染器能显示 / 隐藏**行号**；
> ② `mod+p` 的文件名后面可以接 `:行号` / `:行号范围`，打开就定位并**闪烁**；③ palette 里以 `:`
> 开头表示 go to line；④ 按 `:` 直接打开 palette 并填上 `:`。
>
> 契约不升号（§6）：没有新增内核服务、没有加座位、没有改 `ctx.*` 签名。契约正文改在
> **§3.9**（reveal store 的目标变成区间 + 可闪烁）与 **§3.7**（命令表多两条），变更清单是
> **§39**；`features.md` 的 U26 同步。

## 1. 出发点

三条输入都指向同一个缺失：**页面里没有一个「第 N 行」的坐标系**。

- 搜索命中已经能跳到行（v0.8，`__diorama_reveal__`），但那是**唯一的**入口：读者手里有一条
  别人给的 `src/app.ts:42` 时，没有任何地方能把它输进去。
- 渲染器里看不到行号，所以「第 42 行」这件事即使跳过去了，读者也没法确认自己到的是不是那一行。
- palette 能搜命令，却搜不到「第 42 行」——它不是一条命令，是一个**位置**。

所以顺序是反过来的：先让行号可见（坐标系），再让 `:行号` 可输入（地址），最后让跳过去有反馈
（闪烁）。四件事是同一个功能的正反面，一次做。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 行号的覆盖范围 | `code` 与 `plaintext` | 与搜索跳行的覆盖范围一致（m6/spec §6）：Markdown / 图片 / PDF 渲染后不保源文件行号 |
| 行的形态 | 一行一个元素（`.diorama-line`），行号是第一格 | 行号只能数元素（`counter` 数不了文本里的 `\n`）；范围带也落在行元素上，不再靠 `行号 × 行高` |
| `code` 每行的 HTML | `highlightLines()`（m19 的按行引擎） | 跨行的块注释 / 多行字符串在断行处闭合、下一行重开——已有能力，直接复用 |
| 默认 | **开** | 行号是编辑器默认，也是本档所有功能的坐标系 |
| 状态放在哪 | 页面全局 `__diorama_line_numbers__`（`diorama-ui`） | 两个渲染器 + 命令是三个半边；模块对象会变成三份答案（同 `__diorama_reveal__`） |
| 偏好记不记 | 记，`localStorage` 的 `diorama.lineNumbers`（`0`/`1`） | 与侧栏折叠、diff 读法同一条规矩 |
| 开关入口 | 渲染器自己头部的按钮 + 命令 `view.toggleLineNumbers` | 头部是渲染器自己的地盘（§5.1，O8）；命令让 palette 也能到 |
| reveal 的目标 | `line`…`endLine`（闭区间） | 范围与单行是同一件事：单行就是两端相等 |
| 带的两种样子 | 常驻（搜索命中）/ `flash`（跳转到行） | 「回来读这一行」与「带你到这儿」是两种意图 |
| 超出末尾 | 夹到末行 | 读者说的是「到结尾」；静默失败像坏键 |
| `mod+p` 的语法 | `path:42` / `path:42-60`，**最后一个冒号** + 合法行号才切分 | 路径本身可以带冒号；打到一半的 `app.ts:` 仍是文件名 |
| `mod+p` 里只打 `:42` | 一行「跳转到第 42 行」，排在文件列表前，落点是活动 tab | 与 palette 的 `:` 同一个承诺 |
| palette 的 `:` | go to line 模式：不再列命令，只列那一行 | 命令 id 是稳定标识（§3.7），`:42` 的目标每帧都变，不适合做成命令 |
| `:` 键 | `shift+;` | 绑定写键帽（`SHIFTED` 表：⇧; 打出 `:`）；写 `:` 在没有 ⇧ 的事件上永远不匹配 |
| 全角 `：` | **不认** | 用户明确要求 |

## 3. 实现

### 3.1 `diorama-ui`

- **`src/line-numbers.ts`**（新，纯函数 + 页面全局 store）：`parseLineSpec`（`42` / `42-60` /
  反着写的范围）、`splitLineSuffix`（最后一个冒号，且后面必须是行号）、`clampTarget`、
  `formatLineSpec`；`lineNumbersStore` / `toggleLineNumbers` / `setLineNumbers`。
  `localStorage` 在**调用时**读，`node --test` 能装一个 `Map` 版本（与 `splitpane.ts` 同一手法）。
- **`src/reveal.ts`**：`RevealTarget` 多 `endLine` 与 `flash`；`reveal(path, line, options)`；
  `useRevealLine(path, focus, count?)` 收一个**回调**而不是元素 ref —— 渲染器知道自己怎么排版
  （一行一个元素），store 只决定**什么时候**滚；`count` 让目标先夹进文件。
- **`src/lines.tsx`**（新）：`LineRow`（行号格 + 文本 + 带）与 `RevealBand`；`inRevealed` 是纯函数。
  两个渲染器共用同一份行形态与类名。
- **`src/overlay.ts`**：`showOverlay(id, payload?)` / `overlayPayload(id)` —— `:` 打开 palette 时
  要把「已经打好的冒号」交给它，而 opener 是另一个半边。关掉即清空。

### 3.2 渲染器（`plugins/code`、`plugins/plaintext`）

- 头部从「路径一行」变成 `.diorama-code__header`（路径 + 开关按钮），按钮
  `aria-pressed`、`data-testid="code-line-numbers"` / `plaintext-line-numbers`。
- 正文：`lines.map` → `LineRow`；容器带 `data-line-numbers="on|off"` 与 `--numbered` 类。
- `useLineFocus` / 等价物：`[data-line-number="N"]` 直接 `scrollIntoView({ block: 'center' })`。
- `code` 另外注册 `view.toggleLineNumbers`（`when` 不设：没有文件时也该能改偏好）。

### 3.3 quick open（`plugins/search-view`）

- 输入先过 `splitLineSuffix`：过滤用**路径那一半**，行号跟着结果走。
- 列表项是 `QuickItem`：`file`（原样）或 `line`（只打 `:42` 时，落点 = 活动 tab）。
- 选中后 `openAt(tabs, path, target, { flash: true })`。

### 3.4 palette（`plugins/palette`）

- `query.startsWith(':')` → go to line：`parseLineSpec` 解析，列一行 `palette-goto-line`
  （`data-line` 是它要跳的行），没有活动 tab 时列 `palette-goto-line-empty` 说明原因。
- 打开时读 `overlayPayload(OVERLAY_ID)` 作为初始查询；`palette.goToLine`（`shift+;`）用
  `showOverlay(OVERLAY_ID, ':')`。

### 3.5 选区（`diorama-ui` 的 `selection.ts`）

按行渲染之后，浏览器自己的选区高亮坏了：它画的是**每个 inline box**，于是行号格被跳过
（`user-select: none`）、每行一条、长度各异、行与行之间还有缝——一次跨行选择读起来是「一堆条」。

- **原生高亮透明**：`.diorama-code ::selection` / `.diorama-plaintext ::selection` 设
  `background: transparent`。文字仍然**可选中、可复制、可搜索**，只有**画**归我们。
- **`selectionchange` → 行矩形**：`slicesOfSelection` 把 DOM Range 换成「哪些行、每行从第几个字符到
  第几个」；`selectionSlices`（纯函数，单测覆盖）把同一行的多段并成一段，并判定「整行」——
  覆盖到该行最后一个字符就算整行。
- **画**：整行 `data-sel="full"` 用 `::after` 铺满整行（含行号格），相邻行因此接成一整块；
  局部 `data-sel="part"` 用 `--dio-sel-left` / `--dio-sel-width` 画实测出来的那一段。
  位置由 `Range.getBoundingClientRect()` **量**出来，不用 `ch`：行里有 tab，字体也不保证正好一个
  `ch` 宽。行号格宽度也量（`--dio-line-gutter`），因为读者可以把行号关掉。
- **不重渲染**：矩形写在行的自定义属性上，滚动零成本；监听挂在 `document`（选区可以从外面拖进来）。

### 3.6 图标与样式

- `line-numbers` → Tabler `list-numbers`，进 `scripts/generate-icons.mjs` 的 `BUTTON_ICONS`，
  跑 `pnpm icons`，再重建页面壳（图标表由壳安装，docs/m17/spec.md §6 坑 9）。
- `styles.css`：`.diorama-line` / `__num` / `__text` / `__reveal` / `--flash`、
  两个渲染器的 `__header` / `__tool`；行按内容长、窗格横滚（`width: max-content`）；
  `prefers-reduced-motion` 下闪烁几乎立即结束。

## 4. 测试

| 文件 | 覆盖 |
|---|---|
| `packages/ui/test/line-numbers.test.ts`（新） | `parseLineSpec` / `splitLineSuffix` / `clampTarget` / `formatLineSpec` 的边界；store 的默认值、记忆、只通知一次、storage 被挡时的回退 |
| `apps/web/tests/m27-line-numbers.spec.ts`（新） | 行号默认开、按钮切换、刷新后仍是关；`mod+p` 的 `app.ts:30` 定位并 `data-flash="true"`；palette 的 `:10-12` 画三条带、`:999` 夹到末行；没有 tab 时那一行说明原因 |
| `packages/ui/test/selection.test.ts`（新） | `selectionSlices`：整行判定、局部段、行序、同一行多段合并、反写的区间、空行与未知行 |
| `apps/web/tests/m27-selection.spec.ts`（新） | 跨三行拖选：前两行 `data-sel="full"` 且**等宽、上下相接**（这就是「一整块」），最后一行是 `part`；原生高亮透明而 `getSelection()` 仍能拿到文本 |

## 5. 验证

`pnpm build` → `pnpm test:unit`（420 条）→ `pnpm -r --no-sort run typecheck` →
`pnpm --filter diorama-web exec playwright test`（169 条，含新增 4 条）。改样式后先跑
`node scripts/assemble-package.mjs` 再测（AGENTS.md §3）。

## 6. 坑

1. **`useRevealLine` 换了签名**：原来是 `(path, ref)`，现在是 `(path, focus, count?)`。
   旧的 `code` / `plaintext` 是唯一调用点，一起改了；`git-changes` 从来不用它。
   类型是结构性的，漏改不会在别处报错，只会在运行时「不滚」——所以 `count` 与回调一起换。
2. **`endLine` 夹在渲染器里，不在 store 里**：store 不知道文件多长。第一版没夹，`:999` 在十行的
   文件里算出第 999 个位置，带子画在文字外面——**看着像什么都没发生**。e2e 用「`:999` 仍有一条带」
   锁住（m27 spec §4）。
3. **闪烁要 `key={revealed.at}`**：同一个元素重渲染不会重放动画，连按两次 `:42` 第二次就没有动画。
   `at` 是单调戳（与 `RevealTarget.at` 同一条规矩）。
4. **JSX 里加了条件分支要数括号**：palette 的列表变成 `goToLine ? … : …` 之后，外层 `</ul>` 与
   新分支的闭合必须对齐；`tsc` 会报，但报的是「JSX element has no closing tag」而不是缺哪个。
5. **全角冒号**：`splitLineSuffix` 只认 `:`。这不是疏忽——用户明确要求不认；`：42` 会被当成文件名，
   匹配不到就是空列表，与打错任何字一样。
6. **选区在行模型下会「散成条」**：不是样式细节，是浏览器的画法——它只画 inline box，行号格被
   `user-select: none` 跳过，每行一条。修法是**自己画**（`selection.ts`），原生高亮只留透明；
   别想着用 `::selection` 加 padding/box-shadow 糊过去。
7. **局部段的偏移要量，不要用 `ch`**：行里有 tab（`tab-size: 4`）时 `ch` 与实际宽度对不上，
   带子会从中间开始。行号格的宽度也要量——读者可以把行号关掉。
8. **拖到行尾之外会吸附到行尾**：e2e 里想把最后一行选成「局部」，终点必须落在**行内**；
   拖过末尾会被浏览器吸到行尾，于是整行都是 `full`（行为是对的，断言写错了）。
9. **样式改了要重新组装页面壳**：`.diorama-line` 是新类名，`pnpm build` 只刷 `apps/web/dist`，
   e2e 读的是 `packages/cli/web/`。忘了 `assemble-package.mjs` 的话 testid 齐全、断言全绿、
   只有样式是旧的（AGENTS.md §5 那条）。
