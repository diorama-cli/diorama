# m33 — 定义跳转与语言智能（`ctx.lsp` + `lsp-nav`）

> 2026-11-06。用户要求：「调研能否接入 LSP，支持方法/变量等定义跳转，包括源码浏览 / git diff
> 等界面」。契约见 [contract.md](../contract.md) **§3.12**（服务）与 **§45**（变更清单）；
> 能力档位见 [features.md](../features.md) 的 K21 / P22 / U28。

## 1. 调研：能不能接

**能，而且成本比预想低。** 动手之前先在真实仓库上量过（不是纸面推演）：

| 量的是什么 | 结果 |
|---|---|
| `typescript-language-server` 初始化 | 61 ms |
| `documentSymbol`（一个 340 行的服务端文件） | 20 ms，25 个符号 |
| `references` | 11 ms |
| 第一次 `definition` | 293–340 ms（首次加载工程），之后 **1–4 ms** |
| 跨包定义（插件 → `diorama-ui` 的 `useStore`） | 解析到 `packages/ui/lib/index.d.ts:69` ✅ |
| 同包定义 | 精确到 `src/highlight.ts` 的声明行 ✅ |
| clangd（C） | 99 ms → 0 ms ✅ |
| gopls（Go） | 起来 337 ms，`definition` 回 `null`（需要工程配置，本机样例太裸）⚠️ |
| **clangd 喂未落盘的缓冲区**（模拟 diff 视图里「+2 行偏移」的文本） | 定义仍解析到正确行 ✅ |

最后一条是这次调研最关键的发现：**diff 视图可以直接接定义跳转**——把渲染器正在显示的文本
通过 `didChange` 灌进语言服务器，不需要临时文件、也不写盘。

反面结论同样重要：**裸 `tsserver` 不说 LSP**。它自己那套是 `tsserver protocol`（命令式，
`quickinfo` / `definition` 带 `file` / `line` / `offset`），我实测对 `initialize`
**永远不回答**。适配器 `typescript-language-server` 是必需的，不是可选的。

## 2. 为什么落在内核

插件**禁止** `import 'node:fs'` / 起进程（architecture.md §8、AGENTS.md §6）。LSP 客户端必然
`spawn` 一个进程并说它的管道语言——这条线不能为了一个功能破：破了以后「路径白名单 /
worker 隔离 / 子进程代理」就没有可以换实现的那一层了。所以是**内核服务** `ctx.lsp`，
与 `ctx.git` 同一个形状（每 mount 一份、只读、可选能力）。

## 3. 三个界面

| 界面 | 本档 | 做法 |
|---|---|---|
| **源码浏览** | ✅ | `code` 渲染器上三个手势：⌘/Ctrl+点击转定义、右键菜单（转定义 / 找引用）、悬停卡片 |
| **git diff** | ✅ v2 | 三档读法都接了；每档的行几何不同（见 §3.1） |
| **大纲 / 引用列表** | 服务层就位 | `documentSymbol` / `references` 都在服务上；界面未做 |

### 3.1 diff 的三档读法怎么定位

diff 的行**不是**文本渲染器的行：三个读法三种形状，而且**只有一部分行能问**。

| 读法 | 行上的属性 | 格子 | 前缀 |
|---|---|---|---|
| 行内（`inline`） | `data-new-line`（删除行**没有**） | `.diorama-diff__code` | 1（git 的 `+` / `-` / 空格） |
| 整文件（`file`） | `data-new-line`（删除行**没有**） | 同上 | 0 |
| 双栏（`split`） | `data-new-line`（**只在右栏**） | 同上 | 0 |

三条规则，各有各的理由：

1. **只问当前文件里存在的行**。删除行在当前文件里不存在；对它问「第 12 行」，
   服务器会回答**另一行**——比不跳更坏。所以删除行干脆没有 `data-new-line`，
   手势在那儿找不到行，什么都不发生。
2. **双栏只认右栏**。左栏是**旧**文件，行号是旧文件的。同一行号在左右两侧指的是不同的代码。
3. **行内读法要减 1**。格子里是 git 的原样行（`+` / `-` / 空格在前），列号从 1 起算，
   不减就每次点击都偏一个字符——落在相邻的词上，跳到一个看起来合理但错误的地方。

发给服务器的是**当前文件的全文**（`ctx.fs.readText` 或 `ctx.git.blob`），不是 diff 文本：
diff 的文本没有「第 12 行」这个概念。

`RowGeometry`（`lineAttribute` / `cellSelector` / `trim`）就是这件事的接口，
默认值是文本渲染器的 `TEXT_ROWS`。渲染器自己说明它的行长什么样，手势不必知道有三种读法。

## 4. 缓存写在哪（读者的决定）

**`/tmp/diorama/.cache/lsp/<normalised project>`**，被浏览的目录**一个字节都不写**。

压平规则：去掉前导 `/`、去掉尾随 `/`、**已有的 `-` 先加倍**、
再把 `/` 换成 `-`。加倍那一步是必须的——`/a-b` 与 `/a/b` 是两个项目，
不加倍就共用一个缓存目录（第一版漏了，单测当场抓住）。

