# 实施说明：页面底部的状态栏

> 记录于 2026-11-02。用户要求：「界面底部增加状态栏，显示实例信息、当前文件信息等」。
>
> 契约不升号（§6）：没有新增内核服务、没有改 `ctx.*` 签名。契约正文新增 **§5.4**，变更清单是新写的
> **§42**（标注「未发版，下一个 `0.0.x`」）；`features.md` 的 U9 从「v1 不做」改成 ✅ 并新增 P21。

## 1. 出发点

页面底部什么都没有。要读「我在看哪个目录、哪个文件、它多大、多少行」时，读者得自己去找：目录名在
浏览器标签条上（`<title>`，§34），文件路径在 tab 的 tooltip 与渲染器头部，大小与行数**哪儿都没有**。

`docs/features.md` 里 U9「状态栏」一直写着「**v1 不做**：已从契约 slot 表移除」，`contract.md`
§5 的正文还留着一句「`statusbar`：v1 不做，从 slot 表移除（需要时再议）」。这一档就是那个「再议」。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 栏是座位还是画进 `layout` | **座位**（`layout.status`，单） | `layout` 一直只做「框架的几何」；栏里写什么属于 piece，和 palette / help 同一类 |
| 座位类型 | **单** | 一条状态线只有一处能放；两条栏谁上谁下没有正确答案。要加一格的人改拥有这条栏的 piece |
| 空座位 | **连 `<footer>` 都不画** | M0 验收点 3：去掉一个 piece 剩下的东西必须仍然成立。一条空白栏不是「没有栏」，是一行背景色 |
| 谁填它 | 内置 piece `status-bar`（`order: 100`） | 与 `help` / `palette` 同样的形态：一个只注册条目的客户端 piece |
| 栏里写什么 | 实例（**完整根目录路径** / `mountId` / 地址）· 当前文件（路径 / 大小 / 行数 / 修改时间 / diff 标记）· 标签页数 | 这三组回答「这是哪儿 / 我在读什么 / 开了几个」。根路径写**全路径**：三个 checkout 都叫 `diorama` 时，光秃秃的名字回答不了「这是哪个」 |
| 数据从哪来 | `mountCtx`（`root` / `mountId` / `baseUrl` / `fs` / `rpc`）+ `ctx.tabs` | 全都在页面上；再加一个 `ctx.status` 只会多一份要同步的状态 |
| 行数上限 | 2 MiB（`MAX_LINES_BYTES`） | 数行要读全文。再大的文件只报大小与时间（一次 `stat`） |
| 读不到文件 | 省掉那几格，**不报错** | 原因由 tab 自己说（渲染器的错误面）；栏再喊一遍是噪音 |

## 3. 实现

### 3.1 座位（`packages/plugins/slots`）

- `src/types.ts` 的 `SlotMap` 加 `'layout.status': Record<string, never>`（条目没有 props：它自己读
  `mountCtx` 与 `ctx.tabs`，与 `layout.main` / `layout.overlay` 同形）。

### 3.2 框架（`packages/plugins/layout`）

- `DECLARE` 多一条 `'layout.status': { kind: 'single' }`。
- 新组件 `StatusLine`：`useSeat('layout.status')` 是空的就 `return null`，否则画 `<footer
  data-slot="layout.status">` 并在里面渲染单座位。**hook 在任何提前 return 之前**（m15/spec §6 坑 1）。
- `LayoutRoot` 变成：

  ```tsx
  <div className="diorama-shell">
    <SplitFrame />
    <StatusLine />
  </div>
  <Overlay />
  ```

  `.diorama-shell` 是纵向 flex（`height: 100%; min-height: 0`），框架 `flex: 1 1 auto; min-height: 0`，
  栏 `flex: none`。**`min-height: 0` 是关键**：没有它，框架里的长文件会把整列撑开、把栏顶出窗口。

### 3.3 piece（`packages/plugins/status-bar`，新包）

- `src/info.ts`：纯函数，`node --test` 直接跑——`formatBytes`（与渲染器同一套 KiB / MiB）、
  `formatWhen`（读者 locale、分钟精度，坏数字返回 `undefined`）、`countLines`（末尾换行不算多一行，
  与阅读器同口径）、`displayPath`（挂载根写 `.`）、`MAX_LINES_BYTES`。
