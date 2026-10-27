# 实施说明：网页标题是这个目录的名字

> 记录于 2026-10-27。用户要求：**网页 title 显示了目录名称**。契约不升号（§6）：没有新增服务、
> 没有改 `ctx.*` 的签名、没有加座位、没有改 `/plugin.json`——变的只是**页面壳那一份 HTML**
> 的 `<title>`。契约正文补在 §34。

## 1. 出发点

页面壳的 `<title>` 一直是静态的 `diorama`（`apps/web/index.html`）。一个人同时开着几个挂载
（`diorama a`、`diorama b`，或者 gateway 上挂着整个 worktree 集合）时，浏览器标签条上是几个
一模一样的 `diorama`——**分不出哪个是哪个目录**，只能一个个点开看。

目录名是服务端**一开始就知道**的东西（`MountOptions.root`，也是 `diorama ls` 的 `DIR` 列），
所以它不需要等插件、等 RPC、等文件被打开。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 标题是什么 | `basename(root)` | 与 `diorama ls` 的 `DIR` 列、CLI 输出里的目录**同一个名字**；挂载键本来就是 realpath |
| 由谁写 | `serveShell` | 壳是静态 HTML，`<title>` 就在文件里；而 root 只有服务端有。两样东西只在这里相遇 |
| 什么时候到 | **文档到的时候就对** | 壳在 bundle 之前上屏；由页面 boot 之后补写的话，标签条会先闪一下 `diorama` |
| 带标记字符的目录名 | 转义成文本 | 目录可以叫 `<script>`；标题是文本节点，不是标记 |
| 根没有名字（`/`） | 保留壳自己的 `<title>` | 写一个空标题比写 `diorama` 更糟（标签条会显示 URL） |
| 跟着路由变吗 | **不** | 标题是**挂载**的属性：打开 `/~/README.md` 不该把标签条变成 `README.md`（活动文件已经写在 tab 条上） |
| 做成配置项吗 | **不** | 「这个目录叫什么」由目录本身回答；再加一个 `[ui] title` 只是多一件要维护的事 |

## 3. 语义细则

- `shellTitle(root)`：`basename(root)`，为 `/`（或 Windows 的 `\\`）时返回 `''`。路径末尾的分隔符
  由 `basename` 自己吞掉（`/a/b/` → `b`）。
- `withShellTitle(html, root)`：只替换壳里**第一个** `<title>…</title>`（大小写不敏感、跨行）；
  没有 `<title>` 的壳原样返回；`root` 没有名字时原样返回。
- 两个函数都是**纯函数**，放在 `kernel/src/server/shell-title.ts`，`node --test` 直接测（不 import 任何
  `.tsx`）。它们也从 `diorama-kernel/server` 导出，但它们是服务端工具，不是页面服务——**不进
  `/plugin.json`、不进 `ctx`**。
- 转义只处理 `& < >`：标题里不需要引号（不是属性值），多转一个 `"` 只会让名字看起来变了样。
- `serveShell` 的顺序：先写标题，再注入 `window.__diorama_theme__` 与 page bridge——三者互不依赖，
  但标题要在**任何替换之前**落在原文上，免得替换出来的片段里再出现 `<title>`。

## 4. 改动清单

| 包 | 改动 |
|---|---|
| `kernel/src/server/shell-title.ts`（新） | `shellTitle` / `withShellTitle` |
| `kernel/src/server/http.ts` | `serveShell` 用它替换 `<title>`；函数注释多一条 |
| `kernel/src/server/index.ts` | 导出两个纯函数 |
| `kernel/test/shell-title.test.ts`（新） | 目录名、末尾分隔符、`/`、没有 `<title>` 的壳、转义 |
| `apps/web/tests/m3-gateway.spec.ts` | 2a：两个挂载的**文档**里各写自己的目录名；页面 `title()` 一致；`/~/…` 深链也是这个名字 |
| `docs/contract.md` | 新 **§34** |
| `docs/features.md` | U23 |
| `README.md` | 功能清单补一条 |
| `AGENTS.md` | 「最近一档」指向本文件 |

## 5. 没做的（明确）

- **「目录名 — 文件名」**：活动文件已经在 tab 条上（`active-tab` 的 `title`），再进网页标题只会让
  标签挤不下，而且每开一个文件标题就变一次，反而不利于「这是哪个挂载」。
- **配置项 / CLI 参数**（`--title`）：见 §2 最后一行。要换名字就重命名目录。
- **页面自己改标题**（`document.title`）：那会让「谁最后写谁赢」，而壳的标题是**服务端**给的；
  两处都写的话，刷新前后会不一样。

## 6. 验证

1. `pnpm build`
2. `pnpm test:unit`
3. `pnpm -r --no-sort run typecheck`
4. `node scripts/assemble-package.mjs`，再 `pnpm --filter diorama-web exec playwright test`

## 7. 坑

1. **别在页面里改 `document.title`**。壳的标题是服务端写进 HTML 的：页面再写一次，断线重连、
   主题重绘、插件重载都可能让它变回 `diorama` 或者变成别的名字——两处来源必然漂。
2. **`serveShell` 是唯一知道 root 的地方**，但它同时也在做注入。先替换标题、再拼注入片段，
   否则注入的 `<script>` 里万一出现 `<title>`（不会有，但顺序清楚更省心）会抢走第一个匹配。
3. **e2e 要读文档，不只是读 `page.title()`**：`page.title()` 在 bundle 跑完之后也成立，读文档才
   证明「标题在页面脚本之前就对」。`fetch(url)` 拿到的就是浏览器会拿到的同一份 HTML。
4. **`basename('/')` 是 `'/'**，不是 `''`。不判这一条，`/` 挂载的标题会变成 `/`（标签条上看着像
   路径的一半）。Windows 的 `\\` 同理。
5. **目录名里的 `<` 会真的变成标签**：不转义的话，一个叫 `<b>x` 的目录会让页面头部的 HTML 结构
   坏掉——而 `serveShell` 拼出来的文档是要给浏览器解析的，不是给日志看的。
