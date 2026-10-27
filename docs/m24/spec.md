# 实施说明：文件视图的工具栏与「定位到正在浏览的文件」

> 记录于 2026-10-27。用户要求：**在文件导航窗上加个工具栏，工具栏加个按钮，可以定位到正在浏览的文件**。
> 契约不升号（§6）：没有新增内核服务、没有加座位、没有改 slot 清单、没有改 `/plugin.json`。
> 契约正文补在 §35（另在 §3.4 补了 `ctx.tree.reveal`、§3.7 补了 `tree.revealActive`、§5.2 补了
> 「视图可以有自己的工具栏」）。

## 1. 出发点

文件树是一个**懒加载、可折叠**的列表：目录要一级一级点开，超过 `PAGE_SIZE`（500）条的目录先列一页。
读一个深文件的时候，树往往停在别处——读者刚才是从搜索结果、快速打开、URL 深链，或者干脆是上一个
会话的地址进来的。这时「我读到的东西在这个目录里的哪儿」要靠手点四级目录找回来。

按钮要做的事只有一件：**让树追上正在读的那个文件**。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 工具栏放哪 | 文件视图面板的**顶部**，钉住（`position: sticky`） | 视图的控件就该在视图里；钉住是因为列表在它下面滚 |
| 用什么座位 | **不用** | 座位是「别人往这里注册」的东西；这颗按钮只有文件视图自己知道该做什么（展开、滚它自己的列表）。开座位还会把「谁画这一条」变成第二个 owner，和「切换器由 `layout` 画」的既有分工打架 |
| 「正在浏览的文件」是谁 | **活动 tab 的 `path`** | tab 是「读者在看的那个文件」的唯一真源（§3.4）。`diff` tab 也带 `path`，两种视图下都找得到 |
| 没有 tab 时 | 按钮**禁用**（标题「没有正在浏览的文件」），命令 `when` 为假 | 禁用而不是隐藏：会消失的按钮让工具栏跳动；命令不可执行时 palette 本来就不列它（§3.7） |
| 谁展开目录 | `ctx.tree.reveal(path)` | 「哪些目录是展开的」是服务的状态；服务负责「路径 → 展开」，视图负责「滚 + 标」，两边都不越界 |
| 快照里记什么 | `reveal: { path, at }` | 连按两次要连定位两次；只记路径的话快照不变、React 不重渲染。`at` 是单调戳（与 §3.9 的 `RevealTarget.at` 同一条规矩） |
| 分页的目录 | 落点在第二页之后时**按需长到**落点 | 行不存在就滚不过去；这与「加载更多」是同一个动作，只是由定位代按 |
| 会不会收起目录 | **不会** | 定位是「找回来」，不是「重排」。读者自己开的目录照旧开着 |
| 是不是导航 | **不是** | 不打开、不切 tab、不改选中、不动 URL。读者已经在读了 |
| 高亮 | 一段 `1.6s` 的淡出背景（`data-located`） | 动画不是状态：不需要「清掉高亮」这一步，读者继续滚动也不受影响 |
| 命令 | `tree.revealActive`，`mod+shift+l` | 同一件事的第二个入口（palette / 键盘）。键位不与现有绑定冲突，`l` 取「locate」 |

## 3. 实现

- **服务**（`packages/kernel/src/client/tree.ts`）：`TreeSnapshot` 多一个 `reveal`，`TreeService` 多一个
  `reveal(path)`；`ancestorsOf(path)` 是导出的纯函数（`a/b/c.md` → `a`、`a/b`），单测直接测它。
  `reveal` **不选中、不打开**，只把祖先并进 `expanded` 并递增 `at`。
- **视图**（`packages/plugins/file-tree/src/index.tsx`）：`FileTreeRoot` 外面包一层 `.diorama-tree-view`，
  第一行是 `TreeToolbar`（`role="toolbar"`、`data-testid="file-tree-toolbar"`），按钮
  `data-testid="file-tree-reveal"`。活动路径从 `ctx.tabs` 的快照里读（`useStore`），页面没有 `tabs`
  piece 时读一个常量空 store——hook 数量不变。
- **落点**（`useLocated`）：每行一个 ref，`reveal.at` 变化时 `scrollIntoView({ block: 'center' })`；
  只有 `reveal.path` 那一行返回 `located`，那一行才带 `data-located="true"` 与动画类。
- **分页**（`useDirectory(..., ensure)`）：`ensure` 是「这一页里要露出来的那一行」，落点索引超过当前
  `visible` 时把它长到 `index + 1`。
