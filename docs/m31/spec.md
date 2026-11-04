# 实施说明：Markdown 里的代码片段语法高亮

> 记录于 2026-11-03。用户要求：「支持 markdown 渲染中的代码片断语法高亮」。
>
> 契约不升号（§6）：没有新增内核服务、没有改 `ctx.*` 的签名、没有加座位。契约正文改了
> **§5.1**（Markdown 渲染器画什么）与 **§30 的引擎形状**（多一个可选读法），变更清单是新写的
> **§43**（标注「未发版，下一个 `0.0.x`」）。

## 1. 出发点

`.md` 文件里最常出现的两种内容是正文和代码。正文早就是 HTML 了（表格、链接、公式、图表），
**围栏代码块却一直是转义后的纯文本**：marked 的 `Renderer.code` 只做转义，颜色是零。

同一个仓库里，颜色其实早就有两处：`code` 渲染器（读一个源文件，一行一个元素）与 diff 的
「整个文件」/「新旧对照」两档（读 diff 的行）。两者共用 `code` 在 boot 时发布到页面的引擎
（`__diorama_highlight__`，§30）。缺的不是引擎，是**引擎缺一个给文档用的读法**。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 颜色从哪来 | 页面全局的引擎（`code` 发布的那个） | 一个仓库里只能有一张语言表。让 `markdown` 自己注册一份 highlight.js 就是第二个 bundle、第二张表，而且两边的语言集合会漂（§30 的同一条理由） |
| 引擎怎么扩展 | `Highlighter` 多一个**可选**的 `block(text, language, escaped?)` | 已有的 `lines()` 是「一行一个自足片段」，给 diff 的折带 / 双栏用的；文档是一整段 markup，按行切只会每行多两个标签。可选是因为发布者与读者分开构建（§8），只画行的引擎不该被迫实现它 |
| 语言名从哪来 | 围栏的 info string（```ts`），**先归一** | 围栏写短名、引擎注册长 id。highlight.js 把短名留成别名，查别名再答回长 id，于是文档与文件报同一个语言名 |
| 不认识的围栏 | 转义文本，**不猜** | `highlightAuto` 猜错的颜色比没有颜色更误导：读者无从判断这段为什么是「那样」 |
| 没有引擎时 | 转义文本（与这一档之前完全一样） | M0 验收点 3：去掉一个 piece 剩下的东西必须仍然成立。`--plugins` 里没有 `code` 的页面照常读文档 |
| 内联 `code` | **不上色** | 那是一个名字（`ctx.fs`），不是一段代码 |
| 引擎晚到 | 重新解析这篇文档 | boot 顺序是插件图的，不是某个文件的；`useHighlighter` 的快照是版本号，引擎到达时组件重渲染、`useMemo` 重算 |

## 3. 实现

### 3.1 引擎（`packages/plugins/code`）

- `src/highlight.ts` 加 `highlightBlock(text, language, escaped = false)`：
  - `language` 取第一个词、小写；`canonicalLanguage()` 在**已注册**的定义里按 id 或 `aliases`
    找到它（`ts` → `typescript`），找不到返回 `undefined`；
  - 找到就 `hljs.highlight(text, { language: id, ignoreIllegals: true })`，返回
    `{ html, language: id }`；
  - 找不到（或 highlight.js 自己抛错）返回转义文本 + `language: 'plaintext'`。`escaped` 是调用方
    说「这段已经是转义过的」——marked 的 token 带这个字段，重复转义会把 `&lt;` 变成 `&amp;lt;`。
- `src/index.tsx` 发布时多给一项：`publishHighlighter({ languageOf, lines, block: highlightBlock })`。

### 3.2 渲染器（`packages/plugins/markdown`）

- `documentRenderer(outline, engine?)` 的 `code` 分支：mermaid 围栏照旧变成占位元素；其余先问
  `engine?.block?.(token.text, token.lang, token.escaped === true)`，答出语言就画
  `<pre class="diorama-markdown__code" data-language="…"><code class="language-…">…</code></pre>`，
  否则退回基类（转义文本）。**`data-language` 是给读者与测试看的**：不用再解析 token 才知道这块
  被认成了什么。
- `renderDocument(text, engine?)` / `renderMarkdown(text, engine?)` 把引擎透传下去——纯函数照旧，
  `node --test` 不受影响（不传引擎就是纯文本）。
- `Markdown` 组件用 `useHighlighter()` 取引擎，并放进 `useMemo` 的依赖：引擎晚到时文档重解析。

### 3.3 配色（`packages/ui/src/styles.css`）

- `.diorama-markdown pre .hljs-*` 六组，**只用** `--dio-syn-*` 六个 token（light / dark 成对，
  §5.3），与 `.diorama-code` / `.diorama-diff__code` 的选择器形状相同。没有新增颜色。

## 4. 测试

- `packages/plugins/code/test/highlight.test.ts` 多 5 条：info string 命名语言、只取第一个词、
  未知 / 缺失语言转义、已转义的文本不二次转义、整块是一个片段（换行还在里面）。
- `apps/web/tests/m31-markdown-code.spec.ts`（3 条，真实 CLI + Chromium）：
  1. 一个 ```js 围栏画出 `.hljs-keyword` / `.hljs-comment` / `.hljs-string`，且颜色**等于**
     `var(--dio-syn-keyword)` 解出来的值（探针元素对比，不是「不是黑色」这种弱断言）；
  2. 未注册的语言：没有 token、围栏里的 `<b>` 不被解释、文本照常可读；
  3. `--plugins` 不含 `code`：围栏还在、是文本、没有 token，也不报错。

## 5. 验证

```bash
pnpm build
pnpm test:unit                                   # 453 条
pnpm -r --no-sort run typecheck
node scripts/assemble-package.mjs                # 改了 styles.css，e2e 的壳要重装
pnpm --filter diorama-web exec playwright test   # 182 条
```

## 6. 坑

1. **`hljs.getLanguage('ts')` 拿到的不是 `typescript` 这个名字**。它按别名解析出定义对象，但
   `highlight(code, { language: 'ts' })` 的 `language` 结果、以及定义对象自己的 `name` 字段
   （`'TypeScript'`，带大写）都不是页面里那个 id。第一版直接拿入参当语言名，文档块报的是 `ts`
   而文件报 `typescript`——同一段代码在两处被叫成两个名字。改成按 `aliases` 反查回注册 id。
2. **marked 的 `token.escaped` 不能忽略**。它在 token 上就写着这段文本是否已经被转义；未知语言的
   分支如果无条件再转义一次，`<` 会变成 `&amp;lt;`，读者看到的是实体名。`highlightBlock` 的
   `escaped` 参数就是为这一条存在的。
3. **`block` 必须是可选的**。读者（`markdown`）与发布者（`code`）是两个构建，版本可以不同；
   把方法写成必需项，等于要求每个引擎都实现文档那一半，而 `git-changes` 一个字节都用不上它。
4. **颜色不要用字面量**。第一版在插件里写了一个 `#c9d1d9` 之类的手感色，暗色主题下直接糊成一片；
   token 表是唯一入口（§5.3），e2e 用「探针元素解出的 token 值与 token span 的颜色相等」锁住。
5. **改了 `styles.css` 要重装壳**（m26/spec §6.5.1、m30/spec §6 坑 4）：e2e 的 CSS 来自
   `packages/cli/web/`，`pnpm build` 只刷 `apps/web/dist`。不跑 `assemble-package.mjs`，
   新选择器在测试里**完全没有样式**，颜色断言会以「空字符串」失败。
