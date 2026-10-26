# 实施说明：快捷键能力增强与「按住修饰键看快捷键」

> 记录于 2026-10-25；**2026-10-26 按 cmux 的体验重做**——用户给了两条截图反馈：①芯片要**浮**在
> 组件上，显示 / 隐藏不能改变组件的大小位置；②只显示关键快捷键，关闭这种不要显示；③键位与
> IDE 对齐，跟浏览器冲突也没关系。契约不升号（§6）：没有新增服务、没有加座位、没有改 `ctx.*`
> 的既有签名；变的是 §3.7 的命令表与命令服务的两个新读法、§5.2 里侧栏切换器的一条显示规则，
> 以及 `diorama-ui` 的一个原语。契约正文补在 **§3.7 / §5.2**，变更清单在 contract.md **§31**。

## 1. 出发点

1. **按序号跳 tab** 是编辑器里最顺手的那个手势，本仓一直没有；
2. 读者**不知道有哪些快捷键**——`?` 的速查表要离开页面去查，而 IDE（和 cmux）的做法是
   **按住修饰键，控件自己把键显示出来**。

两件事都落在「命令注册表」上：前者是一条新命令 + 一条绑定，后者是**把注册表里已有的绑定
画到发起它的那个控件旁边**。所以这一档没有新概念，只有两处新读法。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 按序号跳 tab 的键位 | `mod+1` … `mod+9`（v0.16；v0.15 曾用 `alt+<n>`） | 用户拍板：**「跟浏览器冲突也没关系，实现自己功能更重要」**。⌘1 是编辑器里那只手已经会按的键；浏览器先吃掉时页面收不到，读者还有点击与 `⌃Tab`，但键位本身不能教错 |
| tab 条的其余键位 | `mod+w` 关、`mod+shift+[ / ]` 循环（v0.16；v0.15 曾用 `mod+alt+*`） | 同上：v0.15 全避开浏览器换来的是没有一只手认识这些键。`ctrl+tab / ⇧⌃Tab` 浏览器本来就交给页面，保留「到边界停」 |
| `shift+[` 怎么匹配 | 按下时报 `{`，`matchesKeys` 按**键帽**认识它（`SHIFTED` 表，v0.16） | 记法按键帽写（`mod+shift+[`），读者才写得出；否则就得写 `mod+shift+{` 这种没人写的和弦 |
| 第 10 个以后的 tab | 没有键 | 两位数的和弦不是手会做的动作；循环切换（`⌘⇧[ / ]`、`⌃Tab`）已经够 |
| 没那么多 tab 时 | 命令**不可执行**（`when` = tab 数 ≥ n） | 与既有命令同一口径：按了也不该跳到别的 tab |
| 提示什么时候出现 | 按住 **⌘ / Ctrl** 或 **⌥ / Alt** | 绑定里两种家族都有（`⌘1`、`⌘⌥1`、`⇧?`），「按一个修饰键看看」必须对读者伸手按的那一个给出答案 |
| 提示状态放哪 | **页面全局** `__diorama_keys__` | 与 `__diorama_overlay__` / `__diorama_reveal__` / `__diorama_layout__` 同一口径：每个 client 半边是自足的闭包，模块对象会变成每半边一份 |
| 谁维护它 | **内核**（它拥有那个唯一的 keydown 监听器） | 半边只管读；内核在 `keydown` / `keyup` / `window.blur` 上写 |
| 芯片的文本 | 注册表快照的 `label`（`⌘1` / `Ctrl+1`） | 速查表与芯片共读 `formatKeys` 一份表；控件不自己拼键记法 |
| 芯片的无障碍 | `aria-hidden` | 控件自己已有名字；屏幕阅读器念「⌘1」是噪音 |
| **哪些控件显示提示**（v0.16 收紧） | **只有关键的**：tab 条（`⌘<n>`，右上角）与侧栏切换器（图标旁 `⌘⌥<n>`） | 用户反馈：关闭这种就不要显示。tab 的 `✕` 再挂一个 `⌘W`、切换器脚下再来一个 `⌘B`，就不是提示而是噪音；关闭与收起归 `?` 速查表 |
| **芯片怎么显示**（v0.16） | **浮层标签**：`position: absolute`，悬在控件上方 / 旁边，**不参与布局**（cmux 的做法） | 用户反馈：显示 / 隐藏不能改变组件的大小与位置。v0.15 的行内芯片把 tab 撑宽、把关闭按钮撑高；浮层出现与消失时 tab 条的几何**一字不动**（e2e 断言了这一点） |
| tab 的中键 | 关闭该 tab | 常见 tab 条的既有手势；主键仍归标签自己 |

