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
10. **提交详情只有「被看见」这一条路，没有「怎么离开」。** `#history=<sha>` 一写上去，`tabs` 就把右侧
    换成 `seats.git-commit`；而**关掉它的条件当时根本没写**，于是进了历史视图、点过提交之后，再点文件
    只是把 tab 打开在提交详情背后（画面不变）。修法见契约 §5「它什么时候收起」：两条判据缺一不可——
    - **`openCount`**：打开文件（含**打开当前那个文件**）才算离开。只看「活动 tab id 变了」不够：
      再点同一个文件 tab 集合与 URL 路径都不变，看上去像没动过。这就是 `ctx.tabs.openCount` 的由来。
    - **`viewChoice.shown()`**：切侧栏视图不是 tab 变化；一个 tab 都没开时更没有任何变化可听。而且判据
      必须是**选中的就是 `history`**，不是「`history` 已注册」——`available()` 在切走之后仍为 true。
11. **`useSyncExternalStore` 的快照要包含「你判断时用到的一切」。** 判据里的 `openCount` 与侧栏选择
    都不在 `tabs.getSnapshot()` 里：前者是**计数**（快照同一个对象），后者在**另一个半边的 store**。
    只订 `tabs` 的快照，判断用的值变了也不会重渲染（表现为「状态已经对了，画面没变」）。
12. **两个半边各有自己的 store，不能 `import` 共享。** `layout` 的视图选择要能被 `tabs` 读到，
    走页面 `globalThis`（`__diorama_layout__`，与 `__diorama_page__` 同一个理由）；读的时候一律
    **懒读**，`layout` 还没 apply 时返回 `undefined` 而不是抛。
13. **`layout` 的 store 快照函数必须是绑定过的。** 那个对象会被当作 entry 的 props 传给同一次渲染，
    读 `this.version` 的普通方法在那里会抛，React 把 `useSyncExternalStore` 的抛错当成「没有服务端快照」，
    静默丢掉服务端渲染的结果。

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

## 12. 补记：HTML 渲染器（v0.6，不改契约版本）

> 2026-10-20。用户拍板：`.html` / `.htm` 要**源码 + 预览双视图**，并且进**默认插件清单**。
> 不升契约版本：§5.1 的“只预读文本 / 渲染器自己取字节 / 一个扩展名一个 owner”已足够承载，
> 新增的是**内置渲染器的清单与行为**，记在 contract §5.1 与 §16 的表格里。

| 项 | 选择 | 理由 |
|---|---|---|
| 归属 | 新插件 `packages/plugins/html`，`ext: ['html', 'htm']`，`order: 90` | `code` 的 ext 表删掉这两个扩展名（§9 的坑 2：一个扩展名一个 owner） |
| 预览 | DOMPurify 消毒 → `<iframe srcdoc sandbox="allow-same-origin">` | 消毒去掉脚本 / 事件处理器 / `style` / 表单 / 嵌套 frame；frame **没有** `allow-scripts`，漏网的脚本也不执行；`srcdoc` 不产生本站 origin 上的 URL（与 PDF 的 blob 做法不同） |
| frame 的 CSP | `default-src 'none'; img-src data:; style-src 'none'`，wrapper 不带自己的 `<style>` | 页面自己的 CSS 在消毒时就被拿掉了（预览是「消毒后的内容 + 浏览器默认排版」，不是「页面的样子」）；nonce 不可行——实测沙箱 frame 不把 nonce 传给它的 style/script，`<style nonce>` 连 wrapper 自己的都保不住（chromium） |
| 切换 | 渲染器自己的头部两个按钮（`aria-pressed`） | O8：开关归渲染器，不开工具栏；`md` 的同类切换（U6）仍未定 |
| 状态 | 渲染器实例（一个 tab 座位一个）；同一 tab 换文件回到预览 | 同文件换 tab 各自保留；深链 / 刷新恢复总是“打开一个页面” |
| 缺 `html` 插件 | `.html` 落到 `plaintext` | 不回到 `code`：owner 只有一个 |
| 单测 | `packages/plugins/html/test/frame.test.ts`（新目录进 `test:unit`） | 只测纯函数（frame 文档、CSP/nonce、行数/大小）；DOMPurify 需要 window，交给 e2e |

**坑**
1. **`node --test` 不认识 `.tsx`**（`ERR_UNKNOWN_FILE_EXTENSION`）。纯函数放 `src/frame.ts`，
   组件在 `src/index.tsx` 里引它——单测只导入前者。
2. **`export type { X } from './x.ts'` 之后同文件再用 `X` 会“没有导出成员”**：要 `import type { X }` +
   单独 `export type { X }`（m4 §9 坑 1 的同一条，这次在 `.tsx` 上再犯了一次）。
