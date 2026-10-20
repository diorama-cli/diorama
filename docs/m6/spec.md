# 实施说明：文件搜索（v0.8）

> 记录于 2026-10-20。用户要求：**支持文件搜索，包括文件名和文件内容，体验尽量接近 VS Code**。
> 契约变更见 [contract.md §3.9](../contract.md) 与 §18；能力档位见 [features.md](../features.md)。

## 1. 范围

| 做 | 不做 |
|---|---|
| `ctx.search`：`name`（路径子序列）与 `content`（文件内字面量 / 正则）两种查询 | **索引**（不建倒排、不落盘）：每次查询现场走目录 |
| 左栏「搜索」视图：字段、两种模式、大小写 / 全字 / 正则开关、按文件折叠的结果 | 替换（只读工具，没有编辑） |
| `mod+p` 快速打开（`layout.overlay`）：按路径子序列跳文件 | 模糊搜索的「最近打开」排序（需要持久化，`ctx.storage` 仍 🔲） |
| 点结果打开文件并**跳到那一行**（reveal store + 渲染器高亮带） | Markdown / 图片 / PDF 的行跳转（它们的渲染不保行号） |
| `mod+alt+4`（`sidebar.showSearch`）、`mod+shift+f`（`search.open`） | 搜索历史、保存的搜索（同样需要 `ctx.storage`） |

## 2. 为什么是「内核服务 + piece」两层

**服务（`search`）在内核里，piece（`search-view`）在外面。** 三条理由：

1. **读盘必须只走 `ctx.fs`**（contract §3.1）。搜索要遍历目录、读文件，如果放在一个客户端 piece 里，
   它就只能逐文件 RPC——一次搜索是几百次往返。放在服务端，遍历与读取都在同一进程内完成，
   页面只收一份结果。
2. **隐藏规则只有一个强制点**：`fs.list`。搜索走 `list` 就自动继承 `ignore`（`.git` /
   `node_modules` / `diorama.toml` 的 `[ignore]`）。若搜索自己 `readdir`，就出现第二条口径。
3. **可选性反过来**：`--plugins` 选的是客户端图，去掉 `search-view` 只是没有界面，服务仍在
   （和 `fs` / `git` 一样）。要让「没有搜索界面」等于「没有搜索服务」是没必要的耦合。

代价：**两个 id**。服务叫 `search`，piece 叫 `search-view`——同一 id 会让 CLI 的
`halves` 映射表出现同名键（`git` / `git-changes` 当初也是这么分的）。`BUILTIN_PLUGIN_IDS`
里是 `search-view`，`KERNEL_SERVICE_IDS` 里是 `search`。

## 3. 实现形态（契约之外的具体选择）

- **走目录是 BFS、按层读**：`walk()` 用一个队列，每个目录一次 `fs.list`。文件先于子目录访问，
  所以根附近的命中先出现。
- **读取有并发上限**：内容搜索先收集候选（上限 `SEARCH_MAX_SCANNED_FILES` = 20 000），再用
  `mapPool` 以 16 并发读——一个目录几千个文件也不会同时打开几千个描述符。
- **二进制判定**：读到的字节含 NUL 就跳过（与 `fs.readText` 的 `EBINARY` 同一条规则）。
- **同一行的多个命中折成一行**：结果列表按「文件 → 行」两级，`count` 仍是真实命中数。
- **长行截断**：`clipLine` 只保留命中附近的 240 字符，两侧加 `…`。
- **名字打分**：`fuzzyMatch` 给连续段、分隔符后、驼峰边界加分，给跳跃扣分，basename 命中再加分，
  最后减去路径长度的一点点（同分时短路径优先）。快速打开在浏览器里用**同一个函数**重排。
- **快速打开的数据**：不调 `search`（它要求一个查询），而是走 `fs.list` 递归收集一次
  （上限 20 000），**每次打开覆盖层收集一次**，键入时只在内存里过滤。
- **跳行**：tab 只带路径（contract §3.4），所以行号走 `diorama-ui` 的 reveal store
  （页面全局 `__diorama_reveal__`）。渲染器用 `useRevealLine(path, ref)` 得到
  `{ line, top, height }`，滚动父容器并画一条绝对定位的高亮带。它依赖渲染器「一行一行、
  行高固定」的排版（`code` 与 `plaintext` 都是 `white-space: pre` 的 `<pre>`），
  这也是 Markdown 不做跳行的原因。
- **快捷键**：`mod+p`（快速打开）、`mod+shift+f`（搜索视图）、`mod+alt+4`（切换器）。
  与 `help` 的速查表自动同步——它读的是同一个 `ctx.commands`。

## 4. 验收（`apps/web/tests/m6-search.spec.ts`，5 条）

