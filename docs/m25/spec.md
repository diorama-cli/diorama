# 实施说明：文件的原件链接与三个动作（下载 / 复制链接 / 独立窗口打开）

> 记录于 2026-10-28。用户要求：**文件导航窗口右键 →（下载、复制链接、独立浏览器窗口打开）**；
> 随后两次澄清：**复制链接复制的是下载链接**、**独立浏览器窗口打开是直接打开/下载文件本身，
> 而不是打开 diorama 应用里的那个文件**；URL 形状定为 **`/~raw~/<path>`**；**默认不 attachment**；
> **媒体类型按文件类型返回**；三条动作**同时做成命令**；独立窗口**不指定宽高**。
>
> 契约不升号（§6）：没有新增内核服务、没有加座位、没有改 `ctx.*` 签名。契约正文补在
> **§4**（新路由）、**§3.1**（下载不经 `ctx.fs`）、**§3.7**（三条命令）、**§5.2**（视图的右键菜单）、
> **§3.8**（第二条保留前缀）；变更清单是 **§36**。

## 1. 出发点

文件树能**看**一个文件，却没法把它**拿走**。读一份日志、看一张图、要把一个 PDF 发给同事——
这三件事今天都得读者自己去文件系统里找那个文件。而「我在 diorama 里正在看的东西」和
「磁盘上那个文件」本来就该有同一张脸。

要做的事只有一件：**给这个文件一个可以直接用的地址**。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 三个动作指向什么 | **同一个 URL** `/~raw~/<path>` | 读者要的是「下载链接」——发得出去、也打得开的那个地址。一个 URL 服务三个动作，路径里命名的是**资源** |
| 下载怎么表达 | `?download=1` | 动作进查询串。默认 inline，只有它要求保存 |
| 前缀 | `/~raw~/` | 与 `/~/` 成对（页面 / 原件）；`~` 是文件名里不可能出现的字符，裸 `/raw/` 会被同名目录吃掉 |
| 为什么不是 `/~origin~/` | 弃用 | `origin` 在本仓库已是 CORS 语义（`Access-Control-Allow-Origin`、`baseUrl`、`location.origin`），读起来像跨源 |
| 媒体类型 | `mimeOf(path)`，**不降级** | 用户明确要求「按文件类型返回对应的 content-type」 |
| 表要多大 | **源码 / 配置 / 点文件都是文本** | 第一版表只认识 30 来个扩展名，其余一律 `application/octet-stream`，于是「很多代码文件在新窗口打开都是下载」。见 §8 |
| 文本编码 | `charset=utf-8`（`rawContentType`） | 不带 charset 的 `text/*` 让浏览器**猜**编码，中文必乱码。见 §8 |
| `content-disposition` | 默认**不发**，`?download=1` 才 `attachment` | 用户明确「除非明确下载，不然都不要 attachment」 |
| 大小上限 | **无** | 字节流给浏览器，不经过页面；`readBytes` 的 32 MiB 是「读进页面」的成本 |
| 三个动作放哪 | 文件行的**右键菜单** + 三条**命令** | 菜单带得了「哪一行」；命令带不了，所以命令作用于**活动 tab 的文件**。两条入口，一张动作表 |
| 菜单用什么座位 | **不用** | 与 §35 工具栏同一条分工：视图的控件画在视图自己的组件里 |
| 菜单原语放哪 | `diorama-ui` 的 `ContextMenu` | 定位 / 越界翻转 / 键盘 / 关闭规则到处都一样，第二个视图长第二份就会漂 |
| 独立窗口怎么开 | `window.open(url, '_blank')`，**不带宽高、不用 `popup=yes`** | `popup=yes` 会强出一个没有地址栏的 OS 窗口；这个动作的意义就是「拿到这个文件的地址」。见 §8 |

## 3. 实现

### 3.1 服务端路由（`kernel/src/server/http.ts`）

`/~raw~/` 在 `handleRequest` 里、**`serveShell` 兜底之前**（否则会被当成未知路径回页面）。
`serveRaw` 的要点：

- 路径校验用 **`resolveInside`**——与 `ctx.fs` 同一份（绝对路径 / NUL → 400，越界 → 403）；
- 不存在 404、是目录 400、解码失败 400；
- `content-type: rawContentType(path)`（就是 `mimeOf`）、`content-length`、
  `x-content-type-options: nosniff`、`cache-control: no-cache` + `etag`；
- **只有 `download` 为真时才发 `content-disposition`**；
- `createReadStream(...).pipe(res)`；`HEAD` 只 `writeHead` 后 `end()`；
- `ignore` **不参与**：隐藏规则只作用于 `list`（§3.1）。

