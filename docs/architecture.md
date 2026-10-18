# 架构决定

> 记录于 2026-10-18。这份文档只记**已经拍板**的决定；每个决定写清「选了什么、否掉了什么、代价是什么」，方便以后有人来问「为什么」。

## 产品形态：一个 gateway，N 个挂载目录

整台机器只运行**一个** `diorama gateway` 守护进程。在任意目录执行 `diorama .`，CLI 通过 Unix socket 通知 gateway 挂载该目录并开一个端口；浏览器访问该端口即可。

**定位：只读查看器。** 工具只用来“看”文件，不提供任何编辑、保存、重命名、删除能力（见 §13）。

```text
           ┌────────────── diorama gateway（单进程常驻）──────────────┐
           │  root ctx（全局：Loader / 模块表 / 插件图 / 静态资源）      │
           │    ├─ [mount:abc] ctx.fork()   → HTTP :54321 → 目录 A      │
           │    ├─ [mount:def] ctx.fork()   → HTTP :54322 → 目录 B      │
           │    └─ [mount:ghi] ctx.fork()   → HTTP :54323 → 目录 C      │
           │  control server: ~/.diorama/gateway.sock                 │
           └──────────────────────────────────────────────────────────┘
                      ▲ unix socket                    ▲ 每目录一个端口
                 diorama CLI（短命）               浏览器 A / B / C
```

每个挂载目录的页面：

```text
┌──────────────── 浏览器（每端口一个页面实例）───────────────┐
│  左侧文件导航     │  右侧文件浏览（多 tab，只读）           │
│  文件树插件       │  每个 tab 一个文件，按类型派发给渲染插件 │
└───────────────────┴───────────────────────────────────────┘
```

CLI 命令集：

```bash
diorama [dir]              # 确保 gateway 在跑 → 挂载该目录 → 打印 URL
diorama ls                 # 列出「目录 → URL → 状态」
diorama gateway start|stop|status|restart
```

## 决定

### 1. 技术栈：Node/TypeScript 全栈

前后端同一门语言。前端用 Vite 构建，服务端由一个 Node 进程提供 HTTP 与 RPC。插件天然用 TS/JS 编写，npm 分发。

- **放弃**：Rust（性能并非瓶颈——渲染的是文本）、Python（插件生态与双端同构难）、Go。
- **代价**：单二进制分发要靠 bun compile 或 esbuild 打包成单文件；Node 运行时随包走。
- **待定**：具体服务端框架（见开放问题 O1）。

### 2. 插件内核：Cordis

所有功能以 Cordis 插件实现，包括布局、文件树、tab、渲染器本身。两端各运行一棵 Cordis 插件树：

- **宿主（Node）**：Cordis 根 ctx，承载文件系统、git、类型探测等服务。
- **浏览器**：由壳持有一个随包自带的 Loader，从宿主下发的插件图（manifest）动态拉取客户端 bundle，形成第二棵 Cordis 树。

参照 DSH（DeepSeek Harness）已验证的模式：bundle 执行 `window.__ModuleLoader__.load({ id, factory })`，`require` 由懒加载的 CJS 模块表回答；跨插件**值导入**是构建错误，协作只走 Cordis 服务；UI 通过 **slot 系统**组合，而不是组件注册表；React 不含业务逻辑，只通过 `useSyncExternalStore` 消费不可变快照。

