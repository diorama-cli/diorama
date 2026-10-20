# 插件契约 v0.8

> 记录于 2026-10-18；v0.3 记录于 2026-10-19；v0.4 记录于 2026-10-19；v0.5 记录于 2026-10-19；
> v0.6 记录于 2026-10-20；v0.7 记录于 2026-10-20；v0.8 记录于 2026-10-20
> （v0.1 草案已归档为 [contract-v0.1.md](contract-v0.1.md)）。
> 契约先行：这份文档是内核与插件之间的唯一约定，改它 = 破环变更。
>
> **状态：v0.8 已定稿。** v0.1 → v0.2 的差异是 M1 决策（§12），v0.2 → v0.3 是 M2 决策（§13），
> v0.3 → v0.4 是 M3 决策（§14），v0.4 → v0.5 是补齐特性的决策（§15），
> v0.5 → v0.6 是 git 历史视图、字节渲染器与 HTML 渲染器的决策（§16），
> v0.6 → v0.7 是快捷键说明（`help`）与 `layout.overlay` 改 list 的决策（§17），
> v0.7 → v0.8 是文件搜索（`ctx.search` + `search-view`）的决策（§18）。
> 内核契约版本 `0.8`，所有插件声明 `contract: ">=0.8 <0.9"`；内核**已启用**范围检查（§6）。

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
    "contract": ">=0.8 <0.9",                     // 必须：兼容的内核契约范围（§6）
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

## 2.5 生命周期：全局插件图，按目录服务实例 ✅ v0.4 定

一个常驻 gateway 进程服务多个目录。插件**只加载一次**，但服务**每个目录一份**：每个挂载目录是一个 **fork 出的子 ctx**（`ctx.fork()`；内核实现为 `mountScope(root, mountId)` = 对 `MOUNT_SERVICES` 里**每个**服务名各 `isolate(name, <mountId>:<name>)`）。

```ts
export const name = 'fs'
export const inject: string[] = []

// ① 全局注册面：只执行一次（root ctx）
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
| 服务实例通过 mount ctx（fork 出的子 ctx）绑定 | 服务实例按目录隔离 |
| `ctx.fs` / `ctx.git` 等 scope 服务**只在子 ctx 可访问**，root 访问抛错 | 防止插件拿错目录 |
| **Cordis 按服务名隔离，不按 fiber**：`isolate` 只命名它拿到的那个名字，其余名字落回 root 的默认键（`Symbol(name)`），而 store 在 root 上——两个 mount 提供同名服务就会撞（`service "git" has been registered`），root 甚至会解析到某一个 mount 的实例。所以每个 mount 提供的服务名都必须在 `MOUNT_SERVICES` 里（`packages/kernel/src/server/plugins.ts`）；插件自带的按目录服务用 `isolateMountService(mountCtx, name)` | 挂载隔离是逐名字的，不是逐 fiber 的（v0.6 修复，m4/spec §12） |
| 子 ctx **可读** `ctx.diorama`（只读面），但自己的身份从 **`mountId`** 取，不从 `mounts.list()` 里挑 | 子 ctx 是 root 的后代，读父级服务是 Cordis 原语义；靠 list 认领目录是错误来源 |
| 重新挂同一个目录 = **新 `mountId`、新子 ctx**（不复用、不复活旧 ctx） | 故障隔离：旧 ctx 可能已 degraded |
| 组件不得从全局 `ctx` 取数据，用 props 传来的 `tabCtx` / `mountId` | 组件会渲染在某个具体目录的页面里 |
| 卸载插件 = 拆除所有子 ctx；`diorama rm` 只拆一个子 ctx | 防止孤儿实例 |
| 日志前缀 `[mount:<id>]` | 混合模型下的可观测性约定 |

**`onMount` 的时机（v0.4 定）：**

- 在 mount **之前**注册的回调：每个现存 mount 依次调用一次；
- 在 mount **之后**注册的回调（插件 boot 晚于第一次挂载）：立即对每个现存 mount 调用一次；
- 回调的返回值是该 **mount** 上的 disposer；`onMount` 返回的 disposer 对所有 mount 执行各自的 disposer，此后该回调不再被调用；
- 回调抛错 = 该插件在该 mount 上失败：记 `[mount:<id>]` 日志并让该 mount 进入 degraded（§11），其余回调照常。

**卸载一个 mount 的顺序（顺序是契约的一部分）：**

1. 该 mount 状态转 `stopped`，控制面 `unmount` 返回；
2. 关闭该 mount 的 HTTP listener 与全部 RPC 连接（连接关闭 = 取消其全部订阅，§4）；
3. 执行 `onMount` 回调返回的 disposer（**先于**子 ctx 销毁，插件在子 ctx 还活着时清理）；
4. `dispose` 子 ctx（fiber 卸载，服务实例失效）。

之后这个 `mountId` 不再出现在 `diorama.mounts.list()`，`onMount` 回调也不再为它调用。

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
  - **共享与上限（v0.4 定）**：同一个 mount 内，多个订阅同一目录的 `watch` **共享一个 OS 监听**
    （一次 `fs.watch`、一套 debounce 窗口、按 `path` 合并后分发给全部订阅者），引用计数归零即关闭。
    跨 mount **不共享**（目录、忽略规则都不同）。每个 mount 同时监听的目录数上限为
    **`watch.maxDirectories`（默认 64）**：达到上限后新的 `watch` **不抛错**，返回 no-op disposer
    并记一条 `warn`（上限说明）——展开文件树不应被一个上限打断页面。上限按 mount 计，不按进程计。
- **`list` 与忽略规则（v0.3 定，M2）**：`list(path)` **不返回**被 `ignore` 规则隐藏的条目
  （§4.1，`diorama.toml` 的 `[ignore]` 加上内置默认 `'.git'`、`node_modules`；`--all` 解除）。
  这是隐藏规则的**唯一强制点**：文件树、`ctx.search`（§3.9）、watch 都读 `list`，因此天然一致。
  `stat` 不受影响（直接按路径取信息）：已被打开的文件即使被隐藏，也照样能读。
- client 半边：`mountCtx.fs` 与上面**同名同签名**，底层走 RPC（§4），调用形状与本地服务一致。

### 3.2 `ctx.git`（server）✅ v0.5 定 / v0.6 补历史视图

git 的**只读**视图。**只在目录是 git 仓库时才存在**（在 `onMount` 里探测），其它插件必须
`inject: { optional: ['git'] }` 或做能力检测。**不提供任何写操作**（无 commit / stage / checkout；
`showCommit` 是**读**一个提交，不是建提交）。

```ts
type RepoRelPath = string   // 相对挂载根，`/` 分隔，无前导 `/`；'' 表示挂载根（与 §3.1 的 RelPath 同义）

interface GitStatusEntry {
  file: RelPath
  kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'
  /** porcelain 的状态串（如 `M `、`??`），原样；**调用方不应解析它**。 */
  status: string
  /** 仅 `renamed`：改名前的工作区路径。 */
  oldPath?: RelPath
}

interface DiffScope {
  /** 只看这个文件（相对挂载根）。缺省 = `scope` 子树的全部变更。 */
  path?: RelPath
  /** 只看这个目录（相对挂载根，'`' 表示挂载根）。左侧列表按子树过滤时用。 */
  scope?: RelPath
  /**
   * 比较基准。缺省 = `'HEAD'`（工作区 vs HEAD）。
   * - `'HEAD'`：工作区 vs HEAD（含未暂存与未跟踪）
   * - `'index'`：**暂存区** vs HEAD（只列已 `git add` 的改动）
   * - `<commit>`：工作区 vs 该提交（完整或短 sha，必要时带 `^` / `~N`；解析失败 `EINVAL`）
   *
   * v0.5 只接受 `'HEAD'`；v0.6 扩展到这三个分支。
   */
  base?: 'HEAD' | 'index' | string
}

interface DiffEntry {
  file: RelPath
  kind: GitStatusEntry['kind']
  status: string
  /** unified diff 文本（`--no-color`）；二进制文件没有 `text`，而有 `binary: true`。 */
  text?: string
  binary?: true
  oldPath?: RelPath
  /** 该文件 diff 超过上限，`text` 只是前缀。 */
  truncated?: true
}

interface DiffResult {
  /** 变更清单。单个文件读失败不拖垮列表：那一项只有 `file` 与 `error`。 */
  entries: (DiffEntry | { file: RelPath; error: { code: string; message: string } })[]
  /** 整次结果超过上限（4 MiB / 2000 行）：只回前缀，后续文件不出现在 `entries` 里。 */
  truncated: boolean
}

interface GitLogEntry {
  sha: string
  shortSha: string
  subject: string
  author: string
  /** ms since epoch。 */
  at: number
}

/** 一个提交的详情（v0.6）。 */
interface CommitDetail {
  sha: string
  shortSha: string
  subject: string
  author: string
  /** ms since epoch。 */
  at: number
  /** 完整提交说明（含 subject 与正文），原样。 */
  message: string
  /** 该提交改动的文件，形状与 `diff()` 的条目相同（相对挂载根）。 */
  files: DiffEntry[]
  /** 文件清单超过上限（4 MiB / 2000 行）：`files` 只是前缀。 */
  truncated?: true
}

/** 一个提交下的一个文件（v0.6）。 */
interface BlobResult {
  /** 文本文件的内容；二进制文件没有 `text`，而有 `binary: true`。 */
  text?: string
  binary?: true
  /** 内容超过上限（8 MiB）：`text` 只是前缀。 */
  truncated?: true
  /** 字节数（UTF-8 文件为准）。 */
  size: number
}