3. **nonce 在沙箱 frame 里不传播**：`<style nonce>` + `style-src 'nonce-…'` 在直接开页面时有效，
   在 `srcdoc` + `sandbox` 的 frame 里 Chromium 不把 nonce 品牌传下去，wrapper 自己的 `<style>` 也被
   挡掉（页面内创建的带 nonce `<style>` 同样不生效）。所以 wrapper 不带样式：预览用浏览器默认排版，
   `style-src 'none'` 把页面塞进来的样式全挡住——反正消毒已经拿掉了 `<style>`。
4. **`--plugins` 写死的 e2e 夹具**：用例点名一组插件时，`.html` 不在 `code` 里的变化会立刻显示出来
   （`m5-html` 的“去掉 `html` 插件”用例就是靠这一点落到 `plaintext`）；要在**默认**清单里测，就
   不要传 `--plugins`。

**验收**（`apps/web/tests/m5-html.spec.ts`，4 条）：预览默认开、frame 无 `allow-scripts`、脚本没跑、
内联事件没触发、页面自己的 `<style>` 生效；源码视图显示转义后的原文、无 frame；同 tab 换文件回到
预览；去掉 `html` 插件后落到 `plaintext`。

## 13. 修复：git 读错仓库（2026-10-20，v0.6 内修 bug，不升契约）

**现象**：挂载 `meli-erp`，文件树是 meli-erp 的，但「变更」「历史」显示 `diorama` 的改动与提交。

**三个独立原因，逐个复现后修掉：**

1. **继承的 `GIT_*` 环境变量劫持了目录（直接原因）**。`runGit` 用 `env: { ...process.env, … }`，
   而 `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` / `GIT_CONFIG*` 在 git 里**优先于 `-C`**。
   gateway 从带着这些变量的 shell 启动，于是每个 mount 的 git 都指向那个 shell 的仓库。
   修法：`gitEnvironment()` 丢掉所有 `GIT_*`，只留服务自己设的三项（`GIT_TERMINAL_PROMPT=0`、
   `GIT_OPTIONAL_LOCKS=0`、`LC_ALL=C`）。复现：同一进程里带 `GIT_DIR=<other>/.git`，
   `detectRepository` 返回 other、`status()` 列 other 的文件；修后返回目标仓库。
2. **Cordis 按服务名隔离，`forkMount` 只命名了 `fs`**。日志 `[mount:92a8d493] git: service "git" has
   been registered at <git:8b69f512>`：同一仓库的两个目录挂在一起时，第二个 mount 的 `git` 撞上第一个的
   默认键，root 也能解析到某个 mount 的 `GitService`（比报告的更糟）。修法：`mountScope()` 对
   `MOUNT_SERVICES = ['fs', 'git']` 逐个 `isolate(name, Symbol('<mountId>:<name>'))`；插件自带的按目录
   服务用 `isolateMountService(ctx, name)`。新增后台插件要把服务名加进 `MOUNT_SERVICES`。
3. **服务的「回答」被当成 mount 故障**。`guardedDispatcher` 只要错误码不是
   `EMETHOD`/`ESERVICE`/`EBADREQUEST` 就 `degrade`，于是 `ENOENT`（文件被删）、`EBINARY`（读了一次二进制）
   都会让健康 mount 走 degraded → 自动重启 → recovered，日志里刷出 `degraded: ENOENT`。
   修法：内核错误表里的**所有**码（§3.1/§3.2/§4）都是「回答」，只让请求失败；没有码或未知码才算故障。

**回归**：`git.test.ts` +2（环境劫持、`gitEnvironment` 过滤）、`fork.test.ts` +1（同仓库两个目录各拿
自己的 git、root 没有 git、无注册冲突、拆一个不动另一个）、新 `packages/cli/test/guarded-dispatcher.test.ts`
（3 条）。三个都有变异验证：把修复去掉，对应的用例会红。

**已知遗留**：`GIT_*` 作为进程级环境是在 gateway 启动时定下的；已经跑起来的 gateway 要
`diorama-beta gateway restart` 才会带上修复。

## 14. HTML 预览：样式放行、脚本逐文件确认（v0.6 内修订）

§12 的预览把 `<style>` 也剥掉了，实际效果是「白页」——`rbac.html` 的样式全在 `<head>` 的 `<style>`
里，预览只剩文字。用户确认改为：**样式/外部样式/外部图片全放行；脚本默认不执行，逐文件确认后放行。**

