# M0 实现说明（补充契约）

> 记录于 2026-10-18。plan.md 要求「遇到契约未定处先问，不自行决定」。本文只收录
> **契约文档（contract.md）未覆盖、经确认后**在 M0 实现里落地的决定，以及由此新增/调整的
> API 形状。它不是新契约：M1 起任何 `ctx.*` 或 slot 签名的正式变更仍走 contract.md
> 与 contract version。
>
> 状态：**M0 已确认**。每条都注明来自哪里，方便将来回填 contract.md。

## 0. 环境决定

| 项 | 决定 | 备注 |
|---|---|---|
| 插件框架 | npm `cordis@4.0.0-rc.11`（单包） | 与 architecture.md 同日；插件里 `import { Context } from 'cordis'` 原样成立 |
| Workspace | pnpm workspace，照搬 DSH 分层：`packages/*` + `apps/*` | 每个插件一个包，package.json 带 `diorama` 字段 |
| 装配 | 内置清单 + 编译期静态 import；**不做动态 bundle** | plan.md「先静态 import 插件」 |
| 缺 `name` 的服务端插件 | `logger.error` 并跳过，其余插件继续，退出时非 0 | 验收点 5 |
| `diorama [dir]` | 省略 dir = 当前目录 | plan.md 演示脚本 |
| 验证实例根目录 | 仓库内 `.diorama-verify/`（gitignore，每次启动重建） | 供 5 条验收与人工演示 |
| web 壳的失败展示 | 根 slot 为空或渲染抛错 → 壳全屏错误面板 | 验收点 2「不白屏」 |

## 1. slot 与 props（用户确认于 2026-10-18）

每个页面组件都收到 `mountCtx`（client 的能力句柄，见 §3）。

| slot | 类型 | 条目 props |
|---|---|---|
| `root` | 单 | `{ mountCtx }` |
| `layout.main` | 单 | `{}`（由 layout 的 `root` 条目渲染） |
| `sidebar.tree` | 单 | `{}`（同上） |
| `tabs.content` | keyed | `{ tab }`（M0 单 tab 语义，key 固定为唯一 tab 的 id） |
| `file.renderer` | **list**（M0） | `{ file: FileInfo, content: Uint8Array, mountCtx }` |

- **M0 的 `file.renderer` 是 list 形态**：按 `order` 升序，第一个「能渲染」的条目胜出；
  matcher（`ext`）与「plaintext 不参与匹配」属于 M1。
- **渲染器不直接 IO**：`content` 由内核预先读好；渲染器不得自己发文件请求。
- **跨插件协作只走服务，不走 props**：树点击 → `ctx.tabs.open(file)`；
  `ctx.tree.onSelect(cb)`（§3.4）。

## 2. 数据类型（客户端契约）

```ts
/** 挂载根下的相对路径，以 `/` 分隔，不带前导 `/`。 */
type RelPath = string

interface FileInfo {
  path: RelPath
  name: string
  kind: 'file' | 'dir'
  /** 字节数；目录为 0。 */
  size: number
  /** 毫秒时间戳。 */
  mtime: number
}

interface TabInfo {
  id: string
  file: FileInfo
}
```

- `mtime` 用 **number（ms）**：JSON 友好、可直接比较（confirm 于 2026-10-18）。
- M0 目录列举**不过滤**任何条目（`.git`、`node_modules`、隐藏文件全部列出）；隐藏规则在 M2。
- 二进制：`readText` 遇到含 NUL 的内容拒绝并返回 `EBINARY`，页面显示
  「二进制文件，无法以文本显示」（confirm 于 2026-10-18）。

## 3. 客户端服务与槽外兜底

### 3.1 `ctx.slots`（contract §3.3 的实现形态）

```ts
ctx.slots.register(
  { id: string, name: SlotName, order?: number, key?: string },
  Component: (props) => JSX.Element,
): () => void
```

- 返回 disposer；插件卸载时自动清理。
- **`id` 必填**（全局唯一，全局唯一性 = 注册冲突检测的依据）。
- 冲突处理 **M0 取 fail loud**：同一 `(name, key)` 或同一 `id` 重复注册 → warn 并拒绝，
  不替换、不静默覆盖。
