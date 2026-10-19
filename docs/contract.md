# 插件契约 v0.3

> 记录于 2026-10-18；v0.3 记录于 2026-10-19（v0.1 草案已归档为 [contract-v0.1.md](contract-v0.1.md)）。
> 契约先行：这份文档是内核与插件之间的唯一约定，改它 = 破环变更。
>
> **状态：v0.3 已定稿，M2 按它实现。** v0.1 → v0.2 的差异都是 M1 决策（§12），
> v0.2 → v0.3 的差异都是 M2 决策（§13）。内核契约版本 `0.3`，所有插件声明
> `contract: ">=0.3 <0.4"`；内核**已启用**范围检查（§6）。

## 0. 术语

| 词 | 含义 |
|---|---|
| **内核（kernel）** | Cordis 插件树 + Loader + 模块表 + slot 系统本身。`diorama` 包提供。 |
| **插件（plugin）** | 一个 npm 包，声明 `diorama` 字段，可同时带 server / client 半边。 |
| **半边（half）** | `server`（Node 进程内）或 `client`（浏览器）。 |
| **服务（service）** | 插件对其他插件暴露的唯一 API，挂在 Cordis `ctx` 上。 |
| **RPC** | 浏览器对服务端服务的调用通道。server 服务的公开方法自动成为 RPC 方法（§4）。 |
| **slot** | 前端组件的组合点。核心里唯一的组件注册模型。 |

## 1. manifest

插件包的 `package.json` 增加 `diorama` 字段：

```jsonc
{
  "name": "diorama-plugin-markdown",
  "version": "0.1.0",
  "diorama": {
    "contract": ">=0.3 <0.4",                     // 必须：兼容的内核契约范围（§6）
    "id": "markdown",                              // 必须：全局唯一，短名；外部插件建议带前缀
    "displayName": "Markdown",
    "server": { "entry": "./lib/server.mjs" },     // 可选
    "client": { "entry": "./lib/client.cjs" },     // 可选
    "requires": ["plaintext"]                      // 可选：基础设施（如 "slots"）
  }
}
```

规则：

- `server` 和 `client` 至少有一个。
- **`id` 冲突时**：内置插件优先，外部同名插件拒绝加载并报错。插件 `id` 不含 `:`，命令 id 用
  `<插件id>:<命令>` 即天然不冲突（§3.7）。
- **`plugins`（选择清单）与 `requires`（依赖）是两回事**：
  - `--plugins` 决定加载哪些插件；
  - `requires` 保证基础设施在位。boot 图只列 `--plugins` 选中的插件，但执行时在前方**补齐**它们 `requires` 的插件（M0 就有的行为：去掉 file-tree 时 layout 仍在）。
- `contract` 是 **semver 范围**（支持 `>=x.y`、`<x.y`、`^x.y`、`~x.y`、`x.y.x`，空格分隔为 AND）。检查发生在**读 manifest 时**（§6）。
- `resources: false`：该插件不发布资源（M1 无此需要，保留字段位）。
- 不支持 `"both"` 单文件入口——两边是两棵树，是两个加载器。

## 2. 插件骨架

```ts
// server 半边
import { Context } from 'cordis'

export const name = 'fs'
export const inject = []                  // 依赖的服务，缺了就不会 apply

export function apply(ctx: Context) {
  // 注册服务；服务的公开方法自动成为 RPC 方法（§4）
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

多目录共享一个 gateway 进程，插件**只加载一次**，但服务**每个目录一份**（M3 起；M1 仍是单目录前台进程，但形状照此执行）：

```ts
export const name = 'fs'
export const inject: string[] = []

// ① 全局注册面：只执行一次
export function apply(root: Context) {
  root.diorama.mounts.onMount((mountCtx, { root: dir }) => {
    // ② 每个目录实例化一次；mountCtx 是 fork 出的子 ctx
    mountCtx.set('fs', new FsService(dir))
    return () => { /* 关闭 watch 等 */ }
  })
}
```

硬性规则：

| 规则 | 原因 |
|---|---|
| 插件 `apply` 只在 root ctx 执行一次 | 插件代码全局一份，bundle 只加载一次 |
| 服务实例通过 mount ctx 绑定 | 服务实例按目录隔离 |
| `ctx.fs` / `ctx.git` 等 scope 服务**只在子 ctx 可访问**，root 访问抛错 | 防止插件拿错目录 |
| 组件不得从全局 `ctx` 取数据，用 props 传来的 `tabCtx` / `mountId` | 组件会渲染在某个具体目录的页面里 |
| 卸载插件 = 拆除所有子 ctx；`diorama rm` 只拆一个子 ctx | 防止孤儿实例 |
| 日志前缀 `[mount:<id>]` | 混合模型下的可观测性约定 |

## 3. 服务清单

### 3.1 `ctx.fs`（server + client 半边）✅ v0.2 定 / v0.3 补 watch 与忽略

插件访问文件的**唯一**途径。禁止 `import 'node:fs'` / `'node:fs/promises'`（契约约定）。

**只读**：只有读接口（§3.6）。**返回类型不暴露 Node 的 `Dirent`/`Stats`**，用 Diorama 自己的 `FileInfo`。

```ts
type RelPath = string   // 相对挂载根，`/` 分隔，无前导 `/`；'' 表示根

