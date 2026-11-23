# 实施说明：快速打开先排完全匹配，高亮覆盖整条查询

> 记录于 2026-11-18。用户反馈：「完全匹配的项不是最高优先级，而且 `_` 前的部分没高亮」。这是**缺陷**，
> 不是新能力：契约不升号（§6），没有新增服务、没有改 `ctx.*` 的签名、没有加座位。契约正文在
> **§3.9 的 name 匹配**里补了「最优对齐 + 整段加分」两句，变更清单是新写的 **§52**。

## 1. 出发点

截图里快速打开（`mod+p`）打了 `tripo_texture.go`，四行结果是这样的：

```text
59.45  dto[_][t][e][x][t][u][r][e][.][g][o]        code/AI3DJobConsumeAgent/task/impl/tripo/dto_texture.go
58.43  tripo[_][t][e][x][t][u][r][e][.][g][o]      code/AI3DJobConsumeAgent/task/impl/tripo/tripo_texture.go
52.90  dto[_][t][e][x][t][u][r][e]_test[.][g][o]   …/dto_texture_test.go
51.88  tripo[_][t][e][x][t][u][r][e]_test[.][g][o] …/tripo_texture_test.go
```

（`[]` 是高亮的字符，分数来自当时的 `fuzzyMatch`，可直接复现。）

两个现象，同一个根因：

1. **完全匹配的文件排第二**。`tripo_texture.go` 是查询的逐字符同名，却比 `dto_texture.go` 低 1.02 分。
2. **`_` 之前的部分没高亮**。`tripo` 四个字母是灰的，黄色带只盖住 `_texture.go`。

修完这两条之后，用户又报了第三个（同一天，同一处代码）：**打 `tripo` 时完全没有高亮**。这是同一个
「对齐选错了」的另一半，见下面 §2 的最后一行与 §6 坑 6。

根因在 `fuzzyMatch` 的**贪心对齐**：它把指针从头往后走，查询的第一个 `t` 落在路径里第一个 `t` 上
——那是**目录** `tripo/` 里的 `t`。于是 `t``r``i``p``o` 四个字符被消耗在目录上（中间隔着
`code/AI3DJobConsumeAgent/task/impl/` 一大段），只有 `_texture.go` 落在 basename 里。

这同时解释了分数：每个字符的加分与字符数成正比，而「全名命中」这件事**没有任何加分项**。短路径
`dto_texture.go`（23 个字符）比 `tripo_texture.go`（29 个字符）短，逐字符加分却一样，末尾还有
`- length * 0.01` 的短路径奖励——于是它赢了。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 取哪一次对齐 | **最优**：首字符的每个出现都是一次候选起点，各算一遍取分最高 | 贪心扫的是「第一次能扫通」的对齐，不是「最好」的对齐；子序列的口径没变，变的只是选哪一次 |
| 打分粒度 | 保留逐字符加分，另加两条**整段**规则 | 逐字符规则天生偏爱短路径；「命中整个文件名」与「从词首开始」是读者真正在说的事 |
| 词段起点 | 命中字符里起始一个词段的（basename 本身、名内 `_` / `-` / `.` / 空格之后、或一段连续命中的第一个）每个 `+2` | `tripo` 与 `texture` 都是词段起点，两者都命中才配叫「就是这个文件」 |
| 全名命中 | 命中字符恰好覆盖整个文件名（逐字符相同）`+20` | 这是排序问题，不是风格问题：它必须排在所有子序列命中之上 |
| 分数放在哪 | 仍在 `fuzzyMatch` 里，服务端 `searchNames` 与页面快速打开共用 | 两处各写一套排序必然漂；一个函数、一个比较器（`compareNameMatches`） |
| 同分时选哪一次对齐 | **basename 里的那次**（比较用的 `rank` = 逐字符分 + basename 命中的 `SCORE_SEPARATOR`） | 高亮只画 basename：落在目录里的对齐**画不出任何东西**，而它的分数与文件名里的同质量对齐相同，还会因路径更短排前面 |

## 3. 实现

### 3.1 `packages/kernel/src/shared/search.ts`

`fuzzyMatch` 拆成「枚举候选起点」+ `align()`（算一次对齐的逐字符分）+ `segmentStarts()`（数词段起点）：

```ts
const first = needle[0] ?? ''
let best: FuzzyMatch | undefined
let bestRank = -Infinity
for (let start = haystack.indexOf(first); start !== -1; start = haystack.indexOf(first, start + 1)) {
  const match = align(text, haystack, needle, start)
  if (match === undefined) continue
  // basename 里的对齐压过目录里的同质量对齐（这一项最后也会加进分数）
  const rank = match.score + ((match.positions[0] ?? 0) > slash ? SCORE_SEPARATOR : 0)
  if (rank > bestRank) { best = match; bestRank = rank }
}
if (best === undefined) return undefined
if ((best.positions[0] ?? 0) > slash) best.score += SCORE_SEPARATOR      // basename 命中
best.score += SCORE_SEGMENT * segmentStarts(text, best.positions)        // 词段起点
if (best.positions.length === name.length && name.toLowerCase() === needle) best.score += SCORE_EXACT_NAME
best.score -= text.length * 0.01
```