interface GitService {
  /** 工作区根的**绝对路径**（realpath 后）；挂载目录可能是仓库的子目录。 */
  readonly root: string
  status(): Promise<GitStatusEntry[]>                     // 扁平、不排序
  diff(scope?: DiffScope): Promise<DiffResult>
  log(options?: { limit?: number; path?: RelPath }): Promise<GitLogEntry[]>   // 新的在前
  // —— v0.6：历史视图 ——
  /** 该提交里这个文件的改动（相对**父提交**；root commit 相对空树），形状同 `DiffEntry`。 */
  show(commit: string, path: RelPath): Promise<DiffEntry>
  /** 提交详情：提交说明 + 改动的文件清单。 */
  showCommit(commit: string): Promise<CommitDetail>
  /** 该提交下这个文件的**内容**（不是 diff）；`size` 超过 8 MiB 时 `truncated`。 */
  blob(commit: string, path: RelPath): Promise<BlobResult>
}
```

规则：

- **存在性**：`onMount` 时用 `git rev-parse --show-toplevel` 探测；工作区根 = 该命令的输出（可以
  是挂载根，也可以是它的祖先）。不是仓库，或机器上没有 `git` → 该 mount **不 provide `git`**，
  日志一条原因（`[mount:<id>] git: …`）。
- **路径基准**一律是**相对挂载根**的 `RelPath`，与 §3.1 相同：绝对路径、`..` 越界、NUL →
  `EINVAL` / `EOUTSIDE`；路径不在仓库内 → `EOUTSIDE`。服务端自行换算成仓库内路径。
- **只读**：只运行只读的子命令（`status` / `diff` / `log` / `show` / `cat-file` / `rev-parse`），
  带 `--no-color`、不写 index、不碰工作区。
- **上限**（单次调用的累计量，超限检查在返回前）：`diff()` 4 MiB / 2000 行，超出部分不进
  `entries`，`truncated: true`；单个文件的 diff 超限时那一项 `truncated: true`。`log().limit`
  默认 50、上限 500（`EINVAL`）。超限**不**报 `ETOOLARGE`——列表场景要的是前缀而不是失败。
- **错误码**是方法契约（沿用 §3.1 的码，外加两个）：

  | 码 | 含义 |
  |---|---|
  | `EINVAL` | 路径非法、`base` 不是 `'HEAD'` / `'index'` / 可解析的提交、提交号非法、`limit` 越界 |
  | `ENOENT` | 文件不存在且不在任何变更里；`show` / `blob` / `showCommit` 的提交或路径在该提交下不存在 |
  | `EOUTSIDE` | 路径越出挂载根或不在仓库内 |
  | `ENOTREPO` | 服务在，但工作区根已经不可用（目录被移走） |
  | `EIO` | `git` 进程失败（stderr 摘要进 `message`） |

- **形状**：`diff()` 按文件给，不给整次 patch 拼接——左右两栏各按自己的粒度用（左侧只要
  `status` 的 kind，右侧要单个文件的 `text`）。
- **历史视图的三方法（v0.6）**：
  - `show(commit, path)` 是**单文件**的 diff，一次一个文件、一个提交；列表场景要的是
    `showCommit(commit).files`（形状与 `diff()` 的条目一致，左侧可以直接复用目录树的折叠）。
  - `showCommit` 的 `files` 与 `diff()` 共用**同一次上限账**（4 MiB / 2000 行），超限只回前缀、
    `truncated: true`；`message` 不受该上限影响（git 对提交说明本身有长度上限）。
  - `blob(commit, path)` 给该提交下的**文件正文**，不跟任何东西比较；文本上限 **8 MiB**（与
    `fs.readText` 同一阈值），超限回前缀 + `truncated: true`；含 NUL 的文件回 `binary: true` 且
    **没有** `text`（与 `fs.readText` 的 `EBINARY` 同一判定）。
  - **提交号的解析**：`commit` 参数接受完整 sha、短 sha 与 `HEAD~1` 这类 revision 语法，由 git 解析；
    解析不出的按 `EINVAL`（格式不对）或 `ENOENT`（形状对但不存在）报，服务端不自己实现解析。
  - 三个方法都不看工作区：`show` / `showCommit` / `blob` 的结果只由提交对象决定，工作区被改不影响。
- **`base: 'index'` 与未跟踪文件**：暂存区里没有未跟踪文件的位置，`diff({ base: 'index' })`
  **不列**未跟踪文件（它们不是「暂存了什么」的一部分）；`base: 'HEAD'` 才列。
- **未纳入版本库的文件没有 diff**：git 不拿它跟任何东西比较。`diff()` 对它只回
  `{ file, kind: 'untracked' | 'added', status }` 与**无 `text`**；要显示内容的一方自己
  用 `ctx.fs.readText` 读整个文件（§5.1 的同一条约定），不要指望 `ctx.git` 回文件正文。
- client 半边通过 RPC 自动访问（§4），形状不变；`testid` 不在契约里。

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
    view?: 'content' | 'diff'   // 缺省 content；diff 表示这个 tab 画工作区改动（v0.5）
  }

  interface TabsSnapshot {
    tabs: readonly TabInfo[]
    activeId: string | undefined
  }

  interface TabsService {
    /** `view` 缺省 content；对已打开的文件再次 open 会切换那个 tab 的 view（仍只有一个 tab）。 */
    open(file: FileInfo, options?: { view?: 'content' | 'diff' }): TabInfo
    close(id?: string): void           // 缺省关活动 tab
    activate(id: string): void
    next(): void                       // 循环
    prev(): void                       // 循环
    readonly active: TabInfo | undefined
    readonly count: number             // 命令的 when 用
    readonly openCount: number         // open() 被调用的次数（单调，v0.6）
    getSnapshot(): TabsSnapshot        // 不可变，仅变化时替换
    subscribe(listener: () => void): () => void
  }
  ```

  - **一个文件只有一个 tab**：`open` 的键是 `path`。`TabInfo` 不再带 `FileInfo` 快照——
    文件变化时内容区用 `fs.stat` 重读，tab 本身不持有文件数据（tabs 不依赖 fs）。
  - **`view`（v0.5）**：`content`（缺省）画文件本身，`diff` 画它的工作区改动。**tab 的键是
    `(path, view)`**：同一文件在两种视图下是**两个 tab**（可以并排看内容与 diff），同一
    `(path, view)` 再次 `open` 只激活。画在哪里由 `tabs` 按 view 选座位（`tabs.content` 还是
    `seats.git-diff`），内容渲染器永远看不到 diff tab。`tabs.find(path, view)` 是键查找。
  - **关闭后的激活**：右边的 tab，没有则左边的，都没有则空。
  - **标签栏由 `tabs` 自己画**（不开新 seat）；每个 tab 的内容画进 `tabs.content`（§5，
    key = tab id）。
  - `open` 从 v0.2 的 `void` 改为返回 `TabInfo`：源码层面兼容（`void` 用法照旧编译）。
  - **`openCount`（v0.6）**：`open()` **被调用**的次数，单调递增；**每次调用都通知订阅者**，
    包括"打开的就是当前活动文件"这种不改快照的情况。它存在的理由是"阅读者又去浏览文件了"这个
    事件本身：提交详情这类**不是 tab** 的东西要靠它知道该收起（§3.8、§5）。`getSnapshot()` 仍是
    不可变快照，`open` 同一文件时**同一个对象**（快照没变）——所以只听快照听不到这件事。

### 3.5 `ctx.diorama.mounts`（server）✅ v0.4 定

挂载登记面，所有服务插件靠它拿到自己的目录：

```ts
interface MountInfo {
  /** 绝对路径，realpath 后的目录；挂载时确定、不可变。 */
  root: string
  /** 全局唯一、不复用；出现在日志里为 `[mount:<id>]`。 */
  mountId: string
  /** 该目录的 HTTP 端口与 URL（页面 origin）。 */
  port: number
  url: string
  /** 挂载在该目录上的有效配置（§4.1）。 */
  config: EffectiveConfig
  /** 来源配置文件；`undefined` = 全默认。 */
  configFile?: string
}

interface Mounts {
  /** 每个 mount 调用一次；返回值是该 mount 上的 disposer（§2.5 时机）。 */
  onMount(cb: (mountCtx: Context, info: MountInfo) => (() => void) | void): () => void
  list(): MountInfo[]
}
```

- `info` 在 `onMount` 时已完整（含 `port` / `url`）；`info.root` 不可变。
- 返回的 disposer 在该目录卸下时执行，顺序见 §2.5。
- `list()` 返回**全部** mount（跨目录可见）；插件若只需自己的目录，用子 ctx 上的 `ctx.mountId`。
- 服务的**实例化**只发生在 `onMount` 回调里（§2.5）；插件不得自己触发挂载——挂载由控制面
  （§7）驱动。
- `ctx.diorama` 挂在 **root ctx**：`{ name, contract, mounts }`。子 ctx 可读它。

### 3.6 只读原则

**被浏览的目录永远只读。** `ctx.fs` / `ctx.git` 不提供写接口。

