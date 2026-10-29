# 插件契约 v0.0.7

> 记录于 2026-10-18；v0.3 记录于 2026-10-19；v0.4 记录于 2026-10-19；v0.5 记录于 2026-10-19；
> v0.6 记录于 2026-10-20；v0.7 记录于 2026-10-20；v0.8 记录于 2026-10-20；v0.9 记录于 2026-10-20
> （v0.1 草案已归档为 [contract-v0.1.md](contract-v0.1.md)）。
>
> **2026-10-20 首次发布**：契约号重编为 **`0.0.1`**（此前文档里的 `v0.8` 是开发期编号，
> §12–§18 的历史清单保留原样、按里程碑阅读）。发布形态见 [m8/spec.md](m8/spec.md)。
> **`0.0.2`**：主题切换（§19），见 [m9/spec.md](m9/spec.md)。
> **`0.0.3`**：命令行的配置编辑、挂载的 JSON 输出、Markdown 里的链接留在页面内（§20–§22）。
> **`0.0.4`**：diff 的三种读法、一个目录里的多个仓库、可拖动的窗格、断线重连、Markdown 的
> 大纲 / 公式 / 图表、`[html] scripts`、侧栏收起、diff 的语法高亮、快捷键与浮层提示
> （§23–§31）。
> **`0.0.6`**：`diorama stop`、默认主题写在 `diorama.toml` 里、网页标题是目录名、文件视图的
> 工具栏、文件的原件链接与三个动作（§32–§36）。
> **`0.0.7`**：历史视图的多仓库切换改成下拉、还没提交过的仓库不再是 `EIO`、行号与跳转到行
> （§37–§39）。
> 契约先行：这份文档是内核与插件之间的唯一约定，改它 = 破环变更。
>
> **状态：v0.0.7 已定稿。** v0.1 → v0.2 的差异是 M1 决策（§12），v0.2 → v0.3 是 M2 决策（§13），
> v0.3 → v0.4 是 M3 决策（§14），v0.4 → v0.5 是补齐特性的决策（§15），
> v0.5 → v0.6 是 git 历史视图、字节渲染器与 HTML 渲染器的决策（§16），
> v0.6 → v0.7 是快捷键说明（`help`）与 `layout.overlay` 改 list 的决策（§17），
> v0.7 → v0.8 是文件搜索（`ctx.search` + `search-view`）的决策（§18），
> v0.8 → v0.9 是主题切换（`ctx.theme` + `theme` piece）的决策（§19），此后按「发版才升号」
> 记录，`0.0.3` 是 §20–§22、`0.0.4` 是 §23–§31、`0.0.6` 是 §32–§36、`0.0.7` 是 §37–§39。
> 内核契约版本 `0.0.7`（pre-1.0 阶段每次破环只升 `0.0.x` 的数字），
> 所有插件声明 `contract: ">=0.0.7 <0.1.0"`；内核**已启用**范围检查（§6）。

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
    "contract": ">=0.0.7 <0.1.0",                     // 必须：兼容的内核契约范围（§6）
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
- **下载不走 `ctx.fs`**（v0.18）：文件的**原件字节**由 `GET /~raw~/<RelPath>` 直接流给浏览器
  （§4），所以**不受上面两条上限约束**；`ctx.fs` 的上限只针对「把内容读进页面」这件事。

### 3.2 `ctx.git`（server）✅ v0.5 定 / v0.6 补历史视图 / v0.10 多仓库

git 的**只读**视图。**一个挂载目录里的每一个仓库**都在这里（v0.10）：并列的多个、外层仓库里
嵌套的仓库，都在同一个服务里按仓库区分。**一个仓库都没有时才不存在**（在 `onMount` 里探测），
其它插件必须 `inject: { optional: ['git'] }` 或做能力检测。**不提供任何写操作**（无 commit /
stage / checkout；`showCommit` 是**读**一个提交，不是建提交）。

```ts
type RepoRelPath = string   // 相对挂载根，`/` 分隔，无前导 `/`；'' 表示挂载根（与 §3.1 的 RelPath 同义）

/** 一个挂载里的一个仓库（v0.10）。 */
interface GitRepoInfo {
  /** 仓库根相对挂载根的路径；`''` = 仓库根就是挂载根（或包含挂载根）。 */
  path: RelPath
  /** 发现走查因深度/数量上限提前停止：这份清单只是前缀。 */
  truncated?: true
}

interface GitStatusEntry {
  file: RelPath
  kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'
  /** porcelain 的状态串（如 `M `、`??`），原样；**调用方不应解析它**。 */
  status: string
  /** 仅 `renamed`：改名前的工作区路径。 */
  oldPath?: RelPath
  /** 这个改动属于哪个仓库（v0.10；`''` = 挂载根的那个）。 */
  repo?: RelPath
}

interface DiffScope {
  /** 只看这个文件（相对挂载根）。缺省 = `scope` 子树的全部变更。 */
  path?: RelPath
  /** 只看这个目录（相对挂载根，'`' 表示挂载根）。左侧列表按子树过滤时用。 */
  scope?: RelPath
  /**
   * 只看这个仓库（v0.10）。缺省 = 挂载里的全部仓库；给了 `path` 时由路径
   * 自己决定仓库（最深的那一个）。
   */
  repo?: RelPath
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
  /** 这个文件属于哪个仓库（v0.10；`''` = 挂载根的那个）。 */
  repo?: RelPath
  /** unified diff 文本（`--no-color`）；二进制文件没有 `text`，而有 `binary: true`。 */
  text?: string
  binary?: true
  oldPath?: RelPath
  /** 该文件 diff 超过上限，`text` 只是前缀。 */
  truncated?: true
}