### 3.2 纯函数（`kernel/src/shared/raw.ts`）

`RAW_PREFIX`、`encodeRawPath`、`decodeRawPath`、`rawUrl`、`rawContentType`、
`contentDisposition`、`DOWNLOAD_QUERY`。两个 kernel 入口（`.` 与 `./client`、`./server`）都导出。

`contentDisposition` 做两件事：ASCII 回退（非 ASCII → `_`，引号与反斜杠也换掉）与
`filename*=UTF-8''…`；控制字符先被剥掉，所以一个文件名**不能**被写成第二个响应头。

### 3.3 动作表（`plugins/file-tree/src/actions.ts`）

`FILE_ACTIONS`（id / label / hint）、`fileCommand(id)` → `file.download`、
`runFileAction(action, url, host)`、`withDownload(url)`。**这个模块什么都不 import**——理由见 §6 坑 1。

`FileActionHost` 是注入的（`copy` / `save` / `open`），所以整张表能在 `node --test` 里跑，不需要 DOM。

### 3.4 浏览器半边（`plugins/file-tree/src/host.ts`）

- `copyText`：`navigator.clipboard.writeText` → 失败或不存在 → 隐藏 textarea + `execCommand('copy')`
  → 仍失败就返回 `false`（调用方把 URL 显示出来）；
- `saveUrl`：`window.location.assign`——`attachment` 会让浏览器留在当前页并写文件；
- `openInWindow`：`window.open(url, '_blank', 'popup=yes')`，**不带宽高**；返回 `null` 即被拦截。

### 3.5 视图（`plugins/file-tree/src/index.tsx`）

- 行上 `onContextMenu`：**只有文件行**拦截；目录行 `return`，浏览器原生菜单照旧；
- `onKeyDown` 收 `ContextMenu` 键与 `Shift+F10`（菜单的键盘入口）；
- 视图里一个 `menu` state（`{ file, x, y }`）与一个 `notice` state（失败提示）；
- `ContextMenu` 的 `items` 由 `FILE_ACTIONS` 映射而来，`run` 里**就地拼 URL**
  （`rawUrl(mountCtx.baseUrl, path)`）再交给 `runFileAction`；
- 三条命令在 `apply` 里注册，`when` 看 `context.activeTab !== undefined`，URL 由 `ctx.mount.baseUrl` 拼。

### 3.6 菜单原语（`ui/src/contextmenu.tsx`）

受控组件：`{ x, y, title?, items, onClose }`。`position: fixed` 贴指针，`useLayoutEffect` 量到尺寸后
越界翻转并 clamp；`Esc` / 点外部（`pointerdown` 捕获阶段）/ `scroll` / `resize` 关闭；
`↑↓` 循环、`Home` / `End`、`Enter` / `Space` 执行、`Tab` 关闭；`role="menu"` + `role="menuitem"`。

**不需要 portal**：页面容器链上没有 `transform` / `filter` / `contain`，`fixed` 就是相对视口，
不会被滚动窗格裁掉——所以 §8 的模块表仍然只有 `react` 与 `react/jsx-runtime`。

### 3.7 样式（`ui/src/styles.css`）

`.diorama-menu`（`z-index: 120`，高于 palette 的 100 与键帽的 6）、`.diorama-menu__title`
（路径可横向滚，不省略）、`.diorama-menu__item`（`:disabled` 半透明）、`.diorama-menu__hint`、
`.diorama-tree__notice`（失败提示条）。全部走 token，light / dark 不需要各写一份（没有新 token）。
## 4. 改动清单

