# 实施说明：Markdown 里的链接留在页面内（相对链接不再刷新整页）

> 记录于 2026-10-21。用户报告：**markdown 渲染后，点击其中相对文件的链接，会刷新到新文件，
> 导致其它 tab 都没了**。契约不升号（§6）：不改 `ctx.*`、slot、RPC 与控制面协议；新增条款是
> contract.md **§5.1** 末尾的一段「渲染器里的链接」，变更清单在 **§22**。

## 1. 现象与根因

`.md` 渲染成 HTML 之后，`[notes](docs/notes.md)` 就是一个普通的 `<a href="docs/notes.md">`。
点击它，浏览器按 HTML 的规则**跟随这个相对地址**——对页面而言是一次整页导航：

- 页面 URL 从 `/~/README.md` 变成 `/~/docs/notes.md`（服务端对 `/~/…` 回页面壳，SPA 回退）；
- 浏览器重新加载整个页面，内核重新 boot；
- tab 集合**不在 URL 里**（contract.md §3.8：URL 只记活动文件），所以刷新只恢复**一个** tab。

于是「点了 README 里的一行链接，另外五个 tab 全没了」。这不是 URL 路由的 bug：路由按契约只记
活动文件，多 tab 恢复是 O5（待定）。真正的 bug 是**渲染器把「打开一个文件」写成了「导航到一条
URL」**——前者是页面内的动作，后者会毁掉页面状态。

顺带两个同源的坏处：

- 链接指向**仓库外**（`../../etc/passwd`）时，浏览器会去请求一条 `/~/../etc/passwd` 的地址；
  服务端虽然会回壳（然后 `decodeRoute` 拒绝），但这次往返完全没必要；
- 链接指向**别的站点**时，当前页面被替换掉，读者回不来（除非按后退，而那又触发一次 SPA 恢复）。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 谁负责 | **`markdown` 渲染器自己**（`src/links.ts` 纯函数 + 一个 `onClick`） | 链接的语义属于「这段 Markdown 在说什么」，只有渲染器知道它来自哪个文件；内核不该认识 Markdown 的语法，也不该替所有渲染器拦点击 |
| 分类 | 四类：`file` / `anchor` / `external` / `invalid` | 「点下去会发生什么」只有这四种答案；把它们写成返回类型，测试就不必碰 DOM |
| 相对路径的基准 | **包含它的那个文件所在的目录** | 这是 Markdown 的语义，也是读者在编辑器里点同一条链接得到的答案 |
| 以 `/` 开头 | **挂载根**，不是文件系统根 | 仓库里的 `/docs/x.md` 指的是「本仓库的 docs/x.md」；挂载根之外的路径内核本来就拒绝（§3.8） |
| 逃出挂载根 | **`invalid`：什么都不做** | 与 `ctx.fs` 的 `EOUTSIDE`（§3.1）同一个边界；这里连一次 RPC 都不发 |
| 站内文件 | **`ctx.router.open(path)`**（没有 router 时退回 `ctx.tabs.open`） | 「打开一个文件」在内核里只有一个入口（§3.8）；渲染器不该自己拼 URL 或直接改 tab |
| 目录 | 有 `README`/`index` 就打开它，否则**什么都不做** | 目录不是 tab（§3.4）；导航目录是文件树的职责，链接顺手打开索引文档是最不意外的行为 |
| `#fragment` | **本文件内滚动**；`other.md#part` 打开那个文件再滚过去 | 否则锚点链接是死链——内核不滚动，浏览器又会导航走 |
| 标题 `id` | **渲染时按 GitHub 约定生成**（小写、去标点、空格连字符、重名 `-1/-2`） | 读者在 GitHub 上写的 `#getting-started` 在这里也要能用；不生成 id 就没有落点 |
| 别的站点 / 别的 scheme | **`window.open(..., '_blank', 'noopener,noreferrer')`** | 当前页面必须留住（它就是读者的上下文）；`noopener` 让新页面拿不到 `window.opener` |
| 带修饰键的点击 | **不拦**（交给浏览器） | ⌘/Ctrl+点击 = 新标签页、Alt+点击 = 下载，这些是浏览器既有语义；拦下来只会让人更意外 |
| 其他渲染器 | **不动**（`html` 预览在沙箱 iframe 里，`code`/`plaintext` 是纯文本） | 只有 Markdown 把仓库里的路径当链接渲染出来 |

## 3. 语义细则

- **分类发生在点击时，不发生在渲染时**：`href` 原样交给 DOMPurify（它是被消毒的 HTML 的一部分），
  点击时才按「这个文件是谁」解析。同一个渲染器实例可以显示不同文件（一个 tab 换文件），
  渲染期解析就得把基准路径也塞进 HTML，多一份可能过期的真源。
