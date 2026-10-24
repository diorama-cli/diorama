# 实施说明：侧栏可以收起

> 记录于 2026-10-24。用户要求：**左侧图标点击可以收起左侧窗格**。契约不升号（§6）：没有新增服务、
> 没有改 `ctx.*` 的签名、**没有加座位**；变的是 §5.2 里左栏的形态（多一个「收起」状态）、
> §3.7 的命令表（多一条 `sidebar.toggleFolded`），以及 `diorama-ui` 的样式。
> 契约正文补在 **§5.2 / §3.7**，变更清单在 contract.md **§29**。

## 1. 出发点

左栏是一条栏、多个视图（v0.5 的 `sidebar.views`），宽度可拖（v0.11）。读一份长文件时它一直占着
260px，而读者那一刻并不需要它——VS Code 的答案是「把栏折起来，只留 activity bar」：

1. **要有收起 / 展开**，键位与按钮各一条路；
2. **收起后切换器还得在**，否则页面上没有任何东西能把栏展开回来；
3. **收起不能丢掉读者正在看的视图**：展开回来还是那一栏。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 收起后剩什么 | 切换器那一竖条（36px） | 宽度为 0 会把切换器一起带走，页面上就没有「展开」这个动作了 |
| 按钮放哪 | 切换器**脚下**（`diorama-sidebar__rail` 的最后一个子元素） | 它必须留在收起后仍可见的那一竖条里；放在面板头部就会随面板一起消失 |
| 收起是什么 | **偏好**（`localStorage`） | 与宽度、主题、diff 的读法同一口径：读者选的，刷新回来还是它 |
| 收起与「选了哪个视图」 | **两个 store**（`FoldChoice` / `ViewChoice`） | 收起不是"选了一个空视图"：读者展开时期望回到原来那一栏 |
| 点视图时 | **活动图标收起，别的图标切视图**（activity bar 手势） | 用户的原话是「左侧图标点击可以收起」——按 VS Code 的口径，点当前显示中的图标 = 收起，点别的图标 = 切换；折叠状态下任意图标都先展开再切（否则改的是看不见的面板）|
| 收起时的拖拽边 | **不挂载** | 没有宽度可拖；隐藏一个还能聚焦的分隔条只会让 Tab 键停在一个空动作上 |
| 面板怎么收 | 隐藏（`display: none`），**不卸载** | 与「非活动视图」「`tabs.content`」同一条规则：滚动、展开、搜索词都留着 |
| 键位 | `mod+b` | 与现有绑定都不撞；浏览器把 `mod+b` 留给书签栏，但页面拦得住 |
| 图标 | `sidebar-fold` / `sidebar-unfold`（Tabler 的 `layout-sidebar-left-collapse` / `-expand`） | 语义名进 `BUTTON_ICONS`，插画换一张只改一行 |

## 3. 语义细则

- **状态在页面里，不在内核**：`FoldChoice` 与 `ViewChoice` 同在 `layout` 的模块里（切换器的当前
  视图本来就是页面状态）。`ctx.layout` 仍是 🔲（contract §3.4），这里不为它开服务。
- **宽度与收起正交**：宽度还是 `usePaneSize` 管的那个数（160–720px、可拖、记在
  `diorama.layout.sidebarWidth`）；收起时不用它，展开时照旧。所以「收起 → 展开」回来的是**原来
  那个宽度**，不是默认值。
- **URL 不记收起**：hash 只记视图（`#history=<sha>` 之类，contract §3.8）。刷新时 hash 选视图，
  收起状态从 `localStorage` 读——两者各读各的。
- **命令**：`sidebar.toggleFolded`，`when` = 「侧栏有视图」（没有视图时整栏都不画，也就没有可收起的）。
  它不是「第四条视图命令」：收起的是**整栏**，与选哪个视图正交。
- **图标的手势**：点**当前显示中**的图标收起，点别的图标切到那个视图（栏开着时不顺手收起，折叠时
  任意图标都先展开）。活动图标的 `title` 随状态写明（「再点收起侧栏 / 点击展开侧栏」）；
  `aria-label` 仍是视图自己的标题——屏幕阅读器要的是"这是哪个视图"，不是"再点一下会怎样"。
