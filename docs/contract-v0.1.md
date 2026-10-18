# 插件契约 v0.1（草案，历史版本）

> 记录于 2026-10-18，已于 M1 起由 [contract.md](contract.md)（v0.2）取代，保留作历史。旧文：契约先行：这份文档是内核与插件之间的唯一约定，改它 = 破环变更。
> 状态：**讨论中**，标 🔲 的条目待定。

## 0. 术语

| 词 | 含义 |
|---|---|
| **内核（kernel）** | Cordis 插件树 + Loader + 模块表 + slot 系统本身。`diorama` 包提供。 |
| **插件（plugin）** | 一个 npm 包，声明 `diorama` 字段，可同时带 server / client 半边。 |
| **半边（half）** | `server`（Node 进程内）或 `client`（浏览器）。 |
| **服务（service）** | 插件对其他插件暴露的唯一 API，挂在 Cordis `ctx` 上。 |
| **slot** | 前端组件的组合点。核心里唯一的组件注册模型。 |

## 1. manifest

插件包的 `package.json` 增加 `diorama` 字段：

```jsonc
{
  "name": "diorama-plugin-markdown",
  "version": "0.1.0",
  "diorama": {
    "contract": ">=0.1 <0.2",        // 必须：兼容的内核契约范围（见 §6）
    "id": "markdown",                 // 必须：全局唯一，短名；外部插件建议带前缀
    "displayName": "Markdown",
    "server": { "entry": "./lib/server.js" },   // 可选
    "client": { "entry": "./lib/client.js" }    // 可选
  }
}
```

规则：

- `server` 和 `client` 至少有一个。
- `id` 冲突时：内置插件优先，外部同名插件拒绝加载并报错。
- 不支持 `"both"` 单文件入口——两边是两棵树，是两个加载器。

## 2. 插件骨架

```ts
// server 半边
import { Context } from 'cordis'

export const name = 'markdown'
export const inject = ['fs']            // 依赖的服务，缺了就不会 apply

export function apply(ctx: Context) {
  // 注册服务或 RPC handler
}

// client 半边
export const name = 'markdown'
export const inject = ['slots']

export function apply(ctx: Context) {
  // 注册 slot 条目
}
```

一个包的两个半边可以各自有不同的 `inject`。半边之间**不共享内存**，只能通过 RPC（§4）通信。

## 2.5 生命周期：全局插件图，按目录服务实例

多目录共享一个 gateway 进程，插件**只加载一次**，但服务**每个目录一份**。插件作者必须按这个模型写代码：

```ts
// login-server 半边：插件本身是全局的
export const name = 'fs'
export const inject: string[] = []

// ① 全局注册面：只执行一次
export function apply(root: Context) {
  root.diorama.mounts.onMount((mountCtx, { root: dir }) => {
    // ② 每个目录实例化一次；mountCtx 是 fork 出的子 ctx
    mountCtx.set('fs', new FsService(dir))
    // 返回 disposer：该目录卸下时自动清理
    return () => { /* 关闭 watch 等 */ }
  })
}
```

硬性规则：

| 规则 | 原因 |
|---|---|
| 插件 `apply` 只在 root ctx 执行一次 | 插件代码全局一份，bundle 只加载一次 |
| 服务实例通过 `mountCtx.set(name, instance)` 绑定 | 服务实例按目录隔离 |
| `ctx.fs` / `ctx.git` 等 scope 服务**只在子 ctx 可访问**，root 访问抛错 | 防止插件拿错目录 |
| 组件不得从全局 `ctx` 取数据，用 props 传来的 `tabCtx` / `mountId` | 组件会渲染在某个具体目录的页面里 |
| 卸载插件 = 拆除所有子 ctx；`diorama rm` 只拆一个子 ctx | 防止孤儿实例 |
| 日志前缀 `[mount:<id>]` | 混合模型下的可观测性约定 |

## 3. 服务清单

### 3.1 `ctx.fs`（server）🔲

插件访问文件的**唯一**途径。禁止 `import 'node:fs'` / `'node:fs/promises'`（lint 规则 + 契约）。

**只读**：只有读接口，没有任何写接口（§3.6）。**返回类型不暴露 Node 的 `Dirent`/`Stats` 原对象**，用 Diorama 自己的结构，否则以后换实现会漏。

能力范围：`list` / `stat` / `readText` / `readBinary` / `watch`。具体签名待定。

### 3.2 `ctx.git`（server）🔲

git 的**只读**视图。**只在目录是 git 仓库时才存在**，其它插件必须 `inject: { optional: ['git'] }` 或做能力检测。

待定：`diff(filePath)`、`status()`、`log()`。不提供任何写操作（commit / stage / checkout）。

### 3.3 `ctx.slots`（client）

注册 UI 条目：