- **放弃**：自写微内核（可控但丢掉生态、热重载）、只做静态 SPA（插件必须运行时组合）。
- **代价**：客户端 loader / 模块表是必须自己维护到底的基础设施；host 与 client 两套 tsconfig 程序，让「哪个聚合能看到这个文件」偶发成为开发者的疑问。
- **参考**：[DSH Web client architecture](https://raw.githubusercontent.com/Truly-Private/oh-my-deepseek-harness/d7d622923f5f943de4aadf8600f116f13fc03eef/.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md)

### 3. 双端插件：一个包，两个半边

一个插件包同时可以带 `server` 半边与 `client` 半边：

- server 半边注册服务（文件系统、git diff 计算），有文件系统权限。
- client 半边注册 slot 条目与渲染组件，拿到的是服务端算好的数据。
- 不是每个插件都需要两半：`markdown` 可能只有 client 半边（渲染），`git-diff` 两半都需要。

- **放弃**：纯浏览器插件（git diff 之类只能在插件里用 WASM 重写）。
- **代价**：内核要处理两套注册面、两套生命周期。

### 4. 最小插件集：连布局都是插件

壳（`apps/web`）只做三件事：持有 Loader、按插件图 boot、调用渲染器 mount。其余全部是插件包：

| 插件 | 半边 | 职责 |
|---|---|---|
| `core` / `layout` | client | 左右分栏骨架、slot 声明 |
| `fs` | server | 目录列举、文件读取、类型探测 |
| `file-tree` | client | 左侧导航 |
| `tabs` | client | 右侧多 tab 打开、切换、关闭 |
| `renderer-registry` | client | 按文件类型派发给渲染插件（keyed slot） |
| `markdown` | client | `.md` 渲染 |
| `code` | client | 语法高亮 |
| `plaintext` | client | 兜底渲染器 |

- **放弃**：壳固定持有布局/文件树（能更快出功能，但「芯」里会留硬编码）。
- **代价**：基础设施可能比文件浏览本体更费时——这是为将来的扩展性预付的成本。

### 5. Slot 类型：内置编译期、外部运行时

内部插件在 `SlotMap` 上做声明合并，拿编译期类型；外部插件不在编译单元内，注册时用 **zod schema** 校验 props，失败大声报错（fail loud）。

- **放弃**：全运行时 schema（内部插件也没提示）、v1 只允许内置（生态成空话）。
- **代价**：两种插件的心智不同；外部插件的 props 错误只在运行时报出来。

### 6. 插件来源：内置 + 用户目录扫描，预留 npm

v1 从两处加载：CLI 内置插件 + `~/.diorama/plugins` 下的本地插件。npm 安装不做，但 **加载器抽象成 `PluginSource` 接口**，以后加一个 `NpmSource` 就能接上，不改内核。

- **放弃**：只内置（封闭）、v1 就上 npm 安装（提前面对依赖一致性与供应链风险）。
- **代价**：要现在就想清楚版本兼容与崩溃隔离——外部插件会挂。
- **契约要点**：插件包必须声明兼容的 **contract version**，内核与插件版本不匹配时拒绝加载并解释原因，而不是半死不活。

### 7. 插件失败：fail loud + 单点降级

失败的插件大声报错，但只影响它负责的那一块。渲染器插件天然有**回退链**：`.md` 渲染器挂了就落到 `plaintext`，绝不白屏。

- **放弃**：失败阻断整页 boot（调试友好、体验差）、静默跳过（问题跑到生产才暴露）。
- **代价**：每个渲染类 slot 都必须声明 fallback。

### 8. 安全：策略先信任，API 先收口

v1 **不限制**插件权限（完全信任），但有两条现在就要守住的契约：

1. **文件访问必须走 `ctx.fs` 服务，插件禁止直接 `import node:fs`**。即使 v1 的实现就是裸调 `node:fs`，这层壳也必须在。以后加路径白名单 / worker 隔离 / 子进程代理，只改这一层，插件代码零改动。
2. **默认只监听 loopback**，监听地址可配置：无配置时 `127.0.0.1`；可用 `--host` 或 `diorama.toml` 指定网卡 IP（如 `0.0.0.0` 或具体 LAN IP）。

- **放弃**：插件直接持有 `node:fs`（以后收紧要逐插件改造，大变动）、v1 就上 worker 隔离（内核复杂度翻倍）。
- **代价 / 安全债**：进程内插件永远没有真隔离；真正的隔离阈值是「worker 或子进程」，是把 `ctx.fs` 的实现换掉，不是改插件。
- **待办**：认证（token）与外部 server 半边的显式开启，留到真正需要多机访问时做。

### 9. 契约版本：现在就要

每个插件包在 manifest 里声明它兼容的内核契约版本范围（如 `contract: ">=0.1 <0.2"`），内核不兼容就**拒绝加载并解释原因**。成本只有一个字段，但补得越晚越难——外部插件是独立发布、独立演进的。

- **放弃**：v1 不做版本检查（生态起来后无法回填）。
- **代价**：每次改 `ctx.fs` / slot props 签名都是破环变更，要么升 major、要么提供兼容层。

### 10. 进程模型：单 gateway，多挂载

整台机器一个常驻 `diorama gateway`。`diorama .` 是一个短命 CLI，负责：检查 gateway 是否在跑（连 socket 试一下）→ 不在就后台拉起 → 通过 socket 请求挂载当前目录 → 打印 URL。

| 维度 | 选择 | 说明 |
|---|---|---|
| 寻址 | **每目录独立端口** | 随机分配（`--port` 可指定）；不复用单端口 + 路径前缀 |
| 控制通道 | **Unix domain socket** `~/.diorama/gateway.sock`（Windows 命名管道） | 仅本机可访问，无认证负担 |
| 端口冲突 | 随机端口自动重试（上限 20 次）；**显式 `--port` 冲突直接报错** | 尊重用户显式意图 |
| 固定入口 | 不做 | 用 `diorama ls` 拿当前 URL |
| 故障域 | **目录级隔离**：一个挂载崩溃不影响其它 | 见 §11 |
| 持久化 | **不持久化**：gateway 停了挂载即清空 | 见「代价」 |

- **放弃**：单端口 + 路径前缀（origin 集中风险）、每目录一个独立进程（内存与 fs watch 句柄成倍增长）。
- **代价**：
  - **gateway 本身是单点**：进程级崩溃会带走所有目录。目录级隔离保的是「插件故障」不是「gateway 故障」；真正的兜底要 supervisor（见开放问题 O6）。
  - **每端口是独立 origin**：`localStorage` / cookie / 缓存不共享；客户端 bundle 需按内容 hash + `immutable` 缓存，跨端口不重复下载。
  - **非持久化意味着崩溃后 URL 全失效**，`diorama ls` 为空，用户需重新执行 `diorama .`。

### 11. 生命周期切分：代码全局、数据按目录

这是多端口 + 单进程能成立的核心切法。

| 层 | 生命周期 | 内容 |
|---|---|---|
| **插件图 / Loader / 模块表 / client bundle 缓存** | **全局**（root ctx） | 插件代码只加载一次 |
| **插件注册的 slot / RPC handler / 路由** | **全局** | 注册一次，跨目录共享；bundle 按内容 hash 缓存 |
| **服务实例**（`fs`、`git`、`tabs` …） | **按目录**（`ctx.fork()` 出的子 ctx） | 每个目录一份，服务知道自己的根 |
| **UI 页面实例** | **按端口**（每页面一棵 client Cordis 树） | boot 图带 `{ baseUrl, mountId, plugins }` |

规则：

1. **scope 隔离的服务**：`ctx.fs` 只在子 ctx 里可访问，从 root ctx 访问抛错——防止插件拿错目录。
2. **组件不读全局 `ctx` 取数据**，数据上下文由 `tabs` 插件通过 props（`tabCtx` / `mountId`）传下来。
3. **`diorama rm <id>`** 只销毁该 mount 的 fork ctx（连带服务实例、HTTP listener），不卸载插件本体；插件本体卸载时才拆除所有子 ctx，防止孤儿实例。
4. **调试约定**：每个子 ctx 挂 `ctx.diorama.mountId`，日志统一带 `[mount:abc123]` 前缀。

- **放弃**：插件实例也全局一份（插件自己实现多目录路由，人人都要写，必出错）。
- **代价**：混合模型下「这个服务实例属于哪个目录」是高频困惑点，靠 `mountId` 前缀与测试兜住。

### 12. 目录级故障隔离

「单进程多端口」下的隔离有三个必须同时做到的层面，缺一个都会把整个 gateway 拖走：

1. **Cordis 层**：每个 mount 是一个 fork ctx，插件 fiber 出错只影响该子树。
2. **HTTP 层**：每个端口的 listener 有自己的错误边界，异常只把该端口的请求返回 5xx，不冒泡到进程。
3. **进程层**：`uncaughtException` / `unhandledRejection` 兜底——**记录并标记对应 mount 为 degraded（该目录页面显示错误横幅），进程继续存活**。这是「目录级隔离」真正落地的地方。

- **放弃**：不做进程级兜底（一个插件抛异步错误就整机全断）。
- **代价**：degraded 状态的表达与恢复策略要设计（见开放问题 O7）。

### 13. 只读工具

diorama 是**只读查看器**：只浏览，不修改。这缩小了 API 面，也把攻击面收掉一个数量级——插件即使拿到 `ctx.fs`，也删不掉文件。

| 能力 | 提供 | 不提供 |
|---|---|---|
| `ctx.fs` | `list` / `stat` / `readText` / `readBinary` / `watch` | 写入、重命名、删除、mkdir |
| `ctx.git` | `diff` / `status` / `log` | `commit` / `stage` / `checkout` |
| `tabs` | 打开文件、切换、关闭 | 编辑、保存 |

写盘的唯一去处是**工具自己的状态目录** `~/.diorama/`：

- `gateway.sock`、pid 文件、日志
- 插件配置与缓存
- 用户 UI 偏好（理论上，见 O5）

**被浏览的目录永远不写。**

- **放弃**：工具栏（`file.toolbar` / `tabs.actions`）——只读语境下没有“要对文件做的事”，按钮自然消失。
- **代价**：渲染模式切换（`.md` 源码/预览）、图片缩放、diff 并排等原本挂在工具栏上的交互，v1 不做或改由手势 / 快捷键承担。

### 14. 命令模型：快捷键与 palette 同源

快捷键和 command palette 共用一套命令注册表：**命令是实体，快捷键是绑定，palette 是检索界面**。不作为“两个独立功能”实现。

- 命令全局唯一 id，`when` 纯函数判定可用性；快捷键**全局唯一**，冲突 fail loud。
- `CommandContext`（当前 tab、焦点、选中节点）由**内核采集**，插件不各自查询。
- **palette 本身是插件**（`layout.overlay` 上的 slot 条目），不是内核内置。
- v1 不做用户自定义快捷键；palette 的展示细节（是否灰掉不可用命令）延后。

- **放弃**：分层快捷键表（“按了没反应”会成为高频困惑）、每插件自挂 `keydown`（互相抢键、无法列出全部快捷键）。
- **代价**：浏览器保留键（如 `mod+w`）无法拦截，关闭 tab 一律走 `mod+alt+w` 或在 palette 里执行。
- **副产品**：开/关/切 tab、聚焦文件树由快捷键覆盖，进一步坐实“不要工具栏”。

## 开放问题

- **O1**：服务端框架选型（Express / Fastify / Hono）。
- **O3**：token 认证与「外部 server 半边需显式开启」的时机。
- **O4**：git diff 实时计算还是缓存。
- **O5**：多 tab 状态在谁手里（tabs 插件自己的 store，还是全局 router）。
- **O6**：gateway 单点的 supervisor 兜底（崩溃自拉起），还是先接受单点。
- **O7**：mount degraded 后的恢复策略（自动重启该 mount？手动 `diorama rm` 再挂？）。
- **O8**：渲染模式切换（源码/预览）、图片缩放、diff 并排——没有工具栏后放在哪，还是 v1 不做。**部分缓解**：现在有了命令 + 快捷键，这类“开关型”交互可以做成命令（§14）；但纯手势型（缩放）仍需单独设计。