interface DiffResult {
  /** 变更清单。单个文件读失败不拖垮列表：那一项只有 `file` 与 `error`。 */
  entries: (DiffEntry | { file: RelPath; repo?: RelPath; error: { code: string; message: string } })[]
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
  /** 这个提交在哪个仓库（v0.10）。 */
  repo?: RelPath
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
  /** 挂载根的**绝对路径**（realpath 后）。 */
  readonly root: string
  /** 这个挂载里的仓库，浅的在前（v0.10）。 */
  repos(): GitRepoInfo[]
  /** 全部仓库的变更（扁平、不排序）；给了 `repo` 就只看那一个。 */
  status(repo?: RelPath): Promise<GitStatusEntry[]>
  diff(scope?: DiffScope): Promise<DiffResult>
  /** 新的在前；`repo` 缺省 = 挂载自己的仓库。 */
  log(options?: { limit?: number; path?: RelPath; repo?: RelPath }): Promise<GitLogEntry[]>
  // —— v0.6：历史视图 ——
  /** 该提交里这个文件的改动（相对**父提交**；root commit 相对空树），形状同 `DiffEntry`。 */
  show(commit: string, path: RelPath, repo?: RelPath): Promise<DiffEntry>
  /** 提交详情：提交说明 + 改动的文件清单。 */
  showCommit(commit: string, repo?: RelPath): Promise<CommitDetail>
  /** 该提交下这个文件的**内容**（不是 diff）；`size` 超过 8 MiB 时 `truncated`。 */
  blob(commit: string, path: RelPath, repo?: RelPath): Promise<BlobResult>
}
```

规则：

- **存在性（v0.10）**：`onMount` 时**发现**挂载里的全部仓库——向下走查（深度由
  `[git] maxDepth` 决定，默认 3；`[git] ignore` 剪枝，缺省用挂载的 `ignore`），加上
  `git rev-parse --show-toplevel` 找到的**包含**挂载的那个仓库（挂载是它的子目录时）。
  一个仓库都没有，或机器上没有 `git` → 该 mount **不 provide `git`**，日志一条原因
  （`[mount:<id>] git: …`）。
- **仓库之间不重叠**：外层仓库的 `status` / `diff` / `showCommit` **不报**嵌套在它里面的仓库的
  文件（对它是未跟踪目录或 submodule），那些文件由内层仓库自己报。所以
  `status()` 的并集没有重复，`repo` 字段指明每一行属于谁。
- **多仓库时的基准**：`repo` 缺省是「挂载自己的仓库」——仓库根正好是挂载根，或者仓库**包含**
  挂载根；都没有时是发现到的第一个。给了 `path` 的调用由路径决定仓库（最深的那个），不需要
  `repo`。
- **路径基准**一律是**相对挂载根**的 `RelPath`，与 §3.1 相同：绝对路径、`..` 越界、NUL →
  `EINVAL` / `EOUTSIDE`；路径不在仓库内 → `EOUTSIDE`。服务端自行换算成仓库内路径。
- **只读**：只运行只读的子命令（`status` / `diff` / `log` / `show` / `cat-file` / `rev-parse`），
  带 `--no-color`、不写 index、不碰工作区。仓库发现**不调用 git**：只看目录项里有没有
  `.git`（目录或 gitfile），或裸仓库的 `HEAD` + `objects` + `refs`。
- **上限**（单次调用的累计量，超限检查在返回前）：`diff()` 4 MiB / 2000 行，超出部分不进
  `entries`，`truncated: true`；单个文件的 diff 超限时那一项 `truncated: true`。`log().limit`
  默认 50、上限 500（`EINVAL`）。超限**不**报 `ETOOLARGE`——列表场景要的是前缀而不是失败。
- **错误码**是方法契约（沿用 §3.1 的码，外加两个）：

  | 码 | 含义 |
  |---|---|
  | `EINVAL` | 路径非法、`base` 不是 `'HEAD'` / `'index'` / 可解析的提交、提交号非法、`limit` 越界 |
  | `ENOENT` | 文件不存在且不在任何变更里；`show` / `blob` / `showCommit` 的提交或路径在该提交下不存在 |
  | `EOUTSIDE` | 路径越出挂载根或不在仓库内 |
  | `ENOTREPO` | 服务在，但那个仓库已经不可用（目录被移走）；或 `repo` 不是这个挂载里的仓库 |
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
- **一个提交都还没有的仓库（v0.19，`git init` 之后还没 commit）**：这是**状态，不是故障**。
  git 在这种「unborn 分支」上 `log` 直接失败（`fatal: your current branch 'master' does not have
  any commits yet`）、`diff HEAD` 也失败（`fatal: bad revision 'HEAD'`），所以服务端**先问一句
  `rev-parse --verify HEAD^{commit}`**，再按状态作答：
  - `log()` → `[]`（没有历史）；
  - `diff({ base: 'HEAD' })` → 每个变更都是 `kind: 'added'` 且**没有 `text`**（工作区没有可比较
    的对象；渲染器照「未跟踪文件」那条路读文件本身）；
  - `diff({ base: 'index' })` → 照常可用：index 对**空树**，也就是「我暂存了什么」；
  - `show` / `showCommit` / `blob` 带 `HEAD` → `ENOENT`（确实没有这个提交）。
  这几个答案都**不**报 `EIO`。
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

- **`ctx.tree`（v0.17 补 `reveal`）**：导航状态由 `file-tree` 提供（§5.2）。

  ```ts
  interface TreeSnapshot {
    expanded: readonly RelPath[]        // 展开的目录
    selected: RelPath | undefined       // 选中的文件（与 tab 无关，树自己的）
    reveal: { path: RelPath; at: number } | undefined   // 最近一次「定位」请求（v0.17）
  }

  interface TreeService {
    select(file: FileInfo): void       // 选中并通知 onSelect（tabs 借此打开）
    toggle(path: RelPath): void
    isExpanded(path: RelPath): boolean
    reveal(path: RelPath): void        // 展开沿路目录 + 递增 at；不选中、不打开（v0.17）
    onSelect(listener: (file: FileInfo) => void): () => void
    getSnapshot(): TreeSnapshot        // 不可变，仅变化时替换
    subscribe(listener: () => void): () => void
  }
  ```

  `reveal` **只改状态**：把 `path` 的每一级祖先加进 `expanded`（已有的不重复、也不收起任何目录），
  再写一个新的 `at`。把那一行滚进视野、标一下，是视图自己的事（它才知道自己的列表怎么滚）。
  `at` 单调递增：同一个路径连按两次是两次请求，快照因此变化（§35）。

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
  /** 读者此刻按住的修饰键（v0.15）：按住时页面显示各控件的快捷键。 */
  hints?: 'mod' | 'alt'
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
  /** 该命令**第一条**绑定：键记法与可读文本（v0.15，控件显示自己的快捷键用）。 */
  bindingFor(id: string): KeybindingInfo | undefined
  /** bindingFor 的可读那半（`⌘⌥W`），或 undefined。 */
  hintFor(id: string): string | undefined
}

/** 快照里的一条绑定（v0.15 起带 `label`）。 */
interface KeybindingInfo {
  keys: string        // 规范键记法（mod+alt+w），匹配与测试用
  label: string       // 给人看的文本（⌘⌥W / Ctrl+Alt+W），芯片显示用
  command: string
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
| 浏览器保留键 | 拦不住（`mod+w`、`mod+t`、`mod+1..9`…）。**键位与 IDE 对齐，不和浏览器争**（v0.16，§31）：`mod+w` 关 tab、`mod+1..9` 按序号跳——浏览器先吃掉时页面收不到，读者还有点击与循环键，但键位本身是肌肉记忆里的那个。`ctrl+tab` / `ctrl+shift+tab` 浏览器会交给页面，绑“到边界不动”；`mod+shift+[ / ]` 绑“循环切换”（记法按**键帽**写：`shift+[` 按下时报 `{`，`matchesKeys` 认得，v0.16） |
| 快捷键提示（v0.15，v0.16 收紧） | 读者**按住** ⌘ / Ctrl 或 Option / Alt 时，**关键**快捷键以**浮层标签**显示：只显示 tab 条的 `⌘1…`（按序号跳）与侧栏切换器的 `⌘⌥1…`；关闭按钮、收起按钮这类辅助键**不显示**（那是 `?` 速查表的事）。浮层**不参与布局**——出现与消失不改变控件的大小、位置，也不推挤任何东西（cmux 的做法）。状态在**页面全局** `__diorama_keys__`（内核唯一的 keydown 监听器维护），组件用 `diorama-ui` 的 `useHeldModifier` + `KeyHint` 读；文本来自注册表快照的 `label`，**不自己拼键记法**。命令的 `when` 也可以看 `CommandContext.hints` |
| 键记法 → 文本只有一份 | `formatKeys`（`diorama-kernel/client`）是唯一的翻译表：速查表与页面上的芯片都读它（v0.15 前速查表自带一份，已删） |
| palette | 是插件（`requires: ['layout']`、`inject: ['commands']`），注册在 `layout.overlay`（v0.7 起是 **list**）上；打开时把按键交还给它（输入框内的按键不当作快捷键）。**默认只列可执行的命令**（不灰显），`Esc` 关闭，`Enter` 执行。**有快捷键的行右侧显示它**（v0.17）：多个键并列，文本来自注册表快照的 `label`；没有绑定的命令不占位 |
| 快捷键说明（`help`，v0.7） | 同样是 `layout.overlay` 的条目。列出**全部**绑定，当前不可执行的**灰显而不隐藏**（与 palette 相反：速查表回答“有哪些键”，不是“现在能用哪些”）。`?` 开/关（键记法写 `shift+?`），`Esc` 关闭（`help.close`，`when` = 说明开着） |
| 覆盖层互斥（v0.7） | `layout.overlay` 是 **list** 座位，但同一时刻只有一个覆盖层是“开着”的：开一个即关掉另一个。状态在**页面全局**（`diorama-ui` 的 `overlayStore`），不是内核服务——这是页面 UI 状态 |
| 执行失败 | `run` 的 Promise 拒绝 → 控制台报错 + `warn`，不冒泡到按键处理（一次失败不拖垮页面） |
| 生命周期 | `register` / `bind` 返回 disposer；注册属于**页面级**（一个页面一棵 client 树，§11），卸载即撤销 |
| O8 | “开关型”交互（如自动刷新开关）用命令实现，v1 不做用户自定义快捷键 |

**内核内置命令（`m2` 最小集合，每个都有 e2e）：**

| id | 标题 | 快捷键 | when |
|---|---|---|---|
| `tabs.close` | 关闭当前标签页 | `mod+w`（v0.16；v0.15 曾用 `mod+alt+w`） | 有活动 tab |
| `tabs.next` | 下一个标签页（循环） | `mod+shift+]`（v0.16） | tab 数 > 1 |
| `tabs.prev` | 上一个标签页（循环） | `mod+shift+[`（v0.16） | tab 数 > 1 |
| `tabs.nextEdge` | 下一个标签页（到末尾停） | `ctrl+tab` | tab 数 > 1 |
| `tabs.prevEdge` | 上一个标签页（到开头停） | `ctrl+shift+tab` | tab 数 > 1 |
| `tabs.select:<n>` | 第 n 个标签页 | `mod+<n>`（n = 1…9，v0.16；v0.15 曾用 `alt+<n>`） | tab 数 ≥ n |
| `tree.focus` | 聚焦文件树 | `mod+alt+f` | 焦点不在树 |
| `tree.revealActive` | 定位到正在浏览的文件 | `mod+shift+l` | 有活动 tab（v0.17，§35） |
| `file.download` | 文件：下载 | 无（palette） | 有活动 tab（v0.18，§36） |
| `file.copyLink` | 文件：复制链接 | 无（palette） | 有活动 tab（v0.18，§36） |
| `file.openInWindow` | 文件：独立浏览器窗口打开 | 无（palette） | 有活动 tab（v0.18，§36） |
| `palette.toggle` | 打开命令面板 | `mod+k` | 焦点不在输入框 |
| `view.refresh` | 重新读取当前文件 | `mod+alt+r` | 有活动 tab |
| `view.toggleLineNumbers` | 显示 / 隐藏行号 | 无（palette、渲染器头部按钮） | 总可执行（v0.19，§39） |
| `palette.goToLine` | 跳转到行… | `shift+;`（⇧; 打出 `:`） | 焦点不在输入框（v0.19，§39） |
| `view.toggleAutoRefresh` | 自动刷新：开 / 关 | 无（palette） | 有活动 tab |
| `sidebar.showFiles` | 侧栏：文件 | `mod+alt+1` | 侧栏有视图 |
| `sidebar.showChanges` | 侧栏：变更 | `mod+alt+2` | 侧栏有该视图 |
| `sidebar.showHistory` | 侧栏：历史 | `mod+alt+3` | 侧栏有该视图 |
| `sidebar.toggleFolded` | 侧栏：收起 / 展开 | `mod+b` | 侧栏有视图（v0.13） |
| `help.toggle` | 快捷键说明 | `shift+?` | 焦点不在输入框（v0.7） |
| `help.close` | 关闭快捷键说明 | `escape` | 说明开着（v0.7） |
| `theme.cycle` | 主题：跟随系统 / 亮色 / 暗色 | `mod+alt+t` | 总可执行（v0.9） |
| `theme.useSystem` | 主题：跟随系统 | 无（palette） | 总可执行（v0.9） |
| `theme.useLight` | 主题：亮色 | 无（palette） | 总可执行（v0.9） |
| `theme.useDark` | 主题：暗色 | 无（palette） | 总可执行（v0.9） |
| `theme.use:<id>` | 主题：**`<title>`**（`<id>` 的已注册主题） | 无（palette） | 该主题已注册（v0.9） |

命令的**来源插件**决定注册点：`tabs.*` 由 tabs 插件注册、`tree.*` 由 file-tree 注册（含
`tree.revealActive`，它是文件视图工具栏那颗按钮的同一条命令）、
`palette.toggle` 由 palette 注册、`help.*` 由 help 注册、`view.*` 由 renderer-registry 注册（它持有
文件内容缓存）、`sidebar.*` 由 layout 注册（它持有切换器的当前视图，§5.2）、`theme.*` 由 theme
piece 注册（它只注册命令；**状态**在内核的 `ctx.theme`，§3.10）。第三方主题的 `theme.use:<id>`
也是 theme piece 注册的——主题是注册表数据，piece 把注册表同步成命令，注册主题的插件不写任何 UI。

`sidebar.show*` 是**固定三条**命令，不是“每个视图自动一条”：`layout` 只认识 `files` / `changes` /
`history` 三个 id（与它画切换器时用的顺序一致）。新增视图**不自动获得快捷键**；要给它一条命令，
就在注册视图的那个插件里注册（命令 id 用 `<插件id>:<命令>`，开头一条规则）。
`sidebar.toggleFolded`（v0.13）不是「第四条视图命令」：它收起的是**整栏**（视图面板），与选哪个视图
正交，所以只有一个 id、一条绑定；它的 `when` 是「侧栏有视图」（没有视图时整栏都不画，也就没有可收起的）。

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
| **hash** | **插件可写的通用键值面**。跟文件相关的视图写**标记**（`#diff`，无值）；跟文件无关的状态（主题、搜索词）写在根页面（`/#theme=dark`）。内核不知道 `diff` 是什么意思；
`theme` 是 §3.10 保留给自己的 hash 键 |
| 保留前缀 | **`/~/`**（页面）与 **`/~raw~/`**（原件字节，§4）。其余任何路径（`/plugin.json`、`/assets/`、`/plugins/`、`/__diorama__/`）都不被路由解释；以后新增的服务端路由也不会与它相撞。两条前缀不会互相吞掉：`/~raw~/` 的第三个字符是 `r`，`/~/` 的第三个字符是 `~` |
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
  （页面全局 `__diorama_reveal__`）传递：结果列表 `reveal(path, line, { endLine?, flash? })`，
  渲染器画出并滚动到那一行。这是页面 UI 状态，不是内核服务——与 `overlay`（§5）、
  `__diorama_layout__` 同一条规则。
  - v0.19（§39）：目标是**区间**（`line`…`endLine`，闭区间），`flash: true` 表示「带一下就走」
    （跳转到行），缺省是搜索命中的**常驻**带。渲染器把它**夹进文件**（`:999` 落在末行），
    所以 `code` / `plaintext` 的 `useRevealLine(path, focus, count)` 多一个行数。
- **插件与服务的 id 分开**：服务 id 是 `search`（内核 server 半边，每个 mount 都提供）；
  客户端 piece 是 `search-view`（侧栏「搜索」视图 + `mod+p` 快速打开覆盖层），同 `git` /
  `git-changes` 的拆分。

### 3.10 `ctx.theme`（client）✅ v0.9 定

页面的配色方案：跟随系统、指定亮色 / 暗色，以及**第三方插件注册主题**的入口。像 `ctx.commands`
与 `ctx.router` 一样是**内核内置**（注入到页面的 root ctx），不是可选插件的服务：一个不能跟随
系统、记不住选择、又挡不住白屏闪烁的页面，不是插件该修的事。

```ts
type ThemeScheme = 'light' | 'dark'

/** 第三方主题：一组 CSS 自定义属性，叠在样式表定义的调色板之上。 */
interface ThemeDefinition {
  /** 全局唯一；`[A-Za-z0-9_.-]+`（它同时是 hash 值与命令 id 的一部分），建议带插件前缀。 */
  readonly id: string
  /** 展示名（palette 行、诊断信息）。 */
  readonly title: string
  /** 该主题所属的配色；选中它即锁定这个 scheme。 */
  readonly scheme: ThemeScheme
  /**
   * 选中时写到 `<html>` 上的自定义属性，如 `{ '--dio-bg': '#101418' }`。
   * **只收 `--` 开头的键**（其余键被忽略）：主题是数据，不是 CSS 文件——
   * 它只能重新着色，改不了布局。缺省的键沿用样式表里该 scheme 的值。
   */
  readonly tokens: Readonly<Record<string, string>>
  /** 主题清单里的顺序（palette 行的次序），缺省 100。 */
  readonly order?: number
}

interface ThemeSnapshot {
  /** `'system' | 'light' | 'dark'`，或某个已注册主题的 id。 */
  preference: string
  /** 当前正在用的 scheme（`system` 与主题解析之后的结果）。 */
  scheme: ThemeScheme
  /** 当前生效的第三方主题 id；未启用主题时为 `undefined`。 */
  theme: string | undefined
}

interface ThemeService {
  getSnapshot(): ThemeSnapshot                            // 不可变，仅变化时替换
  subscribe(listener: () => void): () => void
  /** 设定偏好；`'system'` / `'light'` / `'dark'` / 已注册主题的 id。 */
  set(preference: string): void
  /** system → light → dark → system（在某个主题上时，下一步回到 `system`）。 */
  cycle(): string
  /** 注册一个主题；返回 disposer，注销时恢复。id 重复 **抛错**（fail loud）。 */
  register(definition: ThemeDefinition): () => void
  /** 已注册主题，按 `order` 再按 `id` 排序。 */
  themes(): readonly ThemeDefinition[]
  has(id: string): boolean
  /** 主题注册表变化（有主题出现 / 消失）时通知。 */
  subscribeThemes(listener: () => void): () => void
}
```

**规则：**

- **默认 `system`**：跟随 `prefers-color-scheme`，**操作系统切换时页面实时重绘**（`matchMedia`
  的 `change` 事件），不需要刷新。`light` / `dark` 是**锁定**：锁定的 scheme 不随系统变。
- **三处状态，一个来源**：
  - `localStorage` 键 **`diorama.theme`** 记住**读者的选择**（没选过时**不存在**，不是
    `"system"`——记住的默认值会盖住之后改的配置）；**`diorama.theme.scheme`** 记住它解析出的
    scheme（主题锁定的 scheme 也在这里，`[ui] theme` 解析出的也算），页面壳（`index.html`）
    在**首帧之前**读后者写 `data-scheme`——没有它暗色页面每次刷新都白闪。两个键与
    `resolveTheme` 的判定规则在 `packages/kernel/src/client/theme.ts`，壳里的脚本必须与它
    保持一致。
  - URL hash 键 **`theme`**（§3.8 的通用键值面）让选择可分享：`/#theme=dark`、
    `/#theme=<主题id>`。`system` 是**没有这个键**（不写 `#theme=system`）。hash 变化
    （前进 / 后退、手工改 URL）同样驱动页面。
  - `<html>` 的 **`data-scheme="light|dark"`** 与 **`data-theme="<id>"`** 是 CSS 看到的面；
    主题的 tokens 以内联 `style` 写在 `<html>` 上（切换主题时清掉上一主题的）。
- **优先级**：boot 时 hash > storage > **`[ui] theme`**（§4.1）> `system`；运行中最后一次
  `set()` 赢。前三者是同一份偏好的三个来源，`[ui] theme` 是配置给的**起点**：读者没选过、
  URL 也没说时用它，读者一选（palette、`mod+alt+t`、分享的链接）就归读者，改文件也不再动他。
  页面壳的首帧：服务端把 `light` / `dark` 的 `[ui] theme` 以 `window.__diorama_theme__` 注入
  `index.html`（它同时持有文件与配置，壳没有第二个途径）；**主题 id 不注入**——壳不知道一个
  主题属于哪个 scheme，那种页面首帧跟随系统、服务启动后由 `ctx.theme` 重绘一次。
- **主题是注册表项，不是文件**：任何插件 `ctx.theme.register({ id, title, scheme, tokens })`
  即可；id 重复抛错（与 `ctx.slots` / `ctx.commands` 的全局 id 同一条规则）。**偏好可以走在
  注册前面**：`set('night-owl')` 时该主题还没注册，页面先跟随系统并 `warn` 一次，主题注册后
  立即生效——palette 与覆盖层都是后到的。
- **第三方主题只是重新着色**：tokens 只收自定义属性（`--dio-*`），且只覆盖**样式表里声明过的**
  token 才有意义。样式表（`diorama-ui/styles.css`）持有 light / dark 两套调色板：
  `:root` 是 light，`:root[data-scheme='dark']` 覆盖之，主题再覆盖在两者之上。
  **新增 token = 在 light 与 dark 两处一起加**。
- **内置 UI 走 palette**：内置 piece `theme`（§5 内置插件表）注册 `theme.cycle`
  （`mod+alt+t`）、`theme.useSystem` / `theme.useLight` / `theme.useDark`，并为**每个已注册
  主题**各注册一条 `theme.use:<id>`——第三方主题不写任何 UI 就有 palette 行；主题注销时命令
  一并注销。去掉 `theme` piece 只是没有命令与快捷键，跟随系统与第三方主题照常工作。
- **纯客户端**：不经过 RPC，不落盘到 `$DIORAMA_HOME`（页面各自的浏览器存储即所见即所得；
  `ctx.storage`（K14）落地后可以讨论服务端同步，签名未定之前不动）。

## 4. RPC / 通信 ✅ v0.2 定 / v0.3 补事件 session 与 §4.1 配置 / v0.11 补存活与重连

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
{ type: 'ping' }                                        // v0.11：保活，服务端回 pong
// server → client
{ type: 'result', id: number, value: unknown }          // 二进制值以 base64 呈现（见下）
{ type: 'error', id: number, code: string, message: string }
{ type: 'event', topic: string, payload: unknown, session?: string }
{ type: 'pong' }                                        // v0.11：保活的回答
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

**存活与重连（v0.11 定，M16 实现）**

页面是长时间开着的，网络会断——断网、睡眠唤醒、VPN 切换。这条通道因此必须自己活下去：

- **断线自动重连**：socket 关闭后客户端持续拨号，指数退避 **500ms → 10s**，不设次数上限。
  断线**期间**发起的新调用立刻以 `EDISCONNECTED` 拒绝（**不排队**：排队会让一次写盘在几分钟后
  突然生效）；`RpcClient.ready()` 指向**当前**那次拨号，断线期间 reject，重连后重新 resolve。
- **保活帧**：client → server `{ type: 'ping' }`，server → client `{ type: 'pong' }`。
  两端都要探测——**断网不会触发 `onclose`**，只等它要几分钟：
  - 客户端每 **5s** 发一帧 `ping`；**20s** 没收到任何帧即判定连接已死，主动关闭并重连。
  - 服务端每 **15s** 对每条连接发 WebSocket ping；连续两轮无 pong 即 `terminate()`，
    并按「连接关闭」取消该连接的全部订阅（否则断网页面留下的 socket 会一直占着 OS watcher）。
  - `ping` / `pong` 是协议层的事：`ping` 由服务端直接应答，不进 `describe()`、不碰任何服务。
- **订阅端点的重放**：连接关闭 = 该连接的订阅全部取消（见上），所以客户端必须重订。
  这一步由**通道**负责：`RpcClient.watchEndpoint(method, args, listener)` 登记一个订阅端点，
  重连成功后自动重放（**先重放订阅，再通知**），返回的 disposer 撤掉登记并在活连接上发
  `{ type: 'cancel' }`。`ctx.fs.watch`（§3.1）就是它的第一个用户，签名不变。
- **`RpcClient.onReconnect(listener)`**：重连成功时回调（**首次连接不算**，除非第一次就连了
  两次以上）。只重订阅是不够的——断网期间磁盘上的改动**没有事件**，所以每个把服务端状态派生
  到界面的读者（文件树、内容区、变更视图、页面壳的降级状态）都要在此时重读一次。

**与 M0 的关系**：M0 的 `GET /api/fs/list`、`/api/fs/read` **删除**。`/plugin.json`、`/plugins/<id>.js`、`/__diorama__/*` 仍是 HTTP。

**插件自己的运行时文件（v0.12，§27）**：`GET /plugins/<id>/<path>` 从**该插件半边所在的目录**
取文件（同一个 `/plugins/` 前缀，所以保留前缀表（§3.8）不变）。用途是体积大、又必须作为独立文件
存在的库：KaTeX 的样式表要能找到它旁边的 20 个字体，Mermaid 是一个 3.5 MB 的自足包。约束与
`client.cjs` 相同——只能取半边所在目录之下的文件（`..` 越界是 403），`<id>` 必须在本次 boot 图里。
发布形态下 `scripts/assemble-package.mjs` 把插件的 `lib/vendor/` 一起带进 CLI 包。

**挂载的原件字节（v0.18，§36）：`GET /~raw~/<RelPath>`**

`/~/` 是「页面怎么显示这个文件」，`/~raw~/` 是「这个文件本身」。**一个 URL 服务三个动作**——
下载、复制链接、在新窗口里打开——所以路径里命名的是**资源**，动作只在查询串里：

| 请求 | 回答 |
|---|---|
| `GET /~raw~/<RelPath>` | 200，`content-type: rawContentType(path)`，**`inline`**（不发 `content-disposition`） |
| `GET /~raw~/<RelPath>?download=1` | 200，同样的类型，另加 `content-disposition: attachment; filename="…"; filename*=UTF-8''…` |
| `HEAD`（两种） | 只回头，不吐体 |

规则：

- **媒体类型按文件类型**，就是内核那张表（`mimeOf`，§5.1）：`.png` 浏览器显示，`.zip` 浏览器保存，
  `.html` 浏览器渲染。**默认 inline**：只有 `?download=1` 才要求保存。
- **文本类型带 `charset=utf-8`**（`rawContentType` = `mimeOf` + 文本类的 charset）：`text/*` 与
  JSON / XML 家族。没有它浏览器**自己猜**编码（多数是 windows-1252），UTF-8 的中文在新窗口里就是
  乱码——而 diorama 自己按 UTF-8 读同一个文件（`fs.readText`），两边必须说同一件事。
  媒体类型（图片、音视频、字体、PDF、wasm）**不带参数**。
- **源码是文本**：各语言源码、配置、点文件（`.gitignore`）都归 `text/*`，所以浏览器**显示**它们，
  不是下载。**没有扩展名的文件按名字认**（`Makefile`、`Dockerfile`、`LICENSE`、`README`、`Gemfile`…）；
  只有扩展名与名字都认不出来的才是 `application/octet-stream`（一个诚实的「我不知道」）。
- **路径校验与 `ctx.fs` 是同一份**：`resolveInside`（§3.1）——绝对路径 / NUL → `EINVAL`(400)，
  `..` 越界 → `EOUTSIDE`(403)，不存在 → `ENOENT`(404)，是目录 → `EISDIR`(400)，
  解码失败 → `EBADPATH`(400)。
- **`ignore` 不影响它**：隐藏规则只作用于 `list`（§3.1），`stat` / `readText` 一直按显式路径可达，
  这条路由同样如此。
- **没有大小上限**，与 `fs.readBytes` 的 `MAX_BINARY_BYTES`（32 MiB）有意不同：字节流式给浏览器，
  进度与落盘都是它的事。
- 恒定头：`content-length`、`x-content-type-options: nosniff`、`cache-control: no-cache` 与
  `etag`（`mtime` + `size`，文件会变，重新验证比 `no-store` 省）。
- **它是原件，不是安全边界**：`/~raw~/x.html` 会在**本站 origin** 上执行页面脚本，因此能读到本站
  `localStorage`、也能调 `/__diorama__/rpc` 读整个挂载目录。这是读者对自己的文件、在本机上按下的
  动作（与 `file://` 打开本地 HTML 同级），**接受**；要收紧只需给这条路由加
  `content-security-policy: sandbox`，不动 `content-type`，也不影响图片与 PDF。
- 三个动作的客户端部分见 §36；纯函数（`encodeRawPath` / `rawUrl` / `contentDisposition` /
  `rawContentType` / `RAW_PREFIX`）在 `diorama-kernel` 的两个入口都导出。

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

[git]
maxDepth = 3                # 向下找仓库的层数（§3.2）；0–64
maxRepos = 32               # 一个挂载最多报多少个仓库；1–4096
# ignore = ["node_modules", "dist"]   # 走查时剪掉的目录；缺省 = 上面的 ignore

[html]
scripts = false             # HTML 预览是否默认执行页面脚本（§5.1）

[ui]
theme = "system"            # 页面没人选过主题时从哪里开始（§3.10）；system / light / dark / 主题 id
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
| `git.maxDepth` | integer 0–64 | `3` | 从挂载根向下找 `.git` 的层数；0 = 只看挂载根（§3.2） |
| `git.maxRepos` | integer 1–4096 | `32` | 一个挂载最多报多少个仓库；到上限时 `repos()` 的 `truncated` 为 true |
| `git.ignore` | string[] | 同 `ignore` | 走查时剪掉的目录；缺省沿用 `ignore`（即 `.git` + `node_modules`） |
| `html.scripts` | boolean | `false` | HTML 预览是否**默认执行**页面脚本（§5.1）；`false` = 逐文件确认后才执行 |
| `ui.theme` | string | `"system"` | 页面**没人选过主题时**的起点（§3.10）：`system` / `light` / `dark` / 某个已注册主题的 id。字符集同 hash 值（`[A-Za-z0-9_.-]+`），否则 fail loud。**是起点不是锁定**：读者选过（命令、快捷键、分享的 `#theme=…`）就以读者的为准 |

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

### 4.2 `diorama config`：读写 `diorama.toml`（`0.0.4` 起）

配置**只有一种格式**（§4.1 的 TOML），也**只有一个读法**（`resolveConfig`）。`config` 子命令是它的
编辑器：读的那一半与 `--dump-config` 是同一段代码，写的那一半把结果重新过一遍 `validateFileConfig`
——**写进去的文件必须是读者会接受的文件**，否则什么都不写、退出码 2。

| 子命令 | 做什么 | 退出码 |
|---|---|---|
| `diorama config` | **交互式**：逐项问 `host` / `port` / `plugins` / `ignore` / `watch.enabled` / `watch.debounceMs` / `watch.maxDirectories` / `html.scripts` / `ui.theme`，然后确认写入 | 0 / 2 |
| `diorama config show [<dir>] [--json]` | 打印 `diorama <dir>` **会用的**配置与来源（与 `--dump-config` 同一合并） | 0 / 2 |
| `diorama config set --<key> <value> …` | 写字段，**文件里其余的行不动**（读-改-写） | 0 / 2 |
| `diorama config unset <key> …` | 删字段（回到默认） | 0 / 2 |

**写到哪个文件**（默认值是安全的那一个）：

| 给了什么 | 写入 |
|---|---|
| 都没给 | `$DIORAMA_HOME/diorama.toml`（全局默认，§4.1 的第 2 顺位） |
| `--dir <dir>` | `<dir>/diorama.toml` |
| `--config <path>` | 就是那个文件（父目录不存在时 `mkdir -p`） |

- **被浏览的目录默认不写**（architecture §8、AGENTS §6）：浏览是只读的，所以「项目级配置」必须由
  用户**点名**（`--dir` / `--config`），而不是从「当前目录」推断。
- **键就是 §4.1 的字段**：`host` / `port` / `plugins` / `ignore` / `watch.enabled` /
  `watch.debounceMs` / `watch.maxDirectories` / `html.scripts` / `ui.theme`。`set` 的拼写是
  `--<key> <value>`；子表的键用点号写全（`--watch.enabled false`、`--ui.theme dark`）。
  未知键是用法错误（列出已知键），不是静默忽略。
- **值的语法**（CLI 与交互式共用一份解析）：`plugins` / `ignore` 是逗号分隔（**空串 = 空数组**，
  所以 `--ignore ""` 就是「不隐藏任何东西」，与 `--all` 同义）；布尔收 `true/false/yes/no/on/off/1/0`；
  整数按 §4.1 的范围校验（`port` 0–65535、`debounceMs` 0–60000、`maxDirectories` 1–4096）；
  `ui.theme` 收 `[A-Za-z0-9_.-]+`（与 §3.10 的 hash 值同一字符集），交互式里给
  `system` / `light` / `dark` 三项候选，**打一个主题 id 也照常收**（主题注册表在页面里，
  CLI 看不见它）。
- **只写选过的字段**：文件里不出现默认值。写出来的键按 §4.1 示例的顺序（`host, port, plugins,
  ignore, [watch], [git], [html], [ui]`），空表不写；`ignore = []` / `plugins = []` 是**显式的
  空数组**，保留（丢掉它会把「显示全部」变回「隐藏 .git」）。所有键都删光 → 文件是空的（0 字节），不是一份默认值快照。
- **交互式**：回车保留、输入值替换、`-` 清除（回到默认）；不合法就重问那一项。最后预览 +
  `write this file? [Y/n]`；**拒绝或 stdin 提前结束都不写**（提前结束是退出码 2，不会留下半个
  文件）。`--dry-run` 只预览；`--yes` 跳过确认。
- **候选（v0.9 后的本档新增）**：`host` / `plugins` / `ignore` / `watch.enabled` 这四项有固定
  候选，交互式里是**编号菜单**；`port` / `watch.debounceMs` / `watch.maxDirectories` **没有候选**
  ——它们收的是数字，`8080` 就是 8080，不会与「第 8080 项」混淆。**候选是提示，不是限制**：任何
  不是列表编号的输入都按字面值走同一条校验。
  - `host` 的候选来自**本机网卡**：`127.0.0.1`（默认）→ `0.0.0.0` → 每个非 internal 的 IPv4
    （标注网卡名）→ `::`（本机有外部 IPv6 时）。**`fe80::` 链路本地不列**：URL 需要 zone id
    （`[fe80::1%en0]`），写进 toml 不可移植。文件里的地址若已不在本机，仍列在最后（标
    `current value`），因为要写什么必须看得见。选了非 loopback 的地址会多一行提醒。
  - `plugins` / `ignore` 是**多选**：编号 = 切换（与屏幕上的 `[x]` 一致），`all` / `none` 是全选 /
    清空，其余文字仍是逗号分隔的字面值。`ignore` 菜单把文件里的自定义 pattern 排在最前面，才能
    被取消勾选。写出的顺序 = 候选顺序（插件即 boot 顺序）。
  - TTY 下菜单可用方向键 + 空格 + 回车，管道下是「打印一次列表 + 读一行」，两套画法同一个语法。
  - 写盘前多一段 `changes:` 摘要（`host: 127.0.0.1 → 0.0.0.0`、`ignore: +dist -*.log`），按
    `mergeConfig` 的结果（读者今天看到的）对比，不是按文件内容对比。
- **写盘**：`mkdir -p` 父目录后整体写（先读旧文件、合并、再写）；读旧文件失败（语法错、未知键）
  就**不写**并报原文——编辑器不替你猜一个坏文件的意思。
- **不重启任何东西**：写配置只改文件。正在跑的 mount 用旧配置，要生效得 `diorama restart <dir>`
  （§11.1 的手动恢复路径）；下一次 `diorama <dir>` 自然读到新文件。
- **失败与展示**：与 §4.1 相同——打印文件名与原因、退出码 2。成功打印 `wrote <path>`。

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

### 5.3 主题 token（v0.9 定，配合 §3.10）

页面里**所有**颜色都是 `diorama-ui/styles.css` 里的一个自定义属性（token）；选择器里不出现
颜色字面量。这是主题能工作的全部前提：

| token | 用途 |
|---|---|
| `--dio-bg` / `--dio-panel` / `--dio-surface-alt` / `--dio-frame-bg` | 页面背景 / 面板（侧栏、tab 条、头部）/ 次级面板（提交正文）/ 预览 iframe 的底色 |
| `--dio-border` / `--dio-border-strong` | 常规分隔线 / 强调分隔线（degraded 横幅） |
| `--dio-text` / `--dio-muted` | 正文 / 弱化文字 |
| `--dio-accent` / `--dio-danger` / `--dio-danger-bg` | 强调（链接、活动态）/ 危险 / 危险底 |
| `--dio-hover` / `--dio-hover-strong` / `--dio-hover-faint` / `--dio-selected` / `--dio-selected-soft` / `--dio-accent-underline` / `--dio-backdrop` / `--dio-shadow` / `--dio-keycap` | 复合表面：行 hover、选中、活动 tab 下划线、覆盖层背板与阴影、键帽 |
| `--dio-syn-comment` / `--dio-syn-keyword` / `--dio-syn-string` / `--dio-syn-number` / `--dio-syn-title` / `--dio-syn-builtin` | 语法高亮六色（`code` piece；diff 的整文件 / 双栏读法用**同一组**，§30） |
| `--dio-added-bg` / `--dio-diff-add-*` / `--dio-diff-del-*` / `--dio-diff-hunk-*` | diff 的加 / 删 / hunk 行（`git-changes`） |
| `--dio-status-modified` / `--dio-status-added` | 变更视图的 M / A 徽标色 |
| `--dio-hit-bg` / `--dio-reveal-bg` / `--dio-reveal-border` | 搜索命中与跳转高亮带（§3.9） |
| `--dio-font` / `--dio-mono` | 字体（不算颜色，同属主题可覆盖的 token） |

规则：

- **light 与 dark 成对**：`:root` 定义 light；`:root[data-scheme='dark']` 整块覆盖。新增 token
  两处一起加，漏掉 dark 会在暗色下掉回 light 的值（CSS 继承不会报错）。
- **主题只覆盖 token**（§3.10）：`--dio-*` 之外的自定义属性照样能写（第三方组件可以用），但
  内置 UI 只认这张表。
- **预览 iframe 不跟主题**：预览的 HTML 是「文件是内容」，默认白底（`--dio-frame-bg`），
  文件自己的样式说了算。

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
- **切换器显示自己的快捷键**（v0.15，v0.16 收紧）：读者按住 ⌘ / Ctrl（或 Option / Alt）时，每个图标**旁边**
  浮出它那条命令的键（`⌘⌥1`…）；收起按钮**不**显示（辅助键归 `?` 速查表，§3.7）。芯片是浮层
  装饰（`aria-hidden`，`position: absolute`，不参与布局），图标的无障碍名仍是视图自己的标题；
  那一竖条 36px 放不下它，所以芯片**浮在图标右侧**、按住期间整栏的 `overflow` 放开。
- **非活动视图隐藏不卸载**（与 `tabs.content` 同一做法）：展开、滚动、选择各自保留。
- **没有视图被注册时，侧栏整栏不画**（M0 验收点 3 的语义，从 `sidebar.tree` 继承）。
- **侧栏可以收起（v0.13）**：切换器脚下有一个「收起 / 展开」按钮（`aria-expanded` / `aria-controls`），
  收起后只剩切换器那一竖条（`SIDEBAR_RAIL_PX`，36px），**视图面板隐藏而不卸载**（与「非活动视图」
  同一条规则：滚动、展开、选择都留着）。三条边界：
  - **收起是读者的偏好，不是"选了哪个视图"**：记在 `localStorage`（`diorama.layout.sidebarFolded`），
    刷新回来还是收起的；切换视图、URL 的 hash 都不改变它。收起**不是**宽度 0——宽度为 0 会把切换器
    一起带走，页面上就没有能展开它的东西了。
  - **收起时没有可拖的边**：没有宽度可拖，`Splitter` 不挂载（而不是隐藏），因此也拿不到焦点。
  - **点视图会展开**：切换器上的图标与 `sidebar.show*` 命令都先展开再切视图（否则按钮改的是
    看不见的面板，读作死键）。收起 / 展开本身是命令 `sidebar.toggleFolded`（`mod+b`，§3.7）。
  - **图标是收起的把手（activity bar 手势）**：点**当前显示中**的那个图标 = 收起整栏；点别的图标 =
    切到那个视图（栏本来就开着，不该顺手收起）。活动图标的 `title` 随状态写明这一手势
    （「再点收起侧栏 / 点击展开侧栏」），无障碍名仍是视图自己的标题。
- `file-tree` 在最前（`order: 10`），git 的「变更」视图 `order: 20`，「历史」视图 `order: 30`
  （v0.6），「搜索」视图 `order: 40`（v0.8，由 `search-view` 注册）。
  这些视图都由各自的 piece 注册，`layout` 不知道它们的含义。
- **图标是页面数据，不是模块导入**（v0.8 起，见 docs/m7/spec.md）：`icon` 仍是普通内联 SVG 字符串，
  但内置 piece 用 `diorama-ui` 的 `iconSvg(name)` 从**页面全局 `__diorama_icons__`** 取形——
  插画由 shell 通过 `diorama-ui/icons` 装一份（否则每个 client 半边都会把插画 bundle 一遍）。
  页面没有装表时（外部宿主、单测）`iconSvg` 返回 `''`，切换器按本节的缺省规则用 title 首字；
  `icon` 字段本身与形状没有任何耦合，外部 piece 可以照旧给任意 SVG。
- **视图里的「一栏选一」用下拉（v0.19）**：一个视图里有若干个并列的对象要**换着看**时（历史视图的
  多个仓库），用一条带原生 `<select>` 的选择行，**一次只画一个**；不要把它们画成同屏并列、可折叠的
  分组。分组把 N 份列表堆在一栏里，读者每换一次仓库都要重新找位置；下拉只换列表本身，头部与位置都不动。
  只有一个对象时**不画**这条行（它只会重复这一栏已经是什么）。选择行画在视图自己的组件里
  （与工具栏、右键菜单同一条分工），`aria-label` 写明选的是什么。**变更视图不受影响**：那里的
  仓库分组是一棵可以同时浏览的树，不是「换着看」的多个对象。
- **视图内部怎么画是视图自己的事**：git 的「变更」把 `status()` 的扁平行折成**目录树**
  （目录优先、单一子目录链合并成一行、展开状态属于该视图，不与文件树共享）。`ctx.git.status()`
  保持扁平（§3.2），折叠由视图完成。
- **列表窗格必须横向可滚（v0.11，docs/m15/spec.md）**：一栏里的列表行按**内容**长
  （`width: max-content; min-width: 100%`），名字元素**不收缩、不省略**；要读全就滚那一栏的
  `overflow: auto`。**任何新视图 / 新列表窗格都照此办理**，不要把长名字截成省略号——截断掉的
  往往正是读者在找的那一段。文件树、变更、历史、搜索、提交座位的文件清单是现有例子。
- **diff 的读法（v0.10 / v0.14）**：`seats.git-diff` 与 `seats.git-commit` 里的同一个 `DiffView`
  给三档读法（「改动」行内 /「整个文件」单栏 /「新旧对照」双栏，§23）。**后两档画的是源码，要按文件的
  语言上色**（§30）：颜色来自 `code` piece 发布到页面的引擎（页面全局 `__diorama_highlight__`），
  六色仍是 `--dio-syn-*`（§5.3）；「改动」那档是 git 自己的文本（`+` 前缀、`@@` 头），**不**上 token 色。
  引擎回答的是**每行一个完整 HTML 片段**（跨行 token 在断行处闭合、下一行重开），因为这两个读法
  一行一行画（折带、行号槽、双栏里一侧留空）。没有引擎时画纯文本，不空白也不报错。
- **可调宽的窗格用同一个原语（v0.11）**：宽度属于读者的偏好，用 `diorama-ui` 的
  `Splitter` + `usePaneSize`（边界 160–720px、`localStorage` 记忆、方向键 / Home / End 可调），
  不要在插件里各写一套指针处理。分隔条**自己占一个网格列**，不压在内容上；拖动期间只写 CSS
  变量，松手才进 React state（否则整栏内容每帧重渲染）。现有的两处是左栏（`layout`）与提交
  座位的文件清单（`git-changes`）。
- **视图可以有自己的工具栏（v0.17）**：一条栏里的视图**各有各的工具栏**，画在该视图面板的顶部
  （`diorama-tree__toolbar` 是第一个例子，§35）。它属于**这个视图**，不是整条侧栏：切换器那一竖条
  仍然只有视图图标与收起按钮，别的视图不受影响；也不用座位——视图的控件就在视图自己的组件里
  （与「一个文件的东西不要扩展到侧边栏」同一条理由，§27）。
  工具栏上的按钮**只作用于视图**（「把这一栏滚到某处」「换个分组方式」），不作用于被读的文件——
  文件自己的开关归渲染器头部（§5.1、O8）。一个动作既是按钮又是命令时，只注册一条命令、按钮调它，
  这样 palette、快捷键与按钮是同一件事（§3.7）。
- **视图可以有自己的右键菜单（v0.18，§36）**：与工具栏同一条分工——画在视图自己的组件里，
  **不开座位**，别的视图不受影响。文件视图的行菜单是第一个例子，菜单项作用于**那一行的文件**
  （下载 / 复制链接 / 在独立窗口打开，三个都指向 §4 的 `/~raw~/`）。三条边界：
  - **只有文件行有菜单**；目录行与视图空白处保留浏览器原生菜单（目录没有「原件字节」）。
  - **右键不改导航状态**：不选中、不开 tab、不动 URL（与 §35「定位不是导航」同一条规矩）。
  - 菜单原语（定位、越界翻转、`Esc` / 点外部 / 滚动关闭、`↑↓` / `Home` / `End` / `Enter`）
    在 `diorama-ui` 的 `ContextMenu` 里，一个视图长第二份就会漂。

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
- `mime` 由内核按扩展名推断（`mimeOf`：文档 / 标记 / 样式 / 数据 / 各语言源码 / 配置 / shell 都是
  `text/*`，媒体（图片、音视频、字体、PDF、wasm）各归其类；**点文件**（`.gitignore`、`.env`）没有扩展名
  但按 `text/plain` 回答；未知才是 `application/octet-stream`）。**表里不带参数**——matcher 比较的是
  `text/plain` 这种裸类型（§5.1），`charset` 由 §4 的原件路由单独加。
- **内置字节渲染器（v0.6）**：`image`（`mime: ['image/*']`）与 `pdf`（`ext: ['pdf']`），两者都先
  `stat` 再 `readBytes`，从 bytes 建 Blob URL 交给浏览器原生的 `<img>` / `<iframe>`；内核**
  不**内联 SVG 的 DOM（`<img>` 渲染 SVG，脚本不执行）。
- **HTML 渲染器（v0.6，`html`）**：`ext: ['html', 'htm']` 的**唯一 owner**（`code` 的 ext 表里
  **没有** `.html` / `.htm`，§5.1 rule 2）。只用预读的 `text`，不发任何请求。**两种显示方式**
  （按钮在渲染器自己的头部，不是工具栏，O8），状态属于渲染器实例（一个 tab 座位一个）：
  1. **预览**（缺省）：
     - **起始阶段由 `[html] scripts` 决定**（§4.1）：`false`（缺省）从**样式阶段**开始，
       `true` 时页面若含脚本就直接从**脚本阶段**开始（等于替读者按了「执行脚本」一次）。
       无论哪种，**提示条都在**，随时可「停止执行」回到样式阶段；没有脚本的页面永远是样式阶段
       （没有可确认的东西）。
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
       「停止执行」。**信任只属于渲染器实例**：换文件、换 tab、刷新页面都回到「`[html] scripts`
       给的起始阶段」，上一份文件的「停止执行」不跟着走。
     - 消毒（样式阶段）用 `WHOLE_DOCUMENT`：DOMPurify 不带它时**只处理 `<body>`**，页面放在 `<head>`
       里的 `<style>` 会被整段丢掉（v0.6 修：这就是「CSS 没加载」）。
  2. **源码**：文件的原文用 `<pre>` 显示（转义为文本，不解释）。没有 `html` 插件时 `.html` 落到兜底
     `plaintext`（普通文本），**不**回到 `code`。
  同一 tab 换成另一个文件时回到**预览**、**起始阶段按 `[html] scripts`**（深链、刷新恢复都是
  “打开一个页面”）。
  **不使用 blob URL**：`srcdoc` 是内联文档，不需要在本站 origin 上开一个 URL。
  边界：**预览会执行读者确认过的页面脚本**——只读承诺覆盖的是 `ctx.fs` / `ctx.git`（本工具从不写
  被浏览的目录），不覆盖页面自身的脚本行为；脚本阶段不携 `allow-same-origin` 正是为了让页面脚本
  够不到本页面。

**渲染器里的链接（`markdown`，`0.0.4` 起；§22）**：Markdown 里的 `href` 是**相对于那个
文件**写的，而页面的 URL 是路由（§3.8）。渲染器**不得**让浏览器跟随它——一次导航就重新 boot 整个
页面，而 tab 集合不在 URL 里（§3.8 只记活动文件，多 tab 恢复是 O5），结果是「点一个链接，别的 tab
全没了」。因此点击由渲染器分类处置：

| `href` | 处置 |
|---|---|
| 本站文件（相对路径、以 `/` 开头的挂载内路径） | `ctx.router.open(path)`（无 router 时 `ctx.tabs.open`）：**开 tab**，不导航 |
| `#fragment` | 本文件内滚动到该标题；`other.md#part` 打开该文件再滚过去 |
| 目录 | 有 `README`/`index`（`.md`/`.mdx`，大小写不敏感）就打开它，否则**什么都不做**（目录不是 tab，§3.4） |
| 别的 origin / 别的 scheme | 新浏览器标签页（`noopener,noreferrer`），当前页面不动 |
| 解出挂载根之外、解码失败、空 `href` | **什么都不做**（与 `EOUTSIDE` 同一个边界，§3.1） |

细则：查询串被丢弃（文件按路径读）；URL 转义**只解码一次**，且解码在越界检查之前；带 ⌘/Ctrl/Shift/Alt
的点击交给浏览器（新标签页、下载是既有语义）；`stat` 失败**不拒绝**（不存在也开 tab，错误由内容区按
§11 说明）。为了让 `#fragment` 有落点，标题渲染时带 `id`（小写、去标点、空格连字符，重名 `-1`/`-2`，
与 GitHub 的约定一致）。其它渲染器不受影响：`html` 的预览在沙箱 iframe 里，`code`/`plaintext` 是纯文本。

**渲染器里的公式与图表（`markdown`，`0.0.4` 起；§27）**：两者都**不在解析时渲染**，
解析只留下**占位元素**，浏览器在**挂载之后**按需加载库再就地替换：

| 源码 | 占位元素 | 库 |
|---|---|---|
| `$x^2$` | `<span class="diorama-math" data-math="inline">`，文本是 TeX | KaTeX |
| `$$…$$`（围栏或单行） | `<div class="diorama-math" data-math="block">` | KaTeX |
| ```mermaid 围栏 | `<div class="diorama-mermaid" data-mermaid="">`，内含 `<pre><code>` 的源码 | Mermaid |

- **源码是文本，不是属性**。DOMPurify 会删掉值里含 `-->` / `]>` 的属性（XML 重解析风险），
  而每张 Mermaid 图都有箭头——第一版把它放在 `data-source` 里，结果每张图都渲染成空串。
- **按需加载**：文档里没有公式、没有 `mermaid` 围栏时，两个库**一个字节都不下载**。库文件是插件
  自己的运行时文件，走 `/plugins/<id>/<path>`（见 §4），不进 `client.cjs`（一个半边是一个自足的
  闭包，进包就是每次打开页面都付这份钱）。
- **失败不白屏**：公式渲染失败留 TeX 文本；图渲染失败留源码 + 一条 `title` 提示。都不弹窗。
- **主题**：Mermaid 把颜色画进 SVG，`data-scheme` 变化时重画；KaTeX 只读页面 token。
- **大纲属于文档，不属于页面**（`outline`）：标题的 `id` 本来就为 `#fragment` 生成，同一份列表
  被画成**文章旁边的一栏目录**，在这篇文章自己的 tab 里（`.diorama-markdown-body`）。它**不是**
  左栏的一个视图——一个文件的标题不是关于挂载的事实，而左栏由所有 tab 共用。**标题少于两条时不画**
  （一条标题就是读者已经看得见的那个题目）。目录里点一行滚到**这一篇**的标题（按文章限定查找，
  不是全文档：每个 tab 的文章都还挂载着，同名 `id` 会撞）。当前小节按滚动位置标记。

## 6. contract version 规则 ✅ v0.2 起强制 / 2026-10-21 改为「只在发版时升」

**契约号跟着发版走，不跟着提交走。** 一次能力落地、一次 `ctx.*` 签名调整、一个 slot 变化，都**不动**
`CONTRACT_VERSION`——它在仓库里是「**上一次发出去的那个版本**」，不是「开发到哪了」。

| 时机 | 做什么 |
|---|---|
| 日常开发（加服务、改签名、加座位、加插件） | **不动**契约号。照常改 `contract.md` 的正文与变更清单（§13 起），把新条款写成当前版本的一部分 |
| **发版**（`npm publish` / 打 tag） | 才升 `CONTRACT_VERSION` + `CONTRACT_RANGE`，并**一次性**把全部内置插件 manifest 的 `contract` 范围升到新值；在变更清单里把「自上次发版以来的条款」归到这一版名下 |
| 发版前的「未发版条款」 | 变更清单里照常记录，但标注它们属于**下一个**版本号；读者据此知道已发布版与仓库 HEAD 的差距 |

- 内核版本 `0.0.x` 期间：**任何改动都可能破环**，插件写窄范围（当前 `>=0.0.7 <0.1.0`）。
  发版时破环 = 升 `0.0.x` 的数字（`0.0.2` → `0.0.3`），契约与全部内置插件一起升。
- **检查时间**：读 manifest 时（加载前）。不满足 → 拒绝加载该插件，并解释原因（终端 + 浏览器控制台）。
- 内置插件同样检查：旧范围的 manifest 会被新内核拒绝，所以**发版时**把全部内置插件一起升到
  当前范围（`0.0.7` 起为 `>=0.0.7 <0.1.0`）。**内核与半边必须一起重新构建**（builtin manifest 与 kernel
  的 `CONTRACT_VERSION` 来自同一份构建）。
- **为什么可以这样**：v1 之外还没有外部插件（§9），仓库里的内核与内置插件永远同一次构建，
  开发期升号只有成本（17 个 manifest 一起改）没有收益；真正需要「拒绝不兼容插件」的时机是
  别人拿到包之后，而那正是发版。
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
| `stop` 时 gateway 未运行 / 目录不在挂载里 | 0（幂等） |
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

**`--json`（`diorama [dir] --json`、`diorama restart <dir> --json`）**：把同一次挂载输出成
**一个** JSON 文档，stdout 只有它（没有人类可读的行），便于其它程序直接取 URL：

```json
{
  "url": "http://127.0.0.1:54321/",
  "root": "/Users/me/proj",
  "mountId": "abc12345",
  "created": true,
  "mount": { "mountId": "abc12345", "root": "/Users/me/proj", "port": 54321, "url": "…", "state": "ok", "since": 1760000000000, "plugins": ["…"], "hidden": [".git", "node_modules"] }
}
```

- `url` / `root` / `mountId` 是顶层便捷键（与 `mount` 里的同名字段**同值**）；`mount` 是 §7.3 的
  `MountStatus` 原文，不再裁剪。`created` 与人类可读形式的 `already mounted` 同义。
- 服务端报了插件故障时另有 `pluginFailures: string`（与人类可读形式的 stderr 行同源）；
  此时退出码仍是 1（§7.6 的表不变）。
- `restart` 另加 `remounted: <旧 mountId> | null`。
- 失败（参数、目录、配置、端口、连不上）照常走 stderr 与对应退出码，**stdout 不输出任何东西**
  ——调用方不会把错误当成一次挂载。
- `--foreground` 可以与 `--json` 同用：文档照常打印在 stdout，进程随后照常**不退出**（§7.5）。
  包一层进程的调用方读第一行即可，子进程的生命周期由它自己管。

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

`diorama stop [dir] [--all] [--json]`——**停止服务一个目录**（不是停 gateway）：

```text
diorama stopped /Users/me/proj
  [mount:abc12345] http://127.0.0.1:54321/
```

- **无参数 = 当前目录**：停掉**包含** `process.cwd()` 的那个挂载（所以在项目里的任何子目录
  `diorama stop` 都停得掉它）。显式给目录时先按 realpath 比，再按 `resolve` 的字符串比
  （目录已被删掉也认得）。
- **包含关系只向上，不向下**：`stop proj` 停 `proj` 自己的挂载；`proj/vendor/lib` 上的挂载
  **不受影响**。反过来 `stop proj/src` 停的是 `proj` 的挂载（挂载嵌套时取**最深**的那个），
  并额外打印一行 `(matched the mount containing <dir>)`。
- **`--all`**：停掉这个 gateway 的**全部**挂载（gateway 进程照旧运行）；一个都没有时打印
  `no mounts to stop`，退出码 0。
- **不匹配不是错误**：打印 `no mount for "<dir>" (run "diorama ls" to see the mounts)` 并列出
  现有挂载，**退出码 0**（与 `gateway stop` 未运行时同一口径）。gateway 未运行时打印
  `gateway is not running (nothing to stop)`，退出码 0。
- **只卸这一个**：走控制面的 `unmount`（§7.3），其它挂载与 gateway 进程都不动；`stop` **不**
  等于 `gateway stop`。要停进程用 `diorama gateway stop`。
- **`--json`**：`{ stopped: [{ mountId, root, url }], target: string | null, all: boolean }`
  （`--all` 时 `target` 是 `null`；一个都没停时 `stopped` 是空数组，退出码仍是 0）。
  部分失败（某个 mount 关不掉）时 stdout 只报**真停掉的**，stderr 逐个报失败的，退出码 1。
- 用法错误（未知选项、给了两个目录、目录与 `--all` 同用）退出码 **2**。

`diorama config …` 的行为与退出码见 §4.2：成功 0，用法错误 / 文件写错 2（`config show` 在目录
不可读时也是 2）。它**不**连 gateway，也不要求 gateway 在跑。

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

## 19. v0.8 → v0.9 变更清单（已计入 `0.0.2`）

> 2026-10-20。用户要求：**实现主题切换（跟随系统或指定暗黑/亮色），并预留第三方插件增加主题的能力**。
>
> **2026-10-21 起 §6 的规则变了**：契约号只在**发版**时升，日常开发不动号。本条是在规则改变之前
> 记下的，已经随 `0.0.2` 定稿；**此后**的条款在发版前一律标注「未发版（下一个 `0.0.x`）」。
> 下一次发版时，自 `0.0.2` 起累积的条款一起归到新号名下。
> 新增 `ctx.theme`（§3.10）是**新增内核服务**，命令表多了五条、内置插件多了一个、样式表从此只认
> token（§5.3）——按 §6 的规则升版。

| 条款 | v0.8 | v0.9 |
|---|---|---|
| §3.10 `ctx.theme` | 无 | 新增内核服务（页面级，不 RPC）：偏好 `system`/`light`/`dark`/主题 id；`register()` 主题注册表；`data-scheme` / `data-theme` 写在 `<html>`；`localStorage`（`diorama.theme`、`diorama.theme.scheme`）+ hash（`#theme=…`）双持久化 |
| §3.10 主题形态 | 无 | 主题 = `{ id, title, scheme, tokens, order? }`，tokens 是**样式表调色板的子集覆盖**（§5.3）；偏好可先于注册（暂跟随系统并 warn，注册即生效） |
| 首帧 | 无 | 页面壳 `index.html` 在样式表生效前读 `diorama.theme.scheme` 写 `data-scheme`（暗色刷新不再白闪）；键与判定规则必须与 `theme.ts` 保持一致 |
| §5.3 token 化 | 颜色字面量散在各选择器 | **全部颜色收敛为 `--dio-*` token**（约 30 个）：light 在 `:root`、dark 在 `:root[data-scheme='dark']`、主题再覆盖其上；第三方主题只覆盖 token |
| §3.7 命令表 | 15 条 | 另加 `theme.cycle`（`mod+alt+t`）、`theme.useSystem` / `theme.useLight` / `theme.useDark`，以及每个已注册主题一条 `theme.use:<id>`，由 `theme` piece 注册 |
| §5 内置插件 | 15 个 | 16 个：新增 `theme`（客户端 piece，只注册命令），进默认清单（§4.1）与 boot 顺序（`help` 之后、`git-changes` 之前） |
| P9（features）/ U12 | 主题明确不做 | **本档推翻**：主题做了；`ctx.storage`（K14）签名仍待定，偏好暂存浏览器 `localStorage` |
| contract version | `0.0.1` / `>=0.0.1 <0.1.0` | `0.0.2` / `>=0.0.2 <0.1.0`（全部内置插件 + kernel 包自己的 manifest） |

**没有变的东西**：slot 清单（无新座位——主题不是 slot，是页面属性）、`ctx.fs` / `ctx.git` /
`ctx.search` / `ctx.router` / `ctx.commands` 的签名、`tabs` 的键、渲染器派发、RPC 与控制面协议。
样式表只把字面量换成同名 token（§5.3），视觉上 light 与 v0.8 一致。

## 20. `0.0.2` 之后：命令行的配置编辑（已计入 `0.0.3`）

> 2026-10-21。用户要求：**支持命令行交互式配置，以及把命令行参数写进配置**。
> 契约号不动（§6）：这一档只**加** CLI 行为，不改 `ctx.*`、slot、RPC 与控制面协议。

| 条款 | `0.0.2` | 本档 |
|---|---|---|
| §4.2（新） | 无 | `diorama config` / `config show` / `config set` / `config unset`：交互式逐项编辑、读-改-写、写前校验、默认写 `$DIORAMA_HOME` |
| §4.2 候选 | 无 | `host` / `plugins` / `ignore` / `watch.enabled` 在交互式里给编号菜单（host 的候选由本机网卡解析，含 `0.0.0.0` 与各外部 IPv4）；数字字段**不给**候选；候选不限制取值 |
| §7.6 | 只有 mount / ls / restart / gateway | 另加 `config` 的退出码与「不连 gateway」 |
| 写盘边界 | `~/.diorama/` 是唯一写盘位置 | 仍以它**为默认**；`--dir` / `--config` 是用户点名的例外（不改变「被浏览的目录永远不写」的默认行为） |
| 内核 | `loadFileConfig` / `mergeConfig` / `validateFileConfig` | 另加 `patchFileConfig` / `formatFileConfig` / `readFileConfig` / `writeFileConfig` / `configWritePath` / `readConfigValue` / `knownKeys`（纯函数，注入式 IO） |

**没有变的东西**：`diorama.toml` 的字段与默认值（§4.1）、优先级（CLI > toml > 默认）、
`EffectiveConfig` 的形状、`/plugin.json` 的下发、控制面 `mount` 的语义。

## 21. `0.0.2` 之后：挂载的 JSON 输出（已计入 `0.0.3`，与 §20 同一档）

> 2026-10-21。用户要求：**加参数控制 diorama 在目录启动后输出 JSON，方便其它程序调用后取 URL**。
> 契约号不动（§6）：只加 CLI 输出形态，不改 `ctx.*`、slot、RPC 与控制面协议。

| 条款 | `0.0.2` | 本档 |
|---|---|---|
| §7.6 `diorama [dir]` 输出 | 五行人类可读文本 | 另加 `--json`：**一个** JSON 文档（顶层 `url` / `root` / `mountId` / `created`，`mount` 为 §7.3 的 `MountStatus` 原文；故障时另有 `pluginFailures`）；默认输出不变 |
| §7.6 `diorama restart <dir>` | 三行文本 | 同样接受 `--json`，另加 `remounted` |
| §7.6 `--json` 的边界 | — | `--foreground` 可同用（打印后照常不退出）；失败时 stdout 为空、照常走 stderr 与退出码 |
| §7.6 退出码表 | 不变 | 不变（`pluginFailures` 仍为 1） |

**没有变的东西**：五行文本（e2e 靠它抓 URL）、`ls --json` 的形状、`diorama.toml`、控制面 `mount`
的语义、`MountStatus` 的字段。`--json` 不新增任何服务端行为——它只是把 gateway 已经回答的
`MountStatus` 原样交给调用方。

## 22. `0.0.2` 之后：Markdown 里的链接留在页面内（已计入 `0.0.3`，与 §20 同一档）

> 2026-10-21。用户报告：**markdown 渲染后，点击其中相对文件的链接，会刷新到新文件，导致其它
> tab 都没了**。契约号不动（§6）：不改 `ctx.*`、slot、RPC 与控制面协议——**`markdown` 这个渲染器
> 如何处置自己画出来的链接**，是 §5.1 里渲染器行为的一部分。

| 条款 | `0.0.2` | 本档 |
|---|---|---|
| §5.1 渲染器里的链接 | 未规定：`href` 原样交给浏览器，相对链接 = 整页导航（重新 boot，tab 只剩一个） | 渲染器分类处置：本站文件**开 tab**（`ctx.router.open`）、`#fragment` 滚动、别的 origin 开新标签页、解出挂载根之外/解码失败/空 `href` **什么都不做**；带修饰键的点击交给浏览器 |
| §5.1 链接解析 | — | 相对**包含它的文件**所在的目录；以 `/` 开头是**挂载根**；查询串丢弃；转义只解码一次，且在越界检查之前 |
| §5.1 目录链接 | — | 有 `README`/`index`（`.md`/`.mdx`）就打开它，否则什么都不做（目录不是 tab，§3.4） |
| §5.1 标题锚点 | 无 `id`，`#section` 是死链 | 标题渲染时带 `id`（小写、去标点、空格连字符、重名 `-1`/`-2`，同 GitHub 的约定） |

**没有变的东西**：`ctx.router` 的 URL 形态与「只记活动文件」（§3.8）、`ctx.tabs` 的键与语义
（§3.4）、`ctx.fs` 的越界规则（§3.1）、DOMPurify 消毒策略、其它渲染器（`html` 在沙箱 iframe、
`code`/`plaintext` 是纯文本）。多 tab 持久化仍是 O5（未做）——本档只是不再**制造**那个问题。

## 23. `0.0.2` 之后：diff 的三种读法与改动间导航（已计入 `0.0.4`）

> 2026-10-22。用户要求：**git diff / 提交详情除了纯 diff 文本，还支持切换到整个文件内容展示
> 变更（单栏，支持展开）与新旧两栏对照（旧栏显示删除、新栏显示新增），并加导航按钮在变更块
> 之间跳转**。契约号不动（§6）：`ctx.git` 的签名、上限与错误码不变（§3.2），`seats.git-diff`
> / `seats.git-commit` 的 props 不变（§5）；变的只是 `git-changes` 这个**渲染方**怎么把同一份
> unified diff 文本画出来。

| 条款 | `0.0.2` | 本档 |
|---|---|---|
| §5.2 diff 的读法 | 只有 unified diff 一行一行着色（「改动」模式） | 另加两档，三个图标按钮切换：「**整个文件**」（单栏）与「**新旧对照**」（双栏，左旧右新、删除在左栏、新增在右栏）：`ctx.fs.readText`（提交座位用 `blob()`）读**一次**文件，改动放进文件自己的行号里；长段未改动行折成一条可展开的横带（点开即展开，不追加任何 RPC） |
| §5.2 双栏对齐 | — | 未改动行两栏取**同一份文本**（本来就是同一行，只是行号不同）；一个变更里的删除与插入按位置配对（`-` 与 `+` 同行，先用完的一侧留空白格）；被删除的行不在当前文件里，取 diff 自己的文本 |
| §5.2 模式的记忆 | — | 浏览器 `localStorage`（`diorama.git.diffMode`），三档对**页面上所有** diff 面生效（工作区 tab 与提交座位是同一份偏好） |
| §5.2 改动间导航 | — | 头部的 ‹ › 按钮（与 ↑ / ↓，焦点在 diff 面内时）：在 `@@` 变更块之间循环移动并滚动到那处；显示「n / 总数」 |
| §5.2 diff 头部 | 徽标、路径、刷新 | 另加 `+a −r` 计数、三个模式图标按钮（带 `aria-label`）、导航组 |
| §5.2 未跟踪文件 | 整文件每行一个 `+` 前缀 | 同样画成**一个 hunk**（`@@ -0,0 +1,n @@`）——三种模式都按 diff 解析，不再有第二条画法 |
| 模式不可用时 | — | 二进制、超限、读取失败的文件保持「改动」模式并说明原因（一行 note），按钮不消失 |

**没有变的东西**：`ctx.git` 全部方法与上限（§3.2）、tab 的 `(path, view)` 键（§3.4）、
`#diff` hash 语义（§3.8）、slot 清单（§5）、主题 token（§5.3 只新增了用现有 token 的选择器）。

## 24. `0.0.2` 之后：一个目录里的多个仓库（已计入 `0.0.4`，与 §23 同一档）

> 2026-10-22。用户要求：**支持目录下多 git 仓库**——并列的多个仓库，以及外层仓库里嵌套的
> 仓库；向下扫描 `.git`，跳过 `node_modules`（可配置其它忽略目录）；变更视图按仓库**分组**，
> 分组可折叠。契约号不动（§6）：`ctx.git` 的方法名不变，只加一个 `repos()` 与可选的
> `repo` 参数。
>
> 同日修复：历史视图点开子目录仓库里的提交报 `ENOENT: no such commit`——提交座位拿不到
> 仓库，`showCommit` / `show` / `blob` 都落回了「挂载自己的仓库」。见下表最后两行。

| 条款 | `0.0.2` | 本档 |
|---|---|---|
| §3.2 存在性 | 一个 mount = 一个仓库（`rev-parse` 探测）；不是仓库就不 provide | 一个 mount = **它里面的全部仓库**（向下走查 + `rev-parse` 找包含它的仓库）；**一个都没有**才不 provide |
| §3.2 新方法 | — | `repos(): GitRepoInfo[]`（浅的在前，`{ path, truncated? }`） |
| §3.2 方法参数 | `status()` / `diff(scope)` / `log(options)` / `show(commit, path)` / `showCommit(commit)` / `blob(commit, path)` | 各加可选 `repo`（`status(repo?)`、`DiffScope.repo`、`log({repo?})`、`show(commit, path, repo?)`、`showCommit(commit, repo?)`、`blob(commit, path, repo?)`）；缺省 = 挂载自己的仓库，给了 `path` 时由路径决定 |
| §3.2 返回值 | `GitStatusEntry` / `DiffEntry` / `CommitDetail` 不带仓库 | 各加可选 `repo`（`''` = 挂载根的那个），调用方据此分组 |
| §3.2 仓库之间 | — | 外层仓库**不报**嵌套在它里面的仓库的文件；`status()` 的并集不重复 |
| §4.1 `diorama.toml` | `host` / `port` / `plugins` / `ignore` / `watch` | 新增 `[git]`：`maxDepth`（默认 **3**，0–64）、`maxRepos`（默认 32，1–4096）、`ignore`（缺省用挂载的 `ignore`，即 `.git` + `node_modules`） |
| §5.2 变更视图 | 一个平铺的改动树 | **按仓库分组**，组头可折叠；只有一个仓库（且就是挂载根）时不出组头 |
| §5.2 历史视图 | 一个提交列表 | 同样按仓库分组、可折叠（**后被 §37 取代**：改成下拉切换，一次一个仓库） |
| §5 `CommitSeatProps` | `{ commit }` | 加可选 `repo`（缺省 = 挂载自己的仓库，即 v0.10 之前的唯一含义） |
| §3.8 `#history` 的值 | 提交 sha | `<repo>:<sha>`（仓库在挂载根之下时）或裸 sha（挂载自己的仓库）；仓库路径不含 `:`，第一个 `:` 是分隔符 |

**没有变的东西**：`ctx.git` 的只读性、路径基准（相对挂载根）、上限（4 MiB / 2000 行、
`log` 50/500、`blob` 8 MiB）、错误码表、`#diff` / `#history` 的 hash 语义、tab 的
`(path, view)` 键、slot 清单。

## 25. `0.0.2` 之后：可拖动的窗格与看得全的长名字（已计入 `0.0.4`，与 §23 同一档）

> 2026-10-23。用户要求：**文件导航、diff 文件列表、git history 文件列表、commit 列表、搜索结果
> 列表等窗格内容都不支持左右滑动，文件名一长就看不全；窗格也要支持鼠标拉动扩大缩小**，并要求
> **以后实现类似窗格都要支持**。契约号不动（§6）：没有新增服务、没有改 `ctx.*` 与座位签名，
> 变的是**页面怎么画一条栏**（§5.2 的规则）与 `diorama-ui` 的一个原语。

| 条款 | `0.0.2` | 本档 |
|---|---|---|
| §5.2 列表窗格的横向滚动 | 未规定；各行 `width: 100%` + 名字 `text-overflow: ellipsis`，长名字只能看前半截 | 列表行按内容长（`max-content` + `min-width: 100%`）、名字不收缩不省略，窗格自己的 `overflow: auto` 横向滚；**新窗格一律照此办理** |
| §5.2 窗格宽度 | 左栏固定 260px、提交座位的文件清单 `minmax(180px, 260px)`（docs/m4/spec.md §6.4 明写「未做拖拽」） | 两处都可拖：`diorama-ui` 的 `Splitter`（`role="separator"`，指针 + ← → / Home / End）+ `usePaneSize`（160–720px，`localStorage` 记忆） |
| §5.2 拖动时的渲染 | — | 拖动期间只写 CSS 变量（`--dio-sidebar-width` / `--dio-commit-files-width`），松手才进 React state：整栏内容不跟着每帧重渲染 |
| §5.2 偏好记在哪 | 无（宽度是常量） | `localStorage`：`diorama.layout.sidebarWidth`、`diorama.git.commitFilesWidth`（与 `diorama.theme` / `diorama.git.diffMode` 同一口径；`ctx.storage` 仍留给 K14） |
| `diorama-ui` 的导出 | `Slot` / `useKernel` / `overlayStore` / `reveal` / 图标… | 另加 `Splitter`、`usePaneSize`、`clampPane`、`readPaneSize`、`storePaneSize`、`MIN_PANE_PX` / `MAX_PANE_PX` / `PANE_STEP_PX`（**不是**内核服务，是渲染原语） |

**没有变的东西**：`ctx.*` 的全部签名、slot 清单与座位类型、RPC 与控制面协议、`diorama.toml`、
URL / hash 语义、主题 token 表（新样式只用既有 token，无新 token）。

## 26. `0.0.2` 之后：断网之后页面自己接回来（已计入 `0.0.4`，与 §23 同一档）

> 2026-10-23。用户报告：**断网后 websocket 断了，网络重连后没有自动重连**。契约号不动（§6）：
> 没有新增服务、没有改 `ctx.*` 的签名与 slot；变的是 §4 那条 WebSocket 的**存活与重连**语义，
> 以及 `RpcClient` 上多出的 `watchEndpoint` / `onReconnect` / `close`。

| 条款 | `0.0.2` | 本档 |
|---|---|---|
| §4 断线 | socket 关闭后**不再拨号**；页面从此永久离线，直到手动刷新 | 自动重连，退避 500ms → 10s，不限次数；`ready()` 指向当前那次拨号 |
| §4 断线期间的调用 | 立即 `EDISCONNECTED` | 不变（**不排队**），但现在只是暂时的：重连后恢复 |
| §4 保活 | 无。断网不触发 `onclose`，要等 TCP 超时（分钟级） | 客户端 5s 发 `ping`、20s 无帧判死；服务端 15s WebSocket ping、两轮无 pong 即 `terminate()` |
| §4 帧表 | `call` / `cancel` / `result` / `error` / `event` | 另加 `{type:'ping'}`（client → server，服务端直接回）与 `{type:'pong'}` |
| §4 订阅端点 | 调用方自己发 `cancel`；连接关闭即取消，**不会重订** | 通道托管：`RpcClient.watchEndpoint(method, args, listener)` 登记，重连后自动重放（**先重放，再通知**）；返回的 disposer 语义不变 |
| §4 重连通知 | 无 | `RpcClient.onReconnect(listener)`：重连成功时回调（首次连接不算）。断网期间的改动**没有事件**，读者据此重读 |
| §4 `RpcClient.close()` | 无（socket 随页面走） | 有：清定时器、不再拨号、在途调用以 `EDISCONNECTED` 结束 |
| §3.1 `fs.watch` | 直连 `onSession` | 内部改用 `watchEndpoint`；**签名、debounce、disposer 全不变**（插件无感） |

**没有变的东西**：`ctx.*` 的全部签名、slot 清单、控制面协议、`diorama.toml`、URL / hash 语义、
错误码表（`EDISCONNECTED` 的含义不变）。断线重连是**传输层**的事，页面语义（fail loud）没变。

## 27. `0.0.2` 之后：Markdown 的大纲、公式与图表（已计入 `0.0.4`，与 §23 同一档）

> 2026-10-23。契约号不动（§6）：没有新增服务、没有改 `ctx.*` 的签名、**没有加座位**；变的是
> **§5.1 里 `markdown` 渲染器的内容规则**（公式与图表的落点、什么时候加载那两个库、大纲画在
> 文档内部），以及**一条 HTTP 路由**（`/plugins/<id>/…`，插件把自己的运行时文件挂在旁边）。

| 条款 | `0.0.2` | 本档 |
|---|---|---|
| §5.1 Markdown 里的公式 | 无（`$…$` 是普通文本） | `$x^2$` / `$$…$$` 解析成**占位元素**，KaTeX 在**挂载之后**渲染；库**按需加载**（文档里没有公式就一个字节都不下） |
| §5.1 Markdown 里的图表 | 无（`mermaid` 围栏当普通代码块） | ```mermaid 围栏解析成占位元素，Mermaid 按需加载、异步渲染；失败时保留**源码**，不弹窗 |
| §5.1 占位元素里的源码 | — | **是文本内容，不是属性**：DOMPurify 会丢掉含 `-->` / `]>` 的属性值（XML 重解析风险），而每张 Mermaid 图都有箭头 |
| §5.1 运行时文件的来源 | 半边的代码全部打进 `client.cjs` | 插件可以把文件放在**半边旁边**（`/plugins/<id>/<path>` 从半边所在目录取），适合体积大、又要有自己文件的库（KaTeX 的 CSS 与 20 个字体、Mermaid 的 3.5 MB 包） |
| §5.1 大纲（`outline`） | 无 | 文档**内部**的一栏目录，画在文章旁边、属于这篇文章的 tab；**不是**左栏视图。标题少于两条不画；点一行滚到这一篇的那一节；当前小节按滚动位置标记 |
| §5.2 侧栏视图 | `files` / `changes` / `history` / `search` | **不变**（大纲不进侧栏） |

**没有变的东西**：`ctx.*` 的全部签名、`file.renderer` 的匹配规则与回退链、RPC 协议、
`diorama.toml`、错误码表。消毒仍然只有一次（`renderMarkdown` 里），公式与图表在**消毒后的 DOM**
上渲染——渲染器不会因为这两个库而放开任何 HTML。

细则：

- **`$` 的判定**沿用 GitHub 的口径：`$` 内两侧不留空格、单行、闭合的 `$` **后面不跟数字**。
  最后一条是为了 `$5 和 $6` 还是钱：不加它，`5 和 ` 会被当成公式。
- **加载顺序**：两个库各自一个模块级的 Promise（每页一次，不是每 tab 一次）。失败时清掉，
  下一次文档再试；失败只 warn，占位元素留着源码。
- **主题**：Mermaid 把颜色**画进 SVG**，所以 `data-scheme` 变化时重画（否则暗色页里挂着一张白图）。
  KaTeX 只读页面 token，不重画。
- **安全**：`securityLevel: 'strict'`（Mermaid），KaTeX 的 `throwOnError: false` + `strict: 'ignore'`
  （一个写错的公式不该让整段消失）。两者都只接收**消毒后**的元素内容。
- **发布**：`scripts/assemble-package.mjs` 把 `lib/vendor/` 一起带进 CLI 包，否则浏览器在那里
  会 404（`/plugins/markdown/vendor/…` 找不到）。
## 28. `[html] scripts`：预览要不要默认执行页面脚本（已计入 `0.0.4`，与 §23、§27 同一档）

> 2026-10-23。契约号不动（§6）：没有新增服务、没有改 `ctx.*` 的签名、**没有加座位**；变的是
> **§4.1 的一张新表**（`[html] scripts`）与 **§5.1 里 HTML 预览的起始阶段**，以及
> **`MountHandle` 上多出的 `config`**（页面读得懂的那一段配置）。

| 条款 | 本档之前 | 本档 |
|---|---|---|
| §4.1 `diorama.toml` | `host` / `port` / `plugins` / `ignore` / `[watch]` / `[git]` | 另加 `[html] scripts`（boolean，默认 `false`） |
| §4.1 下发到页面 | `/plugin.json` 带整个 `EffectiveConfig`，但**没有页面读它** | 不变（仍然带整个），但页面**有了一处读法**：`mountCtx.config` |
| §5.1 HTML 预览的起始阶段 | 恒为**样式阶段**，脚本要逐文件确认 | `scripts = true` 时**含脚本的页面直接进脚本阶段**；提示条仍在，可「停止执行」 |
| §5.1 无脚本的页面 | 样式阶段 | **不变**（没有可确认的东西，配置不改变它） |
| §5.1 换文件 / 刷新 | 回到「预览、未确认」 | 回到「预览、配置给的起始阶段」（上一份文件的「停止执行」不跟着走） |

**没有变的东西**：`file.renderer` 的匹配规则与回退链、两个阶段的 CSP 与 sandbox（脚本阶段仍然
**没有** `allow-same-origin`）、消毒策略、错误码表、slot 清单。默认值 `false` 让「打开一个 HTML
文件」这件事保持原来的安全语义：**配置是读者显式放宽的，不是默认给的**。

细则：

- **页面怎么拿到它**：`createMountHandle` 从 `/plugin.json` 的 `config` 里取出 `MountConfig`
  那一段（目前只有 `html.scripts`），挂在 `mountCtx.config` 上；服务端没给（单测、旧清单）时
  用 `DEFAULT_MOUNT_CONFIG`，与内核 `defaultConfig()` 的值一致。类型在 `shared/config.ts`
  （没有 Cordis、没有 React），由 `diorama-kernel` 与 `diorama-kernel/client` 各导出一次。
- **只管「起始」**：读者点「停止执行」之后不会被配置拽回脚本阶段——配置回答「打开时怎样」，
  不回答「读者刚刚点了什么」。
- **写它**：`diorama config set --html.scripts true`、`diorama config unset html.scripts`；
  交互式里是一个 true/false 菜单。写到哪个文件仍是 §4.2 的规则（默认 `$DIORAMA_HOME/diorama.toml`）。
- **gateway 的校验**：`mount` 请求的 `config` 现在要求带 `html.scripts`（`isEffectiveConfig`），
  少一个字段就是 `EBADREQUEST`——与 `watch.*` 一样，配置是 CLI 合成后整份交过去的。

## 29. `0.0.2` 之后：侧栏可以收起（已计入 `0.0.4`，与 §23、§27、§28 同一档）

> 2026-10-24。用户要求：**左侧图标点击可以收起左侧窗格**。契约号不动（§6）：没有新增服务、
> 没有改 `ctx.*` 的签名、**没有加座位**；变的是 **§5.2 里左栏的形态**（多一个「收起」状态）、
> **§3.7 的命令表**（多一条 `sidebar.toggleFolded`），以及 `diorama-ui` 的样式。

| 条款 | 本档之前 | 本档 |
|---|---|---|
| §5.2 左栏的形态 | 一条栏、多个视图；栏的宽度可拖 | 另有**收起**：只剩切换器（36px 的竖条），视图面板隐藏而不卸载 |
| §5.2 收起放在哪 | — | 切换器**脚下**一个按钮（图标随状态换：收起 / 展开）。它必须留在收起后还看得见的那一竖条里，否则页面上没有能展开它的东西 |
| §5.2 收起是什么状态 | — | **读者的偏好**（`localStorage` 的 `diorama.layout.sidebarFolded`），与「选了哪个视图」正交：切视图、URL 的 hash 都不改变它，刷新回来还是收起的 |
| §5.2 收起时的宽度 | — | 不是 0：`SIDEBAR_RAIL_PX`（36px）。0 会把切换器一起带走 |
| §5.2 收起时的拖拽边 | — | 不挂载（不是隐藏）：没有宽度可拖，也就不该占一个能聚焦的格子 |
| §5.2 点视图时 | 只切视图 | 图标是**收起的把手**（activity bar 手势）：点**当前显示中**的图标收起整栏，点别的图标切视图；折叠状态下任意图标都先展开再切（否则按钮改的是看不见的面板，读作死键）|
| §3.7 命令表 | `sidebar.show*` 三条 | 另加 `sidebar.toggleFolded`（`mod+b`，`when` = 侧栏有视图）|

**没有变的东西**：`sidebar.views` 的座位形态（仍是 keyed、key = 视图 id）、`SidebarViewProps`、
视图的注册方式、`ctx.*` 的全部签名、slot 清单、URL / hash 语义、RPC 协议、错误码表。
收起是**页面状态 + 一条偏好**，不是内核服务。

细则：

- **为什么不是 `ctx.layout`**：切换器的当前视图已经是 `layout` 自己的页面状态（`ViewChoice`，
  经 `__diorama_layout__` 给别的半边读）；收起与它是**同一个层**的东西，所以是同一块里的第二个
  store（`FoldChoice`），而不是一个新服务。`ctx.layout` 仍是 🔲（§3.4）。
- **为什么与视图选择分开存**：读者在长文件里收起侧栏、再展开，期望看到**原来那个视图**；
  把收起做成"选了一个空视图"就会在展开时丢掉它。反过来，URL 的 hash 只记视图、不记收起。
- **图标为什么能收起**：用户的原话是「左侧图标点击可以收起」——按 VS Code 的 activity bar 手势，
  **点当前显示中的那个图标 = 收起**，点别的图标 = 切视图。不撞 `sidebar.show*` 的快捷键路径：
  命令永远只展开，手势才收起。活动图标的 `title` 写明这一点，读得出来就不用猜。
- **隐藏而不是卸载**：与「非活动视图」「`tabs.content`」「`layout.overlay`」同一条规则——
  展开回来时滚动位置、目录展开状态、搜索词都还在。
- **键位**：`mod+b`。不与现有绑定冲突（`mod+alt+*` 那一族、`mod+k`、`mod+p`、`mod+shift+f`、
  `mod+/`、`mod+alt+1..4` 都不同）；浏览器的 `mod+b`（书签栏）在页面上拦得住，且与
  `mod+alt+w` 那族的理由一样——我们只挑不会被浏览器先吃掉的组合。
- **图标**：`sidebar-fold` / `sidebar-unfold`（Tabler 的 `layout-sidebar-left-collapse` /
  `-expand`）进 `scripts/generate-icons.mjs` 的 `BUTTON_ICONS`，跑 `pnpm icons` 重新生成表，
  再重建**页面壳**（表是壳装的，不是半边装的，docs/m17/spec.md §6 坑 9）。页面没有图标表时
  （外部宿主、单测）按钮退回标题首字，与切换器同一条规则。

## 30. `0.0.2` 之后：diff 的两种内容读法加语法高亮（已计入 `0.0.4`，与 §23、§29 同一档）

> 2026-10-24。用户要求：**diff 单栏 / 双栏模式都增加语法高亮**。契约号不动（§6）：没有新增服务、
> 没有改 `ctx.*` 的签名、没有加座位；`seats.git-diff` / `seats.git-commit` 的 props 不变（§5）。
> 变的是 **§5.2 里两个内容读法画什么**，以及 `diorama-ui` 多了一个页面级的引擎位置。

| 条款 | 本档之前 | 本档 |
|---|---|---|
| §5.2 「整个文件」（单栏） | 每行一种色调（未改动 / 新增 / 删除），正文是纯文本 | 正文按文件的语言上色：关键字、字符串、注释、数字、函数名、内建符号六类，**用与 `code` 渲染器同一套 token**（§5.3）；行的色调（背景 + 默认文字色）不变，token 只覆盖它标出的那一段 |
| §5.2 「新旧对照」（双栏） | 同上，两栏都纯文本 | 两栏各自上色。未改动的行两栏是**同一份**文件文本，所以一份标记两栏共用；被删除的格子不在当前文件里，取 diff 自己的文本 |
| §5.2 「改动」（行内） | 着色的 unified diff | **不变**：那是 git 自己的文本（`+` 前缀、`@@` 头），不是源码，不给它上 token 色 |
| 引擎从哪来 | — | `code` piece 在 boot 时把引擎**发布到页面**（`__diorama_highlight__`，与 `__diorama_reveal__` / `__diorama_overlay__` / `__diorama_layout__` 同一口径的页面全局），`git-changes` 从那里读。**半边不能 import 另一个半边**（每个半边是自足的闭包，§8），也不能为此开内核服务：语言表与配色是页面 UI 状态 |
| 引擎的形状 | — | 两件事，都是纯函数：`languageOf(path)`（路径 → 语言，`plaintext` 表示"不认识"）与 `lines(text, path)`（一段文本 → **每行一个 HTML 片段**）。第二个是关键：diff 一行一行画（折带、行号槽、双栏里一侧留空），**跨行断开的 span 必须在这一行闭合、下一行重开** |
| 没有引擎时 | — | 画纯文本（与上一档完全一样），不是空白也不是报错：`code` 不在 boot 图里、或还没发布时，`git-changes` 照常可读 |
| 不认识的语言 | — | `languageOf` 回答 `plaintext`，文本转义后原样画（不解释、不丢行） |

**没有变的东西**：`ctx.git` 全部方法与上限（§3.2）、`#diff` / `#history` 语义（§3.8）、
三档读法与它们之间的导航（§23）、模式偏好与折带（§5.2）、slot 清单（§5）、
`FileRendererProps`（§5.1）、RPC 协议、错误码表。