| 项 | 取值 | 理由 |
|---|---|---|
| 样式阶段 CSP | `default-src 'none'`；`style-src 'unsafe-inline' https: http:`；`img-src data: blob: https: http:`；`font-src data: https: http:`；**无 `script-src`** | 保住页面外观与外部资源，脚本仍被 CSP 与 sandbox 双重挡住 |
| 脚本阶段 CSP | 上面再加 `script-src 'unsafe-inline' 'unsafe-eval' https: http:`、`connect-src`、`media-src` | 确认后页面要能真正跑起来 |
| sandbox | 样式阶段 `allow-same-origin`；脚本阶段 `allow-scripts`，**没有** `allow-same-origin` | 两者同时给 = 没沙箱；脚本阶段牺牲 same-origin，换取页面脚本够不到本页 |
| 消毒 | 样式阶段才消毒；脚本阶段直接用原文 | 消毒会删掉刚被确认的脚本，等于确认无效 |
| 确认 UI | `html-script-notice`：未确认时「执行脚本并预览」，确认后「停止执行」 | 提示只在页面真的有脚本时出现（`<script`、`on*=`、`javascript:`） |
| 信任范围 | 渲染器实例；换文件/换代/刷新即失效 | 不给「信任」一个跨文件的持久身份 |

**坑（这次踩到的）**：DOMPurify 默认**只消毒 `<body>`**，`<head>` 里的节点整个被丢掉——
`<style>` 看起来「不在允许列表里」，其实是位置问题。证据（浏览器内实测）：

```
sanitize(fullDocument)                                  → "<h1>Hi</h1>"
sanitize(fullDocument, { WHOLE_DOCUMENT: true })       → "<html><head><style>h1{color:red}</style></head><body><h1>Hi</h1></body></html>"
sanitize('<head><style>a{color:red}</style></head>…')  → 样式没了
sanitize('<body><style>a{color:red}</style>…')         → 样式保留
```

修法：`WHOLE_DOCUMENT: true`，并把返回文档的 `<head>`（title + style）与 `<body>` 分别取出来放进
frame 文档。e2e 断言的是 `getComputedStyle` 的颜色，不是「标签存在」。

**验收**：`m5-html` 6 条——样式与内联 `style=` 生效、外部资源策略在 CSP 里、脚本未确认不跑、
确认后脚本跑且页面读不进去（取证时 Playwright 报 `Blocked a frame … cross-origin` 正是证据）、
停止执行后回到脚本受限的 frame、无脚本页面没有提示条。

## 15. 补记：快捷键说明（v0.7，`layout.overlay` 改 list）

> 2026-10-20。用户拍板三件事：**独立的 `help` 插件**（不塞进 palette）、不可用的快捷键**灰显列出**、
> `?` 与 `mod+k` 打开任一个时**关掉另一个**。座位从单改 list，按契约 §6 破环，故契约升 **0.7**。

| 项 | 选择 | 理由 |
|---|---|---|
| 归属 | 新插件 `packages/plugins/help`，`layout.overlay` 条目，`order: 200` | 与 palette 平级；palette 的「只列可执行命令」口径不为速查表让路 |
| 座位 | `layout.overlay` 从 `single` 改 **`list`** | 单座位的第二个条目会被 registry 拒绝并 warn（`registry.ts` 的 `single` 分支）|
| 互斥 | 页面全局 `__diorama_overlay__`（`packages/ui/src/overlay.ts`） | 两半边是各自的构建，import 不到同一个对象；内核服务又不该持有页面 UI 状态 |
| 键记法 | `shift+?` | `parseKeys` 取 `KeyboardEvent.key` 且修饰键**精确匹配**：真浏览器敲 `?` 是 `key:'?'`+`shiftKey:true`，写 `?` 永远匹配不到 |
| 列表口径 | 全部绑定都在，不可用的灰显 | 速查表回答「有哪些键」；palette 回答「现在能跑什么」。两者不矛盾 |
| 排序 | **绑定注册顺序**（= boot 顺序） | 同一插件的快捷键相邻（`tabs.*` 一起），比按标题排更好找 |
| 纯函数 | `src/bindings.ts`（`formatKeys` / `shortcutRows`） | `node --test` 不认 `.tsx`（§12 坑 1），组件只负责画 |

**坑**

1. **`press('?')` 在 Playwright 里不等于“敲问号”**：`usKeyboardLayout` 把 `'?'` 当**别名**注册，
   `press('?')` 合成的事件是 `key:'?'` + **`shiftKey:false`**；`matchesKeys` 要求修饰键精确匹配，
   绑定 `shift+?` 不会命中。e2e 必须写 `press('Shift+Slash')`（实测产生 `key:'?'`、`shift:true`）。