- **无障碍**：按钮 `aria-expanded` 表示栏是否展开、`aria-controls="diorama-sidebar-panes"` 指向面板、
  `aria-label` 随状态在「收起侧栏 / 展开侧栏」之间换。面板 `hidden` 时不进无障碍树。

## 4. 改动清单

| 包 | 改动 |
|---|---|
| `plugins/layout/src/sidebar.ts` | 新文件：`SIDEBAR_FOLDED_KEY`、`SIDEBAR_RAIL_PX`、`readFolded` / `storeFolded`。**纯函数**（`node --test` 能跑） |
| `plugins/layout/src/index.tsx` | `FoldChoice` store（版本号快照、`toggle` / `set`）；`Sidebar` 拆出 `diorama-sidebar__rail` + `FoldButton`；`SplitFrame` 读它决定栏宽与是否挂 `Splitter`；切换器与 `sidebar.show*` 先展开；注册 `sidebar.toggleFolded` + `mod+b` |
| `plugins/layout/test/sidebar.test.ts` | 新文件 6 条：没存过 = 展开、存过 = 收起、展开也写、别人写的值不收起、没有 storage 不抛错、竖条宽度 > 0 |
| `ui/src/styles.css` | `.diorama-sidebar__rail`、`.diorama-sidebar__fold`、`.diorama-layout__sidebar--folded`、`.diorama-layout--folded`（两列网格）。只用 token |
| `scripts/generate-icons.mjs` | `BUTTON_ICONS` 加 `sidebar-fold` / `sidebar-unfold`；`pnpm icons` 重新生成 `ui/src/icons/button-icons.ts` |
| `package.json` | `test:unit` 加 `packages/plugins/layout/test/*.test.ts` |
| `apps/web/tests/m18-sidebar.spec.ts` | 新文件 4 条：按钮收起 / 展开（宽度、面板、分隔条、`aria-*`）、`mod+b` 与刷新后仍收起、收起不改变视图且点视图会展开、命令在注册表里 |
| `docs/contract.md` | §5.2 补收起的三条边界；§3.7 命令表加一行与一段说明；新 **§29**；待定清单打勾 |
| `docs/features.md` | U1 补一句；新增 U20 |

## 5. 验证

1. `pnpm build`
2. `pnpm test:unit`（含新的 6 条）
3. `pnpm -r --no-sort run typecheck`
4. `node scripts/assemble-package.mjs`（壳里的图标表变了，e2e 用的是组装产物）
5. `pnpm --filter diorama-web exec playwright test`（含新的 4 条）

## 6. 坑

1. **收起不能做成"宽度 0"**。第一版想让栏宽归零：结果切换器跟着消失，页面上再没有能点「展开」的
   东西——读者被自己的操作锁在外面。规则：**收起后仍可见的那一竖条里，必须有能展开它的控件**。
2. **收起与选视图是两个状态**。做成"选一个空视图"最省事，但展开时视图就丢了；而把收起塞进
   `ViewChoice` 又会让 `sidebar.show*` 顺手改掉它。两个 store、各记各的 `localStorage` 键。
3. **收起的分隔条要卸载，不是隐藏**。`Splitter` 是 `role="separator"`、可聚焦、可用方向键调宽度；
   隐藏一个还能聚焦的分隔条，Tab 键会停在一个改了也看不见的动作上。没有宽度可拖时它就不该存在。
4. **点视图要先展开**。折叠状态下点切换器图标，改的是 `display: none` 的面板——按钮看上去什么
   都没做。切换器与命令都先 `foldChoice.set(false)` 再 `viewChoice.show(...)`。
5. **图标表在页面壳里**。`sidebar-fold` 进 `BUTTON_ICONS` 之后只跑 `pnpm icons` 不够：表由**壳**安装，
   e2e 读的是 `packages/cli/web/` 这份组装产物（`node scripts/assemble-package.mjs`），漏了这一步
   按钮会退回标题首字——看起来"图标没生效"（docs/m9/spec.md §5.1、m17/spec §6 坑 9）。
