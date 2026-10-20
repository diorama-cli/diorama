# 实施说明（补齐特性）

> 记录于 2026-10-19。契约以 [contract.md](../contract.md) **v0.6** 为准，本文只记本次的
> **范围、顺序、实现形态与验收**，不重复契约内容（条款编号指向 contract.md）。
>
> **第二轮（2026-10-20，契约 v0.5 → v0.6）**的补记在 §7–§9：git 历史视图、图片与 PDF 渲染器、
> 侧栏快捷键、变更视图改由 watch 驱动。§1–§6 是第一轮（v0.4 → v0.5）的记录，保留原样。
> 开工前用户逐条拍板：范围 **git 的只读视图 + URL 路由**（主题不做，`ctx.storage` 保持 🔲）；
> 契约升 **0.5**；git 是「左侧变更文件、右侧单个文件的 diff」；侧栏按 VS Code 的方式切换
> 多个视图（`sidebar.views` 取代 `sidebar.tree`）；URL 用 **path 形态 + `/~/` 保留前缀**；
> 刷新恢复**单 tab**。

## 1. 范围

| 块 | 契约条款 | 主要落点 |
|---|---|---|
| git 服务 | §3.2 | `kernel/src/server/git.ts`（新）、`kernel/src/shared/types.ts` |
| git 侧栏视图 + diff 渲染器 | §5（`sidebar.views`）、§5.1 | `plugins/git`（新）、`plugins/layout`（切换器）、`plugins/file-tree`（迁到视图） |
| URL 路由 | §3.8 | `client/router.ts`（新）、`kernel/src/server/http.ts`（`/~/` 前缀）、`apps/web/src/main.tsx` |

不碰：外部插件（`~/.diorama/plugins`、npm source、zod）、`ctx.storage`、`ctx.layout`、主题、
图片 / PDF / Notebook 渲染器（仍是「未来」）。

## 2. 依赖与实施顺序

依赖边：

1. **契约 v0.5 → 所有步骤**：`CONTRACT_VERSION` 与全部内置插件 manifest 范围一起升，否则 boot 被拒（§6）。
2. **`ctx.git` → git 客户端**：diff 渲染器只拿 diff 的一侧（`file.renderer` 派发），变更列表只拿 `status`。
3. **`sidebar.views` → git 视图**：视图给 `layout` 的切换器提供标题/图标，`file-tree` 与 git 各注册一条。
4. **路由 → 深链 / 刷新恢复**：路由只记**活动 tab 的路径**，tab 集合不进 URL。

| 步 | 内容 | 结束时的验收 |
|---|---|---|
| **S0** | contract v0.5、本文、`CONTRACT_VERSION`、全部插件 manifest 范围；features/plan 档位 | 文档；四件套全绿（无行为变化） |
| **S1** | `ctx.git` 服务端：探测仓库（含挂子目录的情形）、`status` / `diff` / `log`、只读、上限、错误码 | 单测：非仓库 → 无服务；临时 git 仓库的 status/diff/log、二进制、重命名、超限、仓库外路径、`base` 拒绝 |
| **S2** | `sidebar.views` 座位 + `layout` 切换器；`file-tree` 迁为 `files` 视图；`plugins/git`（`changes` 视图 + diff 渲染器） | e2e：侧栏里树与变更切换、非活动视图隐藏不卸载；改一个文件 → 变更里出现 → 点在右侧看到 diff；无 git 的目录显示「不是 git 仓库」 |
| **S3** | `ctx.router` + `/~/` 前缀（服务端不 404）、深链、刷新恢复单 tab、关闭回 `/`、非法路径不开 | 单测：路径编解码、非法路径拒绝、历史进出的订阅；e2e：复制 URL 新开标签直达、刷新保留、关闭回根 |
| **S4** | 文档收尾：本文 §6 实现记录、features.md、plan.md、AGENTS.md 地图 | 四件套全绿 |

每步结束跑（AGENTS.md §3）：

```bash
pnpm build
pnpm test:unit
pnpm -r --no-sort run typecheck
pnpm --filter diorama-web exec playwright test
```