写盘只有一处：**`~/.diorama/`**。插件若要持久化状态，走内核提供的 `ctx.storage` 🔲（v0.5 仍未定，
签名待议），而不是自己拼路径。

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
| 带 `alt` 的绑定的匹配（v0.7 修订） | **macOS 上 Option 是组合键**：⌘⌥W 报的 `key` 是 `∑`、⌘⌥R 是 `®`、⌘⌥1 是 `¡`，不是 `w`/`r`/`1`。所以 `alt` 绑定在 `key` 不中时**按物理键 `KeyboardEvent.code` 再比一次**（`KeyW`→`w`、`Digit1`→`1`、`BracketLeft`→`[`）。只对带 `alt` 的绑定开放：`AltGr` 布局下不会让普通绑定被误触发 |
| **冲突（键相同）** | **字面重复才 fail loud**：同一个按键、且二者 `when` 都可能同时为真 → `bind` **抛错**。`when` 显式互斥的绑定可以共存。 |
| **冲突（执行时）** | 某一按键在当前上下文命中的绑定 `canRun` 同时为真且来自不同命令 → **warn，只执行第一条**（先注册者优先） |
| 触发条件 | 页面 mounted；按键命中且非 `repeat`；焦点不在 `input` / `textarea` / `[contenteditable]` 内；命中的绑定 `when` 为真 |
| 浏览器保留键 | 拦不住（`mod+w`、`mod+t`…）。**关闭 tab = `mod+alt+w`**；`ctrl+tab` / `ctrl+shift+tab` 绑定“到边界不动”，`mod+alt+→` / `mod+alt+←` 绑定“循环切换” |
| palette | 是插件（`requires: ['layout']`、`inject: ['commands']`），注册在 `layout.overlay`（v0.7 起是 **list**）上；打开时把按键交还给它（输入框内的按键不当作快捷键）。**默认只列可执行的命令**（不灰显），`Esc` 关闭，`Enter` 执行 |
| 快捷键说明（`help`，v0.7） | 同样是 `layout.overlay` 的条目。列出**全部**绑定，当前不可执行的**灰显而不隐藏**（与 palette 相反：速查表回答“有哪些键”，不是“现在能用哪些”）。`?` 开/关（键记法写 `shift+?`），`Esc` 关闭（`help.close`，`when` = 说明开着） |
| 覆盖层互斥（v0.7） | `layout.overlay` 是 **list** 座位，但同一时刻只有一个覆盖层是“开着”的：开一个即关掉另一个。状态在**页面全局**（`diorama-ui` 的 `overlayStore`），不是内核服务——这是页面 UI 状态 |
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
| `sidebar.showFiles` | 侧栏：文件 | `mod+alt+1` | 侧栏有视图 |
| `sidebar.showChanges` | 侧栏：变更 | `mod+alt+2` | 侧栏有该视图 |
| `sidebar.showHistory` | 侧栏：历史 | `mod+alt+3` | 侧栏有该视图 |
| `help.toggle` | 快捷键说明 | `shift+?` | 焦点不在输入框（v0.7） |
| `help.close` | 关闭快捷键说明 | `escape` | 说明开着（v0.7） |

命令的**来源插件**决定注册点：`tabs.*` 由 tabs 插件注册、`tree.*` 由 file-tree 注册、
`palette.toggle` 由 palette 注册、`help.*` 由 help 注册、`view.*` 由 renderer-registry 注册（它持有
文件内容缓存）、`sidebar.*` 由 layout 注册（它持有切换器的当前视图，§5.2）。

`sidebar.show*` 是**固定三条**命令，不是“每个视图自动一条”：`layout` 只认识 `files` / `changes` /
`history` 三个 id（与它画切换器时用的顺序一致）。新增视图**不自动获得快捷键**；要给它一条命令，
就在注册视图的那个插件里注册（命令 id 用 `<插件id>:<命令>`，开头一条规则）。

### 3.8 `ctx.router`（client）✅ v0.5 定

页面的 URL 与「当前文件」之间的唯一映射。**内核内置**（与 `ctx.commands` 同级，注入到页面的
root ctx），不是某个可选插件的服务：少选一个插件就丢掉深链，与 §3.7 同一个理由。

```ts
interface RouteSnapshot {
  /** 活动 tab 的文件路径；`undefined` = 没有活动 tab（URL 为根）。 */
  file: RelPath | undefined
}

interface RouterService {
  readonly file: RelPath | undefined
  /** 打开并激活该文件的 tab（已有则激活）；路径非法 → 拒绝并返回 false。 */
  open(file: RelPath): boolean
  /** 关闭活动 tab（没有活动 tab 时无操作）。 */
  close(): void
  getSnapshot(): RouteSnapshot                            // 不可变，仅变化时替换
  subscribe(listener: () => void): () => void
}
```

**URL 形态（v0.5 定）：**

| 项 | 取值 |
|---|---|
| 形式 | **path**：`<origin>/~/<RelPath>`，例如 `/~/src/app.js`；`/` 或 `/~/` = 无文件 |
| 管什么 | **页面正在显示哪个文件**：活动 tab 的文件路径，**不论它的 view**。跟文件相关的视图（diff、某个提交的版本）是“关于这个文件的”，文件属于路径，**视图与参数才进 hash** |
| **hash** | **插件可写的通用键值面**。跟文件相关的视图写**标记**（`#diff`，无值）；跟文件无关的状态（主题、搜索词）写在根页面（`/#theme=dark`）。内核不知道 `diff` / `theme` 是什么意思 |
| 保留前缀 | **`/~/`**。其余任何路径（`/plugin.json`、`/assets/`、`/plugins/`、`/__diorama__/`）都不被路由解释；以后新增的服务端路由也不会与它相撞 |
| 编码 | 每段 `encodeURIComponent`（`/` 保留为分隔符） |
| 历史 | 每次「活动文件」变化 `pushState`；浏览器前进/后退 `popstate` → 激活/打开那条路径 |
| 刷新 | **恢复单 tab**：启动时按 URL 打开该文件，tab 集合不进 URL（多 tab 记忆仍待定） |
| 非法路径 | 绝对路径、`..` 越界（解码后归一化不在根内）、NUL → **不开 tab**，页面显示提示；其余情况（不存在、读不了）**总是开 tab**，错误由内容区按 §11 显示 |

规则：

- **`/~/` 跟着活动 tab**：活动 tab 换成 diff（甚至换到另一个文件的 diff）时，路径变成**那个 tab
  的文件**——地址栏始终与画面一致。tab 顺序与非活动 tab 都不在 URL 里。
- **hash 归插件**：
  - 键形如 `[A-Za-z0-9_.-]+`，值经 `encodeURIComponent`；键排序后写出（同一状态 = 同一 URL）。
  - **空值 = 标记**：`#diff` 与 `{ diff: '' }` 互为一对（写 `set('')`，删除用 `set(undefined)`）。
    带参数时是 `#diff=HEAD~1`——**路径里的文件不在 hash 里重复**。
  - `ctx.router.state(key)` → `{ get(), set(v \| undefined), onChange(fn) }`；同一个 key 多次调用
    返回同一个槽位（按 key 共享）。
  - **hash 变化用 `replaceState`**：拨一个开关不进历史（后退键只在文件之间跳）。
  - **刷新保留**：启动时 hash 与 path 一起解码；插件在 `apply` 里读自己的键并恢复（diff 插件见
    `#diff` 就把路径上的文件以 diff 视图打开）。hash 里的未知键不影响别人（缺插件时不报错）。
  - **标记跟着活动 tab 双向同步**：写 `#diff` 的插件负责让“hash 里有这个标记”与“活动 tab 是这种
    视图”始终等价——离开 diff tab 时删掉它（否则刷新会莫名其妙回到 diff），回到 diff tab 时
    再加回来（否则地址栏与画面不一致）。
  - 前缀与内容：`/~/` 的 path 部分、`/plugin.json`、`/assets/`、`/plugins/`、`/__diorama__/` 都不被
    hash 影响；以后新增服务端路由也不会与它相撞。
- 服务端对 `/~/…` **只回页面壳**（SPA 回退），不做文件服务——文件访问始终走 `ctx.fs`（§3.1）。
- 路由不依赖 `tabs` 以外的客户端服务；`file-tree` 不在 boot 图里时深链仍然生效。

### 3.9 `ctx.search`（server + client 半边）✅ v0.8 定

按名字或按内容搜索挂载目录。像 `ctx.fs` 一样是**服务插件**（§2.5）：`apply` 在 root ctx 跑一次，
每个 mount 通过 `ctx.diorama.mounts` 拿到自己的 `SearchService`。

**只读**，并且**只通过 `ctx.fs` 读盘**：`list` 是隐藏规则（§4.1 `ignore`）的唯一强制点，
搜索如果自己摸 `node:fs` 就会出现第二条口径——被隐藏的文件不该在搜索结果里出现。

```ts
type SearchKind = 'name' | 'content'

interface SearchMatch {
  path: RelPath
  /** 1 基；该行第一个命中。 */
  line?: number
  /** 1 基，按字符计。 */
  column?: number
  /** 命中的字符数。 */
  length?: number
  /** 该行文本（长行截断，命中始终可见）。 */
  text?: string
}

interface SearchFile {
  path: RelPath
  /** 该文件的命中（name 命中没有条目）。 */
  matches: SearchMatch[]
  /** 该文件的总命中数——可能大于 `matches.length`（有截断）。 */
  count: number
}

interface SearchResult {
  kind: SearchKind
  files: SearchFile[]
  /** 含截断部分的真实总数。 */
  totalFiles: number
  totalMatches: number
  /** `files`（或它们的 matches）触到上限：这只是前缀。 */
  truncated: boolean
}

interface SearchOptions {
  kind?: SearchKind                        // 缺省 'name'
  caseSensitive?: boolean                  // 缺省 false
  wholeWord?: boolean                      // 缺省 false（内容搜索）
  regex?: boolean                          // 缺省 false（字面量）
  scope?: RelPath                          // 只搜这个子树（'' = 根）
  maxFiles?: number                        // 缺省 / 上限 SEARCH_MAX_FILES = 200
  maxMatchesPerFile?: number               // 缺省 / 上限 20
}

interface SearchService {
  search(query: string, options?: SearchOptions): Promise<SearchResult>
}
```

