# 插件契约 v0.2

> 记录于 2026-10-18（v0.1 草案已归档为 [contract-v0.1.md](contract-v0.1.md)）。
> 契约先行：这份文档是内核与插件之间的唯一约定，改它 = 破环变更。
>
> **状态：v0.2 已定稿，M1 按它实现。** 与 v0.1 的差异都是 M1 决策（见 §12）。
> 内核契约版本 `0.2`，所有插件声明 `contract: ">=0.2 <0.3"`；内核**已启用**范围检查（§6）。

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
    "contract": ">=0.2 <0.3",                     // 必须：兼容的内核契约范围（§6）
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
- `id` 冲突时：内置插件优先，外部同名插件拒绝加载并报错。
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

### 3.1 `ctx.fs`（server + client 半边）✅ v0.2 定

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
- **`watch`（签名现在定，实现 M2）**：文件级/目录级，内核做 debounce（100ms）。事件：

  ```ts
  type FsWatchEvent = { type: 'change' | 'add' | 'unlink'; path: RelPath }
  ```

  M1 内核的 `watch` 返回 disposer，但**不产生事件**（实现随 M2）；client 半边通过 RPC 订阅的事件形态在 M2 定（§4）。
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
- M1 的 `ctx.tabs` 仍是 M0 的单 tab 语义（`open` / `close` / `active` / `getSnapshot`），多 tab 在 M2；`ctx.layout` 未定、M1 不提供。

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

### 3.7 `ctx.commands`（client）— M2

快捷键与 command palette 共用同一套命令模型。**注册表只有一个；快捷键是绑定，palette 是它的检索界面。** M1 不实现，形态见 v0.1 §3.7。

## 4. RPC / 通信 ✅ v0.2 定

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
// server → client
{ type: 'result', id: number, value: unknown }          // 二进制值以 base64 呈现（见下）
{ type: 'error', id: number, code: string, message: string }
{ type: 'event', topic: string, payload: unknown }      // M2 起的推送
```

**方法发现与边界**

- 服务对象必须提供 `describe(): MethodDescriptor[]`，`method` 只允许 `describe()` 列出的名字；其余一律 `EMETHOD`。
- 参数一律被视为**不可信输入**，服务自己校验（`ctx.fs` 先校验再碰磁盘）。
- 未知服务 → `ESERVICE`；方法执行抛错且无 `code` → `EIO`；带 `code` 的错误原样映射（`EINVAL`、`EOUTSIDE`、…）。
- **`Uint8Array` 过 JSON**：RPC 信封在 `value` 中把 `Uint8Array` 表示为 `{ $bytes: base64 }`，client 端还原为 `Uint8Array`。这是 M1 二进制唯一的跨线表示。
- 连接在页面 boot 时建立；服务端**先于**页面读取准备好（fs 在 mount 时已就绪）。连接失败 = 该页的 fs 调用全部 `ESERVICE`（fail loud，不静默兜底）。

**与 M0 的关系**：M0 的 `GET /api/fs/list`、`/api/fs/read` **删除**。`/plugin.json`、`/plugins/<id>.js`、`/__diorama__/*` 仍是 HTTP。

## 5. slot 清单

| slot | 类型 | 声明者 | 条目 | 说明 |
|---|---|---|---|---|
| `root` | 单 | 内核 | 1 | 整个页面 |
| `layout.main` | 单 | `layout` | 1 | 左右分栏 |
| `sidebar.tree` | 单 | `layout` | 1 | 左侧导航 |
| `tabs.content` | keyed | `tabs` | N | 每个 tab 的内容区（key = tab id） |
| `file.renderer` | keyed（内部排序） | `renderer-registry` | N | 按文件类型派发；M1 起带 matcher（§5.1） |

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

- 内核版本 `0.x` 期间：**minor 改动即破环**，插件写窄范围（`>=0.2 <0.3`）。
- **检查时间**：读 manifest 时（加载前）。不满足 → 拒绝加载该插件，并解释原因（终端 + 浏览器控制台）。
- 内置插件同样检查：M0 遗留的 `>=0.1 <0.2` 会被内核拒绝，所以 M1 把所有内置插件升到 `>=0.2 <0.3`。
- M1 内核**没有**外部插件，因此"UI 显示「插件 X 因契约不兼容未加载」"的展示面随外部插件一起推迟；拒绝本身仍然 fail loud（CLI 退出码非 0 / boot 图里不出现）。

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

## 待定清单（v0.2 后仍 🔲）

- [ ] `ctx.git` 具体签名（只读：diff / status / log）— M4
- [ ] `fs.watch` 的实现与 RPC 事件形态（签名已定）— M2
- [ ] `ctx.commands` / palette — M2
- [ ] `ctx.storage` 签名 — 待定
- [ ] 插件异步任务托管 API — 待定
- [ ] O8：渲染模式切换 / 图片缩放 / diff 并排的落点
- [ ] 外部插件的发现、bundle 校验、`--plugins-dir` — 最后一个里程碑
- [ ] gateway 控制面事件订阅 — M3