`align()` 就是原来的循环体，只是起点由调用方给。`segmentStarts()` 数的是「命中字符里，前面是分隔符
或与前一个命中不连续」的那些。

### 3.2 高亮（`packages/plugins/search-view/src/index.tsx`）

**没有改**。高亮一直画的是 `match.positions`，而 `positions` 现在来自最优对齐——这正是缺陷的一半：
错的是位置，不是画法。

## 4. 测试

1. 单测 `packages/plugins/search-view/test/search.test.ts`（`search: fuzzyMatch takes the best alignment…`）：
   - 截图里的那条路径，`positions` 在 basename 里**逐字符全覆盖**（`[...name].map((_, i) => i)`）；
   - 它**排在** `dto_texture.go` 之前；
   - `src/dto_texture_test.go` 对 `texture_test` 取的是后面那个 `texture`（`[8..19]`），不是前面那段；
   - `a/b/app.ts` 对 `app.ts` 的分高于 `apps.ts` 对 `app.ts`（全名命中 > 子序列）。
2. 单测（`search: a match in the basename wins a tie against one in a directory`，第三个反馈的回归）：
   `tripo` 这条查询下 `tripo_texture.go` 的分数**高于** `dto_texture.go`，且 `positions` 落在文件名里
   （`[0,1,2,3,4]`）——不是目录 `tripo/` 的那一段。
3. e2e `apps/web/tests/m6-search.spec.ts`（`quick open ranks the exact name first…`）：真实浏览器里
   `mod+p` 打 `tripo_texture.go`，第一行是 `…/tripo/tripo_texture.go`，它那一行的 `<mark>` 恰好是
   `tripo_texture.go` 一整段；被它压下去的第二行 `<mark>` 是 `_texture.go`；接着改打 `tripo`，第一行
   仍是它，`<mark>` 是 `tripo`。

三条都在旧实现上跑过对照：第一行的 `data-path` 是 `dto_texture.go`、`<mark>` 是 `_texture.go`；打
`tripo` 时两行的 `<mark>` 都是**空**。

## 5. 验证

```bash
pnpm build
pnpm test:unit                                   # 526 条
pnpm -r --no-sort run typecheck
node scripts/assemble-package.mjs                # e2e 跑的是组装产物
pnpm --filter diorama-web exec playwright test
```

代价（本仓库 399 个文件，复制成 20 000 条路径模拟上限，同进程）：

| 查询 | 命中 | 耗时 |
|---|---|---|
| `search` | 300 | 6.7 ms |
| `src/search.ts` | 80 | 3.4 ms |
| `a`（首字符几乎每行都有，候选起点最多） | 7 080 | 2.6 ms |

最坏情况是**短查询**（首字符到处都是 → 候选起点多），而不是长查询；即便如此仍是毫秒级。快速打开
每次打开只排一次（`search.paths` 一次取全部路径），不在按键路径上。

## 6. 坑

1. **贪心对齐的错位同时是「分数错」和「高亮错」**。看到「高亮只盖住一半」时很容易去改画法
   （`highlightPositions`）；真正的错在 `positions` 是贪心扫出来的。先打印 `positions` 再动手。
2. **「更短路径优先」的奖励会反噬**。`- length * 0.01` 是为了同分时短路径在前，但它与逐字符加分
   叠加后，会让一个**只是收尾相同**的短文件压过同名文件。整段加分要大到能盖过这一项（20 分
   远大于 `0.01 × 路径长度`）。
3. **不要只对 basename 匹配**。那会丢掉 `docs/app` 找 `docs/app.ts`（子序列的口径是整条路径）。
   最优对齐保留口径，只换对齐。
4. **`positions` 是**整条路径**的下标，不是文件名里的**。快速打开画之前要减掉 basename 的偏移
   （`index.tsx` 里那行 `position - (item.path.length - name.length)`）；单测断言也用同一种换算。
5. **worktree 里 `pnpm test:unit` 会先报三条 `ERR_MODULE_NOT_FOUND`**（`diorama-kernel/lib/server.js`）：
   新 worktree 没有构建产物。先 `pnpm build`，那三条与改动无关。
6. **「打 `tripo` 没高亮」不是画法的问题，是「对齐落在了目录上」**。只加「最优对齐」还不够：目录里
   那一次对齐与文件名里的同质量对齐**分数相同**，而 `- length * 0.01` 让路径更短的无关文件赢了；
   高亮只画 basename，于是那一行一个高亮字符都没有。修法是把 basename 的加分算进**选择对齐**的比较
   （`rank`），不只是算进最终分数——否则分数对了、位置还是错的。
7. **验证实例要走 worktree 的构建**。直接 `node packages/cli/bin/diorama-beta` 会连上已经在跑的
   gateway（那是**源仓库**构建，插件从源仓库加载），看到的是旧行为。用独立的 `DIORAMA_HOME`
   （`DIORAMA_HOME=/tmp/... diorama-beta <dir> --port <n>`）才是这一份代码；`/plugin.json` 的
   `clientEntry` 能直接看出插件是从哪个 checkout 加载的。
