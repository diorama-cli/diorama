# 实施说明：搜索的性能

> 记录于 2026-11-06。用户要求：「优化搜索性能，包括文件路径搜索和整个项目的文件内容搜索，调研下是否引入
> 一些优秀的开源库」。这是**实现口径的调整**，不是新能力：没有新服务、没有加座位、没有改 `ctx.*` 的
> 既有签名（只多一个 `paths`）。契约不升号（§6），正文在 §3.9 补四条，变更清单是新写的 **§49**
> （标注「已计入 `0.0.11`」）。能力编号 **v0.26**（`0.0.10` 那一档占用了 v0.24）。

## 1. 出发点：先量，别猜

两类搜索的现状（`kernel/src/server/search.ts`）：

- **按文件名**：广度优先走一遍目录，每个文件跑一次 `fuzzyMatch`（子序列 + 打分）。
- **按内容**：走一遍目录收集候选，再用 16 路池逐个 `readFile` + `TextDecoder` + 逐行正则。

在本仓库（795 个文件 / 28 MiB，含构建产物，macOS APFS）上量出来是这样：

| 场景 | 耗时 |
|---|---|
| 只走目录（`fs.list`） | 15–80 ms |
| 按文件名 | 13–19 ms |
| 按内容，任意查询 | **300–350 ms** |

内容搜索里，**匹配只占 6–10 ms**（同样一批文件跑逐行正则），剩下的全是读文件。
于是第一个问题就是：那 300 ms 到底花在哪？

## 2. 三个假设，逐一否掉

### 2.1 「并发不够」——否

`UV_THREADPOOL_SIZE` 从 4 调到 64，同一次搜索的耗时**完全不动**（293 / 296 / 293 ms）。池子大小
不是瓶颈。

### 2.2 「读得太慢」——一半对

同一棵树上拆开量：

| 操作 | 耗时 |
|---|---|
| `readdir` 递归（不 stat） | 7 ms |
| `stat` 1 375 个文件 | 6 ms |
| `readFile` 1 375 个文件（池 16） | **276–380 ms** |
| 解码 7.6 MB | 38 ms |
| 逐行正则 | 6–10 ms |

所以代价是**每个文件一次 `open`**：在 macOS 上约 0.3 ms/次（`open`+`close` 单次约 1.3–1.8 ms，
分摊到 1 375 个文件是 280 ms 量级），而且**与线程数无关**——它就是 syscall 本身的价格。

### 2.3 「换库能解决」——否

- `@vscode/ripgrep` 一类：随包分发平台二进制（约 4 MB × 平台），并且要求把**目录**交给子进程。
  那会绕过 `ctx.fs`，而 `ignore` 是 `list` 的**唯一**强制点（契约 §3.1）——搜索会变成第二套口径。
  且同一棵树上的地板（`open`+`read` 1 373 个文件）是 340 ms，ripgrep 省下的主要是匹配，
  而匹配在 JS 里已经是 6–10 ms。
- `fdir` / `fast-glob`：解决的是**遍历**，而遍历只占 7–15 ms。
- 全文索引（lunr / flexsearch / tantivy）：要维护一致性（watch、断线、外部改动），
  而 `features.md` 的取向是「每次查询现场走目录」。

**结论：不引入任何库。** 瓶颈不在库，与 m32 §7「不换 Monaco」同型。

## 3. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 重复查询怎么变快 | 每个 mount 一份**已解码文本缓存**（32 MiB / 20 000 文件，LRU） | 「读整棵树」换成「stat 整棵树」：同一棵树上 6 ms vs 280 ms |
| 缓存怎么校验 | 每次使用前 `stat`，比对 **mtime + ctime + size** | `mtime` 在部分文件系统上只有秒级粒度，同一秒内的等长重写会漏；`ctime` 会被这次写入刷新。三项来自同一次 `stat`，校验不增加系统调用 |
| 冷启动怎么办 | 先 `readFile` 再 `stat`（不是先 stat 再读） | 每文件两个系统调用，与旧实现（`fs.list` 里的 stat + `readFile`）一样多；缓存只在重复查询上兑现 |
| 匹配怎么做 | 字面量走 `indexOf`（大小写不敏感时在已折叠的文本上）；**只有命中该针的文件**才切行 | 逐行正则 6–10 ms 不算贵，但「先 split 再逐行 test」在无命中的查询上全是白工 |
| 二进制怎么判 | 扩展名在表里的**不打开** | 读文件是唯一的贵操作，NUL 判定放在读之后等于白读 |
| 快速打开的路径列表 | 新增 `search.paths(scope?)`，一次返回全部路径 | 原来是「每个目录一次 `fs.list`」的 N 次往返 |

## 4. 实现

### 4.1 `TextCache`（`kernel/src/server/search.ts`）

`Map` 的插入顺序就是 LRU 顺序：`get` 命中后删掉再插回，淘汰时取第一个键。上限是
`SEARCH_CACHE_MAX_BYTES`（32 MiB）与 `SEARCH_CACHE_MAX_FILES`（20 000）。缓存随 mount 一起消失——
`searchHalf` 的 `onMount` 返回的 disposer 调 `service.close()`。