细则：

- **为什么不是 `ctx.highlight`**：这是"这段文本该是什么颜色"，纯页面的事，没有 IO、没有跨 mount
  语义、没有可被别的插件依赖的服务面。开一个内核服务还要在四处接线（`KERNEL_SERVICE_IDS`、
  `MOUNT_SERVICES`、CLI 的 `PROXYABLE`、server 半边选择），换来的只是同一份 highlight.js 在服务端
  再跑一遍——而 `ctx.fs` 已经是只读文本，颜色在浏览器里算就够了。
- **为什么发布者可以是 `code`**：语言表与语言注册只该有一份（`.ts` 是 TypeScript、`.md` 不是源码，
  这些判断在 `code` 里已经是既成事实）。`git-changes` 不再复制一张表，两份表也就不会漂。
- **发布是版本化的**：读者先于发布者渲染时（boot 顺序是插件图的，不是这里的）要在引擎到达后重画；
  所以页面全局带一个版本号，组件用 `useSyncExternalStore` 读它（快照是数字，不是对象）。
- **每一行都是完整的 HTML**：一条块注释、一个多行字符串在 highlight.js 里是**一个** token；直接按
  `\n` 切开会让某一行留着没闭合的 `<span>`（画出来就是后一行整行变色，或者干脆没有闭合标签）。
  引擎在断行处闭合再重开，代价是每行多两个标签。