interface FileInfo {
  path: RelPath
  name: string
  kind: 'file' | 'dir'
  size: number          // 字节；目录为 0
  mtime: number         // ms since epoch
}

interface FsService {
  list(path?: RelPath): Promise<FileInfo[]>            // 一层，不排序
  stat(path: RelPath): Promise<FileInfo>               // 与 list 的元素同构
  readText(path: RelPath): Promise<string>             // UTF-8；含 NUL → EBINARY
  readBytes(path: RelPath): Promise<Uint8Array>        // 原始字节
  watch(path: RelPath, listener: (event: FsWatchEvent) => void): () => void
}
```

规则：

- **路径基准**：一律 `RelPath`（相对挂载根）。绝对路径、`..` 越界、NUL 一律 `EINVAL` / `EOUTSIDE`。
- **大小上限**（内核常量，超限报 `ETOOLARGE`，超限检查发生在读之前）：
  - `readText`：8 MiB（`MAX_TEXT_BYTES`）
  - `readBytes`：32 MiB（`MAX_BINARY_BYTES`）
- **错误码**是方法契约：

| 码 | 含义 |
|---|---|
| `EINVAL` | 路径非法（绝对路径、含 NUL、类型不对） |
| `ENOENT` | 不存在 |
| `ENOTDIR` | 路径中间不是目录 |
| `EISDIR` | 期望文件却是目录（`readText` / `readBytes`） |
| `EOUTSIDE` | 越出挂载根，或权限拒绝 |
| `EBINARY` | `readText` 遇到二进制（含 NUL） |
| `ETOOLARGE` | 超过上述上限 |
| `EIO` | 其它 I/O 错误 |

- 错误对象的形状：`Error` 且带 `code: FsErrorCode`，`message` 以 `CODE: ...` 开头；`cause` 可能含原始错误（服务端）。
- **`watch`（v0.3 定，M2 实现）**：**只接受目录**（含根 `''`）；它监听该目录**自身一层**。
  文件的变化由**父目录**的监听产生 `{ type: 'change', path }`；要看某个文件，watch 它的父目录
  并按 `path` 过滤。返回 disposer，disposer 之后不再回调。
  - 事件形态（本进程内直接调用服务）：

    ```ts
    type FsWatchEvent = { type: 'change' | 'add' | 'unlink'; path: RelPath }
    ```

  - **debounce（内核，双端同一套规则）**：同一 `path` 的同类事件在 **300ms** 窗口内合并为
    一次（抖动编辑只产生一个 `change`）；不同 `path` 互不合并。窗口**跨一次**事件传递地
    合并自身。
  - **`type` 是提示，不是真相**：一次 rename 可能同时产生 `change` 与 `unlink`（多义）。
    接收方拿 `path` 发一次 `fs.stat` 定夺：存在 → `add`/`change`，`ENOENT` → `unlink`。
  - 订阅时**不**补发初态：调用方先 `list` / `stat` 一次，再 watch。
  - server 半边：文件级监听用“父目录监听 + 过滤”；client 半边：通过 RPC 订阅（§4），
    签名与本地一致。
- **`list` 与忽略规则（v0.3 定，M2）**：`list(path)` **不返回**被 `ignore` 规则隐藏的条目
  （§4.1，`diorama.toml` 的 `[ignore]` 加上内置默认 `'.git'`、`node_modules`；`--all` 解除）。
  这是隐藏规则的**唯一强制点**：文件树、palette 的文件检索、watch 都读 `list`，因此天然一致。
  `stat` 不受影响（直接按路径取信息）：已被打开的文件即使被隐藏，也照样能读。
- client 半边：`mountCtx.fs` 与上面**同名同签名**，底层走 RPC（§4），调用形状与本地服务一致。

### 3.2 `ctx.git`（server）🔲 未定

git 的**只读**视图。**只在目录是 git 仓库时才存在**，其它插件必须 `inject: { optional: ['git'] }` 或做能力检测。

待定：`diff(filePath)`、`status()`、`log()`。不提供任何写操作。

### 3.3 `ctx.slots`（client）

注册 UI 条目：

```ts
ctx.slots.register({
  name: 'file.renderer',   // slot 名（§5）
  key: 'markdown',         // keyed slot 的键；list / single slot 省略
  order: 100,
  matcher: { ext: ['md'] }, // 仅 file.renderer 用（§5.1）
  props: zodSchema,        // 外部插件必填；内置插件可省（编译期类型），M1 无外部插件故不启用
  declare: { … },          // 本条目独占渲染的子 slot
}, Component)
```

**冲突处理（v0.2 定，三类分开）：**

| 情况 | 处理 | 原因 |
|---|---|---|
| **`id` 重复** | **fail loud：抛错（注册调用方据此失败）** | 编程错误，静默会掩盖 |
| **single slot 已有占用者** | warn + 拒绝后来者（第一个赢） | 与 M0 一致 |
| **keyed slot 缺 `key`** | warn + 拒绝 | key 是派发依据，不兜底 |
| **同一 `(name, key)` 多个条目**（list / file.renderer） | **全部保留**，按总序排序，第一个接手，其余是**回退链** | 回退链要求共存 |
| **`order` 相同** | **保留**，按 `id` 字典序（`localeCompare`）决胜，并 warn | §5.1 |
| **slot 名未被声明** | warn + 拒绝 | 没人画的座位不挂载 |
| **子 slot 声明冲突** | warn + 拒绝 | 一个座位只有一个渲染 owner |

- **不按内置/外部区分**：slot 级冲突只按上表，不因来源不同而改规则。
- 注册返回 disposer，插件卸载时自动清理。
- 条目组件渲染抛错 → 边界捕获 → `views.reportFailure(id)` → 该条目从「可用」集合剔除，派发者**尝试下一个**（§5 回退链）。

### 3.4 `ctx.tabs` / `ctx.tree` / `ctx.layout`（client）

分别由 tabs / file-tree / layout 插件暴露，供其他插件操作。属于**跨插件协作**，走服务而非组件导入。

- `tabs` **只负责打开与切换，不提供编辑**。
- `ctx.layout` 仍是 🔲（M2 不提供）。
- **`ctx.tabs`（v0.3 定，M2 多 tab）：**

  ```ts
  interface TabInfo {
    id: string           // tab id，同页内唯一；tabs.content 的 key 用它
    path: RelPath        // 打开时的文件路径；内容由内容区自己 fs.stat / 读
  }

  interface TabsSnapshot {
    tabs: readonly TabInfo[]
    activeId: string | undefined
  }

  interface TabsService {
    open(file: FileInfo): TabInfo      // 已在某个 tab 打开 → 激活它，不新开
    close(id?: string): void           // 缺省关活动 tab
    activate(id: string): void
    next(): void                       // 循环
    prev(): void                       // 循环
    readonly active: TabInfo | undefined
    readonly count: number             // 命令的 when 用
    getSnapshot(): TabsSnapshot        // 不可变，仅变化时替换
    subscribe(listener: () => void): () => void
  }
  ```

  - **一个文件只有一个 tab**：`open` 的键是 `path`。`TabInfo` 不再带 `FileInfo` 快照——
    文件变化时内容区用 `fs.stat` 重读，tab 本身不持有文件数据（tabs 不依赖 fs）。
  - **关闭后的激活**：右边的 tab，没有则左边的，都没有则空。
  - **标签栏由 `tabs` 自己画**（不开新 seat）；每个 tab 的内容画进 `tabs.content`（§5，
    key = tab id）。
  - `open` 从 v0.2 的 `void` 改为返回 `TabInfo`：源码层面兼容（`void` 用法照旧编译）。

### 3.5 `ctx.diorama.mounts`（server）

挂载登记面，所有服务插件靠它拿到自己的目录：

```ts
interface Mounts {
  onMount(cb: (mountCtx: Context, info: { root: string; mountId: string }) => (() => void) | void): () => void
  list(): MountInfo[]
}
```

- `info.root` 是绝对路径，**挂载时确定、不可变**。
- 返回的 disposer 在目录卸下时执行。
- **M1 形态**：内核在 root ctx 上提供 `ctx.diorama.mounts`（含 `mountId`），`fs` 作为内置 server 半边在其中注册 `FsService`；`diorama [dir]` 启动时触发一次 `onMount`。

### 3.6 只读原则

**被浏览的目录永远只读。** `ctx.fs` / `ctx.git` 不提供写接口。

写盘只有一处：**`~/.diorama/`**。插件若要持久化状态，走内核提供的 `ctx.storage` 🔲，而不是自己拼路径。

### 3.7 `ctx.commands`（client）✅ v0.3 定，M2 实现

快捷键与 command palette 共用同一套命令模型。**注册表只有一个；快捷键是绑定，palette 是它的检索界面。**

**归属**：`ctx.commands` 由**内核内置**（kernel 的 client 半边注入到页面的 root ctx，和 `mount` /
`mounts` / `kernel` 同级），**不是**某个可选插件的服务——否则 `.diorama-toml` 少选一个插件，
快捷键就静默失效。`palette` 是**插件**（§5 `layout.overlay` 上的条目），它只是 `ctx.commands` 的一个消费面。

```ts
/** 内核采集的上下文：插件不各自查询。 */
interface CommandContext {
  mountId: string
  /** 活动 tab（含路径）；由 tabs 服务给出。 */
  activeTab?: { id: string; path: RelPath }
  /** 活动 tab 当前由哪个渲染器条目画（失败回退链之后的结果）；内容区未就位时缺省。 */
  activeRenderer?: string
  /** 焦点所在的编辑面（选单只记录来源，不记录节点）。 */
  focus: 'tabs' | 'tree' | 'editor' | 'other'
}