### 4.2 `scanFile` 的两条路径

```
cached = cache.get(path)
if (cached) {                       // 热路径：一次 stat 校验
  info = stat(abs)
  if (!info.isFile() || size > MAX_TEXT_BYTES) return undefined
  if (三项都对上) text = cached.text
}
if (!text) {                        // 冷路径：一次 readFile + 一次 stat（记录校验值）
  bytes = readFile(abs)
  if (bytes.length > MAX_TEXT_BYTES) return undefined
  if (bytes.includes(0)) return undefined
  text = decode(bytes)
  cache.set(path, { mtimeMs, ctimeMs, size, text })
}
```

### 4.3 字面量快路径

`scanLiteral` 在**已折叠**的文本上 `indexOf`；只有包含该针的文件才 `split('\n')`，
逐行 `indexOf` + `literalCount`（非重叠计数，与正则的 `g` 口径一致）。大小写折叠改变长度时
（`İ` → 两个码点）返回 `undefined`，调用方退回引擎——那里报的列号才对应原行。

### 4.4 `paths`

```ts
async paths(scope = ''): Promise<RelPath[]>   // 上限 SEARCH_MAX_PATHS = 20 000
```

走的是同一个 `walk`（因此 `ignore` 口径与搜索、与树一致），一次 RPC 往返。`search-view` 的
快速打开从「自己用 `fs.list` 逐目录走」改成 `mount.search.paths('')`，排序仍在页面里做。

## 5. 实测

同一进程、同一棵树、交替跑新旧两份实现（旧实现从 `git show HEAD:` 取出来做对照）：

| 场景 | 旧实现 | 本档 |
|---|---|---|
| 内容搜索，首次（冷） | 290–330 ms | 300–330 ms（同价） |
| 内容搜索，第二次（暖） | 200–400 ms | **140–156 ms** |
| 内容搜索，无命中 | 201 ms | **61 ms** |
| 正则搜索 | 208 ms | **105 ms** |
| 全字搜索 | 207 ms | **99 ms** |
| 按文件名搜索 | 21 ms | 16 ms |
| 快速打开的路径列表 | 每个目录一次 `fs.list` | 一次调用，22 ms |

结果**逐字段相同**：同一批查询在新旧实现下 `totalFiles` / `totalMatches` / 每条命中的
`line` / `column` 全部一致。

## 6. 坑

1. **「第二次查询还是 300 ms」不等于「实现慢」**：先量三个假设（线程池 / 遍历 / 匹配），
   再决定改什么。这一档的三次否证各花了几分钟，省下的是一次错误的「换库 + 重写」。
2. **不要为了并发调 `UV_THREADPOOL_SIZE`**：本机上 4 / 16 / 64 三档耗时相同（293–320 ms）。
   把它写进代码只会让别处的 I/O 更难预测。
3. **校验要三项**：只比 `mtime` 会漏掉「同一秒内的等长重写」；只比 `mtime + size` 同样会漏
   （编辑器原地保存、长度不变）。`ctime` 是那次写入必然刷新的字段。
4. **冷路径别先 stat**：第一版是「先 stat 再 readFile」，冷启动从 313 ms 变成 508 ms——
   缓存未命中时那次 stat 完全是白付的。先读、再 stat 记录校验值，冷路径才与旧实现同价。
5. **字面量快路径必须是等价实现，不是近似**：列号用折叠后文本的 `indexOf` 结果直接当原行下标，
   前提是折叠不改变长度；长度变了就退回引擎（`İ` 这种极端输入）。
6. **`search-view` 的 `FileInfo` 导入**：`listFiles` 删掉后 `FileInfo` 与 `MountHandle` 里有一个
   不再被使用，typecheck 会报 `TS6133`（`noUnusedLocals`）；两处一起收拾。

## 7. 验证

```bash
pnpm build
pnpm test:unit                                   # 含 4 条新的搜索单测
pnpm -r --no-sort run typecheck
pnpm --filter diorama-web exec playwright test   # m6-search 等
```

新增的单测（`packages/plugins/search-view/test/search.test.ts`）：

- 二进制扩展名不打开（一个叫 `notes.png` 的**文本**文件搜不到内容）；
- 缓存命中的第二次查询结果不变、文件改写后重读、文件消失后不再出现；
- 字面量快路径与正则引擎给出同样的行与列（`aa` 在 `aaaa` 里计 2 次）；
- `paths()` 列出全部文件、尊重 `ignore`、scope 不存在时 `ENOENT`。

## 8. 没做的事

- **索引**：仍是「每次查询现场走目录」。缓存已经把重复查询压到 140 ms 上下；索引要维护一致性，
  是下一档的事（已记在契约的待定清单）。
- **冷启动**：300 ms 是 `open` 的地板。下一步可以复用句柄或把每文件的 `readFile` 换成带缓冲的
  `read`，但收益要先量（已记在待定清单）。
- **`fs.list` 的 stat**：遍历只占 7–15 ms，改成 `readdir(withFileTypes)` 会绕开 `ignore` 的
  唯一强制点，不值。