- **删除行成段上色**：被删除的行不在当前文件里（只有 diff 里的那份文本），所以一段连续的删除行
  **一起**交给引擎再切回来——这样它们之间的多行字符串仍是同一个构造。双栏里与被删除行配对的新增
  格子仍从文件里取（它在文件里），各自独立上色。
- **颜色只用 token**（§5.3）：六个 `--dio-syn-*` 一个不多、light / dark 成对，所以暗色下与
  `code` 渲染器一模一样。

## 31. `0.0.2` 之后：快捷键能力增强与「按住修饰键看快捷键」（已计入 `0.0.4`，与 §23、§27、§29、§30 同一档）

> 2026-10-25。用户要求：**增强快捷键能力，如 mod+数字切换 tab 等跟常见 IDE 类似的能力；当按下 mod 键时，
> 在对应组件上（tab / 按钮 / panel 图标等）用标签显示快捷键，类似 cmux 的体验**。契约号不动（§6）：
> 没有新增服务、没有加座位、没有改 `ctx.*` 的既有签名；变的是 **§3.7 的命令表与命令服务多两个读法**、
> **§5.2 里侧栏切换器多一条显示规则**，以及 `diorama-ui` 多一个原语。

| 条款 | 本档之前 | 本档 |
|---|---|---|
| §3.7 按序号跳 tab | 无 | `tabs.select:<n>`，`when` = tab 数 ≥ n |
| §3.7 tab 条的键位 | `mod+alt+w` 关、`mod+alt+←/→` 循环、`alt+1..9` 跳（v0.15，全避开浏览器） | **IDE 的键位**（v0.16，用户拍板「跟浏览器冲突也没关系，实现自己功能更重要」）：`mod+w` 关、`mod+shift+[ / ]` 循环、`mod+1..9` 跳。浏览器先吃掉的键（`mod+w`、`mod+1`）页面收不到——读者还有点击与 `⌃Tab`，但键位是肌肉记忆里的那个。`shift+[` 按下时报 `{`，`matchesKeys` 按**键帽**认识它（`SHIFTED` 表） |
| §3.7 按住修饰键的提示 | 无（只有 `?` 打开的速查表） | 按住 ⌘ / Ctrl **或** Option / Alt 时，**关键**快捷键显示出来；`CommandContext.hints` 让 `when` 也能问。状态在页面全局 `__diorama_keys__`，由内核唯一的 keydown 监听器维护 |
| §3.7 提示显示什么（v0.16 收紧） | （v0.15：每个有命令的控件都显示） | **只显示关键的**：tab 条的按序号跳（`⌘1…`）与侧栏切换器的视图键（`⌘⌥1…`）。关闭（`✕`）、收起（`⌘B`）这类辅助键不显示——一条 tab 上两个芯片、切换器脚下再来一个，就不是提示而是噪音；完整清单仍在 `?` 速查表 |
| §3.7 提示怎么显示（v0.16） | （v0.15：画在控件自己的行内，控件会变宽/变高） | **浮层标签**（cmux 的做法）：芯片 `position: absolute` 悬在控件上方/旁边，**不参与布局**——出现与消失不改变控件的大小与位置（e2e 断言 tab 条几何不变） |
| §3.7 注册表的读法 | `bindings()` / 快照只有 `keys`（规范记法） | 快照每条绑定多一个 `label`（给人看的 `⌘W` / `Ctrl+W`）；服务多 `bindingFor(id)` / `hintFor(id)`，控件显示自己的快捷键只读它，**不自己拼键记法** |
| §3.7 键记法的唯一翻译表 | `help` 自带一份 `formatKeys` | 移到内核的 `diorama-kernel/client`（`formatKeys`），速查表与芯片同读一份 |
| §5.2 侧栏切换器 | 图标 + tooltip（`title` 写明「再点收起侧栏」） | 另加：按住修饰键时每个图标**旁边**浮出它的键（`⌘⌥1`…）。芯片是装饰（`aria-hidden`），无障碍名不变；收起按钮**不**显示 |
| tab 条 | 标签 + 关闭按钮 | 另加：按住修饰键时每个 tab 的**右上角**浮出 `⌘<n>`（前九个）；**中键点击关闭 tab**（与常见 tab 条一致） |
| palette 的行 | 标题 + 命令 id | 另加（v0.17）：**有快捷键的行右侧显示它**（keycap 芯片，多个键并列）；文本来自注册表快照的 `label`，与芯片、速查表同读一份 `formatKeys`；没有绑定的行不显示、不占位 |