2. **`data-command-keys` 不能贴在速查表上**：那个标记的含义是「这块面自己接管按键，内核不要分发」
   （`boot.ts` 的 `inTextEntry`），贴上去 `?` 与 `mod+k` 在说明打开时全部失效。palette 需要它
   （输入框要能打 `?` 做过滤），说明不需要。
3. **`escape` 只能有一条绑定**：`bind` 对「同键 + 两个普通 `when`」直接抛错（`mayCoexist` 默认认为
   两个函数可能同时为真）。palette 的 Esc 由输入框自己的 `onKeyDown` 处理（既有做法），`help.close`
   才是唯一注册的 `escape` 绑定；跨半边也用不了 `exclusive()`——标记用的 `Symbol` 是各自构建的。
4. **overlay 的 snapshot 必须是原始值**：`overlayStore.getSnapshot()` 返回**开着的那个 id**（字符串或
   `undefined`），不是对象；返回新对象会让 `useSyncExternalStore` 每渲染一次就认为变了（§6.2 的老坑）。
5. **palette 的输入框要等一拍才拿到焦点**：`useEffect` 里 `setTimeout(…, 0)`。测试紧接着敲 Escape
   会在焦点落下之前发出，命令不会跑——e2e 先 `toBeFocused()` 再按键。

**验收**（`apps/web/tests/m5-help.spec.ts`，5 条）：`?` 开/关与 Esc 关、键帽按平台渲染（`⌘⌥W` /
`Ctrl+Alt+W`）、无 tab 时 `tabs.close` 灰显而 `palette.toggle` 正常、打开文件后同一行变可用、
说明与 palette 互斥、在 palette 里打 `?` 只过滤不弹说明、去掉 `help` 后 `?` 无反应且 palette 照常。
单测 5 条（`packages/plugins/help/test/bindings.test.ts`）：两个平台的键帽、命名键与单字符、
绑定顺序与未知命令丢弃、不可用标记与重复键合并、一条命令多个键。

## 16. 修复：macOS 上带 Option 的快捷键全部透传给浏览器（v0.7 内修 bug，不升契约）

**现象**（用户报告）：「好像很多快捷键没有生效，都透传到浏览器上去了」。

**根因**：macOS 的 **Option 是组合键**。⌘⌥W 在浏览器里报的不是 `key: 'w'`，而是 Option 组合出来的
字符——`∑`；⌘⌥R 是 `®`；⌘⌥1 是 `¡`；`⌘⌥[` 是 `“`。而 `matchesKeys` 只比
`event.key.toLowerCase() === keys.key`，于是**所有 `mod+alt+*` 绑定在 Mac 上全是死键**：内核认不出，
`preventDefault` 没被调用，按键继续冒泡给浏览器。`mod+k`、`ctrl+tab` 不含 Option，所以一直正常——
这也解释了为什么看起来是「很多」而不是「全部」。

**为什么 e2e 一直是绿的**：Playwright 的 `keyboard.press('Meta+Alt+W')` 走 DevTools 协议，它直接
合成 `key: 'w'`，**不经过 macOS 的输入法组合**。测试与真实浏览器看到的是两种事件，于是 83 条全绿而
用户全挂。这是本轮最值得记住的一条：**用 CDP 合成按键测不出输入法/组合键行为**。

**修法**：`matchesKeys` 在 `key` 不中且绑定带 `alt` 时，按物理键 `KeyboardEvent.code` 再比一次
（`KeyW`→`w`、`Digit1`→`1`、`BracketLeft`→`[`…）。`code` 是布局无关、且不受组合影响的。

- **只对 `alt` 绑定开放**：Windows/Linux 的 `AltGr` 也会改 `key`，但那些绑定没有 `alt`，不该被
  物理键兜住；把兜底限制在 `alt` 上，普通绑定（`w`、`mod+k`）的行为一字不变。
- **不是「改用 code」**：契约的键记法仍按 `KeyboardEvent.key` 书写（`w`、`arrowleft`、`[`），`code`
  只是 `alt` 这一条路径上的兜底，避免把键记法整个翻成布局相关。

**回归**：`commands.test.ts` +3（组合字符命中 `∑`/`®`/`¡`、别的物理键不命中、非 Apple 平台不启用兜底、
标点 `BracketLeft` 也命中、非 `alt` 绑定不受影响）；e2e `m2-commands` 7e 直接 dispatch
`{ key: '∑', code: 'KeyW', metaKey, altKey }` 并断言 `dispatchEvent` 返回 `false`（即页面
`preventDefault` 了）。变异验证：把 `code` 兜底去掉，7e 变红，其余 4 条仍绿。

**已知遗留**：`ctrl+tab` / `ctrl+shift+tab` 在 macOS 上被浏览器/系统先吃掉（契约 §3.7 已记），
这条不是本次修复的范围。