## 3. 实现形态（契约之外的具体选择）

| 项 | 选择 | 理由 |
|---|---|---|
| 调用 git | `git` 可执行文件 + `execFile`（不引库） | 只读、输出稳定；没有 Node 侧 git 解析库值得为三个只读方法引入 |
| 仓库探测 | `git rev-parse --show-toplevel`（在 mount 时跑一次） | 挂载的可能是仓库子目录；失败 = 不是仓库，不 provide |
| diff 形状 | unified diff **文本**（不结构化） | 渲染器分层着色即可；结构化行模型是又一个跨线契约 |
| diff 列表 | `git status --porcelain=v1 -z` 定性，`git diff -M --no-color` 取文本 | 一份来源，左侧列表与右侧内容一致 |
| 上限 | 单次 `diff()` 4 MiB / 2000 行；`log().limit` 默认 50、上限 500 | 与 §3.1 的「v1 不分块 + 超限报错」同一取舍 |
| 侧栏切换 | `layout` 画竖排图标条；条目提供 `title`/`icon` | 新增视图 = 注册一条条目，不改已有包 |
| 视图隐藏 | 非活动视图 `display:none` 不卸载 | 与 `tabs.content` 同一做法，滚动态各自保留 |
| 路由 | History API；`/~/` 记浏览位置，`#key=value` 是插件状态；服务端对 `/~/` 回退壳 | 两条互不相交的面：路径可校验、可分享；状态归插件 |
| 路由 ↔ tabs | 路由订阅 tabs：**活动 content tab** 的变化 `pushState`；diff 等其它视图不动路径 | 一个 URL 只表达“浏览哪个文件” |
| hash ↔ 插件 | 插件在 `apply` 里 `ctx.router.state(key)` 读写，自己负责刷新后恢复 | 内核不认识 `diff`，以后 history/搜索同理 |
| 变更视图 = 目录树 | `shared/changes.ts` 把扁平 `status()` 折成树；视图持有展开状态 | 服务保持扁平（一个 path 一行），画法归视图 |
| tab 键 | `(path, view)` | 同一文件的 content 与 diff 可以并排 |

## 4. 验收（演示脚本）

1. 在仓库里改一个已跟踪文件、新增一个文件 → 左栏切到「变更」，两个文件都在；
2. 点「变更」里的文件 → 右栏渲染该文件的 diff（新增文件显示整文件为 `+`）；
3. 切回「文件」视图 → 仍是原来的展开状态；切回「变更」→ 选择仍在；
4. 打开 `url/~/src/app.js` → 直达该文件，只有一个 tab；
5. 在该页面刷新 → 仍是同一个文件；关闭 tab → URL 回到 `url/`；
6. `url/~/../etc/passwd` → 不开 tab，页面提示路径非法；
7. 非 git 目录：左栏没有「变更」视图，打开文件仍是普通渲染；
8. M0 5 条、M1 7 条、M2 21 条、M3 16 条仍全绿。

## 5. 风险与已知取舍

- **`sidebar.tree` 被移除**（v0.5 破环）：`file-tree` 改为 `sidebar.views` 的 `files` 视图；M0 验收点 3 的
  断言改为「没有任何视图时侧栏不画」。
- **git 需要可执行文件**：PATH 上没有 `git` → 该 mount 不 provide `git`（等同非仓库），日志一条原因。
- **diff 文本上限**：超大 diff 截断并标 `truncated`，渲染器必须显示「已截断」。
- **路由不持久化 tab 集合**：刷新只恢复活动文件（U10 的多 tab 记忆仍待定）。
- **`/~/` 与安全**：服务端对 `/~/` 只回壳，不做文件服务；路径校验始终在 `ctx.fs`（`EINVAL`/`EOUTSIDE`）。

## 6. 实现记录（2026-10-19，落地后）

### 6.1 验收结果

```
pnpm test:unit                                   # 108 passed
pnpm -r --no-sort run typecheck                  # clean
pnpm --filter diorama-web exec playwright test   # 53 passed
```

