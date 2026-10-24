# 实施说明：diff 的单栏 / 双栏加语法高亮

> 记录于 2026-10-24。用户要求：**diff 单栏 / 双栏模式都增加语法高亮**。契约不升号（§6）：没有新增
> 服务、没有改 `ctx.*` 的签名、没有加座位；变的是 §5.2 里两个内容读法画什么，以及 `diorama-ui`
> 多了一个页面级的引擎位置。契约正文补在 **§5.2 / §5.3**，变更清单在 contract.md **§30**。

## 1. 出发点

v0.10 给了 diff 三档读法（contract §23）：「改动」是着色的 unified diff，「整个文件」把改动放进文件
自己的行号里，「新旧对照」左旧右新。后两档显示的是**源码**，却只有纯文本——而同一个文件在 `code`
渲染器里是上色的。读代码的人在同一次阅读里遇到两套观感：

1. 单栏 / 双栏**要能读代码**，不只是能看出哪几行变了；
2. 颜色必须与 `code` 渲染器**一致**（同一套 token，light / dark 都对）；
3. 不能为了这个把 highlight.js 塞进第二个半边，也不能为此开一个内核服务。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 上色的是哪两档 | 「整个文件」与「新旧对照」 | 这两档画的是源码；「改动」是 git 自己的文本（`+` 前缀、`@@` 头），上 token 色只会更乱 |
| 引擎放哪 | `code` 半边发布到页面（`__diorama_highlight__`） | 语言表与注册只该有一份；半边不能 import 另一个半边（各自是自足闭包，contract §8） |
| 为什么不是内核服务 | 页面 UI 状态 | 没有 IO、没有跨 mount 语义；开服务要在四处接线，只为把同一份 highlight.js 在服务端再跑一遍 |
| 引擎的形状 | `languageOf(path)` + `lines(text, path)` | diff 一行一行画，需要**每行一个完整片段**；给整段 HTML 再让调用方切，等于让每个调用方各写一遍切割 |
| 跨行 token | 断行处闭合、下一行重开 | 一条块注释 / 多行字符串在 highlight.js 里是一个 span；直接按 `\n` 切会留下未闭合标签（后一行整行变色或干脆没闭合） |
| 删除行 | 成段交给引擎，再切回来 | 它们不在当前文件里；成段上色才能保住其中跨行的构造。双栏里与删除行配对的**新增**格子仍从文件取，各自上色 |
| 没有引擎 | 画纯文本 | `code` 不在 boot 图、或还没发布时，diff 照常可读——不是空白，不是报错 |
| 颜色 | 只用 `--dio-syn-*` 六个 token | contract §5.3；light / dark 成对，暗色下与 `code` 完全一致 |

## 3. 语义细则

- **发布是版本化的**：`publishHighlighter` 递增版本号，组件用 `useSyncExternalStore` 读**数字**
  （快照是数字，不是对象——否则每次渲染都是新引用，见 AGENTS §5 的「界面永远正在读取…」）。
  boot 顺序由插件图决定，读者可能先于发布者渲染。
- **注销只撤自己的**：`publishHighlighter` 返回的 disposer 只在"页面上还是我这个引擎"时清空，
  另一个 piece 之后发布的引擎不会被它误删。
- **每行都完整**：`splitHighlightedHtml` 维护一个开标签栈，遇 `\n` 先补闭合、下一行再重开；
  行数与 `splitTextLines` 的口径一致（末尾换行不多出一行）。
- **文本是转义过的**：没有语言时走 `escapeHtml`；有语言时 highlight.js 自己转义输入。
  仓库里的内容永远不被当作 HTML 解释（与 `code` 渲染器同一条规则）。
- **双栏共用一份标记**：未改动的行两栏本来就是同一行文本，所以只切一次、两栏共用；
  只有被删除的格子有自己的一份。
- **`data-language`**：两个内容读法的根元素带上引擎回答的语言（`plaintext` 表示不认识），
  与 `code` 渲染器同名同义，方便读也方便测。

## 4. 改动清单