- **查询串被丢弃**：`notes.md?plain=1` 打开 `notes.md`。挂载的文件是按**路径**读的，查询串只会
  让路径变成错的。
- **只解码一次**：`%2520` 是「名字里真的有个 `%20`」，不能解两次；解码失败（`%E0%A4%A`）算
  `invalid`。解码发生在**越界检查之前**，所以 `%2e%2e/%2e%2e/etc/passwd` 同样被拒。
- **`#` 单独出现**（`notes.md#`）不算锚点，只打开文件；`#` 后面为空同理（`invalid`）。
- **协议相对地址 `//host/path` 是外部链接**，不是路径。
- **`stat` 失败不拒绝**：文件不存在时仍然打开那个 tab，由内容区按 §11 说明原因（§3.8 的既有语义：
  「不存在、读不了」总是开 tab，错误由内容区显示）。只有 `stat` **成功且是目录**时才改变目标。
- **跨文件的锚点会等一下**：`other.md#part` 打开的是一个还没渲染的文件，`scrollToHeading` 每帧重试
  最多 30 帧，找不到就安静放弃（死锚点不值得弹窗）。
- **标题 id 用私有 `Marked` 实例**：不碰共享的默认实例（别人可能也在配置它），renderer 每次
  `parse` 现造一个（`marked.use` 是**合并**，不是替换——注册一次就是一份永久累积）。

## 4. 改动清单

| 包 | 改动 |
|---|---|
| `plugins/markdown/src/links.ts` | 新文件：`classifyLink` / `resolveLinkPath` / `directoryOf` / `headingSlug` / `uniqueHeadingId`（纯函数，无 DOM） |
| `plugins/markdown/src/index.tsx` | 私有 `Marked` 实例 + 每次 parse 现造的标题 id renderer；`onClick` 分类并处置（`router.open` / `scrollToHeading` / `window.open`）；`directoryIndex` 找目录的索引文档 |
| `plugins/markdown/test/links.test.ts` | 新文件 7 条：相对路径基准、越界拒绝、四类答案、解码一次、锚点、slug 约定、重名 id |
| `apps/web/tests/m12-markdown-links.spec.ts` | 新文件 4 条 e2e：相对链接开新 tab（旧 tab 全在、页面没重载）、`#fragment` 滚动且不换 tab、外部链接开新页 / 越界链接什么都不做、目录链接开 README |
| `ui/src/styles.css` | `.diorama-markdown a` 加下划线（`--dio-accent-underline`）与 `cursor: pointer`；`[id]` 加 `scroll-margin-top` |
| `package.json` | `test:unit` 加 `packages/plugins/markdown/test/*.test.ts` |
| `docs/contract.md` | §5.1 末尾补「渲染器里的链接」；新 §22 变更清单 |
| `docs/features.md` | P5 补链接行为；C8 的测试计数更新 |

## 5. 验证

1. `pnpm test:unit`：248 条全绿（241 旧 + 7 新）。
2. `pnpm -r --no-sort run typecheck` 全绿。
3. `pnpm build` + `node scripts/assemble-package.mjs` 后 `playwright test`：112 条全绿
   （108 旧 + 4 新；老的 22 个 spec 无一改动）。
4. 手工：`diorama-beta .` → 打开根 `README.md` → 点 `docs/…` 链接，左栏 tab 数 +1，其余 tab 还在。

## 6. 踩到的坑

1. **`marked.use` 是合并，不是替换**。第一版把标题 id 的 renderer 用 `marked.use({renderer})` 注册在
   共享实例上：每次渲染多挂一个 renderer，而 renderer 里的重名计数器又跨文档不清零——第二篇文档的
   第一个 `## Intro` 会变成 `intro-1`。改成私有 `new Marked(...)` 实例 + 每次 `parse` 传一个现造的
   renderer（`marked.parse(text, { renderer })` 不写回实例），计数器的生命周期就与文档一致。
2. **`new marked.Renderer()` 在类型上不存在**：`marked` 的默认导出是函数（`marked.parse`），类要从
   命名导出取（`import { Marked, Renderer } from 'marked'`）。用默认导出写 `marked.Renderer` 能跑，
   但 `tsc` 报 `Property 'Renderer' does not exist`。
3. **目录链接不能假定 `README.md` 存在**。第一版把目录一律改写成 `<dir>/README.md`，在只有
   `docs/notes.md` 的目录上开出一个 ENOENT 的 tab——比「什么都不做」更糟。现在是 `list` 一下，
   命中 `README`/`index`（大小写不敏感、只认 `.md`/`.mdx`）才开。
4. **两条 tab 的标签可以同名**（两个 `README.md`），所以「打开了哪个文件」只能用 URL 断言。
   第一版 e2e 先断标签、再读 `page.url()`，标签立刻满足而 URL 还没写，测试红了但功能是对的；
   改成 `expect(page).toHaveURL(...)`（会重试）。