**没有变的东西**：`ctx.commands` 的既有方法签名与语义（`register` / `bind` / `run` / `canRun` /
`getSnapshot` / `subscribe` 全部照旧，`CommandContext` 只多一个可选字段）、`ctx.tabs`、
`sidebar.views` 的座位形态、slot 清单、URL / hash 语义、RPC 协议、错误码表、`diorama.toml`。

细则：

- **为什么提示状态在页面全局、不在内核服务**：它是「读者的手此刻按着什么」，纯 UI 状态；与
  `__diorama_overlay__` / `__diorama_reveal__` / `__diorama_layout__` 同一口径。每个 client 半边是
  自足的闭包（§8），模块级对象会变成每半边一份；`globalThis` 是唯一共享的地方。**内核写、半边读**：
  只有内核拥有那个唯一的 keydown 监听器，所以也只有它能维护这个状态。
- **快照是字符串**（`''` / `'mod'` / `'alt'`），不是对象：`useSyncExternalStore` 按值比较，
  每次读都返回新对象会无限重渲染（本仓反复踩到的坑）。store 的方法写成不依赖 `this` 的闭包，
  React 拿去做 `subscribe` 时不会丢接收者。
- **两种「按住」都算**：`⌘`（非 mac 上是 Ctrl）与 `⌥`（Alt）。绑定里两种家族都有（`⌘⌥W`、`⌥1`），
  「按一个修饰键看看」必须对读者伸手按的那一个给出答案。macOS 上 `⌃` **不算**——那里 `mod` 是 `⌘`。