- 条目组件渲染抛错 → 该 slot 视为失败，由渲染它的地方兜底（见 §3.3）。

### 3.2 `ctx.views`（内核服务，M0 新增）

> 原因：「移除 plaintext 显示无可用渲染器」（验收点 2）、「移除 file-tree 只剩右侧空白」
> （验收点 3）这两个要求在 M0 的 list slot 下，需要组件**知道**「没有条目」与
> 「条目抛错」。合同里没有表达这个的槽外服务，M0 先加最小面：

```ts
ctx.views.useSlot<T>(name: SlotName, props): SlotEntry<T>[]   // 按 order 升序的快照
```

- 只读；配合 `useSyncExternalStore` 使用；注册/注销会通知订阅者。
- 条目结构：`{ id, order, key?, Component, failed? }`（`failed` 表示该条目渲染时抛过错）。

### 3.3 根与内容分派的错误边界（壳负责）

- 壳渲染 `root`：没有条目，或条目渲染抛错 → **全屏错误面板**，列出失败原因。
- `renderer-registry` 渲染 `file.renderer`：无条目 → 「无可用渲染器」；条目抛错 →
  标记失败并尝试下一个；全失败 → 显示原因。
- `layout` 渲染 `layout.main` / `sidebar.tree`：没有条目 → 不渲染该栏；条目抛错 →
  该栏显示错误占位（另一栏不受影响）。
- `tabs` 渲染 `tabs.content`：同 `layout`。

### 3.4 `ctx.tabs` / `ctx.tree`（client，M0 最小面）

```ts
ctx.tabs.open(file: FileInfo): void      // M0：同一 tab 内替换
ctx.tabs.active(): { tab?: TabInfo }      // 响应式读取（useSyncExternalStore）
ctx.tree.onSelect(cb: (file: FileInfo) => void): () => void
```

- `tabs` 只负责打开与切换，**不提供编辑**（contract §3.4）。
- 文件列表与读取由 **`file-tree` 持有并负责**：它调用 `mountCtx.fs`（§4），把
  `FileInfo` 交给 `ctx.tabs.open`。`tabs` 只是一个不依赖 fs 的壳。

## 4. `ctx.fs`（client 半边，M0 最小面）

两端各有一份同名服务的**半边**：

```ts
// server 半边（由内核挂载时提供，磁盘访问唯一入口）
ctx.fs.list(path: RelPath): Promise<FileInfo[]>
ctx.fs.readText(path: RelPath): Promise<string>

// client 半边（mountCtx.fs）
mountCtx.fs.list(path: RelPath): Promise<FileInfo[]>
mountCtx.fs.readText(path: RelPath): Promise<string>
```

服务端方法名与 contract §3.1 一致（`list` / `readText`）。**在 M0 定下的传输形状（临时）：**

```
GET /api/fs/list?path=<rel>
  200 → { entries: FileInfo[] }
GET /api/fs/read?path=<rel>
  200 → { path, size, mtime, encoding: 'utf-8', text }
  415 → { error: { code: 'EBINARY', message } }      // 含 NUL
  403 → { error: { code: 'EOUTSIDE', message } }     // 越出挂载根
  404 → { error: { code: 'ENOENT', message } }
  400 → { error: { code: 'EISDIR' | 'ENOTDIR' | 'EBADPATH', message } }
  500 → { error: { code: 'EIO', message } }
```

- `path` 必须是相对路径；内核解析后必须仍在挂载根内（`realpath` 校验）。
- 该 HTTP 形状是 M0 的「最土的方式」，**M1 设计 RPC 后替换，且必须同时更新 contract.md**。
- server 半边**不暴露** `node:fs`；`FileInfo` 不含 Node 的 `Dirent` / `Stats`。

## 5. 服务端插件与本进程边界

- 所有插件都是**真 Cordis 插件**：`export const name`、可选 `inject`、`apply(ctx, config)`。
- 缺 `name` 的插件：内核 `logger.error` 指出是哪个插件（`apply` 函数名 + 包 specifier），
  跳过它，记录一条失败。
- 内核在 mount 的 fork ctx 上 `ctx.set('fs', instance)`（contract §2.5）。
- 当前**没有 server 半边**的插件（全部内置插件在 M0 都只有 client 半边），因此服务端
  只负责：插件校验、`ctx.fs` 服务、RPC、静态资源。浏览器里编译期要求的
  「插件注册面必须是真的」在 §6 的 client 内核里落实。