各服务器的指向方式（**都量过**）：

| 服务器 | 怎么指 | 结果 |
|---|---|---|
| clangd | `--compile-commands-dir=<cache>` | 编译数据库与 `.cache/clangd/index` 都跟着走，项目干净 ✅ |
| clangd | 只改 `cwd` | **无效**：索引仍写进项目的 `.cache/` ❌ |
| clangd | `XDG_CACHE_HOME` | **无效**：这是 Xcode 的 clangd，不读它 ❌ |
| tsserver | `XDG_CACHE_HOME` | 它把工程状态放内存，磁盘上只写日志 |
| gopls | `GOCACHE` | 默认会往 `~/Library/Caches/go-build`（本机 4.5 GB）写，指走它 |

## 5. 自动安装（读者的决定）

TypeScript 的服务器缺了就 **自动 `pnpm add`** 到缓存目录。两件必须一起做：

1. `typescript-language-server` **和** `typescript` 一起装。适配器只是壳：旁边没有编译器时它
   直接退出（"provides no tsserver.js"），每个悬浮都是空的。
2. `typescript` 钉在 **5.x**。registry 上的 `typescript@7` 是原生预览版、**不带**
   `tsserver.js` —— 装上去反而更坏（第一版就是这样，症状是「装好了但一个答案都没有」）。

## 6. 坑（按症状查）