- **芯片文本来自注册表**：`label` 由内核在 `bind` 时算好（一次），页面只负责画。这样速查表与
  芯片不可能对同一个键给出两种写法。
- **不拦按键**：按住本身不执行任何命令（只改显示状态），`handleKey` 的分发顺序与「第一个注册者
  优先」的规则一个字都没动。
- **`alt+1..9` 的代价**：`Alt+digit` 在部分 Linux 桌面上是输入法 / 终端切换键，但浏览器里不被保留，
  且与 `mod+alt+*` 那一族同一个理由（`matchesKeys` 对 `alt` 绑定有物理键兜底，macOS 的 `¡` 也能命中）。
- **窗口失焦要清**：切走再回来时浏览器不会补发 keyup，所以 `window.blur` 也清状态，否则提示会一直亮着。

## 32. `0.0.2` 之后：停止服务一个目录（`diorama stop`）（已计入 `0.0.6`）

> 2026-10-26。用户要求：**增加命令，用于停止当前目录/指定目录实例**。契约号不动（§6）：控制面
> 早就有 `unmount`（§7.3），缺的只是 CLI 的一个入口——本档只加 CLI 行为，不改 `ctx.*`、slot、
> RPC 与控制面协议。

| 条款 | 本档之前 | 本档 |
|---|---|---|
| §7.6 停止一个挂载 | 只有 `restart <dir>`（卸了又挂）与 `gateway stop`（停整个进程） | 新增 `stop [dir] [--all] [--json]`：只卸挂载，gateway 与其它挂载不动 |
| §7.6 `stop` 的目标 | — | 无参数 = **当前目录**（包含 `process.cwd()` 的那个挂载）；显式目录先比 realpath、再比 `resolve` 的字符串（已删掉的目录也认得）；挂载嵌套时取**最深**的包含者 |
| §7.6 `stop` 的方向 | — | **只向上匹配**：`stop proj` 不动 `proj/vendor/lib` 上的挂载；`stop proj/src` 停的是 `proj` 的挂载 |
| §7.6 `stop --all` | — | 停掉这个 gateway 的**全部**挂载，进程照旧运行；零挂载是 `no mounts to stop` + 退出码 0 |
| §7.6 `stop` 的退出码 | — | 不匹配 / gateway 未运行都是 **0**（幂等，与 `gateway stop` 同口径）；用法错误 2；部分失败 1 |
| §7.6 `stop --json` | — | `{ stopped: [{ mountId, root, url }], target, all }`（`target` 是字符串或 `null`）；stdout 只有一个文档 |