规则：

- **两种问题，一个方法**：
  - `kind: 'name'`（缺省）：**子序列**匹配路径（`appts` 命中 `src/app.ts`），子序列打分偏向
    连续段、分隔符后与驼峰边界、basename 命中——这是「快速打开」（`Ctrl/Cmd+P`）的口径。
    name 结果的 `matches` 为空、`count` 恒 1。
  - `kind: 'content'`：文件内的**字面量**（或 `regex`）匹配，逐行报 `line` / `column` / `length`
    与该行文本；同一行的多个命中折成**一条**（`count` 仍是真实次数）。
- **空查询返回空结果**（搜索永远不是目录列表）；query 超过 `SEARCH_MAX_QUERY_CHARS`（200）→
  `EINVAL`；非法正则 → `EINVAL`；scope 不存在 → `ENOENT`（与 `fs.list` 同码）。
- **二进制跳过**：含 NUL 的文件不进内容结果（与 `fs.readText` 的 `EBINARY` 同一判定，§3.1）。
- **上限是「截断」不是「失败」**：`maxFiles` / `maxMatchesPerFile` 之外的东西不出现，但
  `totalFiles` / `totalMatches` 报**真实总数**，`truncated: true` 标记。单次读取的文件数上限
  `SEARCH_MAX_SCANNED_FILES`（20 000），触到即止并截断。
- **隐藏条目不出现**：搜索只走 `fs.list`，因此 `ignore`（§4.1）对树、watch、搜索三者一致。
- **client 半边**：`mountCtx.search` 与上面同名同签名，走 RPC 自动代理（§4）。
- **命中行的落点（client 约定）**：tab 只带路径（§3.4），行号由 `diorama-ui` 的 **reveal store**
  （页面全局 `__diorama_reveal__`）传递：结果列表 `reveal(path, line)`，渲染器画出并滚动到那一行。
  这是页面 UI 状态，不是内核服务——与 `overlay`（§5）、`__diorama_layout__` 同一条规则。
- **插件与服务的 id 分开**：服务 id 是 `search`（内核 server 半边，每个 mount 都提供）；
  客户端 piece 是 `search-view`（侧栏「搜索」视图 + `mod+p` 快速打开覆盖层），同 `git` /
  `git-changes` 的拆分。

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

### 4.1 `diorama.toml` ✅ v0.3 定，M2 实现 / v0.4 补 gateway 化后的归属

唯一的配置文件（TOML；**不引入第二种格式**）。**查找顺序**：

1. `<被服务的目录>/diorama.toml`（目录自己的配置）
2. `$DIORAMA_HOME/diorama.toml`（全局默认；`DIORAMA_HOME` 默认 `~/.diorama`）
3. 都没有 → 默认值

只读**第一个找到的文件**，不合并。`--config <path>` 跳过查找。

```toml
# diorama.toml —— 全部字段可选
host = "127.0.0.1"          # 监听网卡；默认 127.0.0.1（architecture §8）
port = 0                    # 0 = 随机空闲端口（默认）
plugins = ["slots", "layout", "file-tree", "tabs", "renderer-registry", "plaintext", "markdown", "code", "image", "pdf", "html", "palette", "help", "git-changes"]
ignore = [".git", "node_modules"]   # 隐藏规则（覆盖内置默认）

[watch]
debounceMs = 300            # 事件窗口合并（§3.1）；0–60000
maxDirectories = 64         # 每个目录同时监听的目录数上限（§3.1）；1–4096
```

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `host` | string | `"127.0.0.1"` | 等价 `--host` |
| `port` | integer 0–65535 | `0` | 等价 `--port`；显式端口被占 → `EADDRINUSE`，不重试 |
| `plugins` | string[] | 全部内置**客户端**插件 | 等价 `--plugins`；未知 id → fail loud。`fs` / `git` 是内核服务（§3.1、§3.2），不在这个清单里，每个 mount 都自动加载 |
| `ignore` | string[] | `[".git", "node_modules"]` | 隐藏规则；`[]` 或 `--all` 表示不隐藏 |
| `watch.debounceMs` | integer 0–60000 | `300` | `fs.watch` 的合并窗口 |
| `watch.enabled` | boolean | `true` | `false` 时 `fs.watch` 立即返回空 disposer（不监听） |
| `watch.maxDirectories` | integer 1–4096 | `64` | 每个 mount 同时监听的目录上限（§3.1） |

**优先级：CLI > `diorama.toml` > 默认值。**

- **注意**：`--port` / `--host` / `--plugins` 的“没给”与“给了默认值”必须区分——CLI 解析出的
  `undefined` 才落回 toml。`--port 0` 是显式随机端口。
- `--all`（或 `--ignore ''`）：忽略规则为空。
- **`ignore` 的匹配**：gitignore 语法子集——`name`（任意层同名）、`dir/`（只匹配目录）、
  `a/b`（相对根）、`*` `?` `[...]`（不跨 `/`）、`**`（跨层）。**不读 `.gitignore`**（v1）。
  强制点是 `fs.list`（§3.1）。
- **`diorama.toml` 写错 = fail loud**：语法错误或字段类型/范围不对 → 打印文件名与原因，
  CLI 退出码 2，绝不静默忽略。
- **`$DIORAMA_HOME` 的两种含义已分开（v0.4）**：`DIORAMA_HOME` 只表示**状态目录**
  （配置、socket、pid、日志）；web 资源不从这里找（见 §7 的 `assetsRoot` 规则）。
- **gateway 化后的归属（v0.4）**：除 `host` / `port` / `plugins` / `ignore` / `[watch]` 外，
  配置是**每个挂载目录各自一份**。**配置合成发生在短命 CLI 侧**（它知道用户敲的目录），
  合成后的 `EffectiveConfig` 连同来源路径随控制面 `mount` 请求交给 gateway；gateway 不自己读
  toml。因此 `$DIORAMA_HOME/diorama.toml` 是「每个目录在别处都没配置时」的全局默认。
- **失败与展示**：CLI/`--dump-plan` 打印生效的配置来源（`config: <path>` 或 `config: none`）；
  `diorama ls` 的 `CONFIG` 列显示每个 mount 的来源。
- **下发到页面**：`/plugin.json` 带 `config: EffectiveConfig`、`configFile`、`state`
  （`'ok' | 'degraded'`）与 `lastError`（degraded 时）。M2 起只有文件树/palette 读 `ignore`，
  但它们走 `fs.list`——页面不需要再过滤。

## 5. slot 清单

| slot | 类型 | 声明者 | 条目 | 说明 |
|---|---|---|---|---|
| `root` | 单 | 内核 | 1 | 整个页面 |
| `layout.main` | 单 | `layout` | 1 | 左右分栏 |
| `sidebar.views` | **keyed** | `layout` | N | 左侧栏的视图（**key = 视图 id**：`files`、`changes`、`search`…），`layout` 画切换器（§5.2） |
| `tabs.content` | **keyed** | `tabs` | N | 每个 tab 的内容区（**key = tab id**，§3.4） |
| `file.renderer` | keyed（内部排序） | `renderer-registry` | N | 按文件类型派发；M1 起带 matcher（§5.1） |
| `layout.overlay` | **list**（v0.7） | `layout` | N | 覆盖层：命令面板（`palette`）、快捷键说明（`help`）等命令面。座位是 list，但同一时刻只有一个“开着”（§3.7 覆盖层互斥） |
| `seats.git-diff` | 单 | `tabs` | 1 | `view: 'diff'` 的 tab 画在这里（v0.5）；没填时该 tab 显示「没有 diff 渲染器」 |
| `seats.git-commit` | 单 | `git-changes` | 1 | 历史视图选中的提交的详情（v0.6）；**不是 tab**，由 `git-changes` 自己声明、自己填；没填时右侧不显示提交详情 |

- **`tabs.content` 的 key**：v0.3 起是 **tab id**；`tabs` 为**每个 tab**（而不只是活动 tab）渲染一个
  `tabs.content` 座位，非活动座位隐藏而非卸载（每个 tab 的滚动位置与渲染状态彼此独立）。
- **`sidebar.tree`（v0.4 及以前）已被 `sidebar.views` 取代**（v0.5）：侧栏不再是“文件树专用的一栏”，
  而是“一栏多视图”，file-tree 只是其中一个视图。
- **`seats.git-commit`（v0.6）与 `tabs` 无关**：提交不是文件，没有 `(path, view)` 键，不进 tab 集合；
  历史视图选中哪个提交由视图自己持有，`layout` 只负责把单座位画出来。
  - **它什么时候收起**：`tabs` 只在两件事同时成立时把 `#history` 画成提交详情——**选中的侧栏视图仍是
    `history`**，且**选中之后没有 `open()` 过任何文件**（`ctx.tabs.openCount` 没变，§3.4）。任一不成立就
    删掉 `#history` 并回到 tab 列表：打开文件（哪怕打开的是当前活动的那一个）、切到别的侧栏视图，都是
    “阅读者离开这个提交”。反过来，刷新时 hash 与 URL 上的文件一起恢复，仍算同一个提交（v0.6）。