## 3. 语义细则

- **按住不执行任何东西**：只改显示状态。`handleKey` 的分发顺序、「第一个注册者优先」、
  `when` 的判定，一个字都没动。
- **`CommandContext.hints`**：`'mod' | 'alt' | undefined`，由内核通过 `createCommandsService` 的
  `hints` 选项注入。想让某个命令在「按着修饰键时」表现不同，`when` 里读它就行。
- **store 的快照是字符串**（`''` / `'mod'` / `'alt'`）：`useSyncExternalStore` 按值比较，
  每次读都返回新对象会无限重渲染。store 的方法写成不依赖 `this` 的闭包（React 会 detached 调用）。
- **store 必须在第一个组件渲染前就存在**：组件在首次渲染时 `subscribe`，一个还不存在的 store
  订阅不上——第一次按住修饰键时不会有人重渲染。所以 `bootClient` 一开始就 `ensureHeldModifierStore()`
  （这一条是实测踩出来的：状态变了，芯片就是不出现）。
- **窗口失焦要清**：切走再回来浏览器不补发 keyup，`window.blur` 也清，否则提示会一直亮着。
- **重复按住是安静的**：`holdModifier('mod')` 连续调用只通知一次（按住期间每敲一个键都会走
  `keydown`），否则整页每次按键都重渲染。

## 4. 改动清单

| 包 | 改动 |
|---|---|
| `kernel/src/client/keys.ts` | 新文件：键记法整体从 `commands.ts` 搬来（`parseKeys` / `matchesKeys` / `formatKeys`），另加 `hintOf`（某命令的第一条绑定）与 `modifierOf`（事件 → 按住的是哪个修饰键）。纯函数，`node --test` 直接跑 |
| `kernel/src/client/modifiers.ts` | 新文件：页面全局 `__diorama_keys__`（`held` / `listeners` / `subscribe` / `getSnapshot`）、`holdModifier`、`heldModifier`、`ensureHeldModifierStore` |
| `kernel/src/client/commands.ts` | 改用 `keys.ts` 并 re-export（既有 import 不动）；`CommandContext.hints`；快照每条绑定带 `label`；`bindingFor(id)` / `hintFor(id)`；`CommandsOptions.hints` |
| `kernel/src/client/boot.ts` | 建 store；`hints: heldModifier`；keydown 写 `holdModifier(modifierOf(event))`，新增 keyup 与 `window.blur` |
| `kernel/src/client/index.ts` | 导出 `formatKeys` / `hintOf` / `modifierOf` / `parseKeys` / `matchesKeys` / `isApplePlatform` 与 hold store |
| `ui/src/keys.tsx` | 新文件：`useHeldModifier`（读页面全局）与 `KeyHint`（芯片，`aria-hidden`，`data-keys` = 规范记法） |
| `ui/src/styles.css` | `.diorama-keyhint`（**浮层**：`position: absolute`、实底、投影、不可点，v0.16）；tab 里悬在右上角、侧栏里浮在图标右侧；`[data-hints]` 时整栏 `overflow: visible` |
| `plugins/tabs/src/index.tsx` | `tabs.select:<n>` 九条命令 + `mod+<n>` 绑定；`mod+w` 关、`mod+shift+[ / ]` 循环（v0.16）；tab 芯片（`⌘<n>`，浮在右上角）；中键关闭 |
| `plugins/layout/src/index.tsx` | 切换器图标的芯片（收起按钮**不**显示，v0.16）；`hintOfCommand` 读 `bindingFor` |
| `plugins/palette/src/index.tsx` | **v0.17**：行内有快捷键的命令在右侧显示它（`keysFor` 读快照的 `label`，多个键并列；没有绑定的行不显示） |
| `ui/src/styles.css` | 另加 `.diorama-palette__keys` / `.diorama-palette__key`（keycap 芯片，右对齐在命令 id 之前） |
| `plugins/help/src/bindings.ts` | 删掉本地的 `formatKeys`（改读内核的）；`index.tsx` 的 import 跟着换 |
| `kernel/test/keys.test.ts` | 新文件 7 条：格式化、规范记法与打印、`hintOf`、`modifierOf`（含组合字符）、**shift 和弦按按键帽匹配**（`⌘⇧[` 报 `{`）、hold store 的通知次数 |
| `plugins/help/test/bindings.test.ts` | 删掉搬走的 2 条 `formatKeys` 断言（随函数去了内核），另加一条：九个 tab 槽位在速查表里是九行 |
| `kernel/test/commands.test.ts` | 另加 3 条：`hintFor` / 快照的 `label` / `CommandContext.hints` |
| `apps/web/tests/m20-hints.spec.ts` | 新文件 5 条：按住显示 / 松手消失 + **tab 条几何不变**（v0.16）、芯片文本来自注册表 + Option 也算、只显示 tab 键（关闭 / 收起无芯片）、`mod+1..9` 跳 tab（含「没有第 5 个」）、中键关闭 |
| `apps/web/tests/m2-palette-keys.spec.ts` | **v0.17** 新文件 1 条：有快捷键的行右侧显示（`⌘W`、`⌘⌥1`），没有绑定的行不占位 |
| `docs/contract.md` | §3.7 三条规则 + 命令表一行 + 服务签名；§5.2 一条；新 **§31**；待定清单打勾 |
| `docs/features.md` | U3 补一句；新增 U22 |

