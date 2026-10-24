# 功能清单（v1 范围）

> 记录于 2026-10-18。把已经讨论过的一切整理成一份**可勾选的功能清单**。
> 分三档：**v1 必做**、**定过但不做/deliberately 不做**、**未来**。
> 与 [architecture.md](architecture.md) 的决定、[contract.md](contract.md) 的契约对照看。
>
> **档位标注（2026-10-19，2026-10-20 更新）**：标 ✅ 的已落地；git 只读视图、URL 路由、git 历史视图、
> 图片与 PDF 渲染器见 [实施说明](m4/spec.md)（§1–§6 是第一轮，§7–§11 是第二轮）；
> 文件搜索见 [m6/spec.md](m6/spec.md)；界面图标见 [m7/spec.md](m7/spec.md)；
> Markdown 的大纲 / 公式 / 图表见 [m17/spec.md](m17/spec.md)。其余仍是 v1 目标。
> 契约见 [contract.md](contract.md) **v0.0.4**（§19 是主题切换的变更清单；§27 是本档）。

## 一、CLI

| # | 功能 | 档位 | 说明 |
|---|---|---|---|
| C1 | `diorama [dir]` | ✅ M0→M3 | 短命 CLI：确保 gateway → 挂载 → 打印 URL 并退出；`--foreground` 仍可前台跑（调试/测试）|
| C2 | `diorama ls` | ✅ M3 | 表格 `MOUNT PORT STATUS DIR URL CONFIG`（含 URL）；`--json`；不做 `--watch` |
| C3 | `diorama gateway start / stop / status / restart` | ✅ M3 | 后台进程 + pid 文件 + `gateway.log`；另有 `gateway run` 与 `diorama restart <dir>` |
| C4 | `--port <n>` | ✅ M0→M2 | 显式冲突报错；**未给时落 `diorama.toml`，再默认随机** |
| C5 | `--host <ip>` | ✅ M0→M2 | 默认 `127.0.0.1`；`diorama.toml` 可设 |
| C9 | `diorama.toml`（`host`/`port`/`plugins`/`ignore`/`[watch]`/`[git]`/`[html]`） | ✅ M2 | 目录 → `$DIORAMA_HOME` 查找；CLI > toml > 默认；写错 fail loud；`--config`、`--all`、`--dump-config`；`[html] scripts` 控制 HTML 预览是否默认执行页面脚本（contract §28）|
| C10 | `diorama config`（读写 `diorama.toml`） | ✅ 本档 | 交互式逐项编辑（回车保留 / `-` 清除 / 预览 + 确认）；`config show [--json]`、`config set --<key> <value>`、`config unset <key>`；**默认写 `$DIORAMA_HOME/diorama.toml`**，`--dir` / `--config` 才写项目文件（contract §4.2）；`--dry-run` / `--yes` |
| C11 | `diorama [dir] --json` / `diorama restart <dir> --json` | ✅ 本档 | 把挂载输出成**一个** JSON 文档（`url` / `root` / `mountId` / `created` + 完整 `mount: MountStatus`），供其它程序直接取 URL；可与 `--foreground` 同用（打印后照常不退出，contract §7.6） |
| C6 | 随机端口自动重试 | ✅ M3 | 随机端口上限 20 次；显式端口冲突直接 `EADDRINUSE`（退出码 1）|
| C7 | realpath 挂载键 + 别名提示 | ✅ M3 | 挂载键 = realpath（同一真实目录幂等）；打印的目录是 realpath 后的 |
| C8 | 单测/集成测试 | ✅ M0→本轮 | `apps/web/tests/`：114 条端到端（24 个 spec，真实 CLI/gateway + Chromium）；`pnpm test:unit`：289 条单测 |

## 二、Gateway

| # | 功能 | 档位 | 说明 |
|---|---|---|---|
| G1 | 单进程常驻，多目录挂载 | ✅ M3 | 每目录一个端口；插件图只加载一次（`createPluginHost`）|
| G2 | Unix socket 控制面 | ✅ M3 | `~/.diorama/diorama.sock`，NDJSON；`ping/mount/unmount/list/status/stop/events` |
| G3 | 目录级故障隔离 | ✅ M3 | 每 mount 独立 isolate key + fiber；卸载一个不动其它（e2e `2e`）|
| G4 | 不持久化 | ✅ M3（明确） | gateway 停了挂载清空；`gateway restart` 不保留挂载 |
| G5 | 启动竞态 | **暂缓** | 用户明确先不考虑 |
| G6 | supervisor 自拉起 | **未来** | O6 |
| G7 | degraded 恢复策略 | ✅ M3 | 自动重启一次（2s，新 mountId）+ `diorama restart <dir>`；不阻断请求；页面横幅 |