**没有变的东西**：控制面的 `unmount`（§7.3）与其幂等语义、`restart`、`gateway stop|restart`、
`MountStatus` 的字段、`ls` 的输出形状、`diorama.toml`。`stop` 不新增任何服务端行为——
它只是把「按 `mountId` 卸一个」包成一个按**目录**说话的 CLI 动词。

## 33. `0.0.2` 之后：默认主题写在 `diorama.toml` 里（已计入 `0.0.6`，与 §32 同一档）

> 2026-10-27。用户要求：**支持在配置文件中设置默认主题**。契约号不动（§6）：没有新增服务、
> 没有改 `ctx.*` 的签名、没有加座位；变的是 **§4.1 的一张新表**（`[ui] theme`）、**§4.2 的一个
> 可写键**，以及 **§3.10 的优先级多一档**（配置的默认在 `system` 之上、读者的选择之下）。

| 条款 | 本档之前 | 本档 |
|---|---|---|
| §4.1 `diorama.toml` | `host` / `port` / `plugins` / `ignore` / `[watch]` / `[git]` / `[html]` | 另加 `[ui] theme`（string，默认 `"system"`） |
| §4.1 值的校验 | — | 字符集 `[A-Za-z0-9_.-]+`（§3.10 的 hash 值同一套）；空串、带空格 / 冒号 → fail loud |
| §3.10 优先级 | hash > storage > `system` | hash > storage > **`[ui] theme`** > `system` |
| §3.10 `localStorage` | `diorama.theme` 记偏好 | 只在**读者选过**时写；没选过时**删掉**这个键（记住的默认值会盖住之后改的配置）。`diorama.theme.scheme` 照旧每次 paint 都写 |
| §3.10 首帧 | 壳读 `diorama.theme.scheme`，读不到跟随 OS | 再读服务端注入的 `window.__diorama_theme__`（`light` / `dark` 时才注入；主题 id 不注入——壳不知道它的 scheme） |
| §4.2 `diorama config` | 8 个键 | 另加 `ui.theme`：`set --ui.theme dark`、`unset ui.theme`；交互式里是 `system` / `light` / `dark` 三选一菜单（打主题 id 照常收） |
| `MountHandle.config` | `{ html: { scripts } }` | 另加 `ui: { theme }`；服务端没给时与 `defaultConfig()` 一致 |

**没有变的东西**：`ctx.theme` 的签名（没有 `default` 字段——默认来自配置，不来自服务）、
`ThemeDefinition` / `ThemeSnapshot`、命令表、slot 清单、`#theme=…` 的语义（`system` 仍是
**没有这个键**）、`localStorage` 的两个键名。

细则：

- **是起点，不是锁定**。配置回答「没人选过时从哪里开始」，不回答「读者刚点了什么」。读者一选
  （palette 里的 `theme.*`、`mod+alt+t`、分享的 `#theme=…` 链接）就以读者的为准，改文件不再动他。
  这与 `[html] scripts` 的「只管起始阶段」（§28）同一条规矩。
- **默认值不写进 `localStorage`**。写进去的话，读者下一次把文件改成 `dark` 会看起来毫无效果
  （记忆里的 `system` 赢）。所以 `diorama.theme` 只在读者选过时存在；`paint()` 在「没选过」时
  传 `undefined`，浏览器半边 `removeItem`。
- **首帧只有服务端能回答**。壳里的内联脚本在任何 `fetch` 之前跑，配置却在 `/plugin.json` 里；
  所以 `serveShell` 把 `[ui] theme` 的 `light` / `dark` 直接注入成 `window.__diorama_theme__`。
  一个**主题 id** 不注入：它的 scheme 由注册它的插件决定，壳无从得知，那种页面首帧跟随系统、
  服务启动后重绘一次（主题是注册表数据，§3.10 的「偏好可以走在注册前面」本来就允许这一帧）。
- **`ui.theme` 的字符集就是 hash 值的字符集**：它同时是 `#theme=…` 的值和命令 id 的一部分，
  写一个 URL 里说不出来的值没有意义，所以在读文件时就拒绝，而不是到 paint 时才静默忽略。
- **CLI 看不见主题注册表**：注册表在页面里（piece 注册的）。所以交互式只列三项内置候选，
  主题 id 靠**打字**——候选是提示不是限制（§4.2 的老规矩）。

## 34. `0.0.2` 之后：网页标题是目录名（已计入 `0.0.6`，与 §32、§33 同一档）

> 2026-10-27。用户要求：**网页 title 显示了目录名称**。契约号不动（§6）：没有新增服务、没有改
> `ctx.*` 的签名、没有加座位、没有改 `/plugin.json`——变的只是**页面壳那一份 HTML**。

| 条款 | 本档之前 | 本档 |
|---|---|---|
| 页面壳的 `<title>` | 永远是 `diorama`（`apps/web/index.html` 的静态值） | **这个挂载的目录名**：`basename(root)`，即 `diorama ls` 里 `DIR` 那一列的名字 |
| 由谁写 | — | `serveShell`（`packages/kernel/src/server/http.ts`）：它同时持有壳文件与 `MountOptions.root` |
| 什么时候到 | — | **文档到的时候就对**：壳是静态 HTML，在任何 `fetch` 之前就上屏，所以不能由页面在 boot 之后补写 |
| 目录名里带标记字符 | — | 转义成文本（`<` → `&lt;` 等）：标题是文本节点，不是标记 |
| 根没有名字（`/`） | — | 保留壳自己的 `<title>`（不写一个空标题） |
| 哪个路由 | — | 全部走壳的路由（`/`、`/index.html`、`/~/…`、SPA 回退）：标题属于**挂载**，不属于某个文件 |

**没有变的东西**：`/plugin.json`（`BootManifest` 不新增字段）、`ctx.*`、slot、RPC、控制面、
`MountStatus`、`diorama.toml`（标题不是配置项，它由**挂载的目录**决定）。`shellTitle` /
`withShellTitle` 从 `diorama-kernel/server` 导出，但它们是**服务端的纯函数**，不是页面服务。

细则：

- **不做「文件名 + 目录名」**：标题回答「这是哪个目录的页面」，读者开着五个挂载时靠它分辨；
  活动文件已经写在 tab 条上（`active-tab` 的 `title`），再进网页标题只会让标签挤不下。
- **不做配置项**：`[ui]` 里加一个 `title` 会把「这个目录叫什么」变成又一件要维护的事；
  需要换名字的人重命名目录（或等外部插件落地后再说）。
- **标题不随路由变化**：它是挂载的属性，打开 `/~/README.md` 不该变成 `README.md`。

## 35. `0.0.2` 之后：文件视图的工具栏与「定位到正在浏览的文件」（已计入 `0.0.6`，与 §32–§34 同一档）

> 2026-10-27。用户要求：**在文件导航窗上加个工具栏，工具栏加个按钮，可以定位到正在浏览的文件**。
> 契约号不动（§6）：没有新增内核服务、没有加座位、没有改 slot 清单、没有改 `/plugin.json`。
> 变的是 **§5.2 里视图的形态**（视图可以有自己的工具栏）、**§3.4 的 `ctx.tree` 多一个方法**、
> **§3.7 的命令表**（多一条 `tree.revealActive`），以及 `diorama-ui` 的样式与图标表。

| 条款 | 本档之前 | 本档 |
|---|---|---|
| §5.2 视图的形态 | 视图面板里就是它的内容（文件树只有行） | 视图可以有一条**自己的工具栏**，钉在面板顶部（文件视图是第一个） |
| 工具栏归谁 | — | **这个视图**，不是整条侧栏：切换器那一竖条只有视图图标与收起按钮，别的视图不受影响 |
| 工具栏用什么座位 | — | **不用座位**：视图的控件就画在视图自己的组件里（与 §27「一个文件的东西不进侧栏」同一条理由） |
| 那颗按钮做什么 | — | 「定位到正在浏览的文件」：把**活动 tab 的文件**在文件视图里找出来——沿路展开目录、滚到那一行、给那一行一个会淡出的高亮带 |
| 它是不是导航 | — | **不是**：不打开文件、不切换 tab、不改选中、不动 URL。读者已经在读这个文件了，按钮只是让**树**追上来 |
| §3.4 `ctx.tree` | `expanded` / `selected` / `select` / `toggle` / `isExpanded` | 另加 `reveal(path)`；快照多一个 `reveal: { path, at } \| undefined` |
| §3.7 命令表 | `tree.focus` | 另加 `tree.revealActive`（`mod+shift+l`，`when` = 有活动 tab）；工具栏那颗按钮跑的就是它 |

**没有变的东西**：`sidebar.views` 的座位形态（仍 keyed、key = 视图 id）、`SidebarViewProps`（仍是
`{ active }`）、视图的注册方式、slot 清单、`ctx.tabs`、RPC 协议、`diorama.toml`。工具栏是**视图自己的
组件**，不是内核座位，也不是整栏的属性。

细则：

- **为什么按钮在视图里，而不是新开 `sidebar.toolbar` 座位**：座位是「别人往这里注册」的东西，而这颗
  按钮只有文件视图自己知道它做什么（要展开目录、要滚它自己的列表）。开座位还会让「谁画这一条」变成
  第二个 owner，和 §5.2「切换器由 `layout` 画」的既有分工打架。视图的控件归视图，是同一句话的另一半。
- **为什么 `reveal` 是 `ctx.tree` 的方法**："哪些目录是展开的"是这个服务的状态（§3.4），而把某一行
  露出来必须先展开它上面的每一级——那是**状态**的改动，不是视图自己的滚动。服务负责「路径 → 展开」，
  视图负责「那一行滚到中间、标一下」；两边都不越界。
- **快照里为什么是 `{ path, at }` 而不是一个路径**：连按两次按钮要连定位两次，而「同一个路径」在快照
  里不构成变化（`useSyncExternalStore` 不会因此重渲染）。`at` 是单调戳，新请求永远是新的数字。
  这与 reveal store 的 `RevealTarget.at`（§3.9）是同一条规矩。
- **「正在浏览的文件」就是活动 tab 的 `path`**：`diff` tab 也带 `path`，所以两种视图下按钮都找得到那一行；
  没有 tab 时按钮**禁用**（标题写「没有正在浏览的文件」），命令的 `when` 为假（palette 不列它）。
  禁用而不是隐藏：一个会消失的按钮会让工具栏跳动。
- **分页的目录要能长出来**：目录超过 `PAGE_SIZE`（500）时先列一页。定位的落点若在第二页之后，视图
  把那一页**按需长到**落点所在的位置（与「加载更多」同一个动作），否则那一行根本不存在、也就滚不过去。
- **只展开，不收起**：读者自己打开过的目录不会被定位顺手关掉；目标路径上的目录已展开时不重复加。
- **键位 `mod+shift+l`**：不与现有绑定冲突（`mod+alt+*` 那一族、`mod+k`、`mod+p`、`mod+shift+f`、
  `mod+shift+[ / ]`、`mod+w`、`mod+1..9`、`mod+b`、`shift+?` 都不同）。`l` 取「locate」，与编辑器里
  「reveal in explorer」的习惯一致。
- **图标**：`reveal-file`（Tabler 的 `current-location`）进 `scripts/generate-icons.mjs` 的
  `BUTTON_ICONS`，跑 `pnpm icons` 重新生成表，再重建**页面壳**（表由壳装，不是半边装，docs/m17/spec.md
  §6 坑 9）。页面没有图标表时按钮退回一个字（「定」），与切换器同一条规则。
- **落点的高亮是动画，不是状态**：`data-located="true"` 与一段 `1.6s` 的淡出背景，写完就结束；
  读者继续滚动、点别的行都不受影响，也不需要「清掉高亮」这一步。

## 36. `0.0.2` 之后：文件的原件链接与三个动作（已计入 `0.0.6`，与 §32–§35 同一档）

> 2026-10-28。用户要求：**文件导航窗口右键 →（下载、复制链接、独立浏览器窗口打开）**，
> 并且明确「复制链接是复制一个**下载链接**」「独立浏览器窗口打开是直接在窗口里打开/下载**文件**，
> 而不是打开 diorama 应用里的文件」。契约号不动（§6）：没有新增内核服务、没有加座位、
> 没有改 `ctx.*` 的签名；变的是**多一条服务端路由**（§4）、**命令表多三条**（§3.7）、
> **§5.2 多一种视图控件**（右键菜单），以及 `diorama-ui` 的一个原语。

| 条款 | 本档之前 | 本档 |
|---|---|---|
| 原件字节怎么取 | 只能走 `ctx.fs.readBytes`（过 RPC，上限 32 MiB） | 另开 `GET /~raw~/<RelPath>`，流式、不设上限（§4） |
| 三个动作指向什么 | — | **同一个 URL**：`/~raw~/<path>`；只有下载加 `?download=1` |
| `content-disposition` | — | 默认 **inline**（不发头）；`?download=1` 才是 `attachment` |
| 媒体类型 | — | 按文件类型（`mimeOf`），**一律真实类型**，不因可执行而降级 |
| 文本编码 | — | 文本类带 `charset=utf-8`（`rawContentType`）：不带就是让浏览器猜，中文必乱码 |
| 源码算不算文本 | — | **算**：各语言源码 / 配置 / 点文件都是 `text/*`，浏览器显示而不是下载；表外扩展名才是 octet-stream |
| 独立窗口还是新标签页 | — | `window.open(url, '_blank')`，**不带宽高**——现代浏览器给的是标签页；`popup=yes` 会强出一个没有地址栏的 OS 窗口，而「拿到这个文件的地址」正是这个动作的意思 |
| §3.7 命令表 | `tree.revealActive` 为止 | 另加 `file.download` / `file.copyLink` / `file.openInWindow`（无键位，走 palette） |
| §5.2 视图的形态 | 工具栏（v0.17） | 另加**右键菜单**；同一条分工（画在视图里、不开座位） |
| 前缀 | `/~/`（页面） | 另加 `/~raw~/`（原件）；两条互不吞掉 |

**没有变的东西**：`ctx.fs` / `ctx.git` 的签名与上限、RPC 协议、slot 清单、`diorama.toml`、
`/plugin.json`、`/~/…` 的语义（它仍然是页面）。

细则：

- **为什么不是 `?download` 一种 URL、或者 `/download?path=`**：用户要的是「复制一个**下载链接**」，
  也就是**可以直接发给别人、也可以直接在窗口里打开**的地址。`/~raw~/<path>` 两者都是——同一个
  URL，浏览器按类型决定显示还是保存；`?download=1` 只是把「保存」这件事说死。
  `/__diorama__/download?path=…` 那种形状则把路径塞进查询串：编码要再走一层、复制出去的链接
  长得像内部端点、而且 `/__diorama__/` 目前在 `http.ts` 里是**精确路径 switch**，加一个带任意
  后缀的端点会把它变成前缀路由。
- **为什么前缀是 `~raw~` 而不是 `origin` / `file` / `content`**：`origin` 在这个仓库里已经
  是 CORS 语义（`Access-Control-Allow-Origin`、`baseUrl`、`location.origin`）；`blob` 撞
  `ctx.git.blob()`；`content` 撞 `tabs.content` 座位；`asset` 撞 `/assets/`（页面壳的构建产物）。
  `raw` 与生态同口径（`raw.githubusercontent.com`、GitLab `/-/raw/`、Vite `?raw`），而且和
  `ctx.fs.readBytes` 注释里的 "raw bytes" 是同一个词。**命名的是资源，不是动作**——这正是它
  能同时服务三个动作的原因。
- **不能是裸 `/raw/<path>`**：挂载里真有一个叫 `raw` 的目录时，那个目录的文件就被路由吃了。
  `~` 是「文件名里不可能出现的字符」，与 `/~/` 选 `~` 是同一条理由（§3.8「保留前缀」）。