## 5. 验证

1. `pnpm build`
2. `pnpm test:unit`（358 条，含新的 8 条）
3. `pnpm -r --no-sort run typecheck`
4. `node scripts/assemble-package.mjs`（壳与半边都变了，e2e 读的是组装产物）
5. `pnpm --filter diorama-web exec playwright test`（145 条，含新的 4 条）

## 6. 坑

1. **`mod+1` 是浏览器自己的键**。第一版把「按序号跳 tab」做成 `mod+1..9`：Chrome / Safari 直接
   切到浏览器的第 N 个标签，页面的 keydown 根本收不到——**单测与 e2e 全绿也说明不了什么**，
   因为 Playwright 的 `keyboard.press` 走 CDP 合成，绕过了浏览器的保留键。v0.15 改用 `alt+<n>`
   躲开了它——**v0.16 又改回 `mod+<n>`**：躲开浏览器的代价是键位不再是编辑器的那只手会按的键，
   这是更糟的问题（用户拍板「跟浏览器冲突也没关系」）。教训是分清两类验证：`matchesKeys` 的
   物理键兜底归单测，保留键行为归真人验证。
2b. **行内芯片会改变布局**。v0.15 把芯片画进 tab 的 label 按钮里：出现时 tab 变宽、关闭按钮变高，
    tab 条整体挪动——用户第一眼就指出来了。v0.16 的规则：**提示是浮层，不参与布局**
    （`position: absolute`），e2e 加了一条「按住前后 tab 条几何不变」的断言锁住它。
2c. **辅助键也要提示吗**？v0.15 给关闭按钮也挂了 `⌘W`。用户反馈：不要。一条 tab 上两个芯片、
    切换器脚下再来一个，读起来是噪音；提示只回答「这块区域我能按哪个数字 / 哪个视图键」，
    关闭与收起归 `?` 速查表。
2. **store 必须在组件订阅之前存在**。页面全局 store 是懒创建的（第一次 `holdModifier` 才建），
   而组件在**首次渲染**就 `subscribe` 了——订阅到一个稍后才出现的对象，等于没订阅。现象是
   「状态确实变了，芯片就是不出现」。规则：**页面全局 store 由发布方在 boot 时建出来**
   （`ensureHeldModifierStore`），与 `__diorama_overlay__` 那种「写的时候顺手建」不同。
3. **e2e 读的是组装产物**。改了 `ui/src/styles.css` 或半边，只跑 `pnpm build` 不够：壳来自
   `packages/cli/web/`，要跑 `node scripts/assemble-package.mjs`（docs/m9/spec.md §5.1、
   m17/spec §6 坑 9、m18/spec §6 坑 5）。
4. **`${…}` 写在替换字符串里会被吞掉**。本次编辑 `className={`diorama-sidebar__view${…}`}` 时，
   替换文本里的 `${…}` 被当成「替换内容」的插值，结果写出 `${{…}`——vite 报
   `Expected ',' or '}' but found '?'`。改这类模板字符串时**改完要回读一眼**。
5. **侧栏的一竖条放不下芯片**。36px 的 rail 里塞 `⌘⌥1` 会把图标挤掉；芯片必须**浮在图标右侧**，
   而 `.diorama-layout__sidebar` 是 `overflow: hidden`（视图面板靠它裁）——所以只在按住修饰键
   期间（`[data-hints='true']`）放开 `overflow`，折叠状态下尤其重要（那时整栏就是那一竖条）。
   浮层之上还要有**实底与投影**：tab 的芯片悬在文件名上，透明底会和文字叠在一起读不清。
6. **快照是对象就会无限重渲染**。hold store 的快照刻意是 `''` / `'mod'` / `'alt'` 这样的字符串，
   与 `overlayStore`（id）和 `revealStore`（stamp）同一手法。
7. **窗口失焦**。`keyup` 不会补发：`window.blur` 也要清，否则从别的 app 回来时提示一直亮着。