- **命令**：`tree.revealActive` 由 `file-tree` 注册（`tree.*` 归它，§3.7），`when` 看
  `context.activeTab !== undefined`，`run` 调 `ctx.tree.reveal(context.activeTab.path)`。
  工具栏那颗按钮**直接调同一个服务方法**，不绕命令——按钮是即时动作，不值得等一个 `async run`。
- **样式**（`packages/ui/src/styles.css`）：`.diorama-tree__toolbar`（sticky、底边线、面板底色）、
  `.diorama-tree__tool`（24×24 的图标按钮，`:disabled` 半透明）、`.diorama-tree__row--located` +
  `@keyframes diorama-tree-located`（`--dio-reveal-bg` 淡出）。
- **图标**：`reveal-file` → Tabler `current-location`，进 `scripts/generate-icons.mjs` 的
  `BUTTON_ICONS`，跑 `pnpm icons`，再 `node scripts/assemble-package.mjs`（表由壳装）。

## 4. 改动清单

| 包 / 文件 | 改动 |
|---|---|
| `kernel/src/client/tree.ts` | `TreeReveal`、快照的 `reveal`、`reveal(path)`、`ancestorsOf` |
| `kernel/src/client/index.ts`、`kernel/src/types.ts` | 导出 `TreeReveal` |
| `plugins/file-tree/src/index.tsx` | 工具栏、`useLocated`、`useDirectory` 的 `ensure`、命令 `tree.revealActive` |
| `ui/src/styles.css` | 工具栏 / 工具按钮 / 落点动画 |
| `scripts/generate-icons.mjs` + `ui/src/icons/button-icons.ts` | `reveal-file` 图标 |
| `kernel/test/tree.test.ts`（新） | `reveal` 展开沿路、戳递增、不选中、不收起；`ancestorsOf` |
| `apps/web/tests/m24-tree-toolbar.spec.ts`（新） | 按钮定位（展开 + `data-located` + 不多开 tab）、禁用态、命令的 `when` 与快捷键 |
| `docs/contract.md` | §3.4 `ctx.tree` 签名、§3.7 命令表、§5.2「视图可以有自己的工具栏」、§35 |
| `docs/features.md` | U5 改写为「部分 ✅」、新增 U24 |
| `AGENTS.md` | 「最近一档」指向本文件 |

## 5. 没做的（明确）

- **页面级 / 文件级工具栏**：仍然不做（O8）。工具栏上只放**作用于视图**的动作；文件自己的开关
  （渲染模式、缩放）归渲染器头部。
- **在树里「跟随」当前文件**：按钮是一次动作，不是常开模式。常开就得在读者滚动、开 tab 时不停抢
  滚动位置，那与「读者自己在看什么」冲突。
- **定位到提交 / diff 里的某一侧**：提交不是文件、没有树行（§5）。
- **`ctx.layout` 的服务面**：工具栏不改变它仍是 🔲（§3.4）。

## 6. 验证

1. `pnpm build`
2. `pnpm test:unit`（389 条，含新增 4 条）
3. `pnpm -r --no-sort run typecheck`
4. `node scripts/assemble-package.mjs`，再 `pnpm --filter diorama-web exec playwright test`（154 条）

## 7. 坑

1. **`data-located` 只在落点那一行为真**。祖先目录也会被展开，但它们不是「找到的东西」——给每一级
   都标一遍，读者就不知道眼睛该落在哪。
2. **快照里必须带戳**。只记 `path` 的话，连按两次第二次什么都不发生（快照没变、React 不重渲染）。
   这与 §3.9 reveal store 的 `at` 是同一个坑。
3. **分页的落点要先长出来**。600 条里第 550 条的行根本不在 DOM 里，`scrollIntoView` 无处可滚；
   `ensure` 把它长出来之后才轮到滚动（effect 在渲染之后跑）。
4. **别在 `aria-hidden` 的隐藏视图里抢滚动**：非活动视图是隐藏而不卸载（§5.2），它的 ref 还在。
   落点只在 `reveal.at` 变化时执行一次，读者切回来不会再被拽一次——这是刻意的（定位是动作，不是状态）。
5. **按钮禁用而不是隐藏**：没有 tab 时它还在（灰掉），工具栏不会因为「有没有文件」而变形；
   命令那边则用 `when` 让它从 palette 消失，两条路各按自己的规矩。
6. **图标表是壳装的**：新 glyph 要跑 `pnpm icons` **并且** `node scripts/assemble-package.mjs`，
   否则 e2e 的页面里 `iconSvg('reveal-file')` 还是 `''`，按钮退回一个字（docs/m17/spec.md §6 坑 9）。