- **`layout.overlay` 是 list，但覆盖层互斥（v0.7）**：每个条目都渲染（关闭时隐藏而不卸载，与
  `sidebar.views` / `tabs.content` 同一条规则，这样速查表的滚动位置、palette 的查询词都留得住），
  “谁开着”由页面全局的 `overlayStore`（`diorama-ui`）回答。开一个即关掉另一个。
  **不用内核服务**：这是页面 UI 状态；**也不能靠 import 互相知道**：每个 client 半边是各自的构建。
- **`statusbar`：v1 不做**，从 slot 表移除（需要时再议）。
- **没有 toolbar**：只读工具没有“要对文件做的事”，v1 不提供 `file.toolbar` / `tabs.actions`（O8）。
- **回退链**：`file.renderer` 的条目按 §5.1 排序，命中者渲染；渲染抛错 → 标记失败 → **尝试下一个**；matcher 全不命中 → 兜底条目（plaintext）；一个条目都没有 → 「无可用渲染器」。

### 5.2 `sidebar.views`（v0.5 定）

侧栏是**一条栏、多个视图**，由 `layout` 拥有与绘制：

```ts
interface SidebarViewProps {
  /** 是否为当前视图（非活动视图隐藏但不卸载）。 */
  active: boolean
}

interface SidebarViewSpec {
  /** 视图 id，即座椅的 key：`files`、`changes`、`history`…（不含 `:`）。 */
  key: string
  title: string            // 切换器上的文字（tooltip / 无障碍名）
  icon?: string            // 可选：内联 SVG 字符串；缺省用 title 首字
  order?: number           // 切换器里的顺序，缺省 100
}
```

规则：

- **注册即出现**：任何插件 `ctx.slots.register({ name: 'sidebar.views', key, title, icon }, Component)`；
  视图之间**互不知道对方存在**，新增视图不改 `layout` 以外的包。
- **切换器由 `layout` 画**（竖排图标条，VS Code 的 activity bar 形态）；切换状态由 `layout` 持有，
  条目通过 `props.active` 得知。
- **切换器有快捷键**（v0.6）：`layout` 注册 `sidebar.showFiles` / `sidebar.showChanges` /
  `sidebar.showHistory` / `sidebar.showSearch`（`mod+alt+1/2/3/4`，§3.7）；按到没有注册的视图时命令不可执行（`when` 为假），
  不报错。
- **非活动视图隐藏不卸载**（与 `tabs.content` 同一做法）：展开、滚动、选择各自保留。
- **没有视图被注册时，侧栏整栏不画**（M0 验收点 3 的语义，从 `sidebar.tree` 继承）。
- `file-tree` 在最前（`order: 10`），git 的「变更」视图 `order: 20`，「历史」视图 `order: 30`
  （v0.6），「搜索」视图 `order: 40`（v0.8，由 `search-view` 注册）。
  这些视图都由各自的 piece 注册，`layout` 不知道它们的含义。
- **图标是页面数据，不是模块导入**（v0.8 起，见 docs/m7/spec.md）：`icon` 仍是普通内联 SVG 字符串，
  但内置 piece 用 `diorama-ui` 的 `iconSvg(name)` 从**页面全局 `__diorama_icons__`** 取形——
  插画由 shell 通过 `diorama-ui/icons` 装一份（否则每个 client 半边都会把插画 bundle 一遍）。
  页面没有装表时（外部宿主、单测）`iconSvg` 返回 `''`，切换器按本节的缺省规则用 title 首字；
  `icon` 字段本身与形状没有任何耦合，外部 piece 可以照旧给任意 SVG。
- **视图内部怎么画是视图自己的事**：git 的「变更」把 `status()` 的扁平行折成**目录树**
  （目录优先、单一子目录链合并成一行、展开状态属于该视图，不与文件树共享）。`ctx.git.status()`
  保持扁平（§3.2），折叠由视图完成。

### 5.1 `file.renderer` 匹配规则

```ts
type FileMatcher =
  | { ext: string[] }                      // 不带点，小写比较
  | { mime: string[] }                     // 精确 mime，或末尾通配 `image/*`（v0.6）
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
3b. **`mime` 的通配（v0.6）**：一项允许**只有末尾**一个 `*`（`image/*` 匹配 `image/png`、
   `image/svg+xml`…；`*/*` 等价“任意 mime”）。中间的通配（`image/*+xml`）不支持，注册时按字面
   对待（不报错，只是不命中）——保留“要么精确、要么一个前缀”这一档，避免写出一套 glob。
4. `probe`：`cost: 'cheap'` 总是可用；`cost: 'expensive'` 仅在 ext/mime 全部未命中时执行，结果按 `(path, mtime, size)` 缓存。
5. `probe` 只能读内核给的前 N 字节（`PROBE_HEAD_BYTES = 4096`），**不得自己发文件请求**。
   注：内核目前没有“按偏移读”的 `ctx.fs` 方法，内核为 probe 取的头部是**从预读的文本里截**；
   文本取不到（二进制 / `EBINARY`）时内核**不**为此读字节（v0.6 起），`probe` 拿到空头。
6. 全部不命中或无 matcher → **兜底条目**（`plaintext`，`matcher` 缺省）。没有兜底条目 → 「无可派发的渲染器」。
7. 命中条目渲染抛错 → 标记失败，回到 2 继续（下一个候选），最终落到兜底；兜底也失败 → 显示失败原因。

**渲染器 props**：内核**只预读文本**；需要字节的渲染器自己走 `mountCtx.fs.readBytes`。

```ts
interface FileRendererProps {
  file: FileInfo
  /** 内核预读的文本（非二进制、未超 8 MiB 时）。二进制文件没有它。 */
  text?: string
  mime: string
  mountCtx: MountHandle
}
```

- **`text` 可能缺**：二进制文件（`readText` 报 `EBINARY`）与超过 `MAX_TEXT_BYTES`（8 MiB）的文件
  都**没有** `text`。**`bytes` 字段在 v0.6 删除**：内核不再预读字节（`Uint8Array` 过 RPC 的
  成本是 `text` 的数倍，而需要字节的渲染器只有图片 / PDF 两类）。
- **需要字节的渲染器自己取**（v0.5 定、v0.6 起内核真的这么做）：在 matcher 命中后
  **用 `props.mountCtx.fs.readBytes(path)`**；先 `fs.stat` 看 `size`，超 `MAX_BINARY_BYTES`（32 MiB）
  **不请求**、直接显示「文件过大（大小）」。`ctx.fs` 的 `ETOOLARGE` 语义不变（§3.1）——渲染器
  **不得**因此白屏，仍然落进回退链（§5“回退链”、§11）。
- **`probe` 不因此读字节**：`head` 从 `text` 截（见上一条），二进制文件拿到空头。要按魔数识别
  **二进制**格式的渲染器，用 `ext` / `mime` 档，不要指望 `probe`。
- **没有渲染器认领的二进制文件**：落到兜底 `plaintext`，它显示「二进制文件 · <size> · <mime>」，
  **不**读字节、不白屏（v0.6）。
- `mime` 由内核按扩展名推断（小表：text/*、application/json、image/*、application/pdf 等；未知为
  `application/octet-stream`）。
- **内置字节渲染器（v0.6）**：`image`（`mime: ['image/*']`）与 `pdf`（`ext: ['pdf']`），两者都先
  `stat` 再 `readBytes`，从 bytes 建 Blob URL 交给浏览器原生的 `<img>` / `<iframe>`；内核**
  不**内联 SVG 的 DOM（`<img>` 渲染 SVG，脚本不执行）。
- **HTML 渲染器（v0.6，`html`）**：`ext: ['html', 'htm']` 的**唯一 owner**（`code` 的 ext 表里
  **没有** `.html` / `.htm`，§5.1 rule 2）。只用预读的 `text`，不发任何请求。**两种显示方式**
  （按钮在渲染器自己的头部，不是工具栏，O8），状态属于渲染器实例（一个 tab 座位一个）：
  1. **预览**（缺省）：
     - **样式阶段**（缺省）：页面的 CSS 全部保留——`<style>`、`style=` 属性、外部样式表
       （`style-src 'unsafe-inline' https: http:`），外部图片与字体同样放行
       （`img-src` / `font-src` 含 `https: http:`）。**脚本不执行**：CSP 没有 `script-src`，frame 是
       `sandbox="allow-same-origin"`（无 `allow-scripts`）。
     - **脚本阶段**（读者逐文件确认后）：页面原样载入（**跳过消毒**——消毒会删掉被确认的脚本），
       frame 换成  `sandbox="allow-scripts"`、CSP 放行 `script-src` / `connect-src` / `media-src`。
       **同时给 `allow-scripts` 与 `allow-same-origin` 等于没有沙箱**，所以脚本阶段**没有**
       `allow-same-origin`：页面脚本能跑，但读不到本页、本页的 cookie 与文件。
     - **确认**：页面含脚本（`<script>`、`on*=` 或 `javascript:`）时，预览上方出现提示条
       「此页面含脚本，预览中未执行 · 执行脚本并预览」；确认后同一位置变为「已执行页面脚本」+
       「停止执行」。**信任只属于渲染器实例**：换文件、换 tab、刷新页面都回到未确认。
     - 消毒（样式阶段）用 `WHOLE_DOCUMENT`：DOMPurify 不带它时**只处理 `<body>`**，页面放在 `<head>`
       里的 `<style>` 会被整段丢掉（v0.6 修：这就是「CSS 没加载」）。
  2. **源码**：文件的原文用 `<pre>` 显示（转义为文本，不解释）。没有 `html` 插件时 `.html` 落到兜底
     `plaintext`（普通文本），**不**回到 `code`。
  同一 tab 换成另一个文件时回到**预览**且**未确认**（深链、刷新恢复都是“打开一个页面”）。
  **不使用 blob URL**：`srcdoc` 是内联文档，不需要在本站 origin 上开一个 URL。
  边界：**预览会执行读者确认过的页面脚本**——只读承诺覆盖的是 `ctx.fs` / `ctx.git`（本工具从不写
  被浏览的目录），不覆盖页面自身的脚本行为；脚本阶段不携 `allow-same-origin` 正是为了让页面脚本
  够不到本页面。

## 6. contract version 规则 ✅ v0.2 起强制

- 内核版本 `0.x` 期间：**minor 改动即破环**，插件写窄范围（`>=0.8 <0.9`）。
- **检查时间**：读 manifest 时（加载前）。不满足 → 拒绝加载该插件，并解释原因（终端 + 浏览器控制台）。
- 内置插件同样检查：旧范围的 manifest 会被新内核拒绝，所以每次升版都把全部内置插件一起升到
  当前范围（v0.8 起为 `>=0.8 <0.9`）。**内核与半边必须一起重新构建**（builtin manifest 与 kernel
  的 `CONTRACT_VERSION` 来自同一份构建）。
- M2 起**没有**外部插件（§9），因此"UI 显示「插件 X 因契约不兼容未加载」"的展示面随外部插件一起推迟；
  拒绝本身仍然 fail loud（CLI 退出码非 0 / boot 图里不出现）。

## 7. Gateway 控制面 ✅ v0.4 定

CLI（短命进程）与 gateway（常驻进程）之间的唯一通道。**它不属于插件契约**（插件见不到它），
但与内核同一次构建，故一并写在这里。

**进程模型**（architecture.md §10/§11）：整台机器一个 `diorama gateway`；`diorama <dir>` 是短命
CLI：连 socket → 不在就后台拉起 gateway → 请求 `mount` → 打印 URL。每个挂载目录一个独立端口。

### 7.1 传输

| 项 | 取值 |
|---|---|
| 地址 | Unix domain socket：**`$DIORAMA_HOME/diorama.sock`**（`DIORAMA_HOME` 默认 `~/.diorama`，目录不存在则创建）。Windows 用命名管道（v1 不实现，留分支） |
| 通道（v0.4） | **beta 构建**（`diorama-beta`，即 link 进来的 checkout）用 `diorama-beta.sock`，发布版用 `diorama.sock`；pid 与日志同理（`gateway[-beta].pid/.log`）。两条通道的 gateway 可同时运行且互不可见 |
| 帧 | **NDJSON**：一行一个 JSON 对象，`\n` 结尾（JSON 内的换行已转义，二者不冲突） |
| 上限 | 单行 **1 MiB**；超限 → 回 `ETOOLARGE` 并断开该连接 |
| 并发 | 一条连接可同时有多个请求；响应按 `id` 配对，**可乱序** |
| 配对 | 客户端为每个请求分配自增 `id`；服务端原样回填 |
| 认证 | 无（仅本机，architecture.md §10 已拍板） |

### 7.2 帧

```ts
// client → gateway
{ type: 'request', id: number, method: string, params: object }

