# 开发计划

> 记录于 2026-10-18。MVP 只验证一件事：**插件内核能不能撑起一个能用的文件查看器**。
> 功能清单见 [features.md](features.md)，架构决定见 [architecture.md](architecture.md)，契约见 [contract.md](contract.md)。

## 原则

1. **每个里程碑都以「能演示」为完成标准**，不以“模块写完”为标准。
2. **MVP 不用 gateway**。gateway 是进程模型，不是插件能力的证明；它会让 MVP 变成“运维工程”。gateway 放到 M4。
3. **MVP 不用真实 Cordis Loader 的完整链路**，但**插件注册面必须是真的**。先证明“插件注册 → slot 组合 → 渲染”，再证明“动态 bundle 加载”。
4. **MVP 只做双端插件的 server 半边里最小的那个**：`fs` 只读。

## M0：MVP —— 「左树右文」（目标：能演示）

**演示脚本**：在终端执行 `npx diorama .`（或 `diorama .`），输出一个 URL；打开浏览器，左侧看到目录树，点一个文件，右侧显示原始文本内容（等宽字体、无高亮、无 Markdown 渲染）；点另一个文件，**在同一个 tab 里替换内容**（多 tab 放在 M2）。

### M0 范围

| 部分 | 做 | 不做 |
|---|---|---|
| CLI | `diorama [dir] --port --host`，前台运行 | gateway、ls、后台常驻 |
| 服务端 | 单目录、单端口、静态资源、`ctx.fs` 只读 | 多目录、socket、认证 |
| 内核 | Cordis 树（服务端 + 浏览器各一棵）、slot 注册、React 渲染器 | 动态 bundle 加载（**先用静态 import 装插件**） |
| 插件 | `layout`、`file-tree`、`tabs`（单 tab 语义）、`renderer-registry`、`plaintext` | markdown、code、palette、快捷指令 |
| UI | 左右分栏、树点击、文本显示 | 多 tab、watch、快捷键、palette |
| 契约 | slot 名、`file.renderer` matcher 的 `ext` 分支、`ctx.fs.list/readText` | probe/mime matcher、contract version 检查 |

### M0 的验收点（缺一不可）

1. `diorama .` 打印 URL，浏览器打开能跑。
2. **移除 `plaintext` 插件的注册，页面不白屏，而是显示“无可用渲染器”** —— 证明回退链成立。
3. **把 `file-tree` 插件从插件列表里去掉，页面只剩右侧空白** —— 证明布局不依赖文件树，槽位真的可拆。
4. **在服务端换一个目录，浏览器无需改代码** —— 证明目录是数据，不是硬编码。
5. 插件注册时漏了 `name`，控制台报错并指出是哪个插件 —— 证明 fail loud 有效。

### M0 的技术取舍

- **先静态 import 插件，不做动态 bundle**：证明“插件注册面”成立只需静态装配；动态加载（`window.__ModuleLoader__`）是独立的一层，放进 M1。这样 M0 能快很多。
- **`ctx.fs` 的 RPC 用最土的方式**：一个 `/api/fs/list` 与 `/api/fs/read` 的 HTTP 接口，不做自动代理。自动代理在 M1 设计。
- **不引入 zod**：M0 只有内置插件，编译期类型足够；外部插件的运行时校验在 M1 随动态加载一起做。

## M1：插件内核成型 ✅ 已完成（2026-10-18）

> 实施记录见 [m1/spec.md](m1/spec.md)。**范围调整（用户决定）**：外部插件
> （`~/.diorama/plugins` 动态加载、npm source、zod 运行时校验）整体推迟到最后一个
> 里程碑，契约位保留（contract.md §9）；M1 的「动态加载」只保留浏览器 Loader /
> 模块表，且演示脚本改为「去掉 markdown 回退 plaintext」（`--plugins`）。

**原演示脚本**：把一个 `markdown` 插件从 `~/.diorama/plugins` 目录里**动态加载**进来，浏览器里 `.md` 文件渲染成 HTML；删除该插件后回退到 plaintext。

| 部分 | 做 |
|---|---|
| 动态加载 | 客户端 Loader + 模块表；服务端从 `~/.diorama/plugins` 与内置目录加载 |
| 契约 | manifest（`diorama` 字段）、contract version 检查、zod 校验外部插件 props |
| RPC | 确定形态（自动代理 vs 显式 call），替换 M0 的土办法 |
| `ctx.fs` | 定签名：`list / stat / readText / readBinary / watch` |
| 失败处理 | 加载失败 fail loud、渲染器回退链、slot 条目错误边界 |
| 插件 | 新增 `markdown`、`code`（高亮） |

## M2：日常可用 ✅ 已完成（2026-10-19）

> 实施记录见 [m2/spec.md](m2/spec.md)。契约升到 **v0.3**（contract §13）。五块全按推荐值落地，
> 顺序为 toml → 文件树 → 多 tab → 命令 → palette → watch。

| 部分 | 做 |
|---|---|
| 多 tab | 打开/切换/关闭，`tabs.content` **keyed（key = tab id）**，请求过的文件各占一个 tab |
| 命令 | `ctx.commands`（内核内置）、快捷键（单一 keydown 分发）、`palette` 插件（`layout.overlay`） |
| 实时 | `ctx.fs.watch`（目录、300ms 合并）经 RPC 订阅端点驱动内容与树 |
| 文件树 | 隐藏规则（`ignore`，默认 `.git`、`node_modules`；`.gitignore` 不读）、大目录分页 |
| 配置 | `diorama.toml` 定下 `host` / `port` / `plugins` / `ignore` / `[watch]`，CLI > toml > 默认 |

## M3：gateway 化

| 部分 | 做 |
|---|---|
| 进程 | 常驻 gateway、短命 CLI、Unix socket 控制面 |
| 多目录 | 每目录端口、`ctx.fork()` 生命周期切分 |
| 命令 | `diorama ls`、`diorama gateway start/stop/status/restart` |
| 隔离 | 目录级故障隔离 + degraded 状态 |
| 移除 | 单目录前台模式（或保留为 `--foreground` 调试模式） |

## M4：补齐特性

- `git-diff` 渲染器（取决于你确认它是否属于 v1 卖点）
- 图片 / PDF / Notebook 渲染器
- URL 路由（直接打开某文件）
- 主题

## 里程碑之外、但必须同时做的

| 项 | 放在哪 |
|---|---|
| 测试策略 | 每档都要有：M0 至少 3 个端到端用例（上面验收点 2–4） |
| 契约变更流程 | M1 起，每次改 `ctx.*` 或 slot 签名都要升 contract version（M2 升 0.3） |
| 文档 | 每档结束时更新 features.md 的档位 |

## 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| M0 就把 Cordis + 动态加载全上 | MVP 周期失控 | 静态 import，动态加载推 M1 |
| `file.renderer` 的匹配在 M0 就做全 | 过早优化 | M0 只做 `ext`，其余 M1 |
| M2 的 watch 与多目录冲突 | 重复监听 | watch 按 mount 隔离，M3 时验证 |
| gateway 把插件内核的坑掩盖 | 到 M3 才暴露 | M0–M2 保持单目录，问题早暴露 |