| 用例文件 | 覆盖 |
|---|---|
| `m4-git`（3） | 仓库挂载经 RPC 答 `git.status`；非仓库 `ESERVICE`；侧栏「变更」与「文件」互切、点开文件右侧看到 diff、未跟踪文件标注 |
| `m4-router`（2） | `/~/` 深链直达且单 tab、刷新保留、树点击写 URL、关闭回到根、`goBack` 沿历史、越界路径不开 |
| `m4-git`（4） | 同一文件的 content 与 diff 是两个 tab；diff 只进 `#diff`，刷新两者都恢复；变更视图是目录树（折叠、单一子目录链合并） |

单测：`git` 10（status/diff/log、按文件与子树、改名、子目录挂载、二进制、非仓库、RPC 白名单、porcelain 解析）；
`router` 6（编解码、非法路径、URL 写回、历史、深链、tabs 未就绪时排队）。

### 6.2 踩到的坑（按症状查）

1. **`onMount` 是同步的，仓库探测不是。** `gitHalf` 在 `onMount` 里 `ctx.plugin({ async apply })`：
   `apply` 里 `await` 探测，服务在探测回来后 `provide`；卸载先于探测完成时，fiber 带走一切。
   不要在 `onMount` 回调里 `await`。
2. **服务对象上的普通字段跨半边读不到。** `ctx.router.getSnapshot()` / 字段在插件侧读出来是 `{}`
   （Cordis 剥自定义字段，AGENTS §5 的同一条）。状态一律用**方法**读（`router.current()`），
   或者让调用方在自己的构建里读快照。
3. **`useSeat(name)` 读的是“无 key 的桶”。** keyed 座位的条目全在各自的 key 下，用 `useSeat` 看
   永远是空。侧栏这类“遍历一个 keyed 座位的全部实例”要用 `useKeyedSeat(name)`（本轮新增）。
3b. **半个插件读不到另一个半边提供的服务。** `ctx.tabs` 由 `tabs` 半边提供；`git-changes`
   在自己的 `ctx` 上读 `ctx.tabs` 永远是 `undefined`（它连 `inject` 都没有列）。跨半边读服务
   走**页面桥**：`__diorama_page__.getKernel().ctx.tabs`。
4. **`useSyncExternalStore` 的快照必须在任何时刻都稳定。** `seatSnapshot` 在内核尚未安装时返回过
   新数组，`useSeat` 也返回过 `[]` 字面量——都是每次渲染新引用，页面前几帧就进入无限重渲染
   （React #185）。现在空状态用一个共享对象，并在内核装好后按版本缓存。
4b. **`root` 与 `repoRoot` 必须在同一个路径空间。** macOS 上 `/tmp`、`/var` 是指向
   `/private/...` 的符号链接：`git rev-parse` 回的是 realpath，挂载根却可能保留原样路径，
   于是 `relative(repoRoot, root)` 变成 `../../tmp/x`，**所有条目都被前缀过滤掉**（症状：
   「工作区没有改动」）。`GitService` 现在会 realpath 挂载根；单测用符号链接固定这条。
5. **插件 id 与内核服务 id 撞名。** 客户端插件最初叫 `git`，与内核的 `git` 服务冲突（`halves`
   映射重复键）。客户端插件是 `git-changes`；它的目录**必须**叫 `git-changes`
   （`builtinPackageJson` 按 id 找 `packages/plugins/<id>`）。
6. **`fs` 不再出现在 `config.plugins`。** 它以前只是恰好因为进了 `BUILTIN_PLUGIN_IDS` 才出现在
   客户端清单里，而页面会拿它当插件脚本加载（空 URL）。内核服务（`fs`、`git`）现在由
   `KERNEL_SERVICE_IDS` 单独列出，每 mount 自动加载，不进页面图。
7. **改了 shell 依赖的包，要重建 shell。** `apps/web/dist` 内联了自己的 kernel client 副本；
   只重建 `packages/kernel` 时页面跑的是旧副本（表现为“改了没用”）。`pnpm build` 会全量重建，
   单独调试时记得 `pnpm --filter diorama-web run build`。