// gateway → client
{ type: 'result', id: number, result: object }
{ type: 'error',  id: number, code: string, message: string }
{ type: 'event',  topic: string, payload: object }      // 只发给订阅了 events 的连接
```

- 服务端对**未订阅连接**发事件是非法状态（不会发生）；未收到 `events` 的连接不接收事件帧。
- 解析失败的行 → 回 `{ code: 'EBADREQUEST' }`（`id` 缺失时记日志并忽略该行）。
- 未知方法与未知方法名区分：`EMETHOD`。

### 7.3 方法

| method | params | result |
|---|---|---|
| `ping` | `{}` | `{ pid, version, contract, protocol: 1, startedAt }` |
| `mount` | `{ root, config, configFile?, port?, host?, plugins?, all?, breakPlugin? }` | `MountStatus` + `{ created: boolean }` |
| `unmount` | `{ mountId }` 或 `{ root }`（二选一） | `{ mountId, root }` |
| `list` | `{}` | `{ mounts: MountStatus[] }` |
| `status` | `{}` | `{ pid, version, contract, startedAt, state: 'ok' 或 'degraded', mounts: MountStatus[] }` |
| `stop` | `{ force?: boolean }` | `{ stopping: true }`（响应发出后 gateway 卸载全部 mount、关闭 socket 并退出） |
| `events` | `{ topics?: ('mounted' / 'unmounted' / 'degraded' / 'recovered')[] }` | `{ subscribed: true }`，之后该连接收事件帧 |

```ts
interface MountStatus {
  mountId: string
  root: string                   // realpath 后的绝对路径
  port: number
  url: string                    // http://<host>:<port>/（0.0.0.0 时显示 127.0.0.1）
  state: 'starting' | 'ok' | 'degraded' | 'stopped'
  since: number                  // 进入当前状态的毫秒时间戳
  configFile?: string            // 来源 diorama.toml；缺省 = 全默认
  plugins: string[]              // 客户端插件选择（boot 顺序）
  hidden: string[]               // 生效的 ignore 规则
  lastError?: { code?: string; message: string; at: number }   // degraded 时
}
```

**`mount` 的语义：**

- **配置在 CLI 侧合成**（§4.1）：`config` 是完整的 `EffectiveConfig`，`configFile` 是来源；
  `port` / `host` / `plugins` / `all` / `breakPlugin` 是 CLI 的**原始覆盖**，gateway 用它们再合成
  一次时以 `config` 为准（两者必须一致；不一致是调用方 bug，`EBADREQUEST`）。
  `breakPlugin` 是验证开关（M0 验收点 5），原样传给服务端插件树。
- **幂等**：同一 `root`（realpath）已在挂载 → 返回已有 `MountStatus`，`created: false`。
  幂等判定只看 root，不看配置：再次挂载**不**改已有 mount 的配置与端口。
- **端口**：`config.port === 0` → 随机端口，被占时自动重试（上限 20 次）；
  显式 `port !== 0` 被占 → `EADDRINUSE`，不重试（尊重用户显式意图、不占用别人端口）。
- **`root` 不存在 / 不是目录** → `ENOTDIR`。

**`unmount` 的语义：** 按 §2.5 的四步顺序卸下。`mountId` 不存在（已卸下）→ 幂等成功。

**`events` 的事件：** `mounted`（`MountStatus`）、`unmounted`（`{ mountId, root }`）、
`degraded` / `recovered`（`MountStatus`）。连接关闭即退订；不需要 `cancel` 帧。
v1 **没有 CLI 命令消费它**（`diorama ls` 不做 `--watch`）；它存在是为了脚本与以后的 UI。

**错误码：**

| 码 | 含义 |
|---|---|
| `EBADREQUEST` | 帧或参数形状不对 |
| `EMETHOD` | 未知方法 |
| `ENOMOUNT` | 指定 `mountId` / `root` 不在表里 |
| `EADDRINUSE` | 显式端口被占 |
| `ENOTDIR` | root 不存在或不是目录 |
| `ETOOLARGE` | 单行超过 1 MiB |
| `EGATEWAYDEAD` | **CLI 侧**：连不上 socket（gateway 没在跑） |
| `ESTARTING` | socket 存在但 gateway 还没开始服务（短暂，CLI 应重试到超时） |

### 7.4 后台进程

- `diorama gateway start` 拉起**独立进程**（`detached`，父进程退出不影响它），写入
  `$DIORAMA_HOME/gateway.pid`（内容 `{ pid, socket, startedAt }`），并把 stdout/stderr 追加到
  `$DIORAMA_HOME/gateway.log`。
- 启动竞态**不追求并发正确性**（v0.1 的结论保持）：谁先 `bind` socket 成功谁就是 gateway，输者
  以 `EADDRINUSE` 退出；CLI 连不上时**重试连接**到超时（默认 5s）。
- **`stop`**：发 `stop` 请求，等进程退出（默认 5s）；超时且有 `force` → `SIGKILL`；
  无 `force` → 报错退出非 0。**未运行时 `stop` 是成功的 no-op**（退出码 0）。
- **`restart`**：`stop` 后 `start`，**不保留挂载**（gateway 不持久化，architecture.md §10）。
- **`status`**：gateway 未运行时打印一行并退出 **1**。
- 进程崩溃后 pid 文件与 socket 文件可能残留：CLI 连不上就视为未运行，并清理残留 socket 文件。

### 7.5 前台模式

`diorama <dir> --foreground`：CLI 进程**自己**启动一个 gateway（同样建 socket、写 pid 文件），挂载
该目录，前台等待 `SIGINT`/`SIGTERM`；退出时卸载并删除 socket。它用于调试与测试隔离：
语义与后台 gateway 完全一致（页面、控制面、`diorama ls` 都可见），只是没有 `detached`。
**默认（无 `--foreground`）走后台 gateway。**

### 7.6 CLI 行为（退出码与输出）

| 情形 | 退出码 |
|---|---|
| 成功 | 0 |
| 参数/用法错误、`diorama.toml` 写错 | 2 |
| 目录不存在 / 不是目录 | 2 |
| 显式端口被占（`EADDRINUSE`） | 1 |
| 插件加载失败（boot 图有 failure） | 1 |
| `status` 时 gateway 未运行 | 1 |
| `stop` 时 gateway 未运行 | 0（幂等） |
| 连不上 / 启动超时 | 1 |

`diorama [dir]` 打印（保持 M1 起的三行，便于 e2e 抓 URL）：

```text
diorama serving <realpath>
  <url>
  config: <path> | none (defaults)
  [mount:<id>] plugins: <ids>
  hidden: <ignore>