1. 内容搜索列出两个文件的命中，`search-status` 报「2 个文件，2 处匹配」；点 `src/app.ts` 的那条
   打开该文件、渲染器是 `code:renderer`、`code-reveal` 的 `data-line` 是 2。
2. 「文件名」模式只匹配路径（`guide` 在内容里不存在，切到文件名后命中 `docs/guide.md`）。
3. `mod+p` 输入 `appts` 命中 `src/app.ts`（子序列），Enter 打开；Escape 关掉且不打开任何东西。
4. `mod+alt+4` 切到搜索视图；切走再切回，查询与结果都还在（非活动视图不卸载）。
5. 大小写 / 全字开关逐步收窄：3 条 → 2 条 → 1 条（`data-line` = 2）。

单测 7 条（`packages/plugins/search-view/test/search.test.ts`）：名字搜索与隐藏目录、
内容搜索的 line/column/text 与二进制跳过、大小写 / 全字 / 正则、`EINVAL` 与空查询、
scope 与上限截断（真实总数仍准确）、`fuzzyMatch` 的排序与 `isSubsequence`、
`contentMatcher` 的字面量转义与空匹配不死循环、`clipLine`。

## 5. 踩到的坑（按症状查）

1. **`onMount` 里拿不到 `fs`**。`onMount` 回调跑在 mount fiber 还在 `apply` 的时候，
   而 `fs` 的 `provide` 是个 effect——要等 fiber 激活才可见。症状：日志
   `[mount:…] search: no "fs" on this mount`，RPC 回 `ESERVICE`。
   修法：`SearchService` 构造时只收一个 **`() => FsService`**，第一次搜索时才解析。
   （`gitHalf` 用子 fiber 绕开过同一个问题；这里连子 fiber 都不需要。）
2. **piece 的 `name` 必须等于 manifest 的 `id`**。改名时只改了 `package.json`，浏览器报
   `does not declare the expected name "search-view" (got search)` 并跳过整个插件。
3. **服务 id 与 piece id 不能同名**。同名的直接后果是 `plugins-server.ts` 的映射表里两个
   `'search'` 键（TS1117），随后 kernel 的 server 半边被覆盖掉，RPC 一直是 `ESERVICE`。
4. **改完 CLI 的 server 半边要重建 CLI**。e2e 跑的是构建产物；只重建 kernel 不重建 cli，
   测的还是旧表。
5. **`mod+p` 的测试要等焦点**。覆盖层的输入框在 `useEffect` 里 `setTimeout(…, 0)` 拿焦点
   （与 palette 同一条），紧跟着 `press('Escape')` 会在焦点落下之前发出——先断言
   `toBeFocused()` 再按键。
6. **新增侧栏视图会改别人的断言**。`m4-git` 断言「仓库上有 3 个视图」、`m4-history` 断言
   「非仓库只有 1 个视图」，加了 `search` 之后是 4 / 2——这是视图数量的事实变化，改断言，
   不是改产品。

## 6. 与契约的对应

| 契约 | 实现 |
|---|---|
| §3.9 `ctx.search` 的签名与错误码 | `kernel/src/server/search.ts`（`SearchService`）、`kernel/src/shared/search.ts`（纯函数与类型）、`kernel/src/client/search.ts`（RPC 面）|
| §3.9 的三种上限与「截断不失败」 | `SEARCH_MAX_FILES` / `SEARCH_MAX_MATCHES_PER_FILE` / `SEARCH_MAX_SCANNED_FILES`，结果带 `truncated` 与真实总数 |
| §3.1 的隐藏规则一致 | 只走 `fs.list`（单测覆盖：`node_modules` 里的文件搜不到）|
| §5.2 `search` 视图（`order: 40`） | `packages/plugins/search-view/src/index.tsx` |
| §3.7 三条命令 | `search.quickOpen`（`mod+p`）、`search.open`（`mod+shift+f`）、`sidebar.showSearch`（`mod+alt+4`，在 `layout`）|
| §3.9 的 reveal store | `packages/ui/src/reveal.ts`；`code` / `plaintext` 两个渲染器接上 |

## 7. 仍未做

- **索引**：每次查询现场走目录。上万文件的仓库里一次内容搜索是「读一遍树 + 读一遍文本」的量级；
  上限把它挡在 2 万个文件。要做索引就得先有 `ctx.storage`（仍 🔲）。
- **跳行只覆盖 `code` / `plaintext`**：Markdown 渲染成 HTML 后行号不再对应源文件。
- **快速打开没有「最近打开」排序**：同样卡在 `ctx.storage`。
- **`ctx.fs` 没有按偏移读**：搜索在服务端读整个文件（不超 `MAX_TEXT_BYTES` 才有意义），
  将来若要「只在超大文件里搜前 N 行」需要新的 fs 能力。
