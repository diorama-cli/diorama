# 功能清单（v1 范围）

> 记录于 2026-10-18。把已经讨论过的一切整理成一份**可勾选的功能清单**。
> 分三档：**v1 必做**、**定过但不做/deliberately 不做**、**未来**。
> 与 [architecture.md](architecture.md) 的决定、[contract.md](contract.md) 的契约对照看。
>
> **档位标注（2026-10-19，M2 完成时）**：标 ✅ 的已落地；**M2** 一栏均已实现并通过
> [M2 实施说明](m2/spec.md) 的验收。其余仍是 v1 目标。契约见 [contract.md](contract.md) **v0.3**。

## 一、CLI

| # | 功能 | 档位 | 说明 |
|---|---|---|---|
| C1 | `diorama [dir]` | ✅ M0→M1 | 前台单进程直接服务该目录并打印 URL（gateway 化在 M3）|
| C2 | `diorama ls` | v1 | 列出「目录 → URL → 状态」 |
| C3 | `diorama gateway start / stop / status / restart` | v1 | 你只提了 stop，另外三个是缺了不好用的配套 |
| C4 | `--port <n>` | ✅ M0→M2 | 显式冲突报错；**未给时落 `diorama.toml`，再默认随机** |
| C5 | `--host <ip>` | ✅ M0→M2 | 默认 `127.0.0.1`；`diorama.toml` 可设 |
| C9 | `diorama.toml`（`host`/`port`/`plugins`/`ignore`/`[watch]`） | ✅ M2 | 目录 → `$DIORAMA_HOME` 查找；CLI > toml > 默认；写错 fail loud；`--config`、`--all`、`--dump-config` |
| C6 | 随机端口自动重试 | v1 | 上限 20 次 |
| C7 | realpath 挂载键 + 别名提示 | v1 | 符号链接输入时打印 `mounted <real> (from <input>)` |
| C8 | 单测/集成测试 | ✅ M0→M2 | `apps/web/tests/`：31 条端到端（真实 CLI + Chromium）；`pnpm test:unit`：58 条单测 |

## 二、Gateway

| # | 功能 | 档位 | 说明 |
|---|---|---|---|
| G1 | 单进程常驻，多目录挂载 | v1 | 每目录一个端口 |
| G2 | Unix socket 控制面 | v1 | `~/.diorama/gateway.sock` |
| G3 | 目录级故障隔离 | v1 | 一个挂载崩不影响其它 |
| G4 | 不持久化 | v1（明确） | gateway 停了挂载清空 |
| G5 | 启动竞态 | **暂缓** | 用户明确先不考虑 |
| G6 | supervisor 自拉起 | **未来** | O6 |
| G7 | degraded 恢复策略 | 🔲 待定 | O7 |

## 三、插件内核

| # | 功能 | 档位 | 说明 |
|---|---|---|---|
| K1 | Cordis 插件树（双端） | ✅ M0→M1 | `cordis@4.0.0-rc.11`；`fs` 是真正的 server 半边（`mounts.onMount`）|
| K2 | 客户端 Loader + 模块表 | ✅ M0→M1 | 闭合工厂 + 页面模块表（`react` / `react/jsx-runtime`，contract §8）；外部半边推迟 |
| K3 | 插件 manifest + contract version 检查 | ✅ M1 | `>=0.2 <0.3` 强制；`requires` 进 boot 图 |
| K4 | 插件来源：内置 + `~/.diorama/plugins` | **未来（最后一个里程碑）** | `PluginSource` 接口与 `BuiltinSource` 就位；外部目录见 contract §9 |
| K5 | 生命周期：代码全局、数据按目录 | ✅ M1（单目录形态） | `ctx.diorama.mounts` + `onMount`；`ctx.fork()` 随 M3 |
| K6 | slot 系统 | ✅ M0→M1 | 冲突三类分开（contract §3.3）、`ctx.slots.declare`、`file.renderer` matcher |
| K7 | fail loud + 回退链 | ✅ M0→M1 | 加载/契约/slot/渲染/RPC 五层；渲染器抛错→标记失败→下一个→plaintext |
| K8 | `ctx.fs`（只读） | ✅ M2 | `list`（尊重 ignore）/ `stat` / `readText` / `readBytes` / `watch`（目录、300ms 合并）；`ETOOLARGE` 上限 |
| K9 | `ctx.git`（只读） | v1 | diff / status / log 🔲 签名待定 |
| K10 | `ctx.slots` | ✅ M0→M1 | |
| K11 | `ctx.commands` | ✅ M2 | 内核内置：命令 id fail loud、快捷键字面冲突抛错、`CommandContext` 内核采集、单一 keydown 分发 |
| K12 | `ctx.diorama.mounts` | v1 | |
| K13 | RPC（client ↔ server） | ✅ M2 | WebSocket 自动代理；**订阅端点 + session**（`fs.watch`、`cancel`、连接关闭即取消）|
| K14 | `ctx.storage`（`~/.diorama/` 持久化） | 🔲 待定 | 签名未定 |
| K15 | 插件异步任务托管 API | 🔲 待定 | 见 §12 讨论 |
| K16 | 热重载（HMR） | **未来** | 内好用，外部插件不必 |
| K17 | 插件安装/卸载管理（npm） | **未来** | `PluginSource` 预留 |
| K18 | token 认证 / 外部 server 半边显式开启 | **未来** | O3 |