```ts
ctx.slots.register({
  name: 'file.renderer',   // slot 名（§5）
  key: 'markdown',         // keyed slot 的键；list slot 可省略
  order: 100,
  props: zodSchema,        // 外部插件必填；内置插件可省（编译期类型）
}, Component)
```

- 名字、key、order 冲突的处理规则 🔲。
- 注册返回 disposer，插件卸载时自动清理。

### 3.4 `ctx.tabs` / `ctx.tree` / `ctx.layout`（client）🔲

分别由 tabs / file-tree / layout 插件暴露，供其他插件操作（打开文件、选中节点、切布局）。属于**跨插件协作**，走服务而非组件导入。

`tabs` **只负责打开与切换，不提供编辑**。

### 3.5 `ctx.diorama.mounts`（server）

gateway 提供的挂载登记面，所有服务插件都靠它拿到自己的目录：

```ts
interface Mounts {
  onMount(cb: (mountCtx: Context, info: { root: string; mountId: string }) => (() => void) | void): () => void
  list(): MountInfo[]
}
```

- `info.root` 是绝对路径，**挂载时确定、不可变**。
- 返回的 disposer 在目录被 `diorama rm` / gateway 停止时执行。
- mount 的创建由 gateway 控制面（§7）驱动，插件不应自己触发挂载。

### 3.6 只读原则

**被浏览的目录永远只读。** 任何插件都不得修改、创建、删除、重命名被挂载目录内的任何内容——这一条不靠约定，靠 API 面：`ctx.fs` / `ctx.git` 不提供写接口。

写盘只有一处：**`~/.diorama/`**（socket、pid、日志、插件配置与缓存、UI 偏好）。插件若要持久化自己的状态，走内核提供的 `ctx.storage` 🔲，而不是自己拼路径。

### 3.7 `ctx.commands`（client）

快捷键与 command palette 共用同一套命令模型。**内核里只有一个命令注册表；快捷键是绑定，palette 是它的检索界面。**

```ts
ctx.commands.register({
  id: 'tabs.close',                 // 全局唯一；插件 id 作前缀
  title: 'Close Tab',
  group: 'Tabs',                    // palette 分组
  when?: (ctx: CommandContext) => boolean,
  keybindings?: string[],
  run: (ctx: CommandContext) => void | Promise<void>,
})
```

- **快捷键全局唯一**，不做分层键表；上下文差异靠 `when` 表达。
- 绑定冲突 → **fail loud**（与「slot order 冲突 warn」不同，键冲突必须报错）。
- `when` 是**纯函数**，入参 `CommandContext` 由**内核采集**，插件不自己查询：

```ts
interface CommandContext {
  hasTab: boolean
  activeTab?: { file: FileInfo; rendererKey: string }
  treeSelection?: FileInfo
  focus: 'tree' | 'content' | 'palette' | 'none'
}
```

- `ctx.commands.list()` 由 palette 消费。🔲 是否也承载“动态可检索项”（文件搜索结果、最近打开）待定，见 §3.8。
- v1 不支持用户自定义快捷键。

### 3.8 命令扩展点（预留，不实现）

后面若要增强 palette，这三条是契约里预先留出的缝，不影响 v1 实现：

1. **palette 是一个 slot 条目**（`layout.overlay`），由插件提供，不是内核内置——想换实现就换插件。
2. **命令来源可聚合**：palette 除了 `ctx.commands`，还可能需要合并“文件搜索结果”“最近打开”这类动态 source。这决定 `list()` 的返回形态（纯命令 vs 可检索项），留到真正需要时再定。
3. **`when` 判定与绑定优先级**：同一快捷键冲突一律报错；`when` 为假的命令不拦截按键（按不到就冒泡给浏览器）。

## 4. RPC / 通信

🔲 未定。需要确定：

- 双向还是单向。
- 流式（文件很大时的分块）怎么表达。
- client 半边如何拿到 server 插件的服务——是统一 `ctx.rpc.call('fs.list', args)`，还是每个 server 服务自动生成一个 client 代理。

倾向：**自动生成代理**，`ctx.fs.list(...)` 在 client 半边也能调，底层走一条 RPC 通道。

## 5. slot 清单

| slot | 类型 | 声明者 | 条目 | 说明 |
|---|---|---|---|---|
| `root` | 单 | 内核 | 1 | 整个页面 |
| `layout.main` | 单 | `layout` | 1 | 左右分栏 |
| `sidebar.tree` | 单 | `layout` | 1 | 左侧导航 |
| `tabs.content` | keyed | `tabs` | N | 每个 tab 的内容区（key = tab id） |
| `file.renderer` | keyed | `renderer-registry` | N | 按文件类型派发（key = 插件自带 matcher） |
| `statusbar` | list | `layout` | 0..N | 底部状态栏 🔲 是否需要 |