## 6. client 内核（浏览器）

- `diorama-plugin-application`（`packages/builtin`）是**静态装配清单**：
  `import { apply as layout } from 'diorama-plugin-layout'` … 逐条给内核校验 `name` 后
  `ctx.plugin(...)`。
- 浏览器 bootstrap 把 bundle 内部模块表交给插件：插件由壳项目（`apps/web`）的构建
  统一编译，**不依赖 `window.__ModuleLoader__`**（那是 M1）。
- 对浏览器半边的静态检查：loader 读取每个内置插件包 package.json 的
  `diorama.client.entry`，确认文件存在；否则报错并中止 boot（fail loud）。
- Cordis 的 browser build 不需要 Node 依赖；React 通过 `packages/ui` 的渲染器挂载。

## 7. 内置插件清单（M0）

| id | 半边 | 注册 | 依赖 |
|---|---|---|---|
| `layout` | client | `root` + 声明 `layout.main`、`sidebar.tree` | `slots` |
| `file-tree` | client | `sidebar.tree` | `slots`、`tree`、`tabs`、`mounts` |
| `tabs` | client | `tabs.content` | `slots`、`views`、`mounts` |
| `renderer-registry` | client | `file.renderer` 派发 | `slots`、`views`、`mounts` |
| `plaintext` | client | `file.renderer`（无 matcher） | `slots` |

- `renderer-registry` 不依赖 `tabs`：它读活动 tab，自己发文件请求；`tabs` 不依赖 fs。
- 每个包都在 package.json 里带 `diorama` manifest（`contract: ">=0.1 <0.2"`、`id` 等）。

## 8. 响应式约定

- 组件不持有业务状态：`file-tree` 的目录展开/选中、`tabs` 的活动 tab、`tabs` 的
  文件内容，全部由服务（`ctx.tree` / `ctx.tabs` / 请求）通过
  `useSyncExternalStore` 暴露的不可变快照驱动（architecture §2）。
- 组件只读 `mountCtx` 与自身 props，不读全局 `ctx`（contract §2.5）。

## 9. M0 验收的自动化

`apps/web/tests/` 下 Playwright 用例对着**真实进程**跑（`diorama <临时目录>`），覆盖
plan.md 的 5 条验收点；场景通过 CLI 的环境变量/`--plugins` 开关复现，不改源码：

| 开关 | 作用 | 用于验收点 |
|---|---|---|
| `diorama <dir>`（默认清单） | 打印 URL、左右分栏、点文件换内容 | 1 |
| `--plugins` 去掉 `plaintext` | 「无可用渲染器」 | 2 |
| `--plugins` 去掉 `file-tree` | 只剩右侧空白 | 3 |
| 两次 `diorama <dirA>` / `<dirB>` | 目录是数据 | 4 |
| `--break-plugin <id>:name` | 模拟插件漏写 `name` | 5 |

## 10. 实现记录与未决问题（2026-10-18 实现过程中）

### 10.1 已成立并通过验证

| 项 | 证据 |
|---|---|
| `diorama <dir> --port --host` 打印 URL、前台运行 | 手动启动，`diorama serving … http://127.0.0.1:4731/` |
| `ctx.fs` 只读服务 + `/api/fs/list` / `/api/fs/read` | curl 验证；越界 `403 EOUTSIDE`，二进制 `415 EBINARY`，缺失 `404 ENOENT` |
| 服务端插件校验 fail loud + 跳过其余插件 | `--break-plugin plaintext:name` → 日志指出插件并继续 |
| `--dump-plan` 输出 boot 图 | 含每个插件的 `id / name / clientUrl / clientEntry` |
| React 树、slot 注册、错误边界、失败面板 | 页面上 layout 分栏可渲染（`data-layout="split"`），无白屏 |

### 10.2 Cordis 4.0.0-rc.11 的实测事实（影响契约）