## 三、插件内核

| # | 功能 | 档位 | 说明 |
|---|---|---|---|
| K1 | Cordis 插件树（双端） | ✅ M0→M1 | `cordis@4.0.0-rc.11`；`fs` 是真正的 server 半边（`mounts.onMount`）|
| K2 | 客户端 Loader + 模块表 | ✅ M0→M1 | 闭合工厂 + 页面模块表（`react` / `react/jsx-runtime`，contract §8）；外部半边推迟 |
| K3 | 插件 manifest + contract version 检查 | ✅ M0→本轮 | `>=0.6 <0.7` 强制（含 kernel 包自己的 manifest）；`requires` 进 boot 图 |
| K4 | 插件来源：内置 + `~/.diorama/plugins` | **未来（最后一个里程碑）** | `PluginSource` 接口与 `BuiltinSource` 就位；外部目录见 contract §9 |
| K5 | 生命周期：代码全局、数据按目录 | ✅ M3 | `ctx.diorama.mounts` + `onMount`；每 mount 一个 fork 子 ctx（`isolate` + 自有 fiber）|
| K6 | slot 系统 | ✅ M0→M1 | 冲突三类分开（contract §3.3）、`ctx.slots.declare`、`file.renderer` matcher |
| K7 | fail loud + 回退链 | ✅ M0→M1 | 加载/契约/slot/渲染/RPC 五层；渲染器抛错→标记失败→下一个→plaintext |
| K8 | `ctx.fs`（只读） | ✅ M2→M3 | `list`（尊重 ignore）/ `stat` / `readText` / `readBytes` / `watch`（目录、300ms 合并、**mount 内共享**、`maxDirectories` 上限）；`ETOOLARGE` 上限 |
| K20 | `ctx.theme`（client） | ✅ v0.9 | 页面配色：跟随系统 / 锁定 / 主题注册表（§3.10）；纯客户端，不 RPC |
| K19 | `ctx.search`（只读） | ✅ v0.8 | `search(query, { kind, caseSensitive, wholeWord, regex, scope, maxFiles, maxMatchesPerFile })`；`name`（子序列）/ `content`（逐行报 line/column/length）；上限 200 文件 / 每文件 20 条 / 扫描 2 万文件，超限**截断**并报真实总数；二进制跳过；`EINVAL` / `ENOENT`（contract §3.9）|
| K9 | `ctx.git`（只读） | ✅ | `status` / `diff(scope)` / `log`（v0.5）；`show` / `showCommit` / `blob`、`base: 'index' \| <commit>`（v0.6）；**v0.10：一个挂载里的全部仓库**——`repos()` + 每个方法的可选 `repo`，向下走查 `.git`（`[git] maxDepth` 默认 3、`maxRepos`、`ignore` 剪枝），嵌套仓库不重复出现在外层；上限、错误码（contract §3.2）|
| K10 | `ctx.slots` | ✅ M0→M1 | |
| K11 | `ctx.commands` | ✅ M2 | 内核内置：命令 id fail loud、快捷键字面冲突抛错、`CommandContext` 内核采集、单一 keydown 分发 |
| K12 | `ctx.diorama.mounts` | ✅ M3 | `onMount` 时机、卸载顺序、`MountInfo` 带 `port`/`url`/`configFile`（契约 §2.5/§3.5）|
| K13 | RPC（client ↔ server） | ✅ M2 | WebSocket 自动代理；**订阅端点 + session**（`fs.watch`、`cancel`、连接关闭即取消）；**断线自动重连**（退避 500ms→10s）、保活帧（`ping`/`pong`）与订阅重放（`watchEndpoint`），重连后 `onReconnect` 让读者重读（contract §4、§26）|
| K14 | `ctx.storage`（`~/.diorama/` 持久化） | 🔲 待定 | 签名未定 |
| K15 | 插件异步任务托管 API | 🔲 待定 | 见 §12 讨论 |
| K16 | 热重载（HMR） | **未来** | 内好用，外部插件不必 |
| K17 | 插件安装/卸载管理（npm） | **未来** | `PluginSource` 预留 |
| K18 | token 认证 / 外部 server 半边显式开启 | **未来** | O3 |

## 四、内置插件