- **为什么下载不设上限**：`readBytes` 的 32 MiB 是「读进页面」的成本（`Uint8Array` 过 RPC 是
  `{ $bytes: base64 }`，32 MiB 变 44 MiB 的 JSON 单帧）。下载不经过页面：字节从磁盘直接流向浏览器，
  浏览器有进度条和自己的磁盘。日志、视频、大 CSV 因此都能下。
- **html / svg / xml 不降级**：用户明确「按文件类型返回对应的 content-type」。代价是
  `/~raw~/x.html` 会在**本站 origin** 上执行页面脚本（能读本站 `localStorage`、能调 RPC 读整个
  挂载目录）。这是读者对自己机器上自己的文件按下的动作，与 `file://` 打开本地 HTML 同级，
  **接受**并写进 §4 的边界；要收紧只需加一条 `content-security-policy: sandbox`，不动 `content-type`。
- **三条命令都作用于活动 tab 的文件**：页面级命令没有「哪一行」这个上下文，能命名的只有活动 tab
  （§3.7 的 `CommandContext.activeTab`）。**不绑键位**：`mod+d`（书签）、`mod+c`（复制）、
  `mod+o`（打开）都是浏览器自己的，语义也不同；这三条在 palette 里被找到。
- **菜单只有文件行有**：三个动作都是关于**字节**的，目录没有字节。目录行与空白处保留浏览器原生菜单。
- **右键不改导航状态**：不选中、不开 tab、不动 URL——读者是在问「这一行能做什么」，不是在打开它
  （与 §35「定位不是导航」同一条规矩）。
- **失败要说出来**：剪贴板在非 secure context 下会**拒绝**（`--host 0.0.0.0` 后用 LAN 地址打开），
  弹窗会被拦截。两者都**不静默**：菜单那条路在视图顶部显示一条带 URL 的提示，命令那条路在
  console 里给同样的文本。回退链是 `navigator.clipboard` → `execCommand('copy')` → 手抄 URL。
- **「独立窗口」= 新标签页**：`window.open(url, '_blank')`，**不带宽高、也不要 `popup=yes`**。
  动作的名字是读者视角的（「在 diorama 外面打开这个文件」），浏览器怎么放由浏览器决定：现代浏览器
  对不带 features 的 `_blank` 给的就是标签页。第一版写了 `popup=yes`，结果真开出一个没有工具栏、
  没有标签条、**也没有地址栏**的 OS 窗口——而这个动作的全部意义就是「我要这个文件的地址」。
  被拦截时 `window.open` 返回 `null`，此时把 URL 显示出来（不静默）。
- **纯函数放在两处可测的地方**：`diorama-kernel` 的 `shared/raw.ts`（编码、URL、disposition、
  类型）与 `file-tree` 的 `actions.ts`（动作表与三种结果），都是 `node --test` 直接吃的 `.ts`。

## 37. `0.0.6` 之后：历史视图的仓库切换改成下拉（已计入 `0.0.7`）

> 2026-10-28。用户要求：**git 历史窗格中 git 仓库切换改成下拉切换，而不是分组**。契约号不动
> （§6）：没有新增内核服务、没有加座位、没有改 `ctx.*` 签名；变的是 **§5.2 里历史视图的形态**
> （v0.10 的分组 → 下拉），以及 `diorama-ui` 的一条样式。`#history` 的语义（§3.8）、
> `repos()` 的顺序（§3.2）、提交座位都不变。

| 条款 | 本档之前（v0.10） | 本档 |
|---|---|---|
| 历史视图里的多个仓库 | 同屏并列的**分组**，组头可折叠 | 顶部一行**下拉**，一次只画一个仓库的提交 |
| 折叠状态 | `collapsed` 集合（键 `repo:<path>`） | 没了：没有组要折 |
| 只有一个仓库时 | 不出组头 | 不出下拉（它只会重复这一栏已经是什么） |
| 选项上写什么 | 组头是仓库路径 + 提交数 | 选项是「仓库路径（提交数）」；当前仓库的路径同时是选择行的 `title` |
| 选了哪一个 | 无状态（全部都在） | 视图自己的 `useState`；`null` = 显示第一个，选中的仓库消失了就退回第一个 |
| 变更视图 | 按仓库分组、可折叠 | **不变**——那里是一棵可以同时浏览的树，不是「换着看」的多个对象 |

**没有变的东西**：`ctx.git` 的全部方法与上限、`git.repos()` 的顺序（浅的在前，同深度按路径）、
`#history` 的值形状（`<repo>:<sha>` / 裸 sha）、提交座位（`seats.git-commit`）、
`git-history-commit` / `git-history-repo` 这两个 testid 的语义、`sidebar.views` 的座位形态。

细则：

- **为什么不是分组**：分组把 N 份列表**同时**画在一栏里，读者每换一次仓库都要在滚动里重新找位置；
  而「看历史」这件事一次只需要一个仓库的提交。下拉只换列表本身，头部、计数与位置都不动。
- **为什么用原生 `<select>`**：菜单、键盘、`Esc`、平台自己的浮层都免费；一个自绘的弹出层要重做
  定位、越界翻转与关闭规则（那套东西已经有一个 `ContextMenu`，不该有第二份）。
- **为什么状态在视图里**：这是「这个视图正在看哪个仓库」，不是页面状态：不进 URL、不进
  `localStorage`。读者关掉再打开这个视图，回到第一个仓库是合理的默认。
- **选中提交与选中仓库是两件事**：`#history` 记的是**提交**（以及它属于哪个仓库）。换了仓库不会
  清掉 `#history`——右侧的提交详情属于读者刚才点的那一个，换仓库只是在挑下一份列表来看。
- **testid 保留**：`git-history-repo` 现在只有**一条**（就是当前仓库），`data-repo` 仍是它的路径；
  下拉是 `git-history-picker`。已有的「按仓库找行」的写法改成先 `selectOption`。

## 38. `0.0.6` 之后：还没提交过的仓库不是一个错误（已计入 `0.0.7`，与 §37 同一档）

> 2026-10-28。用户报：**第一层目录不是 git 仓库时会报**
> `EIO: git failed: fatal: your current branch 'master' does not have any commits yet`。
> 契约号不动（§6）：没有新增服务、没有改签名；变的是 **§3.2 里三个方法在「unborn 分支」上的答案**
> （从 `EIO` 变成空历史 / 全新文件），以及历史视图的一个空态。

| 条款 | 本档之前 | 本档 |
|---|---|---|
| `log()` 在没有提交的仓库上 | git 退出码非 0 → `EIO`（整个历史视图变成错误框） | `[]`：没有历史是答案，不是故障 |
| `diff({ base: 'HEAD' })` 同上 | `fatal: bad revision 'HEAD'` → 每一项带 `error: EIO` | 每一项 `kind: 'added'`、**无 `text`**（照未跟踪文件那条路，渲染器读文件本身） |
| `diff({ base: 'index' })` 同上 | `git diff --cached HEAD` → `EIO` | 可用：`--cached` **不带** `HEAD`，比较对象是空树 |
| `show` / `showCommit` / `blob` 带 `HEAD` | `ENOENT` | 不变（确实没有这个提交） |
| 历史视图里某个仓库没有提交 | 整栏一个错误框 | 下拉照常列出它，选中时写「这个仓库还没有提交」（`git-history-empty`） |

**没有变的东西**：`ctx.git` 的方法与上限、错误码表（`EIO` 仍是「git 进程失败」，只是这一种失败
不再发生）、`#history` 的语义、仓库发现。

细则：

- **为什么先问 `rev-parse` 而不是匹配 stderr**：`log` 的失败信息是本地化的（`LC_ALL=C` 让它在
  这里稳定，但按文本判断仍然是脆的），而 `rev-parse --verify --quiet HEAD^{commit}` 的退出码就是
  这个状态的定义。一次额外的进程调用换掉一条正则。
- **为什么 `diff` 不给「对着空树」的真实 diff**：那会把整棵工作区渲染成一份巨大的 patch（每个文件
  都是 `new file mode`），而读者要看的是**这个文件现在是什么**——那本来就是「新增且没有 diff 文本」
  这条既有形状（`ctx.fs` 读文件，渲染器合成 addition）。
- **`--cached` 去掉 `HEAD` 是净改进**：`git diff --cached` 的缺省比较对象就是 `HEAD`（没有 HEAD
  时是空树），所以对普通仓库行为一模一样，对 unborn 仓库才有答案。这一条在两种仓库上都对，
  所以不留分支。
- **`show` 一族的 `ENOENT` 不变**：那里问的是「某个提交」，而没有提交就是没有；把它变成空答案
  只会让「你点了一个不存在的提交」和「这个仓库还没有提交」混在一起。

## 39. `0.0.6` 之后：行号、`:行号` 与跳转到行（已计入 `0.0.7`，与 §37、§38 同一档）

> 2026-10-29。用户要求四件事，其实是**同一条链**：① 文本渲染器能显示 / 隐藏**行号**；
> ② `mod+p` 的文件名后面可以接 `:行号` / `:行号范围`，打开就定位并**闪烁**；③ palette 里以 `:`
> 开头表示 go to line；④ 按 `:` 直接打开 palette 并填上 `:`。契约号不动（§6）：没有新增内核服务、
> 没有加座位、没有改 `ctx.*` 签名。变的是 **§3.9 的 reveal store 形状**（区间 + 闪烁）、**§3.7 的
> 命令表**（两条）、`diorama-ui` 的导出，以及 `code` / `plaintext` 两个渲染器的行形态。

| 条款 | 本档之前 | 本档 |
|---|---|---|
| 文本渲染器的行 | 一整块 `<pre>` + 一段 HTML | **一行一个元素**（`.diorama-line`），行号是它的第一格 |
| 行号显示 | 无 | 有，**默认开**；偏好记在 `localStorage`（`diorama.lineNumbers`） |
| 行号状态 | — | 页面全局 store（`diorama-ui` 的 `lineNumbersStore`），两个渲染器与命令共读一份 |
| 行号入口 | — | 渲染器自己头部的一颗开关按钮 + 命令 `view.toggleLineNumbers`（palette） |
| reveal 的目标 | 单行 | **区间**：`line`…`endLine`（闭区间），闭区间两端都画带 |
| reveal 的高亮带 | 常驻 | 常驻（搜索命中）或 `flash: true` 一次性淡出（跳转到行） |
| `mod+p` 的输入 | 文件名（子序列匹配） | 另认 `path:42` / `path:42-60`：**最后一个冒号**后面是行号才切分 |
| `mod+p` 里只打 `:42` | — | 一行「跳转到第 42 行」排在文件列表前面，落点是**活动 tab** |
| palette 的 `:` | 按命令名过滤 | **go to line 模式**：`:42` / `:42-60`，列一行「跳转到第 N 行」 |
| `:` 键 | — | `shift+;` 打开 palette 并**预填 `:`**（命令 `palette.goToLine`） |
| 超出文件末尾 | — | **夹到末行**并照常闪烁（读者说的是「到结尾」，静默失败像坏键） |
| 圈选多行的样式 | 浏览器自己的高亮（按 inline box 画：每行一条、长度各异） | **自己画**：原生高亮透明，按选区覆盖的行填整行 / 实测局部，相邻行接成一整块 |

**没有变的东西**：tab 仍只带路径（§3.4）；行号仍走页面全局而不是内核服务；搜索命中的落点仍是
常驻带；Markdown / 图片 / PDF 仍不支持跳行（它们的渲染不保源文件行号）；diff 的三档读法与它自己
的行号槽（§5.2）不受影响。

细则：

- **为什么行号要按行渲染**：行号需要一个**每行一个**的元素（`counter` 只能数元素，不能数文本里的
  `\n`）。`code` 用现成的 `highlightLines()`（m19 已让每行是一个自足片段：跨行的块注释在断行处
  闭合、下一行重开），`plaintext` 按 `\n` 切。顺带的好处是范围带落在行元素上，不再靠
  `行号 × 行高` 算位置。
- **代价说清楚**：大文件从「一个 `<pre>` 一块 HTML」变成「N 个元素」。可读上限本来就是
  `MAX_TEXT_BYTES`（8 MiB），而一个几千行的源码文件在浏览器里仍是常态；真要更大的文件，该动的是
  虚拟滚动，不是退回单块。
- **为什么行号是页面全局**：`code` 与 `plaintext` 是两个半边（各自一份 bundle），命令是第三个半边。
  模块对象会变成三份互不相干的答案；`__diorama_reveal__` / `__diorama_overlay__` /
  `__diorama_layout__` 是同一条规矩。
- **为什么默认开**：行号是编辑器的默认，也是本档所有功能的坐标系（`:42` 对着它数）；默认关会让
  「跳转到第 42 行」在第一次使用时看不见自己跳到了哪。
- **闪烁 vs 常驻**：搜索命中是「你回来读这一行」，带要留着；跳转到行是「带你到这儿」，带淡出后
  只剩文字，读者接着读。两者是同一个 store 的一个布尔值（`flash`），不是两套机制。
- **为什么只认 `:` 不认全角 `：`**：用户明确只认半角。输入法打出的全角冒号不是这个语法的一部分，
  它会被当成文件名的一个字符（匹配不到就是空列表，与打错任何字一样）。
- **为什么 palette 的 `:` 不是一条动态命令**：命令 id 是注册表里的稳定标识（§3.7），而 `:42` 的
  目标每一帧都在变。palette 在自己的输入上做模式判断，列出的那一行只是「Enter 会做什么」的说明。
- **`shift+;` 而不是 `:`**：绑定写的是**键帽**（§3.7 的 `SHIFTED` 表：⇧; 打出 `:`），写 `:` 在
  一个没有 ⇧ 的事件上永远不匹配。
- **`mod+p` 的解析是「最后一个冒号 + 合法行号」**：路径本身可以带冒号（Windows 盘符、时间戳、
  自定义扩展名），所以只有「后面确实是行号」才切分；`app.ts:` 这种打到一半的状态仍是文件名。
- **范围两端都夹**：`8-999` 在十行的文件里是 8–10，不是一个空区间，也不是整行不画。
- **为什么选区要自己画**：按行渲染之后，浏览器的高亮画在**每个 inline box** 上——行号格被
  `user-select: none` 跳过、每行文字长短不一、行与行之间还隔着块边界，于是一次跨行选择读起来是
  「一堆互不相干的条」。编辑器都是自己画的，这里也一样：原生高亮在读者里**透明**（文字照常可选中、
  可复制、可搜索），`selectionchange` 把 DOM Range 换成**行的矩形**——被整行覆盖的画满整行（这才是
  相邻行接成一块的原因），只覆盖一部分的按**实测**的起止位置画。用实测而不是 `ch`：行里有 tab、
  字体也不保证正好一个 `ch` 宽。

## 待定清单（v0.4 后仍 🔲）

- [x] `ctx.git` 具体签名（只读：diff / status / log）— v0.5 定（§3.2）
- [x] git history 视图（`show` / 提交列表在左栏的落点）— v0.6 定（§3.2、§5、§5.2）
- [ ] `ctx.layout` 的服务面（overlay 走 slot）
- [ ] `ctx.storage` 签名（跨 mount 的偏好同步）— 待定（主题偏好在 v0.9 已落浏览器 `localStorage`，§3.10；服务端同步留给 K14）
- [ ] 插件异步任务托管 API — 待定
- [x] O8 的 diff 部分：v0.10 定了**三档读法**（行内 / 整文件单栏 / 新旧双栏）+ 变更块间导航，开关归渲染器头部（§23）；图片缩放、Markdown 源码/预览仍在 O8 里
- [ ] URL 里是否记多 tab（刷新恢复整组）— 与 U10 一起定
- [x] 窗格可拖动 / 长名字可横向滚动 — v0.11 定（§5.2、§25）
- [x] 侧栏可收起（只剩切换器）— v0.13 定（§5.2、§3.7、§29）
- [x] diff 的单栏 / 双栏加语法高亮 — v0.14 定（§5.2、§30）：引擎由 `code` 发布到页面，
  `git-changes` 读它；行内那档是 git 的文本，不上色
- [x] 快捷键能力增强（按序号跳 tab、按住修饰键显示快捷键）— v0.15 定、v0.16 按 cmux 的体验重做
  （§3.7、§5.2、§31）：键位对齐 IDE（`mod+w` / `mod+1..9` / `mod+shift+[ ]`）；提示只显示关键键
  （tab 的 `⌘<n>` 与切换器的 `⌘⌥<n>`），以**浮层标签**出现，不改变任何控件的几何；
  提示状态在页面全局 `__diorama_keys__`
- [x] RPC 断线自动重连与订阅重放 — v0.11 定（§4、§26）
- [x] Markdown 的大纲 / 公式 / 图表 — v0.12 定（§5.1、§27）；`$` 的判定、Mermaid 的主题跟随、
  以及「大纲放在文档里而不是侧栏」也一并定了
- [ ] 外部插件的发现、bundle 校验、`--plugins-dir` — 最后一个里程碑
- [ ] gateway 控制面事件的 CLI 消费者（`diorama ls --watch`）— 以后再定（协议已定，见 §7.3）
- [ ] gateway 单点的 supervisor 兜底（崩溃自拉起，O6）— 以后再定
- [ ] 挂载持久化（gateway 重启后恢复 mount）— **明确不做**（architecture.md §10）
- [x] palette 附录文件检索（`Ctrl+P`）— v0.8 定：**不是 palette 的一部分**，是 `search-view` 的独立覆盖层（§3.9）
- [ ] `.gitignore` 是否纳入隐藏规则 — 以后再定
- [ ] 多 tab 状态持久化（刷新后恢复）— O5