1. **子 ctx 上发布的 record 对其他 ctx 不可见**：`ctx.set()` 只对 root ctx 生效，插件拿到的子 ctx 上 `set` 会抛
   `cannot set property ... without provide`；`defineProperty` 能写，但别的 ctx 读不到。
   ⇒ `slotRegistry` 这类"槽外服务"只能是 root 上的 **service**（`ctx.provide`），不能是 record。
2. **插件 `apply` 返回 ≠ fiber 就绪**：`apply` 作为 fiber effect 执行；内核需对每个 fiber `await fiber.await()` 才能保证顺序。
3. **`skipLibCheck` 会吞掉 Cordis 自带的 `declare module './context'` 增强**，导致 `ctx.plugin/set` 不可见。仓库已关闭该选项。
4. **客户端半边被独立打包时会各自内联一份依赖**：`diorama-kernel/client` 内的"页面桥"因此不是同一份。
   ⇒ 客户端半边**不能**在模块级持有跨包共享状态；共享面只能是（a）root 上的 service，或（b）稳定的全局对象。

### 10.3 已定：客户端半边通过最小模块表加载（A 方案，2026-10-18）

**决定**：M0 就把 M1 的模块表做成最小版——客户端半边不再被 Vite 静态 import，
而是像 DSH 一样以 `window.__ModuleLoader__.load({ id, factory })` 注册自己，
`factory(require)` 通过模块表解析平台词与跨包 import。

**线协议（M0 最小版，照 DSH 的形状裁剪）**

```ts
// 半边的构建产物形状
window.__ModuleLoader__.load({
  id: 'layout',                         // = 插件 id
  factory: (require) => { /* bundle body */ return exports },
})
```

```ts
// require 只回答"模块表"里的条目；其余一律报错（fail loud）
type ModuleTable = Record<string, unknown>
// M0 的表：'react' | 'react/jsx-runtime' | 'react-dom' | 'react-dom/client' | 'cordis'
//        | 'diorama-kernel/client' | 'diorama-ui' | 'diorama-plugin-slots'
```

- **表由壳（apps/web）提供**：壳是唯一持有这些模块实例的地方，所以全页只有一份 React、一份
  `diorama-ui`、一份页面桥（见 §10.2 事实 4）。客户端半边对这些 specifier 一律 `external`，构建为 CJS 风格
  `require` 调用，由 `factory(require)` 在加载时解析。
- **加载顺序**：壳读 `/plugin.json` → 先注册表 → 按 `plugins[]` 顺序串行加载每个半边的
  `<script src=clientUrl>`（`load` 先入队，再按 id 取工厂执行）→ 再 `bootClient` 注册到 Cordis。
  加载失败 = 该半边 `failures` 记一条（fail loud），继续下一个。
- **静态 import 的边界**：插件列表仍是编译期的（`packages/cli/src/plugins-server.ts`），
  改变的是"客户端半边怎么到浏览器"——从静态 import 变成模块表加载。plan.md 的
  "先静态 import 插件，不做动态 bundle"约束的是**清单**（哪些插件存在），这一点没变；
  动态发现外部插件仍留 M1。
- 服务端插件树不变（仍是静态 import + Cordis 校验）。

### 10.4 原未决问题（已由 10.3 解决，保留记录）

页面引导与 UI 组合的**模块边界**：槽条目组件来自各插件包的内联构建，而壳渲染器来自壳自己的构建。
"渲染某个 seat"的渲染器实例、`ctx.views` 订阅、React context 三者跨这条边界时都不保证同一性。
试过并失败（或只能部分工作）的路径：source 别名、统一构建 ui 包、全局页面桥（内联副本无法安装）、
把插件树放进 React 树内引导。

**候选方案**（都不改变契约里的 slot/service 语义）：

- **A. 客户端半边全部走模块表（M1 的 `__ModuleLoader__` 提前到 M0）**：服务端下发 boot 图，页面按 URL 加载每个半边，
  模块表保证 `diorama-ui` / `diorama-kernel/client` 全页只有一份。M0 只做最小版：静态 URL 表 + 一份共享入口。
- **B. 槽渲染下沉到"持槽组件"自带的渲染器**：不再由壳渲染 `root`，每个持槽插件用自己的 `<Slot>`（各自内联）渲染自己的子槽；
  代价是"回退链/空白槽"的呈现由各插件负责，验收点 2/3 的呈现需要重新定义。