| # | 插件 | 档位 | 说明 |
|---|---|---|---|
| P1 | `layout` | ✅ M0 | 左右分栏（`layout.overlay` 给命令面：palette 与 help；v0.7 起是 list 座位）|
| P2 | `file-tree` | ✅ M0 | 左侧导航；目录点击=导航，文件点击=打开 |
| P3 | `tabs` | ✅ M2 | 多 tab：每文件一个 tab、keyed 座位、关闭回退、每 tab 独立滚动；**不提供编辑** |
| P4 | `renderer-registry` | ✅ M0→M1 | matcher 三档（ext → mime → probe）+ 兜底 + 失败回退（contract §5.1）|
| P5 | `markdown` | ✅ M1 | `.md` → HTML（marked + DOMPurify 消毒）；**链接留在页面内**（本站文件开 tab、`#fragment` 滚动、外部链接开新标签页、越界链接不动作；标题带 `id` 供锚点落点）——见 [m12/spec.md](m12/spec.md)。**v0.12：公式、图表与文档内大纲**（`$…$` / `$$…$$` → KaTeX，```mermaid 围栏 → Mermaid，两者**按需加载**、挂载后渲染、失败留源码；文章旁边一栏目录，属于这一篇、点一行滚过去）——见 [m17/spec.md](m17/spec.md) |
| P6 | `code` | ✅ M1 | highlight.js 按语言注册；`.md` 不在其中（归 markdown），`.html` / `.htm` 也不在其中（归 html）|
| P7 | `plaintext` | ✅ M0 | 兜底渲染器 |
| P8 | `palette` | ✅ M2 | 插件，`layout.overlay` 条目，`mod+k`；只列可执行命令 |
| P18 | `help`（快捷键说明） | ✅ v0.7 | 插件，第二个 `layout.overlay` 条目（`order: 200`），`?`（`shift+?`）开/关；列出**全部**绑定，当前不可用的**灰显**；`Esc` 关闭。与 palette 互斥（开一个关另一个）|
| P20 | `theme`（主题命令） | ✅ v0.9 | 内核服务 `ctx.theme`（§3.10）+ 只注册命令的 piece：`theme.cycle`（`mod+alt+t`）、跟随系统 / 亮色 / 暗色，**每个第三方主题一条 `theme.use:<id>`**；偏好存 `localStorage`、hash 可分享，页面壳首帧前防白闪 |
| P15 | `fs`（server 半边） | ✅ M1 | 内核自带；`--plugins` 不影响服务端 |
| P10 | `image` 渲染器 | ✅ 本轮 | `mime: ['image/*']`；先 `stat`、超 32 MiB 不请求；bytes → Blob URL → 原生 `<img>`（SVG 也走 `<img>`，不内联 DOM）|
| P11 | `pdf` 渲染器 | ✅ 本轮 | `ext: ['pdf']`；bytes → Blob URL → `<iframe>`（浏览器 viewers），另给 blob 链接；不引 PDF 引擎 |
| P17 | `html` 渲染器 | ✅ | `ext: ['html', 'htm']` 的唯一 owner；**样式阶段**：页面 CSS（内联 / `style=` / 外链）与外部图片放行，脚本不跑；**脚本阶段**：逐文件确认后 `allow-scripts`（无 `allow-same-origin`）执行页面脚本；另有源码视图。切换在渲染器头部（contract §5.1）。**`[html] scripts = true` 让含脚本的页面打开即进脚本阶段**（默认 `false`，仍逐文件确认；contract §4.1、§28）|
| P12 | `git-changes`（变更视图 + diff 座位） | ✅ | 左栏「变更」（`sidebar.views` 的 `changes` 视图，`order: 20`）；该 tab 以 `view: 'diff'` 渲染 unified diff；**v0.6：由 `fs.watch` 驱动重算**（不再 5 秒轮询）；**v0.10：按仓库分组、组头可折叠**（多仓库挂载）；一个仓库都没有时两个 git 视图都不出现。**v0.10：diff 三种读法**（「改动」= 着色的 unified diff；「整个文件」= 单栏，把改动放进文件自己的行号里；「新旧对照」= 双栏，左旧右新、删除在左、新增在右；长段未改动行都折成可展开的横带；偏好存 `localStorage`、对工作区 tab 与提交座位同时生效）+ 头部 ‹ › 与 ↑/↓ 在变更块之间循环跳转、`+a −r` 计数 |
| P16 | `git-changes`（历史视图 + 提交座位） | ✅ 本轮 | 左栏「历史」（`history`，`order: 30`）：提交列表（每页 50，上限 500），**v0.10 起按仓库分组、组头可折叠**；点提交写 `#history=<sha>`，右侧 `seats.git-commit` 显示**标题行**（正文展开/收起）、作者、文件清单与「改动 / 提交时的内容」；**打开文件（含再点当前文件）或切走侧栏视图即回到 tab 列表**，`#history` 随之清掉 |
| P13 | `search-view`（文件搜索） | ✅ v0.8 | 左栏「搜索」视图（`order: 40`）：**按内容**（字面量 / 正则、大小写、全字）与**按文件名**（子序列，VS Code 的 `Ctrl+P` 口径）两种模式；结果按文件折叠，点一条打开文件并**跳到那一行**。另注册 `mod+p` 快速打开覆盖层（`layout.overlay`，`order: 300`）。服务是内核的 `ctx.search`（§3.9），只走 `ctx.fs`，因此 `ignore` 对树与搜索一致 |
| P14 | `jupyter` / `.ipynb` | **未来** | 第二轮明确不做（只要文本，但渲染形式未定）|
| P9 | `i18n` | 🔲 待定 | 界面语言未做（主题已独立成 P20 / U12）|
| P19 | 图标（文件类型 + 功能按钮） | ✅ v0.8 | 按钮 = Tabler 描边（语义名），文件/文件夹 = Material Icon Theme 彩色（精选 ~195 glyph + 其映射表）；插画由 shell 经 `diorama-ui/icons` 装到页面全局，半边只带读法（[m7/spec.md](m7/spec.md)）|