8. **`role="tab"` 不再只有标签栏。** 侧栏视图切换器也用 `role="tab"`；测试里按
   `.diorama-tabs__strip [role="tab"]` 限定，否则计数多 1。

### 6.3 与契约的对应

| 契约 | 实现位置 |
|---|---|
| §3.2 `ctx.git`（探测、status/diff/log、上限、错误码） | `kernel/src/server/git.ts`、`kernel/src/shared/types.ts`、`kernel/src/shared/errors.ts`（`ENOTREPO`） |
| §3.2 client 面（`mountCtx.git`、`hasGit`） | `kernel/src/client/git.ts`、`kernel/src/client/mount.ts` |
| §3.4 `TabInfo.view`、`tabs.open(file, { view })` | `kernel/src/client/tabs.ts`、`kernel/src/shared/types.ts` |
| §3.4 `seats.git-diff` 派发 | `plugins/tabs`、`plugins/git-changes` |
| §3.8 `ctx.router`、`/~/` | `kernel/src/client/router.ts`、`kernel/src/client/boot.ts`、`kernel/src/server/http.ts` |
| §5 `sidebar.views`、§5.2 切换器 | `plugins/layout`、`plugins/slots`（`title`/`icon` 为一等字段）、`plugins/file-tree`、`plugins/git-changes` |
| §5.1 渲染器字节约定 | 文档对齐（`ctx.fs.readBytes` + 先 `stat`），代码未变 |
| §15 contract 0.5 | `kernel/src/contract.ts`、全部内置插件 manifest |

### 6.4 遗留与取舍

- **变更列表不订阅**：`ctx.git` 没有订阅端点（契约只定了三个只读方法），侧栏用 5 秒轮询 +
  「刷新」按钮；`fs.watch` 驱动的实时刷新留给以后把 `git.change` 加进 §4 的订阅端点时做。
- **未跟踪文件没有 diff 文本**：`diff()` 对它只回 `kind` 与 `status`；diff 读取器自己用
  `ctx.fs.readText` 读整个文件、按「全部新增」渲染（超过 2 MiB 或 5000 行只报大小/截断；
  二进制只报大小与行数以外的事实），契约里写明这条分工（§3.2）。
- **`sidebar.views` 的切换器无快捷键**：以后与 history 视图一起加。
- **URL 只记活动文件**：刷新恢复单 tab；多 tab 记忆仍是待定项（U10）。
- **左栏宽度固定 260px**：未做拖拽。

## 7. 第二轮范围与顺序（v0.5 → v0.6）

> 开工前用户逐条拍板：范围 = **git 历史视图 + 图片 / PDF 渲染器**（Notebook 不做、主题不做、
> `ctx.storage` 仍 🔲）；git 只**新增**方法不改已有方法；渲染器改为**只预读文本**；
> `mime` 档接受末尾通配；另加侧栏切换器快捷键与「变更视图由 watch 驱动」。

依赖边：

1. **契约 v0.6 → 所有步骤**：`CONTRACT_VERSION`、`CONTRACT_RANGE` 与全部内置插件 manifest（含
   `kernel/package.json` 自己的 `diorama` 块）一起改，否则 boot 被拒（§6）。
2. **「只预读文本」→ 图片 / PDF**：字节渲染器自己 `stat` + `readBytes`；不做这一步，图片拿不到
   超限语义（旧的预读会把 32 MiB 以上的二进制变成「读文件失败」）。
3. **`show` / `showCommit` / `blob` → 历史视图**：列表只要 `log()`，详情要提交说明与文件清单，
   单文件要看 diff 或当时的正文。
4. **`sidebar.views` 已有 → 历史视图**；**`ctx.router.state` 已有 → `#history=<sha>`**。