- **C. 壳只渲染失败面板，页面组合交给一个内置 `app` 插件**：由 `app` 插件（与其它半边同一构建批次内联渲染器）渲染 `root`，
  壳只负责加载与失败展示。验收点 2 的"无可用渲染器"由 `app` 内联的渲染器呈现。

### 10.5 模块表实现进展（2026-10-18 第二轮末）

已落地（可复跑）：

- 半边构建：每个插件包产出两个产物——`lib/index.mjs`（Node 侧加载，给服务端 Cordis 树）与
  `lib/client.cjs`（`window.__ModuleLoader__.load({ id, factory })` 闭包工厂，`require` 留给模块表）。
- 服务端：`/__diorama__/import-map.js`（生成 importmap）、`/__diorama__/table/<spec>.js`（虚拟模块，
  从 `globalThis.__diorama_table__` 再导出）、`/plugins/<id>.js`（半边，`text/javascript`）；
  壳 HTML 注入顺序为 **importmap → page-table → 壳入口**。
- 壳：入口外壳只 2.7 KB，全部表内 specifier 都是裸导入，由 import map 解析；`page-table` 单独打包成
  261 KB 的块，负责把真实实例写进 `globalThis.__diorama_table__`。

**仍未通过**：浏览器里 `globalThis.__diorama_table__` 仍为空、两个模块脚本都报
"the page table has no react"。排查记录：脚本顺序正确、import map 已生效（7 个虚拟模块都被请求）、
page-table 块内确有 `globalThis.__diorama_table__ = {...}`，但它在模块求值阶段抛错 →
表赋值未执行。即 **table 块自身被 import map 解析到了虚拟模块**，形成自引用。

### 10.6 这暴露的契约空洞（需要你拍板）

contract.md 从未定义**浏览器里的模块身份规则**：哪些包由内核提供单例、哪个包**不得**经由该单例解析、
以及引导顺序（谁先于模块表求值）。M0 试了三种形状（源码别名 / 各包内联 / import map + 虚拟模块），
每种都会在这个未定义的点上撞墙。

我建议在 contract.md 增加一节 **§8 客户端模块表**，写死：

1. **表成员（内核提供单例）**：`react`、`react/jsx-runtime`、`react-dom`、`cordis`、
   `diorama-kernel/client`、`diorama-ui`、`diorama-plugin-slots`。
2. **自举例外**：`diorama-ui` 与 `diorama-plugin-slots` 的**提供者**（即内核的 page-table 入口）
   必须从**真实包**导入，不走表；它们对外暴露的一切都经表。
3. **顺序**：importmap → page-table（自举，真实导入）→ 壳 → 各半边；任何模块脚本都不早于 importmap。
4. **半边的唯一依赖形状**：`factory(require)`，`require` 只回答表成员，其余内联。

请你确认这四条（或给出修正），我按契约把它一次写清并落地；这是我在 M0 剩下的唯一阻塞点。

### 10.7 第二轮结论（2026-10-18 晚）

**已落地并验证的服务端（可复跑）：**

| 验收点 | 状态 | 证据 |
|---|---|---|
| 1 `diorama .` 打印 URL | ✅ | `diorama serving … http://127.0.0.1:4731/` |
| 4 换目录无需改代码 | ✅（服务端） | `/plugin.json` 的 `root` 随 `diorama <dir>` 变化；`/api/fs/*` 跟随 |
| 5 插件漏 name fail loud | ✅（服务端） | `--break-plugin plaintext:name` 报出插件名并跳过 |
| 2 移除 plaintext → "无可用渲染器" | ❌ 未验证 | 需 UI |
| 3 移除 file-tree → 只剩右侧空白 | ❌ 未验证 | layout 能渲染，但 seat 内容未出现 |

服务端 API：`/api/fs/list`、`/api/fs/read`、`/plugin.json`、`/plugins/<id>.js`、
`/__diorama__/page.js`（页面桥）。越界 403、二进制 415、缺失 404 均已 curl 验证。