## 五、UI 交互

| # | 功能 | 档位 | 说明 |
|---|---|---|---|
| U1 | 左侧栏 + 右侧多 tab | ✅ M0→本轮 | 左栏是 `sidebar.views`（文件树 / 变更 / 历史 / 搜索，VS Code 式切换）；每个 tab 一个内容座位（隐藏不卸载）；**v0.11 起左栏宽度可拖**（U16）；**v0.13 起可收起**（U20）|
| U15 | 文件类型图标 / 功能按钮图标 | ✅ v0.8 | 树、tab 条、搜索结果、变更列表的文件行带彩色类型图标（目录随展开态换画）；切换器、tab 关闭、搜索开关、刷新等按钮用同族描边图标；换掉文字的按钮都补 `aria-label`（[m7/spec.md](m7/spec.md)）|
| U2 | 文件变化自动刷新（watch） | ✅ M2 | 内容与树；`view.toggleAutoRefresh` 可关 |
| U3 | 快捷键 | ✅ M2 | 全局唯一绑定 + `when`；`mod` = ⌘/Ctrl；v0.6 加 `mod+alt+1/2/3` 切侧栏视图；v0.7 加 `?` 开快捷键说明；v0.8 加 `mod+alt+4`（搜索视图）、`mod+p`（快速打开）、`mod+shift+f`（搜索视图）；v0.9 加 `mod+alt+t`（主题循环） |
| U4 | command palette | ✅ M2 | 只列可执行命令（不灰显），`Esc` 关、`Enter` 跑 |
| U14 | 搜索结果的落点（跳到那一行） | ✅ v0.8 | 点搜索结果打开文件并滚到该行、画出高亮带（`diorama-ui` 的 reveal store，页面全局）；`code` 与 `plaintext` 都实现了，Markdown 等不跳（其渲染不保行号）|
| U13 | 快捷键说明（速查表） | ✅ v0.7 | `?` 开/关，`Esc` 关；全部绑定都在（不可用的灰显）；与 palette 同一时刻只开一个 |
| U16 | 可拖动的窗格 | ✅ v0.11 | 左栏与提交座位的文件清单各有一条可拖的边（`diorama-ui` 的 `Splitter`）：指针拖动、← → / Shift / Home / End 可调，160–720px，宽度记在 `localStorage`；拖动期间只写 CSS 变量，松手才进 React state（contract §5.2、docs/m15/spec.md） |
| U20 | 侧栏收起（只剩切换器） | ✅ v0.13 | 切换器脚下有「收起 / 展开」按钮（`aria-expanded` / `aria-controls`），`mod+b` 同一条命令；**点当前显示中的那个图标也收起**（activity bar 手势，别的图标切视图）；收起后只剩 36px 的一竖条，视图面板**隐藏不卸载**（滚动、展开、选择都留着），没有可拖的边；收起是**偏好**（`localStorage`），与「选了哪个视图」正交，折叠状态下点图标会先展开（contract §5.2、§3.7、§29；docs/m18/spec.md）|
| U17 | 长名字看得全（横向滚动） | ✅ v0.11 | 列表窗格的行按内容长、名字不收缩不省略，横向滚那一栏：文件树、变更、历史、搜索、提交座位文件清单；**新窗格照此办理**（contract §5.2） |
| U5 | 工具栏 | **不做** | 明确移除；开关型交互改由命令承担（O8 缓解；本轮「改动/内容」是提交座位里的两个按钮，不是工具栏）|
| U6 | 渲染模式切换 | 部分 ✅ | `html` 在自己的头部给了「预览 / 源码」两个按钮，`git-changes` 的 diff 给了「改动 / 整个文件 / 新旧对照」三个（O8：开关归渲染器，不开工具栏）；`md` 的源码/预览仍未定 |
| U18 | Markdown 大纲（文档内目录） | ✅ v0.12 | 文章**旁边一栏目录**，在这篇文章自己的 tab 里（**不是**左栏视图：一个文件的标题不是关于挂载的事实）。标题按层级缩进、从 1 起不跳级，点一行滚到这一篇的那一节，当前小节按滚动位置标记；**少于两条标题不画**（contract §5.1、§27）|
| U19 | 公式（KaTeX）与图表（Mermaid） | ✅ v0.12 | `$…$` / `$$…$$` 与 ```mermaid 围栏；两个库**按需加载**（文档里没有就一个字节都不下），从插件自己的包 `/plugins/markdown/vendor/` 取，挂载后在消毒过的 DOM 上渲染；渲染失败留源码、不弹窗；Mermaid 跟随页面配色重画（contract §5.1、§27）|
| U7 | 图片缩放 / 适配窗口 | 🔲 待定 | O8 |
| U8 | diff 并排 / 行内切换 | ✅ | **并排已做**（v0.10）：三档读法「改动（行内）/ 整个文件（单栏）/ 新旧对照（双栏）」+ 变更块间导航（contract §23）|
| U9 | 状态栏 | **v1 不做** | 已从契约 slot 表移除 |
| U10 | 多 tab 状态持久化（刷新后恢复整组 tab） | 🔲 待定 | O5；刷新只恢复**活动文件**（URL）与 hash 里的视图（`#diff`、`#history=<sha>`）|
| U11 | URL 路由（可直接分享某个文件） | ✅ 本轮 | `/~/<RelPath>`（path 形态，`/~/` 为保留前缀）；`ctx.router` 内核内置；刷新恢复单 tab（contract §3.8）|
| U12 | 深色/浅色主题 | ✅ v0.9 | 默认跟随系统（`prefers-color-scheme` 实时跟随）；`light` / `dark` 锁定；第三方主题经 `ctx.theme.register` 以 token 覆盖加入（contract §3.10、§5.3）；`ctx.storage` 服务端同步仍留给 K14 |