- **根路径怎么画**：`splitRoot(root)` 把它拆成「父路径 + 最后一段」两半——最后一段是读者扫一眼要找的
  那个名字，**不缩不淡**；父路径淡化、宽度不够时从**它的末尾**出省略号。所以窄窗口里被吃掉的是
  `/private/var/folders/…`，留下来的永远是 `diorama-test-peqcp5`。分隔符两个都认（POSIX 与 Windows）。
- `src/index.tsx`：
  - `useTabSnapshot`：`ctx.tabs` 在就用它的快照，不在就 `NO_TABS`（`try/catch` 读服务，服务端树里没有）；
  - `useFileFacts(path)`：`stat` 先给大小与时间，文件且不超过上限再 `readText` 数行；**同一目录的
    `fs.watch`** 与 **`rpc.onReconnect`** 都触发重读（断网期间的写盘没有事件）；
  - `StatusBar`：三个 `.diorama-statusbar__group`，文件组可收缩（`flex: 1 1 auto`），路径 `ellipsis`。
- `package.json`：`diorama.id = "status-bar"`、`requires: ["slots", "layout"]`、`client.entry`。

### 3.4 七处接线（AGENTS.md §4）

`plan.ts` 的 `BUILTIN_PLUGIN_IDS`（末尾）、`cli/src/plugins-server.ts` 的 `halves`、
`cli/package.json` 的依赖、根 `package.json` 的 `build` 与 `test:unit`、
`kernel/test/config.test.ts` 的默认清单断言。新座位没有新的 sidebar 视图，第 6 处不动。

## 4. 测试

- `packages/plugins/status-bar/test/info.test.ts`（6 条）：字节三档与坏数字、时间的格式化与丢弃、
  行数口径（`'a\nb\n'` → 2、`''` → 0、`'\n'` → 1）、上限、路径的 `.`。
- `apps/web/tests/m30-status-bar.spec.ts`（4 条，真实 CLI + Chromium）：
  1. 实例三格（目录名 / 8 位 `mountId` / `:<port>`），没开 tab 时文件格写「未打开文件」；
     点 `README.md` 之后是路径、`4 行`、字节数、非空时间；
  2. 变更视图打开一个改动文件 → 栏里出现「差异」标记；
  3. `--plugins` 不含 `status-bar` → 没有 `status-bar`，也没有 `[data-slot="layout.status"]`；
  4. 几何：栏在框架**下方**，且 `scrollHeight <= innerHeight`（加一条栏不会让窗口滚动）。

## 5. 验证

```bash
pnpm build
pnpm test:unit                                   # 447 条
pnpm -r --no-sort run typecheck
node scripts/assemble-package.mjs                # 改了 styles.css，e2e 的壳要重装
pnpm --filter diorama-web exec playwright test    # 179 条
```

## 6. 坑

1. **`min-height: 0` 是栏能不能留在窗口里的分水岭**。第一版只给 `.diorama-shell` 写了
   `display: flex; flex-direction: column; height: 100%`，框架里的长文件（`height: 100%` 的
   `.diorama-tabs`）让列撑高，状态栏被推到视口之外——页面看着「没有状态栏」，而 `data-testid` 全在。
   flex 子项默认 `min-height: auto`（内容高度），框架必须显式 `min-height: 0` 才会让出高度。
2. **空座位要真的不画**。`Slot` 的 `empty={null}` 只决定**座位里**渲染什么，`<footer>` 仍然会被
   画出来——那就是一行 1px 上边框加面板底色。所以 `StatusLine` 先 `useSeat` 问一句有没有条目。
   e2e 用「`[data-slot="layout.status"]` 计数为 0」锁住，而不是只看 `status-bar` 不在。
3. **`useSeat` 也是 hook**。写成 `if (entries.length === 0) return null` 之后再读别的 store，
   就是两次渲染 hook 数量不同（m15/spec §6 坑 1）。这个组件只有这一个 hook，且在任何 return 之前。
4. **改了 `styles.css` 要重装壳**。e2e 的 CSS 来自 `packages/cli/web/`，`pnpm build` 只刷
   `apps/web/dist`——不跑 `assemble-package.mjs`，新类名在测试里**完全没有样式**，而几何断言会
   以「栏高度 0」失败（m26/spec §6.5.1 的同一条）。
5. **别在栏里报错**。`stat` 失败（文件刚被删）时第一版显示「读取失败」，结果删掉一个文件后栏比
   tab 还响。改成省掉那几格：栏是装饰，tab 才是报告错误的地方。