**前端现状（诚实记录）：** React 能渲染 layout 骨架（`data-layout="split"` 两栏），
`ctx.views.entries('sidebar.tree')` 在页面上下文里返回 1 条、owner 正确、桥监听器 8 个、
`useKernel` 能随版本重渲染；但 layout 半边的 `<Slot>` 始终渲染出空内容，
强制刷新也不改变。已验证排除：槽注册、`views` 接口、桥身份（已改为全局单例并由服务端
`/__diorama__/page.js` 预先安装）、props 不稳定导致的重挂载。

**架构取舍（用户已授权由我决定）：** 保留“客户端半边闭合工厂 + 服务端注入页面桥”的形状；
M0 的 UI 问题定位在 layout 半边对 `Slot` 的渲染路径上，尚未定位到具体行。
下一步只有两条：逐行对比 `packages/plugins/layout/lib/client.cjs` 的 `<Slot>` 与
`packages/ui/lib/index.js` 的差异（最小复现），或把 slot 渲染改由**壳**直接完成（layout
只声明座位）。

**测试**（plan M0 要求 e2e 覆盖 2–4、全 5 条）尚未建立，`apps/web/tests/` 仍是空的。

### 10.8 第三轮：根因已定位（2026-10-18 夜）

**已定位的前端阻塞链（逐条实测）：**

1. `Slot` 渲染分支里出现 `<Slot name="sidebar.tree">` 套在自身渲染结果里（layout 的
   `SplitFrame.render` 里又渲染了 `TreeColumn`），导致同一 seat 递归 → 空内容。
   **已修**：`SplitFrame.render` 现在直接挂载 seat 条目，树列不再二次读同一 seat。
2. 修复后条目组件**首次被真正挂载**（`solot entry failed` 从挂载过程冒出来即证明）。
3. 新的阻塞点：组件里拿到的 `ctx` 是**插件自己的 fork ctx**，其 `ctx.tree` / `ctx.tabs`
   在读的时刻不可见（`Cannot read properties of undefined (reading 'onSelect')`）。
   内核已改为把 **page handle 的 ctx 指向一个能看见全部 provision 的子 ctx**
   （`ctx.extend()`），但组件实际读到的仍是插件 ctx——下一次要把组件取 ctx 的方式
   改成从 page handle 取（`useKernel().ctx` 已是子 ctx，但插件 ctx 的读法还没统一）。

**目前已通过的服务端验收（可复跑）**：验收点 1、4、5（详见 §10.7）；
`/api/fs/*`、越界 403、二进制 415、`--break-plugin <id>:name` 均验证。

**本轮新增：** `apps/web/tests/` 起一个 Playwright 验收脚手架，把 5 条验收点逐条写成用例
（先跑服务端可验证的三条，UI 两条标记为待修），这样下一轮可以直接看红绿。


## 11. M0 完成记录（2026-10-18 定稿）

### 11.1 验收结果（`pnpm --filter diorama-web exec playwright test`）

```
5 passed (1.5s)
  ✓ 1. diorama prints a URL and the page boots
  ✓ 4. switching the directory needs no code change
  ✓ 5. a plugin missing its name is reported and the rest still boot
  ✓ 2. removing plaintext shows "无可用渲染器" instead of a blank page
  ✓ 3. removing file-tree leaves only the right side
```

每个用例自己拉起真实 `diorama` 进程 + 真实 Chromium（`apps/web/tests/`）。
验收点 2/3 用 `--plugins` 复现，验收点 5 用 `--break-plugin <id>:name` 复现。

### 11.2 演示脚本（plan.md M0）

```
$ node packages/cli/bin/diorama .diorama-verify
diorama serving <abs path>
  http://127.0.0.1:4731/
  [mount:95f83fb3] plugins: slots, layout, file-tree, tabs, renderer-registry, plaintext
```

打开 URL：左树右文；点 `README.md` → 右侧等宽原文；点 `docs/notes.md` → 同一 tab 内替换。

### 11.3 客户端边界的最终结论（A 方案落地）

让前端反复失效的根因不是 slot 语义，而是**模块实例边界**。最终规则（实现即契约）：

1. **半边是闭合工厂**：每个插件包产出 `lib/index.mjs`（Node 侧，给服务端 Cordis 树）与
   `lib/client.cjs`（`window.__ModuleLoader__.load({ id, factory })`）。半边自包含，
   只有 `react` / `react/jsx-runtime` 由页面提供。