**没有 toolbar**：只读工具没有“要对文件做的事”，v1 不提供 `file.toolbar` / `tabs.actions`。带来的一连串后果记在 O8。

**回退链**：`file.renderer` 的某个插件失败或无匹配时，按 order 依次尝试下一个，最终落到 `plaintext`。

### 5.1 `file.renderer` 匹配规则

渲染器按 `order` **升序**依次尝试，第一个 matcher 命中的接手；全部不命中落到 `plaintext`。

```ts
type FileMatcher =
  | { ext: string[] }                      // 零成本，最常用；不带点，小写比较
  | { mime: string[] }                     // 需要先探测类型
  | { probe: (ctx: ProbeCtx) => boolean }  // 有成本，必须声明 cost

type ProbeCtx = {
  head: Uint8Array      // 文件前 N 字节（由内核给，插件不得自己读文件）
  size: number
  path: string
  mime: string
}

interface RendererRegistration {
  order: number
  matcher: FileMatcher
  cost?: 'cheap' | 'expensive'   // probe 形式的 matcher 必须声明
  props?: ZodSchema
}
```

规则：

- **`ext` 优先于 `mime`，`mime` 优先于 `probe`**：同一 order 内按这个优先级排序，避免「每个文件都跑一遍 probe」。
- **`cost: 'expensive'` 的 probe 只有在 ext/mime 全部未命中时才执行**，且结果按 `(path, mtime, size)` 缓存。
- **probe 只能读 `ctx.head`**，不得自己发文件请求——否则打开一个文件会触发 N 次 IO。
- `order` 相同的两个渲染器命中同一文件 → 按插件 `id` 字典序决定，并输出 warn。
- `plaintext` 是 `order: Infinity` 的兜底，不参与匹配。

## 6. contract version 规则

- 内核版本 `0.x` 期间：**minor 改动即破环**，插件应写窄范围（`>=0.1 <0.2`）。
- 不兼容时：拒绝加载该插件，在终端与浏览器控制台同时输出原因，UI 显示「插件 X 因契约不兼容未加载」。
- 检查发生在**加载前**（读 manifest），而不是加载后。

## 7. Gateway 控制面

CLI 与 gateway 之间的协议，走 `~/.diorama/gateway.sock`（Windows：`\\.\pipe\diorama-gateway`）。JSON 行协议：

```jsonc
// 请求
{ "id": 1, "method": "mount", "params": { "root": "/abs/path", "port": 8001 } }
// 响应
{ "id": 1, "result": { "mountId": "abc123", "url": "http://127.0.0.1:8001/", "port": 8001 } }
// 错误
{ "id": 1, "error": { "code": "EADDRINUSE", "message": "port 8001 in use" } }
```

v1 方法：`ping`、`mount`、`unmount`、`list`、`stop`。🔲 待定：是否需要 `watch`（订阅挂载变化）。

挂载键规则：

- **挂载键 = `realpath(root)`**。符号链接会被解析，同一真实目录永不重复挂载。
- `mount` 幂等：同一 realpath 再次挂载返回已有 mount 与 URL。
- 路径不严格相同即视为新挂载：`proj/` 已挂载时，在 `proj/sub/` 执行会得到第二个 mount 与端口；CLI 输出提示「父目录已挂载于 :8001」。
- 若用户输入的路径与 realpath 不同（经过符号链接），CLI 打印 `mounted <realpath> (from <input>)`。
- 显式 `port` 冲突返回 `EADDRINUSE`，不做随机重试；未指定 `port` 时 gateway 随机分配并重试。
- `list` 返回 `{ mountId, root, port, url, status }`，`status` 为 `ok` | `degraded`。

## 待定清单

- [ ] `ctx.fs` 具体签名与返回结构（**只读**：list / stat / readText / readBinary / watch）
- [ ] `ctx.fs.watch` 的事件模型（目录级还是文件级？debounce？）
- [ ] `ctx.git` 具体签名（**只读**：diff / status / log）
- [ ] RPC 通道形态（自动代理 vs 显式 call）
- [ ] slot key/order 冲突处理
- [ ] `file.renderer` 的匹配规则（扩展名？content-type？还是文件内容？）→ **已定，见 §5.1**
- [ ] 是否需要 `statusbar`
- [ ] 外部插件的 bundle 格式（是否强制 tsdown？还是接受任意 ESM？）
- [ ] gateway 控制面是否需要事件订阅（`watch`）
- [ ] 插件异步任务的托管 API（见 architecture.md §12 的讨论）
- [ ] `ctx.storage`（`~/.diorama/` 下的插件状态持久化）的签名
- [ ] 渲染模式切换 / 图片缩放 / diff 并排在没有工具栏后的落点（architecture.md O8）
- [ ] gateway 启动竞态：**用户明确暂缓**，实现时用「bind 成功者胜出 + 重试连接」的简单写法，不追求并发正确性。