type CommandWhen = (ctx: CommandContext) => boolean

interface CommandSpec {
  /** 全局唯一：`<插件id>:<命令>`（插件 id 不含 `:`）。 */
  id: string
  title: string
  when?: CommandWhen                   // 缺省恒真；不返回 false 以外的真值判定
  run(ctx: CommandContext): void | Promise<void>
}

interface KeybindingSpec {
  /** 键记法：`mod+alt+w`、`mod+k`、`mod+shift+[`、`ctrl+tab`（见下）。 */
  keys: string
  command: string                      // 命令 id；必须是已注册（或稍后注册）的 id
  when?: CommandWhen
}

interface CommandsService {
  register(spec: CommandSpec): () => void
  /** 可执行性（when 缺省恒真）。未注册的 id 为 false。 */
  canRun(id: string): boolean
  /** 不存在 / when 为假 → 返回 false 并 warn，不抛错。 */
  run(id: string): Promise<boolean>
  /** 按当前 CommandContext 可执行的绑定。 */
  bindings(): readonly { keys: string; command: string }[]
  bind(spec: KeybindingSpec): () => void
  /** 可观察快照（palette 用 useSyncExternalStore 读）。 */
  getSnapshot(): CommandsSnapshot
  subscribe(listener: () => void): () => void
}
```

**规则（v0.3 定）：**

| 条款 | 取值 |
|---|---|
| 命令 id 重复 | **fail loud：`register` 抛错**（与 §3.3 的 `id` 重复同一条规则） |
| 键记法 | 修饰键 `mod`（mac = ⌘，其它 = Ctrl）、`ctrl`、`alt`、`shift`；键名小写，取 `KeyboardEvent.key` 的小写名（`w`、`k`、`arrowleft`、`[`、`tab`）；`mod+alt+w` 这种 `+` 分隔、顺序无关；`mod` 与 `ctrl` 同平台重复 → 拒绝并 warn |
| **冲突（键相同）** | **字面重复才 fail loud**：同一个按键、且二者 `when` 都可能同时为真 → `bind` **抛错**。`when` 显式互斥的绑定可以共存。 |
| **冲突（执行时）** | 某一按键在当前上下文命中的绑定 `canRun` 同时为真且来自不同命令 → **warn，只执行第一条**（先注册者优先） |
| 触发条件 | 页面 mounted；按键命中且非 `repeat`；焦点不在 `input` / `textarea` / `[contenteditable]` 内；命中的绑定 `when` 为真 |
| 浏览器保留键 | 拦不住（`mod+w`、`mod+t`…）。**关闭 tab = `mod+alt+w`**；`ctrl+tab` / `ctrl+shift+tab` 绑定“到边界不动”，`mod+alt+→` / `mod+alt+←` 绑定“循环切换” |
| palette | 是插件（`requires: ['layout']`、`inject: ['commands']`），注册在 `layout.overlay`（single）上；打开时把按键交还给它（输入框内的按键不当作快捷键）。**默认只列可执行的命令**（不灰显），`Esc` 关闭，`Enter` 执行 |
| 执行失败 | `run` 的 Promise 拒绝 → 控制台报错 + `warn`，不冒泡到按键处理（一次失败不拖垮页面） |
| 生命周期 | `register` / `bind` 返回 disposer；注册属于**页面级**（一个页面一棵 client 树，§11），卸载即撤销 |
| O8 | “开关型”交互（如自动刷新开关）用命令实现，v1 不做用户自定义快捷键 |

**内核内置命令（`m2` 最小集合，每个都有 e2e）：**

| id | 标题 | 快捷键 | when |
|---|---|---|---|
| `tabs.close` | 关闭当前标签页 | `mod+alt+w` | 有活动 tab |
| `tabs.next` | 下一个标签页 | `mod+alt+arrowright` | tab 数 > 1 |
| `tabs.prev` | 上一个标签页 | `mod+alt+arrowleft` | tab 数 > 1 |
| `tabs.nextEdge` | 下一个标签页（到末尾停） | `ctrl+tab` | tab 数 > 1 |
| `tabs.prevEdge` | 上一个标签页（到开头停） | `ctrl+shift+tab` | tab 数 > 1 |
| `tree.focus` | 聚焦文件树 | `mod+alt+f` | 焦点不在树 |
| `palette.toggle` | 打开命令面板 | `mod+k` | 焦点不在输入框 |
| `view.refresh` | 重新读取当前文件 | `mod+alt+r` | 有活动 tab |
| `view.toggleAutoRefresh` | 自动刷新：开 / 关 | 无（palette） | 有活动 tab |

命令的**来源插件**决定注册点：`tabs.*` 由 tabs 插件注册、`tree.*` 由 file-tree 注册、
`palette.toggle` 由 palette 注册、`view.*` 由 renderer-registry 注册（它持有文件内容缓存）。

## 4. RPC / 通信 ✅ v0.2 定 / v0.3 补事件 session 与 §4.1 配置

**形态：自动代理（A1）。** server 插件的服务公开方法自动成为浏览器可调的 RPC 方法：client 半边里 `mountCtx.fs.list(...)` 的形状与 server 服务一致。

| 决策 | 取值 |
|---|---|
| 方向 | **双向**：client → server 调用；server → client 推送（M2 的 watch 用，M1 管道已铺好） |
| 传输 | **WebSocket 单连接**，端点 `GET /__diorama__/rpc`（同源、同端口） |
| 帧格式 | JSON 文本帧 |
| 服务可见性 | 服务端挂载 ctx 上的服务**自动**可代理，名字一致；client 半边通过 `mountCtx.<service>` 访问 |
| 流式 / 分块 | **v1 不分块**；超过 `ctx.fs` 上限报 `ETOOLARGE` |
| 逃生口 | client 半边可用 `mountCtx.rpc.call(method, ...args)` 调任意公开方法 |

**帧**

```ts
// client → server
{ type: 'call', id: number, method: `${service}.${method}`, args: unknown[] }
{ type: 'cancel', session: string }                     // v0.3：取消一个订阅端点（§3.1 watch）
// server → client
{ type: 'result', id: number, value: unknown }          // 二进制值以 base64 呈现（见下）
{ type: 'error', id: number, code: string, message: string }
{ type: 'event', topic: string, payload: unknown, session?: string }
```

**订阅端点与事件 session（v0.3 定，M2 起）**

- 有些服务方法是**订阅端点**：调用它不是请求—响应，而是注册一个推送端点。当前唯一一个是
  `fs.watch`（§3.1）。订阅端点**不出现在** `describe()` 里（`describe()` 只列普通方法）；
  RPC 按**约定名**路由：`<service>.watch`。
- 调用订阅端点：`{ type: 'call', method: 'fs.watch', args: [path] }` → `{ type: 'result', id, value: { session: string } }`。
  订阅期间服务端为该端点产生的事件帧带上同一个 `session`。
- 取消：`{ type: 'cancel', session }`。**连接关闭 = 该连接上所有端点自动取消**（一次性清理，
  不需要逐条 unsubscribe 帧）。
- 事件路由：**带 `session` 的帧只投给创建它的那条连接**；不带 `session` 的帧沿用广播
  （`RpcChannel.broadcast`，M1 的形态）。`RpcClient.onSession(session, listener)` 订阅后者。
- `ctx.fs.watch(path, listener)` 的**签名不变**：client 半边内部完成“订阅端点 → onSession →
  300ms 窗口合并 → listener”的转换，返回的 disposer 发 `{ type: 'cancel' }`。
- 这是**增量**：客户端帧、结果帧、调用帧都不变；M1 的客户端遇到 `session` 只是忽略该字段。

**方法发现与边界**

- 服务对象必须提供 `describe(): MethodDescriptor[]`，`method` 只允许 `describe()` 列出的名字；其余一律 `EMETHOD`。
- 参数一律被视为**不可信输入**，服务自己校验（`ctx.fs` 先校验再碰磁盘）。
- 未知服务 → `ESERVICE`；方法执行抛错且无 `code` → `EIO`；带 `code` 的错误原样映射（`EINVAL`、`EOUTSIDE`、…）。
- **`Uint8Array` 过 JSON**：RPC 信封在 `value` 中把 `Uint8Array` 表示为 `{ $bytes: base64 }`，client 端还原为 `Uint8Array`。这是 M1 二进制唯一的跨线表示。
- 连接在页面 boot 时建立；服务端**先于**页面读取准备好（fs 在 mount 时已就绪）。连接失败 = 该页的 fs 调用全部 `ESERVICE`（fail loud，不静默兜底）。

**与 M0 的关系**：M0 的 `GET /api/fs/list`、`/api/fs/read` **删除**。`/plugin.json`、`/plugins/<id>.js`、`/__diorama__/*` 仍是 HTTP。

### 4.1 `diorama.toml` ✅ v0.3 定，M2 实现

唯一的配置文件。**查找顺序**：`<被服务的目录>/diorama.toml` → `$DIORAMA_HOME/diorama.toml`
（`DIORAMA_HOME` 默认 `~/.diorama`；两个路径都找不到就用默认值）。只读**第一个找到的文件**，不合并。

```toml
# diorama.toml —— 全部字段可选
host = "127.0.0.1"          # 监听网卡；默认 127.0.0.1（architecture §8）
port = 0                    # 0 = 随机空闲端口（默认）
plugins = ["slots", "layout", "file-tree", "tabs", "renderer-registry", "plaintext", "markdown", "code", "palette"]
ignore = [".git", "node_modules"]   # 隐藏规则（覆盖内置默认）

[watch]
debounceMs = 300            # 事件窗口合并（§3.1）；0–60000
```

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `host` | string | `"127.0.0.1"` | 等价 `--host` |
| `port` | integer 0–65535 | `0` | 等价 `--port` |
| `plugins` | string[] | 全部内置 | 等价 `--plugins`；未知 id → fail loud |
| `ignore` | string[] | `[".git", "node_modules"]` | 隐藏规则；`[]` 或 `--all` 表示不隐藏 |
| `watch.debounceMs` | integer 0–60000 | `300` | `fs.watch` 的合并窗口 |
| `watch.enabled` | boolean | `true` | `false` 时 `fs.watch` 立即返回空 disposer（不监听） |

**优先级：CLI > `diorama.toml` > 默认值。**

- **注意**：`--port` / `--host` / `--plugins` 的“没给”与“给了默认值”必须区分——CLI 解析出的
  `undefined` 才落回 toml。`--port 0` 是显式随机端口。
- `--all`（或 `--ignore ''`）：忽略规则为空。
- **`ignore` 的匹配**：gitignore 语法子集——`name`（任意层同名）、`dir/`（只匹配目录）、
  `a/b`（相对根）、`*` `?` `[...]`（不跨 `/`）、`**`（跨层）。**不读 `.gitignore`**（v1）。
  强制点是 `fs.list`（§3.1）。
- **`diorama.toml` 写错 = fail loud**：语法错误或字段类型/范围不对 → 打印文件名与原因，
  CLI 退出码 2，绝不静默忽略。
- **失败与展示**：CLI/`--dump-plan` 打印生效的配置来源（`config: <path>` 或 `config: none`）。
- **下发到页面**：`/plugin.json` 增加 `config: EffectiveConfig`，内容是合成后的有效配置
  （不含 toml 原文）。M2 只有文件树/palette 读 `ignore`——但它们走 `fs.list`，页面不需要再过滤。

## 5. slot 清单

| slot | 类型 | 声明者 | 条目 | 说明 |
|---|---|---|---|---|
| `root` | 单 | 内核 | 1 | 整个页面 |
| `layout.main` | 单 | `layout` | 1 | 左右分栏 |
| `sidebar.tree` | 单 | `layout` | 1 | 左侧导航 |
| `tabs.content` | **keyed** | `tabs` | N | 每个 tab 的内容区（**key = tab id**，§3.4） |
| `file.renderer` | keyed（内部排序） | `renderer-registry` | N | 按文件类型派发；M1 起带 matcher（§5.1） |
| `layout.overlay` | 单 | `layout` | 1 | 覆盖层（v0.3 新增：palette 等命令面板；M2 只给 `palette` 用） |

- **`tabs.content` 的 key**：v0.3 起是 **tab id**；`tabs` 为**每个 tab**（而不只是活动 tab）渲染一个
  `tabs.content` 座位，非活动座位隐藏而非卸载（每个 tab 的滚动位置与渲染状态彼此独立）。
- **`statusbar`：v1 不做**，从 slot 表移除（需要时再议）。
- **没有 toolbar**：只读工具没有“要对文件做的事”，v1 不提供 `file.toolbar` / `tabs.actions`（O8）。
- **回退链**：`file.renderer` 的条目按 §5.1 排序，命中者渲染；渲染抛错 → 标记失败 → **尝试下一个**；matcher 全不命中 → 兜底条目（plaintext）；一个条目都没有 → 「无可用渲染器」。

### 5.1 `file.renderer` 匹配规则

```ts
type FileMatcher =
  | { ext: string[] }                      // 不带点，小写比较
  | { mime: string[] }
  | { probe: (head: Uint8Array, file: FileInfo, mime: string) => boolean, cost: 'cheap' | 'expensive' }

interface RendererEntry {
  id: string
  order: number
  matcher?: FileMatcher   // 缺省 = 兜底（plaintext 专用）
}
```

**排序与选择（v0.2 定，与 v0.1 草案的差异见 §12）：**

1. 候选集 = 该 key 下所有**未失败**的条目。
2. 分三档：`ext` → `mime` → `probe`。**按档位先后**逐档扫描：先看所有 `ext` 条目（order 升序、同 order 按 id），命中即选；`ext` 全不中再看 `mime`，最后 `probe`。这样避免“每个文件都跑一遍 probe”，并让 `ext` 永远优先于 `mime` / `probe`。
3. 同一档内 order 升序、同 order 按插件 `id` 字典序（并 warn）。
4. `probe`：`cost: 'cheap'` 总是可用；`cost: 'expensive'` 仅在 ext/mime 全部未命中时执行，结果按 `(path, mtime, size)` 缓存。
5. `probe` 只能读内核给的前 N 字节（`PROBE_HEAD_BYTES = 4096`），**不得自己发文件请求**。
6. 全部不命中或无 matcher → **兜底条目**（`plaintext`，`matcher` 缺省）。没有兜底条目 → 「无可派发的渲染器」。
7. 命中条目渲染抛错 → 标记失败，回到 2 继续（下一个候选），最终落到兜底；兜底也失败 → 显示失败原因。

**渲染器 props**：渲染内容由内核预读、经 props 下发；渲染器不得自己发文件请求。

```ts
interface FileRendererProps {
  file: FileInfo
  /** 内核预读的文本（非二进制、未超上限时）。 */
  text?: string
  /** 内核预读的原始字节（readText 报 EBINARY 时回退用）。 */
  bytes?: Uint8Array
  mime: string
  mountCtx: MountHandle
}
```

- `text` 与 `bytes` 至少有一个；二进制文件只有 `bytes`。
- `mime` 由内核按扩展名推断（M1 是小表：text/*、application/json、image/* 等；未知为 `application/octet-stream`）。

## 6. contract version 规则 ✅ v0.2 起强制

- 内核版本 `0.x` 期间：**minor 改动即破环**，插件写窄范围（`>=0.3 <0.4`）。
- **检查时间**：读 manifest 时（加载前）。不满足 → 拒绝加载该插件，并解释原因（终端 + 浏览器控制台）。
- 内置插件同样检查：M1 遗留的 `>=0.2 <0.3` 会被 v0.3 内核拒绝，所以 M2 把所有内置插件升到
  `>=0.3 <0.4`。**内核与半边必须一起重新构建**（builtin manifest 与 kernel 的 `CONTRACT_VERSION`
  来自同一份构建）。
- M2 起**没有**外部插件（§9），因此"UI 显示「插件 X 因契约不兼容未加载」"的展示面随外部插件一起推迟；
  拒绝本身仍然 fail loud（CLI 退出码非 0 / boot 图里不出现）。

## 7. Gateway 控制面 — M3

CLI 与 gateway 之间的 socket 协议，M3 实现，见 v0.1 §7。M1 仍是前台单进程。

## 8. 客户端模块表 ✅ v0.2 定（M0 §10.3/§10.6 的空洞）

**规则（实现即契约）：**

1. **半边是闭合工厂**：每个 client 半边是 `window.__ModuleLoader__.load({ id, factory })`，
   `factory(require)` 只回答**表成员**，其余一律报错（fail loud）。
2. **表成员（页面提供单例）**：`react`、`react/jsx-runtime`（M1 表就这两个；M0 曾列
   `cordis` / `diorama-kernel/client` / `diorama-ui` / `diorama-plugin-slots`，实测半边
   一律内联它们并通过页面桥通信，表里放它们反而制造第二份实例的风险，故 M1 收紧）。
3. **半边自包含**：React 之外的一切依赖由半边内联；跨包协作只走 Cordis 服务与
   `globalThis.__diorama_page__`（方法调用，不持有引用）。
4. **加载顺序**：壳读 `/plugin.json` → 逐条 `<script src=clientUrl>`（工厂入队）→
   取工厂执行 → `bootClient` 注册进 Cordis。Shell 自身先于所有半边求值。
5. **外部插件（推迟到后续里程碑）**：bundle 必须符合同一工厂形状（见 §9），按内容 hash
   缓存；当前内核只实现内置 source，接口形状保留。

## 9. 插件来源与外部 bundle（推迟，契约位保留）

> **用户决定（M0 结束时）：外部插件（`~/.diorama/plugins` 动态加载、npm source）不做，
> 放到最后一个里程碑实现；M1 只在设计上保留可能性。**

保留的契约位：

- **`PluginSource` 接口**：

  ```ts
  interface PluginSource {
    /** 来源名：'builtin' | 'user-dir' | 'npm' …（将来）。 */
    readonly kind: string
    /** 发现该来源下的插件 manifest。 */
    discover(): Promise<PluginManifest[]>
    /** 解析 server 半边模块。 */
    loadServer(manifest: PluginManifest): Promise<unknown>
    /** client 半边的 URL（内核替它发）。 */
    clientUrl(manifest: PluginManifest): string
  }
  ```

- **server 半边**：`server.entry` 指向包目录内的 ESM 文件，`import()` 加载。
- **client 半边**：`client.entry` 指向 `.cjs`，形状见 §8；任意 ESM 不被接受（无法保证单例）。
- **依赖**：外部插件的 npm 依赖必须自己 bundle；`require` 只回答表成员，其余报错。
- **发现**：扫 `~/.diorama/plugins/*/package.json`（只看一层）。
- **失败**：外部插件加载失败记 failure 并继续其余插件（与 §6 的拒绝一致，fail loud 不阻断 boot）。
- **`id` 冲突**：内置优先（§1）。
- **CLI**：`--plugins-dir <path>` 便于测试与演示（推迟到实现外部插件时一并加）。
- **M1 的状态**：内核已有 `PluginSource` 接口与内建的 `BuiltinSource`；后续里程碑只需新增
  `UserDirSource` 并把它接进 `planPlugins`，不动内核其余部分。

## 10. zod 校验 ✅ 规则定，适用范围 M1 为空

- 规则：**外部插件**注册 slot 条目时 `props` schema 必填，注册时校验；校验失败 → fail loud，
  **该条目不注册**，插件其余条目照常（单点降级）。
- 只校验 slot 条目 props，**不**校验 `apply(ctx, config)` 的 config；**内置插件**不跑运行时 schema。
- **M1 无外部插件**，所以校验入口在 `ctx.slots.register` 里就位、M1 无实际调用者。

## 11. 失败处理（fail loud + 单点降级）

| 层 | 失败 | 表现 |
|---|---|---|
| 内核 boot | 半边加载失败 / 名字不符 / apply 抛错 | 控制台报错指出插件，跳过它，其余 boot |
| 契约 | contract 范围不满足 | 加载前拒绝，解释原因 |
| slot | `id` 重复 / 声明冲突 | 抛错 / warn + 拒绝（§3.3） |
| 渲染 | 条目渲染抛错 | 边界捕获 → 标记失败 → 回退链下一个 |
| 渲染 | 无可用条目 | 「无可用渲染器」，不白屏 |
| 渲染 | 读文件失败 | 显示错误码与原因，不白屏 |
| RPC | 服务不存在 / 方法不存在 | `ESERVICE` / `EMETHOD`，日志 + 调用方失败 |
| 订阅 | 订阅端点失败 / `cancel` 未知 session | 失败帧带 `code`；未知 session 记日志后忽略 |
| 命令 | 命令 id 重复 / 键字面重复 | `register` / `bind` 抛错（§3.7） |
| 配置 | `diorama.toml` 语法或字段错误 | CLI 退出码 2，点名文件与原因，不静默忽略（§4.1） |

## 12. v0.1 → v0.2 变更清单（破环，故升 minor）

| 条款 | v0.1 | v0.2 |
|---|---|---|
| RPC | 🔲 倾向自动代理 | §4 自动代理 + WebSocket + 双向 + base64 字节 |
| `/api/fs/*` HTTP | M0 临时形状 | 删除，改 RPC |
| `ctx.fs` | 🔲 方法名 | §3.1 完整签名、上限、错误码、`stat`、`readBytes`、watch 签名 |
| `file.renderer` | list slot，按 order 试 | keyed slot + matcher 三档 + 兜底 + 失败回退 |
| `file.renderer` props | `content: Uint8Array` | `text? / bytes? / mime` |
| 渲染器 props 取值 | 🔲 | 内核预读（AH1） |
| slot 冲突 | M0 fail loud 一律 | 三类分开（§3.3） |
| 条目注册形状 | 无 matcher | `matcher` 字段 + `probe` 签名函数 |
| 模块表 | 未定义（M0 探索） | §8 定稿 |
| contract 检查 | 未强制 | §6 强制 |
| `statusbar` | 🔲 | 移除 |
| 外部插件 | v1 | §9 推迟到最后一个里程碑，接口保留 |
| zod | v1 | 规则定，M1 无调用者 |

## 13. v0.2 → v0.3 变更清单（破环，故升 minor）

> 2026-10-19，M2 开工前用户逐条拍板（推荐值全采纳）。

| 条款 | v0.2 | v0.3 |
|---|---|---|
| `TabInfo` | `{ id, file: FileInfo }` | `{ id, path }`（内容区自己 stat/读） |
| `ctx.tabs` | 单 tab：`open`/`close`/`active`/`getSnapshot` | 多 tab：`open`（返回 `TabInfo`）/ `close` / `activate` / `next` / `prev` / `count`（§3.4） |
| `tabs.content` | single | **keyed，key = tab id**；每个 tab 一个座位（§5） |
| `layout.overlay` | 无 | 新增 single seat，palette 占用（§5） |
| `ctx.commands` | 🔲（“形态见 v0.1 §3.7”） | ✅ 内核内置；命令 id fail loud、键冲突字面重复才抛错、执行时多命中 warn 取第一条、`mod` = ⌘/Ctrl、`CommandContext` 内核采集、内置命令表（§3.7） |
| palette | 🔲 | 插件，`layout.overlay` 条目，**只列可执行命令**（§3.7） |
| `fs.watch` | 签名定、实现 M2、debounce 100ms | 只接受目录、每 300ms 窗口合并、`type` 为提示、不补发初态（§3.1） |
| `fs.list` | 返回目录全部条目 | **不返回被 `ignore` 隐藏的条目**（§3.1、§4.1） |
| RPC 事件帧 | `{ type: 'event', topic, payload }`（广播） | 加 `session?`；订阅端点 `fs.watch` + `{ type: 'cancel' }`；连接关闭自动取消（§4） |
| `diorama.toml` | 只定了名字 | 字段、查找顺序、CLI 优先级、gitignore 子集、fail loud（§4.1） |
| contract version | `0.2` / `>=0.2 <0.3` | `0.3` / `>=0.3 <0.4`（全部内置插件） |

## 待定清单（v0.3 后仍 🔲）

- [ ] `ctx.git` 具体签名（只读：diff / status / log）— M4
- [ ] `ctx.layout` 的服务面（M2 不提供，overlay 走 slot）
- [ ] `ctx.storage` 签名 — 待定
- [ ] 插件异步任务托管 API — 待定
- [ ] O8：渲染模式切换 / 图片缩放 / diff 并排的落点（命令化已缓解“开关型”）
- [ ] 外部插件的发现、bundle 校验、`--plugins-dir` — 最后一个里程碑
- [ ] gateway 控制面事件订阅 — M3
- [ ] palette 附录文件检索（`Ctrl+P`）与全量列出灰显 — 以后再定
- [ ] `.gitignore` 是否纳入隐藏规则 — 以后再定
- [ ] 多 tab 状态持久化（刷新后恢复）— O5