## 四、内置插件

| # | 插件 | 档位 | 说明 |
|---|---|---|---|
| P1 | `layout` | ✅ M0 | 左右分栏（`layout.overlay` 留给 palette，M2）|
| P2 | `file-tree` | ✅ M0 | 左侧导航；目录点击=导航，文件点击=打开 |
| P3 | `tabs` | ✅ M2 | 多 tab：每文件一个 tab、keyed 座位、关闭回退、每 tab 独立滚动；**不提供编辑** |
| P4 | `renderer-registry` | ✅ M0→M1 | matcher 三档（ext → mime → probe）+ 兜底 + 失败回退（contract §5.1）|
| P5 | `markdown` | ✅ M1 | `.md` → HTML（marked + DOMPurify 消毒）|
| P6 | `code` | ✅ M1 | highlight.js 按语言注册；`.md` 不在其中（归 markdown）|
| P7 | `plaintext` | ✅ M0 | 兜底渲染器 |
| P8 | `palette` | ✅ M2 | 插件，`layout.overlay` 条目，`mod+k`；只列可执行命令 |
| P9 | `theme` / `i18n` | 🔲 待定 | 没讨论过 |
| P15 | `fs`（server 半边） | ✅ M1 | 内核自带；`--plugins` 不影响服务端 |
| P10 | `image` 渲染器 | **未来** | 没讨论过 |
| P11 | `pdf` 渲染器 | **未来** | 没讨论过 |
| P12 | `git-diff` 渲染器 | **未来** | 需要 `ctx.git`；是名字里的卖点之一 |
| P13 | `search`（全文检索） | **未来** | 没讨论过 |
| P14 | `jupyter` / `.ipynb` | **未来** | 没讨论过 |

## 五、UI 交互

| # | 功能 | 档位 | 说明 |
|---|---|---|---|
| U1 | 左侧树 + 右侧多 tab | ✅ M2 | 每个 tab 一个内容座位（隐藏不卸载）|
| U2 | 文件变化自动刷新（watch） | ✅ M2 | 内容与树；`view.toggleAutoRefresh` 可关 |
| U3 | 快捷键 | ✅ M2 | 全局唯一绑定 + `when`；`mod` = ⌘/Ctrl |
| U4 | command palette | ✅ M2 | 只列可执行命令（不灰显），`Esc` 关、`Enter` 跑 |
| U5 | 工具栏 | **不做** | 明确移除；开关型交互改由命令承担（O8 缓解）|
| U6 | 渲染模式切换（`md` 源码/预览） | 🔲 待定 | O8 |
| U7 | 图片缩放 / 适配窗口 | 🔲 待定 | O8 |
| U8 | diff 并排 / 行内切换 | 🔲 待定 | O8 |
| U9 | 状态栏 | **v1 不做** | 已从契约 slot 表移除 |
| U10 | 多 tab 状态持久化（刷新后恢复） | 🔲 待定 | O5 |
| U11 | URL 路由（可直接分享某个文件） | 🔲 待定 | 没讨论过 |
| U12 | 深色/浅色主题 | 🔲 待定 | 没讨论过 |

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

1. **全文搜索（命令面板附带文件搜索）** —— 需要额外服务与索引策略。
2. **主题 / 外观配置** —— 至少要不要支持跟随系统深色模式。
3. **URL 可分享** —— `#/path/to/file`，打开链接直达某文件。
4. **多 tab 记忆** —— 刷新后恢复上次打开的 tab。
5. **隐藏文件与 `.gitignore`** —— 文件树默认是否隐藏 `.git`、`node_modules`。（**已定**：默认隐藏这两项，可用 `ignore` 覆盖；`.gitignore` 不读）
6. **大文件/大目录策略** —— 目录上万文件时树怎么加载；文件超大时是否截断。（**M2 已做**：每目录 500 条分页 +「加载更多」）
7. **二进制文件处理** —— 不认识的文件显示大小/类型信息，还是“不支持”。
8. **键盘可达性** —— 文件树能否全键盘导航。
9. **语言 / 本地化** —— UI 是否只做中文，还是中英双语。
10. **`diorama.toml`** —— 名字定过配置文件名，但配置项一个都没定。（**M2 已定**：见 contract §4.1）