| 包 / 文件 | 改动 |
|---|---|
| `kernel/src/shared/types.ts` | `RAW_PREFIX` |
| `kernel/src/shared/raw.ts`（新） | 编码 / URL / `contentDisposition` / `rawContentType` |
| `kernel/src/server/http.ts` | `/~raw~/` 路由与 `serveRaw` |
| `kernel/src/client/index.ts`、`kernel/src/types.ts`、`kernel/src/server/index.ts` | 导出新纯函数 |
| `ui/src/contextmenu.tsx`（新）、`ui/src/index.ts`、`ui/src/styles.css` | `ContextMenu` 原语与样式 |
| `plugins/file-tree/src/actions.ts`（新） | 动作表与 `runFileAction`（**不 import**） |
| `plugins/file-tree/src/host.ts`（新） | 剪贴板 / 保存 / 开窗 |
| `plugins/file-tree/src/index.tsx` | 行菜单、失败提示、三条命令 |
| `kernel/src/shared/mime.ts` | 表按文本 / 二进制两半重建（源码、配置、点文件都是文本）；另加一张**按名字**的表（`Makefile` / `LICENSE` / 点文件）；新增 `isTextualMime` |
| `kernel/test/raw.test.ts`（新） | 7 条纯函数单测 |
| `kernel/test/mime.test.ts`（新） | 7 条表覆盖（含「表里不许带参数」） |
| `plugins/file-tree/test/actions.test.ts`（新） | 8 条动作表单测（含失败两条） |
| `apps/web/tests/m25-tree-menu.spec.ts`（新） | 9 条 e2e（含 content-type 与 UTF-8 两条） |
| `package.json` | `test:unit` 加 `packages/plugins/file-tree/test/*.test.ts` |
| `docs/contract.md` | §3.1、§3.7、§3.8、§4、§5.2、§36 |
| `docs/features.md` | 新增 U25 |
| `AGENTS.md` | 「最近一档」指向本文件 |

## 5. 没做的（明确）

- **不做 Range 请求**：大视频在窗口里能播但不能 seek。要的话加 `Range` / `206`，不动其它。
- **不做下载上限**：与 `readBytes` 的 32 MiB 是有意的差别。
- **不给三条命令绑键位**：`mod+d` / `mod+c` / `mod+o` 都是浏览器自己的，语义也不同。
- **菜单只铺在文件树**：tab 条、变更视图、搜索结果复用同一个原语是下一步的事，这一档不开。
- **不记独立窗口的尺寸**：用户明确不要指定宽高。

## 6. 坑

1. **新模块只要 `import` 了 `diorama-kernel` 而没先 `import 'cordis'`，整个包的 `Context.provide`
   增强就没了。** 症状是 `file-tree` 里早就写着的 `ctx.provide('tree', …)` 突然报
   `TS2339: Property 'provide' does not exist on type 'Context'`——报的是**旧代码**，病因在**新文件**。
   这是 TypeScript 的模块增强与「谁先进程序」的相互作用：`cordis` 的 `reflect.d.ts` 里那句
   `declare module './context'` 只有在 `cordis` 先被加载时才把 `provide` 合进 `Context`。
   实测：同一份内容叫 `actions.ts` 报错、叫 `zz.ts` 不报错（文件顺序变了）；在 import 列表最前面
   加一行 `import type { Context } from 'cordis'` 就不报错。
   **本档的处理**：`actions.ts` **不 import 任何东西**（URL 由视图拼好传进来），
   `host.ts` 只 import `./actions.ts` 的类型。以后在这个包里加文件，照此办理。
2. **`/~raw~/` 必须排在 `serveShell` 兜底之前**。`http.ts` 的最后一条是「未知路径回页面壳」
   （SPA 语义），放晚了这条路就是「打开一个 HTML 页面」，而不是「打开那个文件」。
3. **`/~raw~/` 不会被 `/~/` 吞掉**：`pathname.startsWith('/~/')` 看的是第三个字符，
   `/~raw~/` 那里是 `r`。两条前缀互不为前缀，可以放心并列。
4. **`attachment` 是「保存」，`inline` 是「显示」，别在 header 里两处都写**：默认那个分支
   **不发** `content-disposition`，比发一个 `inline` 更干净（`inline` 还要处理 filename 的转义）。
5. **剪贴板在非 secure context 下是「存在但拒绝」**：`navigator.clipboard` 在 `http://192.168.x.x`
   上不是 `undefined`，是 `writeText()` reject。所以 `try/catch` 之后必须**继续往下走**
   到 `execCommand` 回退，不能只看 `!== undefined`。
6. **`window.open(url, '_blank', 'popup=yes')` 被拦截时返回 `null`**（不是抛错）。
   必须在用户手势的同一个 tick 里调用，否则浏览器一律拦。
7. **菜单是 `position: fixed` 且没有 portal**：靠的是「祖先没有 `transform` / `filter` / `contain`」。
   哪天给 `.diorama-layout` 或 `.diorama-sidebar__panes` 加了其中任何一个，菜单就会被那个祖先
   接管坐标系、并被 `overflow: hidden` 裁掉。那时才需要 `createPortal`——而 `react-dom` 进模块表
   是 §8 的破环变更，得单独议。
8. **`data-menu-item` 是测试钩子也是 id**：菜单项 id 用动作 id（`download` / `copyLink` /
   `openInWindow`），命令 id 是 `file.<动作>`——两者刻意不同（一个在 DOM 里，一个在注册表里）。