2. **页面状态只走页面桥**：`window.__diorama_page__`（服务端 `/__diorama__/page.js` 在壳之前
   注入），面为 `getKernel / getVersion / subscribe / install / notify`。任何一方**必须通过对象
   调方法**（React 会无接收者地调用 `subscribe`，内联副本的模块状态不是同一份）。
3. **服务面单一来源**：`tabs` / `tree` 的服务对象由内核工厂提供（`createTabsService` /
   `createTreeService`），半边只 `provide` 一个普通对象——Cordis 的 `hasInstance` 比较类身份，
   两份构建的同名类不相等。
4. **ctx 类型面集中**：客户端 `ctx.tabs` / `ctx.tree` / `ctx.mount` 在内核
   `client/context.ts` 声明一次，避免各半边各自声明的类型互不可见。
5. **页面句柄的 ctx 惰性取值**：`bootClient` 交给组件的 ctx 通过 `ctx.get` 解析后置服务
   （根 ctx 的裸属性读是固定的）。

### 11.4 前端实现过程中修掉的真缺陷（供 M1 参考）

| 症状 | 根因 |
|---|---|
| 页面白屏 / 插件不激活 | `skipLibCheck` 吞掉 Cordis 自带 `declare module './context'` |
| 半边加载即崩 | 半边内联了 React/renderer 副本；改为自包含 + 页面桥 |
| 无限重渲染（React #185） | seat 快照每次读都是新数组 + 嵌套同一 seat；改为按版本缓存快照、不在空态里再读同一 seat |
| 树挂载后无内容 | 条目组件的 `ctx` 是插件 fork ctx；服务改由内核工厂 provide，ctx 面集中声明 |
| layout.main 空白 | 座位只 `render={() => null}`，从未挂载条目 |

### 11.5 与 plan.md 的对照

| plan M0 项 | 状态 |
|---|---|
| CLI `diorama [dir] --port --host`，前台运行 | 完成（另有 `--plugins`、`--break-plugin`、`--dump-plan` 作为验收开关） |
| 服务端单目录、静态资源、`ctx.fs` 只读 | 完成（越界 403、二进制 415、缺失 404） |
| 内核：Cordis 双端、slot 注册、React 渲染器 | 完成 |
| 插件：layout / file-tree / tabs（单 tab）/ renderer-registry / plaintext | 完成 |
| 不做的：动态 bundle、多 tab、watch、快捷键、palette、markdown/code | 均未做 |
| 测试：至少 3 个端到端用例（验收点 2–4） | 完成，且 5 条全覆盖 |
| 文档：更新 features.md 档位 | 完成（C1/C4/C5/C8、K1/K6/K7/K8/K10、P1–P4/P7、U1 标注 ✅ M0）|

### 11.6 复跑方式

```bash
pnpm install
pnpm build                                        # kernel → slots → ui → 插件 → cli → apps/web
pnpm --filter diorama-web exec playwright test    # 5 条 M0 验收（真实进程 + Chromium）
node packages/cli/bin/diorama .diorama-verify  # 手动演示：打开打印出的 URL
```

验收开关：`--plugins a,b,c`（选择内置插件）、`--break-plugin <id>:name`（模拟漏写 `name`）、
`--dump-plan`（打印 boot 图 JSON）。

### 11.7 本地试用（link）

全局 `npm link` 在本机不可用：`~/.nvm/.../bin` 与 `lib/node_modules` 不可写（沙箱），且包是
private、依赖为 `workspace:*`。可行的两种方式：

1. **仓库内直接跑**（推荐，零安装）：

   ```bash
   source ./link.sh          # 构建并把 packages/cli/bin 加进当前 shell 的 PATH
   diorama .                 # 任意目录
   diorama --dump-plan
   ```

   `link.sh` 只影响当前 shell；改完源码后 `pnpm build` 即可，PATH 一直有效。

2. **在别的项目里当依赖 link**：

   ```bash
   npm link /path/to/diorama/packages/cli   # 或 npm install /path/to/diorama/packages/cli
   npx diorama .
   ```

   npm 会把 `packages/cli` 链过去；它运行时的依赖经 `packages/cli/node_modules` 指回仓库里的
   各 workspace 包，所以不需要去 registry 解析，也不需要发布。
