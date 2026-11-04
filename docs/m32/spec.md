# 实施说明：diff 双栏里的缩进

> 记录于 2026-11-04。用户反馈：「git diff 双栏模式的缩进没了」。这是**缺陷**，不是新能力：契约不升号
> （§6），没有新增服务、没有改 `ctx.*` 的签名、没有加座位。契约正文只在 **§5.2 的 diff 读法**里补一句
> 「双栏的每一格也是一行」，变更清单是新写的 **§44**（标注「未发版，下一个 `0.0.x`」）。
>
> 同一个问题里还有第二问——「文件高亮 / diff 要不要改用 Monaco」。结论是**不换**，实测数字与理由见 §7。

## 1. 出发点

双栏（「新旧对照」）把一行画成两个格子，每格是「行号 + 代码」。整文件那一档的行是
`.diorama-diff__line`（`display: flex` 之外还带着 **`white-space: pre`**），双栏的格子却另写了一套：

```css
.diorama-diff__split-cell { display: flex; align-items: baseline; min-width: 0; padding-right: 12px }
```

没有 `white-space`，于是浏览器按默认的 `normal` **折叠空白**：行首缩进被吃掉，行内连续的空格并成一个。
读者看到的是一份「被重新排版过」的文件——位置对、颜色对，只有空格不对，而这恰恰是读代码时最要紧的那部分。

这个缺陷一直没被测试抓到，是因为它**不影响任何文本断言**：`textContent` 里空格还在（折叠发生在排版，
不在 DOM），`hasText` / `toContainText` 照样命中。m19 的双栏用例断的是 token 与文本，全绿。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 空白怎么保住 | 双栏的格**就是**行模型 `.diorama-diff__line`，与整文件共用一套规则 | 同一个读者、两种排版，规则只能有一份。再补一条 `white-space: pre` 也能修，但下一次改行模型（比如行高、tab-size）又会漏掉这一处 |
| 长行怎么办 | 每格自己的代码列横向滚（`overflow-x: auto`），**不换行** | 换行会让同一行的两栏高度对不上，左右就再也对不齐了；整文件那一档本来就是横向滚（§5.2「列表窗格必须横向可滚」的同一条取向） |
| 格内对齐 | **不覆盖**，沿用行模型的 `align-items: baseline` | 量过：给代码列加 `padding-top` 之后，`baseline` 让行号跟着代码的**第一行文字**走（两者 `top` 相同）；换成 `stretch` 反而让行号停在格子顶端、与文字错开 30px。第一版写的 `stretch` 是照着「滚动容器的基线是下边缘」的传闻改的，实测在 Chromium 上不成立 |
| 格子的右内边距 | 去掉（`padding: 0`） | 行模型的 `0 12px 0 0` 是给整行的；格子只有半行宽，中缝已经由相邻格的左边框画出来了 |
| 行高 | 不设，沿用 `line-height: 1.55` | 与整文件那一档必须一致：读者在两档之间切换时，同一个文件的同一行应当还是那么高 |

## 3. 实现

### 3.1 组件（`packages/plugins/git-changes/src/index.tsx`）

`SplitFile` 的每个格子多一个 `diorama-diff__line`（tone 类照旧）：

```tsx
className={`diorama-diff__split-cell diorama-diff__line${…}`}
```

### 3.2 样式（`packages/ui/src/styles.css`）

```css
.diorama-diff__split-cell {
  min-width: 0;           /* grid 轨道里可以收缩，长行不撑破整行 */
  padding: 0;             /* 行模型的右内边距不属于半行宽的格子 */
}

.diorama-diff__split-cell .diorama-diff__code {
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}
```

`display: flex`、`align-items: baseline` 与 `white-space: pre` 都由 `.diorama-diff__line` 提供，
这里不再重复——**这正是本档的要点**：格子不再自带一套排版规则。

## 4. 测试

`apps/web/tests/m19-diff-highlight.spec.ts` 的双栏那条多一段：取含两层缩进的格子，断言

- 计算样式 `white-space` 是 `pre`（不是 `normal`）；
- 行首两个空格的**实测宽度**大于 8px（一个等宽字符约 7.2px，两个空格约 14px）。

用 `Range` 量前导空白，而不是截图或「看起来对齐了」：折叠掉的空格是白底白字，肉眼与断言都容易放过它。

## 5. 验证

```bash
pnpm build
pnpm test:unit                                   # 454 条
pnpm -r --no-sort run typecheck
node scripts/assemble-package.mjs                # 改了 styles.css，e2e 的壳要重装
pnpm --filter diorama-web exec playwright test   # 183 条
```