```

重复挂载已存在的目录：额外一行 `already mounted (use "diorama gateway restart" to reload)`。

`diorama ls`（表头固定；URL 一列**必须有**；非 TTY 不加颜色，不截断）：

```text
MOUNT      PORT   STATUS     DIR                       URL                              CONFIG
abc12345   54321  ok         /Users/me/proj            http://127.0.0.1:54321/          diorama.toml
def67890   54322  degraded   /Users/me/notes           http://127.0.0.1:54322/          (defaults)
```

- 无 mount：打印 `no mounts (run "diorama <dir>")`，**退出码 0**。
- gateway 未运行：打印 `gateway is not running (run "diorama gateway start")`，**退出码 0**
  （`ls` 是查询，不是错误）。
- `--json`：输出 `{ gateway: StatusResult, mounts: MountStatus[] }`（字段与 §7.3 一致）。

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

## 11. 失败处理（fail loud + 单点降级）✅ v0.2 定 / v0.4 补 mount 级

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
| **mount** | `onMount` 回调抛错、该 mount 的 RPC/订阅/HTTP 处理抛错、子 ctx 的 fiber 报错 | 该 mount 进入 **degraded**（不阻断请求，页面显示横幅），其余 mount 不受影响 |
| **mount** | 无法归因到 mount 的 `uncaughtException` / `unhandledRejection` | 记日志，gateway 级 `state: 'degraded'`；mount 状态不变 |
| **gateway** | 控制面方法未知 / 帧非法 | `EMETHOD` / `EBADREQUEST`，连接不断 |
| **gateway** | 进程退出 | 全部 URL 失效（不持久化）；pid 与 socket 残留由下一次 CLI 调用清理 |

### 11.1 degraded（O7 已定）

**状态机**：`starting → ok → degraded → ok（恢复）`；卸下 → `stopped`。

**触发**：上面「mount」行的三种情况。记录 `lastError = { code?, message, at }`，日志
`[mount:<id>] degraded: <原因>`，并向控制面订阅者发 `degraded` 事件、向该 mount 的页面发
RPC 广播 `{ topic: 'mount.state', payload: MountStatus }`。

**表达**：

- 页面：页头**错误横幅**（不白屏、不阻断使用），文案含 `lastError.message`；恢复时横幅消失。
- CLI：`diorama ls` / `diorama gateway status` 的 `STATUS` 列为 `degraded`。

**恢复**：

1. **自动**：gateway 对该 mount 自动**重启一次**（卸下 + 重新挂载，2s 退避）后回到 `ok`；
   若再次进入 degraded，**不再自动重启**（避免重启风暴），只保持 degraded 并记录。
2. **手动**：`diorama restart <mountId|dir>`（`diorama gateway restart` 是重启整个 gateway）。
3. **不阻断**：degraded 的 mount 继续服务请求。

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

## 14. v0.3 → v0.4 变更清单（破环，故升 minor）

> 2026-10-19，M3 开工前用户逐条拍板（推荐值全采纳；配置格式用户明确沿用 TOML）。

| 条款 | v0.3 | v0.4 |
|---|---|---|
| 进程模型 | 单目录前台进程 | 常驻 gateway + 短命 CLI；每目录一个端口（architecture §10） |
| §2.5 生命周期 | "M3 起，形状照此执行" | ✅ 定稿：一个 mount = 一个 fork 出的子 ctx；子 ctx 可读 `ctx.diorama`；重挂 = 新 `mountId`；`onMount` 时机；**卸载四步顺序** |
| §3.1 `watch` | 每个订阅一个 OS 监听 | mount 内按 path **共享** + 引用计数；每 mount `watch.maxDirectories`（默认 64），超限 no-op + warn |
| §3.5 `MountInfo` | `{ root, mountId, config? }` | `{ root, mountId, port, url, config, configFile? }` |
| §4.1 `diorama.toml` | 目录 → `$DIORAMA_HOME` | 同上（格式不变）；新增 `watch.maxDirectories`；配置在 **CLI 侧**合成后交给 gateway；`DIORAMA_HOME` 只作状态目录 |
| §4.1 `/plugin.json` | 带 `config` | 另带 `configFile`、`state`、`lastError` |
| **§7 控制面** | 🔲（M3，见 v0.1 §7） | ✅ NDJSON over `$DIORAMA_HOME/diorama.sock`；`ping/mount/unmount/list/status/stop/events`；`MountStatus`；错误码；后台进程与 `--foreground`；CLI 退出码与 `ls` 输出 |
| §11 失败处理 | 单进程各层 | 加 **mount 级**：degraded 状态机、触发、表达、**自动重启一次** + `diorama restart <mount>`、不阻断请求 |
| `DIORAMA_HOME` | 兼作 web 资源目录 | **只作状态目录**；资源只在包内 `web/` 或 `apps/web/dist`（CLI 侧规则） |
| contract version | `0.3` / `>=0.3 <0.4` | `0.4` / `>=0.4 <0.5`（全部内置插件） |

## 15. v0.4 → v0.5 变更清单（破环，故升 minor）

> 2026-10-19，用户逐条拍板：范围 = git 的只读视图 + URL 路由（主题不做）；侧栏按 VS Code 的
> 方式切换多个视图；URL 用 path 形态与 `/~/` 保留前缀；刷新恢复单 tab。

| 条款 | v0.4 | v0.5 |
|---|---|---|
| §3.2 `ctx.git` | 🔲 一句“待定” | ✅ `status()` / `diff(scope?)` / `log(options?)`；`DiffScope` / `DiffEntry` / `DiffResult` / `GitStatusEntry` / `GitLogEntry`；`root` 为绝对路径；只读；单次 4 MiB / 2000 行、`log` 50/500；错误码 `EINVAL`/`ENOENT`/`EOUTSIDE`/`ENOTREPO`/`EIO`；不是仓库 → 不 provide |
| §3.8 `ctx.router` | 无 | ✅ 内核内置客户端服务；`/~/<RelPath>` **记活动 tab 的文件**（任何视图），每次变化 `pushState`；`#key[=value]` 是**插件可写的键值面**（`ctx.router.state`，空值 = 标记，`replaceState` 不进历史，刷新保留）；`/` = 无文件；非法路径不开 |
| §3.4 `TabInfo.view` / `tabs.open(file, { view })` | `TabInfo` 只有 `{ id, path }`，一个文件一个 tab、一种画法 | `view: 'content' \| 'diff'`（缺省 content）；**tab 的键是 `(path, view)`**，同一文件两种视图是两个 tab |
| §5 `seats.git-diff` | 无 | 新增单座位（声明者 `tabs`）；`tabs` 按 view 派发 |
| §5.2 视图元数据 | 无 | `sidebar.views` 条目的 `title` / `icon` 是**一等字段**（registry 会重建条目对象，自定义字段活不过一次 notify） |
| §5 `sidebar.views` | 无（`sidebar.tree` 是单座位，file-tree 专用） | 新增 **keyed** 座位（key = 视图 id），`layout` 画切换器；`sidebar.tree` **移除**；无视图 → 侧栏不画（§5.2） |
| §5.1 渲染器字节 | “内核预读、渲染器不得自己发文件请求”（与代码里已有的 `mountCtx` 不一致） | **文本**由内核预读；需要字节的渲染器自己 `mountCtx.fs.readBytes`，先 `stat`、超 32 MiB 不请求（§5.1） |
| §3.6 `ctx.storage` | 🔲 | 🔲（本次不做主题，签名仍未定） |
| contract version | `0.4` / `>=0.4 <0.5` | `0.5` / `>=0.5 <0.6`（全部内置插件） |

## 16. v0.5 → v0.6 变更清单（破环，故升 minor）

> 2026-10-20，用户逐条拍板：范围 = **git 历史视图 + 图片 / PDF 渲染器**（Notebook 不做、主题不做、
> `ctx.storage` 仍 🔲）；git 新增 **`show` / `showCommit` / `blob`** 三个方法（不改已有方法），
> `DiffScope.base` 扩展到 `'index'` 与任意提交；渲染器改为**只预读文本**、字节自己取；
> `mime` 档接受末尾通配；侧栏切换器加三条命令与快捷键。