## 9. 补充：可选的 ripgrep 引擎（v0.27，契约 §50）

> 承接用户追问「由 `ctx.fs` 里的方法代理 `@vscode/ripgrep` 呢」。这个提法比「搜索自己起子进程」
> 高明：把引擎收进 `ctx.fs` 的口径里，`ignore` 的唯一强制点就保住了。照这个思路做了实现。

### 9.1 三个形态，测出来才定

| 形态 | 罕见词 | 中等词（131 文件） | 宽命中（442 文件） |
|---|---|---|---|
| 只有 JavaScript（暖缓存） | 66 ms | 112 ms | 143 ms |
| `rg --json` 全解析 | 26 ms | 80 ms | **231 ms** |
| `rg -l` 窄化 + JS 出细节 | 26–33 ms | 84 ms | 142 ms（退回后） |

`rg --json` 的帧**随命中数**膨胀（`contract` 一次 12 MB、25 ms 纯解析），宽命中时反而更慢；
`--files-with-matches` 的输出**随命中文件数**增长，稳定在 25 ms 上下。所以最终形态是后者。

### 9.2 关键决定

- **它不拿目录**：候选仍由 `fs.list` 列出，引擎收到**显式文件清单** + `--no-ignore`。
  `ignore` 因此仍是唯一强制点（契约 §3.1），也不会被 `.gitignore` 干扰。
- **`ignore` 不需要翻译层**：实测内核的 `ignore` 语法与 ripgrep 的 `--glob` 语义**逐条等价**——
  `.git` / `dist/` / `a/b` / `*.log` / `**/gen` / `docs/**/tmp` 六组与 `fs.list` 的输出完全一致。
  （第一版多加了 `!**/x`，把「带 `/` 即锚定根」的规则搞坏，`src/a/b/z.ts` 被误排除——恒等映射才对。）
- **它不改「什么算命中」**：行、列、预览都由 JavaScript 一侧产出，所以**两条路径结果逐字段相同**。
  引擎的**字节偏移**因此完全不参与列号（VS Code 要切字节再解码，我们不需要）。
- **正则不交给它**：`rg` 默认引擎不支持 look-around / 反向引用（直接报错退出），PCRE2 与 JavaScript
  仍有差异。契约以 JavaScript 为准，所以正则一律走 JavaScript。
- **两条退回条件**：命中面超过一半文件、或文本缓存已覆盖整棵树——这两种情况下 spawn 是纯开销。
- **顺序要还原**：引擎按自己的顺序返回，而 `maxFiles` 截断取谁不能取决于跑了哪个引擎，
  所以窄化之后按**遍历顺序**重排。

### 9.3 坑

1. **同一行多个命中要折成一条**：契约 §3.9 规定一行一条（`count` 记真实次数）。第一版每个 submatch
   都 push，测试立刻抓到（`matches.map(line)` 出现重复行）。
2. **别拿目录**：会绕过 `fs.list`。
3. **别解析逐命中帧**：随命中数膨胀。
4. **分发**：`@vscode/ripgrep` 按平台取二进制（darwin-arm64 为 4.3 MB），声明为
   `optionalDependencies`——装不上就没有引擎，功能不受影响。


### 9.4 正则也交给它窄化（v0.27 补，照 VS Code 的 `--engine auto`）

第一版只让引擎处理字面量，理由是「方言不同」。查了 VS Code 的实现后改成和它一样：

```js
// vscode ripgrepTextSearchEngine.ts
if (query.isRegExp) {
  query.pattern = unicodeEscapesToPCRE2(query.pattern);
  args.push('--engine', 'auto');
}
```

它**没有 JS 回退**——正则编译失败就报 `regexParseError` 给用户。我们这边可以更稳：因为引擎只做窄化，
方言差异**只会多给文件、不会少给**，细节仍由 JavaScript 判定。实测：

| 查询 | JS 命中文件 | rg 窄化文件 | 最终结果 |
|---|---|---|---|
| `export (const\|function)` | 182 | 182 | 一致 |
| `function \w+\(` | 402 | 402 | 一致（窄化曾多给 202，被 JS 过滤掉） |
| `\bconst\b` | 382 | 382 | 一致 |
| `(?<=a)b` | 492 | 492 | 一致（PCRE2 接住了 lookbehind） |

性能：`export (const|function)` 176 → 76 ms，`TODO|FIXME` 184 → 73 ms。

**两个必须记住的点**：

1. **非法正则仍由 JavaScript 判定**。引擎对编译不了的模式回答「没有命中」（退出码 1），而契约要
   `EINVAL`。所以先 `contentMatcher({ query, regex: true })` 验一次再交出去——这个 bug 是单测抓到的。
2. **`regex` 标志要传对**。窄化调用最初写的是 `regex: wholeWord`（只支持字面量时的遗留），
   于是正则被当成 `--fixed-strings` 字面量，`\bconst\b` 窄化到 **0 个文件**。
   等价性扫描立刻报 16 处不一致——**这正是那个扫描存在的理由**。