| 步 | 内容 | 结束时的验收 |
|---|---|---|
| **S0** | 契约 v0.6（§3.2 三方法、`base` 三分支、§5 `seats.git-commit`、§5.1 通配与 props、§5.2 `history`、§3.7 三条命令、§16）；`CONTRACT_VERSION`、`CONTRACT_RANGE`、12 个 manifest | 四件套全绿，计数不变 |
| **S1** | registry 只预读文本；`EBINARY` / `ETOOLARGE` 都变成「无 text」的正常态；plaintext 从 `stat` 描述二进制；probe 只看预读文本 | 单测；m1 用例 5 加强（内容、大小、mime 都在） |
| **S2** | `mime` 末尾通配；`MAX_*_BYTES` 移到 `kernel/src/shared`；`FileRendererProps.mountCtx`；`image` 插件；`code` 不再认领 `.svg` | e2e：png/svg 经 blob URL 解码、超限不请求字节、非图片仍回退 |
| **S3** | `ctx.git`：`show` / `showCommit` / `blob`；`base: 'index' \| sha`；客户端 `GIT_METHODS` | 单测：root commit、改名、二进制、不存在 sha、`index` 不含未跟踪、RPC 白名单 |
| **S4** | `seats.git-commit`（`tabs` 声明、`git-changes` 填）；`history` 视图；`#history=<sha>`；`layout` 的视图选择提到页面 store + `sidebar.show*` | e2e：列表顺序、点提交出详情、改动/内容切换、刷新恢复、快捷键、非仓库不可执行 |
| **S5** | `pdf` 插件（`ext: ['pdf']`，iframe + blob，另给 blob 链接） | e2e：viewer 打开、超限、去掉插件后的回退 |
| **S6** | 变更视图：5s 轮询 → `fs.watch` 驱动（每层目录一个 watch，事件节流 400ms 合并成一次 `status()`） | e2e：改文件后无需刷新即出现新条目 |
| **S7** | 文档收尾：本文 §7–§9、features、plan、AGENTS 地图 | 四件套全绿 |

## 8. 实现记录（2026-10-20，第二轮落地）

```
pnpm build                                       # clean
pnpm test:unit                                   # 128 passed
pnpm -r --no-sort run typecheck                  # clean
pnpm --filter diorama-web exec playwright test   # 69 passed（17 个 spec 文件）
```

| 用例文件 | 覆盖 |
|---|---|
| `m4-history`（7） | 提交列表（新的在前、作者）、点提交出详情与文件 diff、`#history=<sha>` 写 URL、刷新回到同一提交与同一视图、改动/内容两种显示、`mod+alt+1/2/3` 切换视图、非仓库时命令不可执行、变更视图由 watch 即时更新；提交说明只显示标题行，正文可展开/收起，纯标题的提交没有展开按钮 |
| `m4-images`（4） | png 解码（`naturalWidth`）、svg 经 `<img>`（页面里没有内联 `<svg>`）、超 32 MiB 显示「文件过大」且**未发生** `readBytes`、未知二进制仍回退 plaintext |
| `m4-pdf`（3） | viewer 的帧拿到完整 blob（`%PDF-` 头 + 与链接同源）、超限不请求、去掉 `pdf` 插件后 plaintext 描述 |
| `m4-git`（改） | 侧栏视图数 2 → 3 |

单测：`git` 16（新增 5：show 的 root commit/改名/二进制/不存在、showCommit 的说明与清单与 revision
语法、blob 的文本/二进制/改名前后、`base` 的 index 与提交、历史方法的 RPC 面）；`chooseRenderer`
新增 1（`image/*`、裸 `*` 不算通配、中间通配不命中、精确项优先）；`config` 默认清单含 `image` / `pdf`。

## 9. 第二轮的坑（按症状查）

1. **`FileRendererProps` 有两份。** 内核 `shared/matcher.ts` 里有定义，`plugins/slots/src/types.ts`
   里还有一份副本：前者缺契约写明的 `mountCtx`，后者还带着已删除的 `bytes`。图片渲染器第一次编译
   就报「`mountCtx` does not exist」。现在 `slots` 从内核 re-export 同一份。
   注意 `export type { X } from '…'` 之后**同文件不能再用 `X`**——tsc 的声明产物会缺名字
   （`Cannot find name 'FileRendererProps'`），要写成 `import type { X }` + `export type { X }`。