| 包 | 改动 |
|---|---|
| `ui/src/highlight.ts` | 新文件：`Highlighter` 接口、`publishHighlighter` / `highlighter` / `highlighterStore` / `useHighlighter`，页面全局 `__diorama_highlight__`（版本号 + 监听者） |
| `ui/src/index.ts` | 导出上面这些 |
| `plugins/code/src/highlight.ts` | 新文件（**纯函数**，`node --test` 能跑）：语言表、注册、`languageOf` / `highlight` / `escapeHtml` / `splitTextLines` / `splitHighlightedHtml` / `highlightLines` |
| `plugins/code/src/index.tsx` | 渲染器改用它；`ctx.effect` 里 `publishHighlighter({ languageOf, lines: highlightLines })` |
| `plugins/code/test/highlight.test.ts` | 新文件 9 条：语言判定、claimed 扩展名、行数口径、跨行 span 的闭合与重开、转义、未知语言回退 |
| `plugins/git-changes/src/coloring.ts` | 新文件（**纯函数**）：`colorFileRows` / `colorSplitRows`——把两种读法的行映射到引擎的每行片段 |
| `plugins/git-changes/src/index.tsx` | `WholeFile` / `SplitFile` 读 `useHighlighter()`、带上 `path`；新 `CodeCell`（有片段就 `dangerouslySetInnerHTML`，没有就纯文本）；行内那档显式保持纯文本 |
| `plugins/git-changes/test/coloring.test.ts` | 新文件 6 条：未改动行取自己的文件行、删除行成段、双栏两侧共用、删除/新增各在一侧、纯插入左侧为空 |
| `ui/src/styles.css` | `.diorama-diff__code` 下的六个 `.hljs-*` 选择器（只用 token） |
| `package.json` | `test:unit` 加 `packages/plugins/code/test/*.test.ts` |
| `apps/web/tests/m19-diff-highlight.spec.ts` | 新文件 3 条：单栏上色且行内不上色、双栏两侧各自上色、不认识的语言画纯文本 |
| `docs/contract.md` | §5.2 补两档画什么；§5.3 注明六色两处共用；新 **§30**；待定清单打勾 |
| `docs/features.md` | P6、U6 补一句；新增 U21 |

## 5. 验证

1. `pnpm build`
2. `pnpm test:unit`（含新的 15 条）
3. `pnpm -r --no-sort run typecheck`
4. `node scripts/assemble-package.mjs`（e2e 用的是组装产物）
5. `pnpm --filter diorama-web exec playwright test`（含新的 3 条）

## 6. 坑

1. **直接按 `\n` 切 highlight.js 的输出会坏**。块注释、多行字符串是**一个** span：切完第一行
   留着没闭合的 `<span class="hljs-comment">`，第二行没有开标签——每行独立用
   `dangerouslySetInnerHTML` 画时，后者整行没有颜色、前者把闭合标签丢进下一行。
   规则：**断行处闭合，下一行重开**（`splitHighlightedHtml` 的开标签栈）。
2. **双栏里"删除格"和"新增格"不是一回事**。删除的格子不在当前文件里（只有 diff 的副本），新增的
   格子**在**。第一版把配对行（`-` 与 `+` 同行）整个当成"删除行"处理，新增格就拿不到片段——
   单测 `colorSplitRows: a deletion is on the left only, an insertion on the right only` 抓到的就是这个。
   规则：左侧取成段的删除文本，右侧**各自**按自己的行号从文件里取。
3. **快照必须是数字**。页面全局里的引擎是个对象；把它当 `useSyncExternalStore` 的快照，每次渲染
   都是新引用，React 会一直重渲染（AGENTS §5「界面永远正在读取…」）。版本号才是快照。
4. **半边不能 import 另一个半边**。`git-changes` 想直接用 `code` 的语言表是最省事的写法，但每个
   半边是自足的闭包：那样做会把 highlight.js 整个打进第二个 bundle（`code` 的 `client.cjs` 已经
   ~110 KB），并且两份语言表迟早漂。发布到页面全局是唯一既共享又不复制的地方。
5. **`diorama-ui` 的声明是构建产物**。加了 `publishHighlighter` 之后只跑 `typecheck` 会报
   「has no exported member」——先 `pnpm --filter diorama-ui run build`（AGENTS §3）。
6. **行内那档不要顺手也上色**。unified diff 的每行都带 `+` / `-` / 空格前缀，它**不是**合法源码：
   交给引擎会得到"关键字后面跟着一行乱码"的效果。这一档保持 git 的文本与色调。