| 条款 | v0.5 | v0.6 |
|---|---|---|
| §3.2 `ctx.git` 历史 | 只有 `status` / `diff` / `log` | 新增 `show(commit, path)`（单文件 diff）、`showCommit(commit)`（`CommitDetail`：说明 + 文件清单）、`blob(commit, path)`（`BlobResult`：该提交下的文件正文）；**已有三个方法签名不变** |
| §3.2 `DiffScope.base` | 只接受 `'HEAD'` | `'HEAD'`（缺省）/ `'index'`（暂存区）/ `<commit>`（工作区 vs 该提交）；`base: 'index'` 不列未跟踪文件 |
| §3.2 只读子命令 | `status` / `diff` / `log` / `rev-parse` | 另加 `show` / `cat-file`（仍只读；`showCommit` 是**读**提交，不是 git 的 `commit`） |
| §3.2 上限 | `diff()` 4 MiB / 2000 行 | `showCommit().files` 共用同一账；`blob()` 文本 8 MiB（同 `fs.readText`）、超限前缀 + `truncated` |
| §5.1 渲染器 props | `text?` 与 `bytes?` 至少有一个 | **`bytes` 删除**；内核只预读文本，`EBINARY` 后不再读字节；文本超 8 MiB 也无 `text` |
| §5.1 无认领的二进制 | 落到 plaintext（只有字节，没有可显示的东西） | plaintext 显示「二进制文件 · size · mime」 |
| §5.1 `mime` matcher | 精确 mime | 允许**末尾**一个 `*`（`image/*`）；中间通配不支持 |
| §5.1 内置渲染器 | 无字节渲染器 | `image`（`image/*`）与 `pdf`（`.pdf`），先 `stat`、超 32 MiB 不请求，Blob URL + 原生 `<img>` / `<iframe>` |
| §5 `seats.git-commit` | 无 | 新增单座位（声明者 `git-changes`）；提交详情**不是 tab**、不进 `(path, view)` 键；`#history` 只在“仍在 `history` 视图且之后没 `open()` 过文件”时画详情（§5） |
| §3.4 `ctx.tabs.openCount` | 无 | 新增只读计数：`open()` 被调用几次；**每次调用都通知**（打开当前文件也算），供“阅读者又去浏览了”这类事件用（§3.4） |
| §5.2 `history` 视图 | 侧栏两个视图（`files` / `changes`） | 第三个视图 `history`（`order: 30`），由 `git-changes` 注册；选中提交写 `#history=<sha>`（router 的 hash 面，内核不解释） |
| §3.7 命令表 | 9 条 | 另加 `sidebar.showFiles` / `sidebar.showChanges` / `sidebar.showHistory`（`mod+alt+1/2/3`），由 layout 注册（v0.8 另加 `sidebar.showSearch`，`mod+alt+4`） |
| §5.1 内置渲染器（HTML） | 无（`.html` 归 `code` 当源码看） | `html`（`ext: ['html', 'htm']`，`code` 不再认领）：预览 = DOMPurify 消毒 + `srcdoc` 沙箱 frame（无 `allow-scripts`），源码 = 转义文本；切换在渲染器头部，缺省预览 |
| §3.6 `ctx.storage` | 🔲 | 🔲（仍不做主题；签名仍未定） |
| contract version | `0.5` / `>=0.5 <0.6` | `0.6` / `>=0.6 <0.7`（全部内置插件 + kernel 包自己的 manifest） |

## 17. v0.6 → v0.7 变更清单（破环，故升 minor）

> 2026-10-20。用户拍板：要一个**独立的 `help` 插件**（不是塞进 palette），不可用的快捷键
> **灰显列出**（不隐藏），`?` 与 `mod+k` 打开任一个时**关掉另一个**。
> 把 `layout.overlay` 从单座位改成 list 是座位类型变更，按 §6 的规则破环，故升 minor。

| 条款 | v0.6 | v0.7 |
|---|---|---|
| §5 `layout.overlay` | 单座位（只有 `palette`） | **list**：多个命令面共存（`palette`、`help`…）。`layout` 全部渲染，各自的显隐由页面全局的 `overlayStore` 决定 |
| §3.7 覆盖层互斥 | 无（单座位天然只有一个） | 同一时刻只有一个覆盖层“开着”，开一个即关掉另一个。状态在**页面全局** `__diorama_overlay__`（`diorama-ui/overlay.ts`），不是内核服务 |
| §3.7 命令表 | 12 条 | 另加 `help.toggle`（`shift+?`）与 `help.close`（`escape`，`when` = 说明开着），由 `help` 注册 |
| §3.7 列表口径 | palette 只列可执行命令 | 新增一条并列口径：**快捷键说明列全部绑定，不可用的灰显**（两者回答不同的问题，不是矛盾） |
| §5 内置插件 | 13 个 | 14 个：新增 `help`（`layout.overlay`，`order: 200`），进默认清单（§4.1）与 boot 顺序（`palette` 之后） |
| §3.7 带 `alt` 绑定的匹配 | 只比 `KeyboardEvent.key` | `key` 不中时按物理键 `code` 再比一次（macOS 上 Option 会把字母组合成 `∑` / `®` / `¡`，此前所有 `mod+alt+*` 在 Mac 上都是死键并透传给浏览器）；只对 `alt` 绑定开放 |
| contract version | `0.6` / `>=0.6 <0.7` | `0.7` / `>=0.7 <0.8`（全部内置插件 + kernel 包自己的 manifest） |

**没有变的东西**：`ctx.commands` 的签名与注册/绑定规则、键记法本身（仍按 `KeyboardEvent.key` 书写）、
`sidebar.views`、`tabs`、渲染器派发、`ctx.fs` / `ctx.git` / `ctx.router`。`help` 不提供任何服务，
也不新增座位。

## 18. v0.7 → v0.8 变更清单（破环，故升 minor）

> 2026-10-20。用户要求：**支持文件搜索，包括文件名和文件内容，体验尽量接近 VS Code**。
> 新增 `ctx.search`（§3.9）是**新增服务**，但 `sidebar.views` 多了一个视图、命令表多了三条、
> 内置插件多了一个——按 §6 的规则「minor 改动即破环」，升 minor。

| 条款 | v0.7 | v0.8 |
|---|---|---|
| §3.9 `ctx.search` | 无 | 新增内核服务（每个 mount 都提供）：`search(query, options?)`；`kind` = `'name'`（子序列匹配路径）/ `'content'`（文件内的字面量或正则），`SearchResult` 带 `totalFiles` / `totalMatches` / `truncated`；只读，只走 `ctx.fs`（`ignore` 口径与树一致） |
| §3.9 上限 | 无 | `SEARCH_MAX_FILES` 200、每文件 20 条、扫描 20 000 个文件、query 200 字符；超限**截断**（报真实总数），不报 `ETOOLARGE` |
| §3.9 命中落点 | 无 | 行号经 `diorama-ui` 的 **reveal store**（页面全局 `__diorama_reveal__`）传给渲染器；tab 仍只带路径（§3.4 不变） |
| §5.2 `search` 视图 | 三个视图（`files` / `changes` / `history`） | 第四个视图 `search`（`order: 40`），由 `search-view` 注册：字段 + 「内容 / 文件名」两种模式 + 大小写 / 全字 / 正则开关 + 可折叠结果 |
| §3.7 命令表 | 15 条 | 另加 `sidebar.showSearch`（`mod+alt+4`，layout 注册）、`search.quickOpen`（`mod+p`）、`search.open`（`mod+shift+f`），由 `search-view` 注册 |
| §5 `layout.overlay` 条目 | `palette`（100）、`help`（200） | 另加快速打开（`order: 300`），与其它覆盖层互斥（§3.7 的 `overlayStore`） |
| §5 内置插件 | 14 个 | 15 个：新增 `search-view`（客户端 piece），进默认清单（§4.1）与 boot 顺序（`git-changes` 之后） |
| §3.1 `ctx.fs` | 不变 | 不变。搜索不新增 fs 方法：它复用 `list` / `stat` 与自己的读取 |
| contract version | `0.7` / `>=0.7 <0.8` | `0.8` / `>=0.8 <0.9`（全部内置插件 + kernel 包自己的 manifest） |

**为什么服务 id 与 piece id 分开**：`search` 是内核的 server 服务（每个 mount 都提供，
`--plugins` 选不掉）；画它的客户端 piece 是 `search-view`。同一个 id 同时出现在
`KERNEL_SERVICE_IDS` 与 `BUILTIN_PLUGIN_IDS` 里，会让 CLI 的 server 半边映射表出现同名键
（`git` / `git-changes` 当初就是这么分的）。

**没有变的东西**：`ctx.fs` / `ctx.git` / `ctx.router` / `ctx.commands` 的签名、`tabs` 的键、
渲染器派发与 `file.renderer` 的匹配规则、`sidebar.views` 的座位形态（仍是 keyed，只是多一个 key）。

## 待定清单（v0.4 后仍 🔲）

- [x] `ctx.git` 具体签名（只读：diff / status / log）— v0.5 定（§3.2）
- [x] git history 视图（`show` / 提交列表在左栏的落点）— v0.6 定（§3.2、§5、§5.2）
- [ ] `ctx.layout` 的服务面（overlay 走 slot）
- [ ] `ctx.storage` 签名（主题 / 偏好持久化）— 待定
- [ ] 插件异步任务托管 API — 待定
- [ ] O8：渲染模式切换 / 图片缩放 / diff 并排的落点（命令化已缓解“开关型”；git diff 已是行内形态）
- [ ] URL 里是否记多 tab（刷新恢复整组）— 与 U10 一起定
- [ ] 外部插件的发现、bundle 校验、`--plugins-dir` — 最后一个里程碑
- [ ] gateway 控制面事件的 CLI 消费者（`diorama ls --watch`）— 以后再定（协议已定，见 §7.3）
- [ ] gateway 单点的 supervisor 兜底（崩溃自拉起，O6）— 以后再定
- [ ] 挂载持久化（gateway 重启后恢复 mount）— **明确不做**（architecture.md §10）
- [x] palette 附录文件检索（`Ctrl+P`）— v0.8 定：**不是 palette 的一部分**，是 `search-view` 的独立覆盖层（§3.9）
- [ ] `.gitignore` 是否纳入隐藏规则 — 以后再定
- [ ] 多 tab 状态持久化（刷新后恢复）— O5