## 6. 坑

1. **折叠空白不影响 `textContent`**。e2e 之前全绿正是因为这个：`hasText` / `toContainText` 读的是 DOM
   文本，而 `white-space: normal` 只在排版阶段合并空格。要测排版就得测**几何**（计算样式或 `Range` 宽度）。
2. **别照着「滚动容器的基线是下边缘」的传闻改对齐**。第一版把格子改成 `align-items: stretch`，理由正是
   这一条；实测（Chromium 148）：给代码列加 `padding-top: 30px`，`baseline` 让行号与代码的第一行文字
   对齐（两者 `top` 都是 178），`stretch` 却让行号停在 148、与文字错开 30px。**行模型给什么就用什么**，
   覆盖它得有量出来的证据。
3. **改 `styles.css` 要重装壳**（m26/spec §6.5.1、m31/spec §6 坑 5）：e2e 的 CSS 来自 `packages/cli/web/`，
   `pnpm build` 只刷 `apps/web/dist`。不跑 `assemble-package.mjs`，新选择器在测试里完全没有样式，
   `white-space` 会读回 `normal`。

## 7. 顺带的评估：文件高亮 / diff 要不要换成 Monaco（或 CodeMirror）

同一个问题里还问了「文件高亮、diff 这些要不要改用 Monaco」。**结论：这一档不换**，理由是量出来的，
不是口味。以下是 2026-11-04 在本机实测的数字（`monaco-editor@0.57.0`、`codemirror@6` +
`@codemirror/merge`，esbuild `--bundle --minify --format=esm`）：

| 方案 | 原始体积 | gzip | 备注 |
|---|---|---|---|
| **现状**：`code` 半边（highlight.js + 22 种语言） | 117 KB | 40 KB | 一个 `client.cjs`，随页面壳按需加载 |
| **现状**：`git-changes` 半边（三种读法 + 上色） | 45 KB | 13 KB | 同上 |
| **现状**：页面壳（React + 内核 + 全部内置 piece 的入口） | 428 KB | 130 KB | |
| Monaco 核心 editor chunk | 2.47 MB | 620 KB | 另需 `editor.worker`；`ts.worker` 7.0 MB（gzip 1.5 MB）、`css.worker` 1.05 MB、`html.worker` 717 KB |
| Monaco 整包（`min/`） | 25 MB | — | `esm/` 32 MB；语言与 worker 是**按需 chunk**，但核心那几个躲不掉 |
| CodeMirror 6 核心 + `@codemirror/merge` | 410 KB | 133 KB | 无 worker，纯 ESM |
| CodeMirror 6 再加 10 种语言 | 692 KB | 248 KB | 语言包本身不小（Lezer 语法） |

三条更根本的理由：

1. **它是编辑器，diorama 是只读查看器**（architecture §13）。Monaco 的价值大头在编辑体验——补全、
   诊断、多光标、格式化——这些在只读语境里全是关掉的。留下来的「并排 diff」我们已经在
   `buildSplitRows` / `collapseSplitRows` 里做过一遍（按位置配对、折带、行号各是各的）。
2. **体积与「每个挂载一个端口、插件是自足闭包」的部署方式冲突**（contract §4、§8）。插件半边只有
   `client.cjs` 被服务，Monaco 需要 worker 与一堆 chunk，得整包塞进 `lib/vendor/`，并且 worker 的
   base URL 要跟着 `?h=<hash>` 的缓存键走。CodeMirror 没有 worker 问题，但 133 KB（核心）起步、
   语言另算，仍比现在整页壳的一半还多。
3. **这次的缺陷不是「引擎不够强」，而是「样式没对齐」**。缩进丢的是 `white-space`，换编辑器能修好它，
   但那等于用 25 MB 换一条 CSS。真要说引擎的短板，是**行内 diff**（逐词比较）：现在按位置配对，
   一行里改一个词会把整行标成删除 + 新增。那是一个独立的小能力（m13/spec §3 已把它列在「先不做」），
   不需要换内核。

**什么情况下值得重新评估**：出现「只读」之外的需求（编辑 / 保存，那要先推翻 architecture §13）、
或者需要**逐词 diff / 双向滚动同步 / 大文件虚拟化**（几万行的 diff 现在是一次性 DOM）。真到那一步，
CodeMirror 6 比 Monaco 更贴合本项目的形状（无 worker、可按插件拆分、包体小一个数量级）。