2. **`ext` 档永远赢 `mime` 档。** `code` 原本按扩展名认领 `svg`，于是 SVG 进了高亮器而不是图片
   （契约 §5.1 rule 2 是对的，错的是 `code` 的清单）。规则：**一个扩展名只能有一个 owner**，
   给新的字节渲染器让路时要把它从别的表的 `ext` 里拿掉。
3. **`mod` 在 mac 上是 Meta。** e2e 里写死 `Control+Alt+2` 在 macOS 上不匹配任何绑定（探测过：
   按键事件本身送达）。测试一律用 `MOD = darwin ? 'Meta' : 'Control'`（m2 的写法）。
4. **提交不是文件，不进 tab。** `tabs` 声明 `seats.git-commit`、`git-changes` 填充；右侧由 `tabs`
   在「hash 里有 `history=<sha>`」时改画这个座位（tab 集合与每个 tab 的状态**仍然挂载**，
   只是被替换显示）。这样关掉历史视图（hash 值消失）就回到原来的 tab。
5. **`layout` 的视图选择从组件 `useState` 提到页面级 store。** 切换器点击、`sidebar.show*` 命令、
   hash 恢复三处都要写同一个选择；留在组件里时命令够不着它。store 的
   `useSyncExternalStore` 快照是**版本号**，不是对象（M1 的 #185 同一条）。
6. **`ctx.fs` 没有按偏移读。** probe 拿到的头部只能从**预读的文本**截；二进制文件拿到空头。
   需要按魔数识别二进制格式的渲染器必须用 `ext` / `mime` 档（契约 §5.1 rule 5 已写）。
7. **手写的最小 PDF 是纯 ASCII。** 它不含 NUL，`readText` 会成功，plaintext 就把它当文本显示——
   这在「没有 PDF 渲染器」时是**正确**行为。要测二进制回退，夹具里得有一个 NUL。
8. **`fs.watch` 只服务文件树与变更视图之间的信号，不是 `git` 的订阅。** `ctx.git` 仍然没有订阅端点；
   变更视图把「目录事件 → 节流 → 一次 `status()`」串起来。目录上限（`watch.maxDirectories`）被
   触发时 watch 是 no-op（契约约定不报错），此时只有手动刷新可用——这是已知取舍。
9. **`pnpm --filter <pkg> run build` 只重建那一个包。** 改了内核**导出**（新增/改类型）必须重建内核，
   再由下游重新 typecheck；改了 shell 依赖的包要 `pnpm --filter diorama-web run build`（AGENTS §3）。
   本轮多次出现「类型找不到成员」都是声明陈旧，不是代码错。

## 10. 与契约的对应（第二轮）

| 契约 | 实现位置 |
|---|---|
| §3.2 `show` / `showCommit` / `blob`、`base: 'index' \| sha` | `kernel/src/server/git.ts`、`kernel/src/shared/types.ts`、`kernel/src/client/git.ts` |
| §5 `seats.git-commit` | `plugins/tabs`（声明与绘制列）、`plugins/git-changes`（填充）、`plugins/slots/src/types.ts` |
| §5.2 `history` 视图 | `plugins/git-changes`（`HISTORY_VIEW`、`HISTORY_HASH_KEY`） |
| §5.1 只预读文本、`image/*`、字节渲染器 | `plugins/renderer-registry`、`plugins/plaintext`、`plugins/image`、`plugins/pdf`、`kernel/src/shared/limits.ts`、`plugins/slots/src/select.ts` |
| §3.7 `sidebar.showFiles` / `showChanges` / `showHistory` | `plugins/layout`（`ViewChoice` store + 三条命令） |
| §16 contract 0.6 | `kernel/src/contract.ts`、12 个 manifest、`kernel/test/config.test.ts` |

## 11. 仍未做（与契约「待定清单」一致）

- `ctx.storage` 与主题（U12 / K14 / P9）：签名仍未定，本轮零代码。
- Notebook（`.ipynb`）渲染器：本轮明确不做。
- 变更视图的订阅端点（`git.change` 进 §4）：现在是 `fs.watch` 驱动的重算，不是 git 的推送。
- 历史视图的搜索 / 按作者过滤 / 图形化提交图：只做了线性列表与分页（每页 50，上限 500）。