| 症状 | 根因 | 规则 |
|---|---|---|
| 起服务器成功，但每个请求都 `ESERVICE` / 超时 | 裸 `tsserver` 不说 LSP；或者适配器旁边没有 `typescript` | 适配器 + `typescript@5` 一起装；`status()` 的 `reason` 会写出真实原因 |
| 「装好了但一个答案都没有」 | `typescript@7` 不带 `tsserver.js` | 版本钉 5.x（§5） |
| **第一次**定义指回自己的 `import` 行，第二次才对 | 服务器还在加载工程，此时它只认得已打开的那一个文件 | 某语言的第一次查询：等 `$/progress` 归零，再**反复问直到两次答案一致**（坑 3） |
| 服务器一直等到超时 | 它对客户端发 `workspace/configuration` / `client/registerCapability`，没人回答 | 每个 server→client **请求**都要回（`configuration` 回 `[]`，其余回 `null`）；只回 notification 是不够的 |
| 第一次能跳，之后再也不跳 | 同一个：服务器在等一个没人回的问题 | 同上 |
| `node --test` 报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | 用了 TypeScript 的**参数属性**（`constructor(private readonly x)`），strip-only 模式不认 | 手写字段赋值 |
| 手势挂不上、点了没反应 | 把 `useKernel()` 的返回值当成 `ctx` 用 | `useKernel()` 返回 `{ ctx, mount, views, registry }`：服务在 `ctx` 上，`lsp` 在 `mount` 上 |
| 渲染器 import 不到手势 | 手势写在 piece 里 | 手势在 `diorama-ui`（两个半边不能互相 import）；piece 只发布页面全局的面 |
| e2e 里点不中标识符 | 按固定像素偏移点，落在行首的 `const` 上 | 用 `Range` 量出那个词的矩形再点 |
| 缓存目录撞车 | 压平把 `/a/b` 与 `/a-b` 变成同一个名字 | 先给已有的 `-` 加倍，再换分隔符 |
| **悬浮卡片里显示的是 ```typescript` 这样的围栏标记** | 把语言服务器的 Markdown 当文本画了 | 由 `markdown` piece 发布 `renderMarkdown` 到页面全局（``__diorama_markdown__``），卡片用它渲染；返回的 HTML **已经消毒**，别再转义（会变成 `&lt;`） |
| **点声明时只高亮自己，看不到谁在用它** | 只问了 `definition`：在声明上它的答案就是声明自己 | 同时问 `definition@@ + `references`，**先排除点击的那一处**（`isSelf`：同文件且行落在它的区间里）；剩下有定义就跳、没定义就列使用处（`chooseTargets`） |
| 「查找使用处」**静默地什么都不返回** | `includeDeclaration` 放在了 `textDocument/references` 参数的顶层；协议要求它在 `context` 里，放错位置服务器拒掉整个请求 | `{ context: { includeDeclaration: true } }` |
| 悬浮卡片**太容易弹出来**，扫过一行就挡代码 | 延时太短 | `HOVER_DELAY_MS = 1000`：停一秒才出现（`packages/ui/src/lsp-gestures.tsx`） |
| 指针只是离开**这个词**，卡片还挂着 | 只在容器上挂了 `onMouseLeave`，它要指针出整个代码区才触发 | 「离开」是**离开这个词**：`mouseover` 落到非标识符上也要立刻撤卡片 |
| 指针已经停在 token 上，**按 ⌘ 没有下划线** | 按键不产生指针事件，`mouseover` 不会再触发一次 | 记下最后一次指针位置（`onMouseMove`），`held` 变化时用 `elementFromPoint` 重新算一遍下划线 |
| 指针移开了，卡片**还挂着** | 有宽限期 | `HOVER_GRACE_MS = 0`，`onMouseLeave` 直接撤；指针在同一个标识符上时本来就不撤，所以不需要宽限 |
| 按下 ⌘ 后悬浮卡片**盖住了使用列表** | 卡片与列表都画在指针旁，卡片没有让路 | `held` 一变就撤卡片，并且**按住期间不再安排新的悬浮**（`onMouseOver` 里先判 `held`） |
| 使用列表每行前面都有「使用」两个字 | 标签里带了 kind | 列表只回答一个问题，每行按构造同类；只写 `path:行号`，`kind` 留在数据里 |
| 光标没变小手 / 整片代码都是小手 | 想用窗格级的 `cursor: pointer` | 写在**指针下那个元素**上（内联样式），离开时把原值放回；窗格级会对空白也承诺可点 |
| **松开 ⌘ 之后下划线还留着** | 松开修饰键**不触发任何鼠标事件**，没有事件来清状态 | 在 `held` 变回 `undefined` 的 `useEffect` 里主动清掉 |
| 下划线画在了整行上 | 想用 CSS 类贴在行上 | 下划线是**词**上的浮层：用 `Range` 量出那个词自己的矩形（与 caret 同一套度量），`position: fixed` + `pointer-events: none` |
| 点定义只跳到第一个，另外几处**永远看不到** | 服务器回答多处（重载 / 声明 + 实现 / 两处再导出），代码取了 `locations[0]` | **一个位置就跳，多个列出来**（`chooseDefinition`）；同一位置回答两次先**去重**，否则一次跳转变成了「只有一个选项的列表」 |
| **点一下整行右边的空白，语言服务器就死了**，之后这个 mount 上每个请求都失败 | tsserver 5.9.3 对**超出该行长度**的列抛 `Debug Failure. False expression`（`computePositionOfLineAndCharacter`）并退出 | 边界处 `clampPosition`：行夹进文件、**列夹进该行长度**。页面产生这种列是诚实的（diff 的行比它来自的那一行短） |
| diff 里点标识符跳到**另一行** | 对着删除行 / 双栏左栏问了「当前文件的第 N 行」，而那一行在当前文件里是别的内容 | 只有当前文件存在的行才有 `data-new-line`；删除行与左栏不给这个属性 |
| diff 里点标识符**偏一个字符**，跳到相邻的词 | 行内读法的格子带 git 的 `+` / `-` 前缀，列号多算了一个 | `RowGeometry.trim: 1`（只有行内那一档是 1） |
| 行内 diff 里定义跳转总是落空 | 行内读法本来不读文件正文，服务器没有那个文件可问 | 有手势面时也读一次（`useLspNav()` 有面时才 `wanted`）；没有 piece 的页面读的东西不变 |
| 卸载 mount 后 gateway 里堆了一堆 `tsserver` | 只 `kill` 了直接子进程，或者根本没关 | 先 `shutdown` 再 `exit`，500 ms 后 `SIGKILL`；关闭挂在 mount 的 disposer 上 |

## 7. 测法

| 层 | 文件 | 钉住什么 |
|---|---|---|
| 单测 | `packages/kernel/test/lsp.test.ts` | 1-based ↔ 0-based 互逆、`NaN` 不上线、扩展名归属、缓存目录不撞车、`Location` / `LocationLink` / `DocumentSymbol` / `SymbolInformation` 四种答案解析 |
| 单测 | `packages/ui/test/lsp-position.test.ts` | caret 落在哪个标识符上（空白、标点、行首、行尾、跨行都不串） |
| e2e | `apps/web/tests/m33-lsp.spec.ts` | 真服务器：定义落在声明那一行且是 1-based；⌘+点击真的开 tab 并闪目标行；去掉 piece 后页面全局没有手势面 |
| 单测 | `packages/plugins/git-changes/test/diff-rows.test.ts` | 三档 diff 的行几何：都认 `data-new-line`、只有行内那一档 `trim: 1` |
| 单测 | `packages/ui/test/lsp-hover-definition.test.ts` | 围栏解析（一个围栏 / 多个围栏 / 空围栏）与「一个就跳、多个列出来、没有就不动、重复先去重」 |
| 单测 | `packages/kernel/test/lsp-clamp.test.ts` | 位置夹进文本：列超出行长、行超出文件、负数、空文本 |
| e2e | `apps/web/tests/m33-lsp-nav.spec.ts` | 点**声明**列出使用处（且不含自己）；点**使用处**直接跳声明、不弹列表；按住 ⌘ 出现下划线、松开消失 |
| e2e | `apps/web/tests/m33-lsp-hover.spec.ts` | 卡片里是 `<pre><code>` + 上色 span 且没有反引号；重载列出两条并能选；单个定义直接跳、不弹列表；**超出行长的列不会弄死服务器** |
| e2e | `apps/web/tests/m33-lsp-diff.spec.ts` | 三档读法各跳一次（真的落在 `src/math.ts`）；删除行没有 `data-new-line`；双栏左栏一个都没有 |