9. **e2e 里读剪贴板要先授权**：`context.grantPermissions(['clipboard-read', 'clipboard-write'])`，
   否则 `navigator.clipboard.readText()` 抛错。
10. **断言 palette 之前要等两件事，不是一件**。`toHaveCount(0)` 对着**还没渲染**的 palette 会
    立刻通过（等于在「没有列表」的时候断言列表里没有某行）；而 palette 的按键由它的**输入框**接管，
    输入框是在 overlay 打开后 `setTimeout(0)` 才聚焦的——`Escape` 发早了没人接，palette 留在原地，
    它的背板再把下一次点击吞掉。症状是一个只在全量跑时出现的超时（本档实测两次：先 30s 的
    `locator.click`，再 10s 的 `toHaveCount(0)`）。修法是两个等待：`palette` 可见 + `palette-input`
    已聚焦。

## 7. 验证

1. `pnpm build`
2. `pnpm test:unit`（**411 条**：396 + 8 条动作表 + 7 条 mime 表）
3. `pnpm -r --no-sort run typecheck`
4. `node scripts/assemble-package.mjs`，再 `pnpm --filter diorama-web exec playwright test`
   （**163 条**：154 + 9 条本档）

## 8. 追补：三处实测反馈（2026-10-28）

用户试用后报了三条，都改了：

| 反馈 | 根因 | 改法 |
|---|---|---|
| 「很多代码文件在新窗口打开都是下载」 | `mimeOf` 的表只有 30 来个扩展名；`.py` / `.rs` / `.java` / `.go` / `.sh` … 全部落到 `application/octet-stream`，而浏览器对 octet-stream 只有一种反应：保存 | 表按「文本 / 二进制」两半重建，覆盖各语言源码、配置、shell、标记、数据、点文件；**只有表外扩展名**才是 octet-stream |
| 「乱码，应该是 content-type 没有字符编码」 | `text/*` 不带 `charset` 时浏览器**自己猜**（多数按 windows-1252），UTF-8 的中文就成了乱码；diorama 自己却按 UTF-8 读同一个文件 | `rawContentType` 给文本类加 `charset=utf-8`；**`mimeOf` 保持裸类型**，否则 `text/plain` 这类 matcher 全部失配（§5.1） |
| 「为什么不是 chrome 新 tab，而是真一个新窗口」 | `window.open(url, '_blank', 'popup=yes')`：`popup=yes` 让浏览器开一个没有工具栏 / 标签条 / **地址栏**的 OS 窗口 | 去掉 features：`window.open(url, '_blank')`，现代浏览器给的就是标签页 |

三条的共同教训：**这条路由是「给别人用的地址」，所以它必须像一个普通 URL 那样工作**——普通 URL
不会因为扩展名陌生就下载，不会因为没写 charset 就乱码，也不会开一个没有地址栏的窗口。

细节：

- **没有扩展名的文件**（`extensionOf` 对它们答 `''`）以前一律「未知」→ octet-stream。现在走一张
  **按名字**的表：`Makefile` / `Dockerfile` / `LICENSE` / `README` / `Gemfile` …，以及
  `.gitignore` / `.env` / `.npmrc` 这类点文件（开头的点属于名字，不是扩展名）。
  `Dockerfile.dev` 这种变体按点前的名字认；而 `Gemfile.lock` 里的 `.lock` 是**已知扩展名**，
  所以按扩展名走（`text/plain`）——名字表只在扩展名表答不出来时才被问到。
- **`isTextualMime`** 是「要不要加 charset」的唯一判据：`text/*` 加上 JSON / NDJSON / manifest / XHTML。
  图片、音视频、字体、PDF、wasm 不加参数——给它们加 `charset` 只会是噪音。
- **`mimeOf` 与 `rawContentType` 分工**：前者是 matcher 与渲染器看的裸类型，后者是线上头。
  两者的差别只有 `; charset=utf-8`，但它必须在**一个**地方加，否则 matcher 与线上头会各自漂。
- **e2e 锁住了这三条**：`m25-tree-menu.spec.ts` 的「the raw route answers every source file as text」
  逐条断言 `.py` / `.rs` / `.java` / `.gitignore` / `.json` / `.md` / `.bin` 的 `content-type` 与
  「默认没有 `content-disposition`」；「a UTF-8 file comes back as UTF-8」断言中文文件名与正文。
  新表另有 `kernel/test/mime.test.ts`（7 条）逐组覆盖，包括「表里不许带参数」这一条。