## 六、明确不做（v1 及以后）

| 功能 | 原因 |
|---|---|
| 编辑 / 保存 / 重命名 / 删除 | 定位是只读查看器 |
| git 写操作（commit / stage / checkout） | 同上 |
| 固定 URL 入口 | 你明确不要 |
| 用户自定义快捷键 | v1 不做 |
| 多挂载同页展示 | 一端口一目录 |

## 七、尚未讨论过的功能（需要你决定要不要）

这些是我认为「一个文件查看器通常会想要、但你没提过」的，列出来供你取舍：

1. ~~**全文搜索（命令面板附带文件搜索）**~~ —— **v0.8 已做**：不是塞进命令面板，而是独立的「搜索」视图 + `mod+p` 快速打开（见 P13 / K19 / U14）。不做索引：每次查询现场走目录（上限见 contract §3.9）。
2. **主题 / 外观配置** —— 至少要不要支持跟随系统深色模式。（**两轮都明确不做**；等 `ctx.storage` 定签名）
3. **URL 可分享** —— `#/path/to/file`，打开链接直达某文件。
4. **多 tab 记忆** —— 刷新后恢复上次打开的 tab。（**待定**：现在只恢复活动文件与 hash 里的视图）
5. **隐藏文件与 `.gitignore`** —— 文件树默认是否隐藏 `.git`、`node_modules`。（**已定**：默认隐藏这两项，可用 `ignore` 覆盖；`.gitignore` 不读）
6. **大文件/大目录策略** —— 目录上万文件时树怎么加载；文件超大时是否截断。（**M2 已做**：每目录 500 条分页 +「加载更多」）
7. **二进制文件处理** —— 不认识的文件显示大小/类型信息，还是“不支持”。
8. **键盘可达性** —— 文件树能否全键盘导航。
9. **语言 / 本地化** —— UI 是否只做中文，还是中英双语。
10. **`diorama.toml`** —— 名字定过配置文件名，但配置项一个都没定。（**M2 已定**：见 contract §4.1）
