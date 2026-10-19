# M2 实施说明（日常可用）

> 记录于 2026-10-19。契约以 [contract.md](../contract.md) **v0.3** 为准，本文只记 M2 的
> **范围、顺序、实现形态与验收**，不重复契约内容（条款编号指向 contract.md）。
> 范围与顺序由用户 2026-10-19 拍板：五块全做，**逐条采纳推荐值，contract 升 0.3**。

## 1. 范围（五块）

| 块 | 契约条款 | 主要落点 |
|---|---|---|
| 多 tab | §3.4、§5 | `kernel/src/client/tabs.ts`、`plugins/tabs`、`renderer-registry` 的 `tabs.content` |
| 命令 / 快捷键 / palette | §3.7、§5（`layout.overlay`） | `kernel/src/client/commands.ts`（新）、`plugins/palette`（新）、`plugins/layout` |
| `fs.watch` 实时刷新 | §3.1、§4 | `server/fs.ts`、`server/rpc.ts`、`client/rpc.ts`、`client/fs.ts`、`file-tree`、`renderer-registry` |
| 文件树隐藏 + 大目录懒加载 | §3.1（`list`）、§4.1 | `server/fs.ts`、`plugins/file-tree` |
| `diorama.toml` | §4.1 | `kernel/src/shared/toml.ts`（新）、`server/config.ts`（新）、`cli/src/run.ts` |

不碰：外部插件（`~/.diorama/plugins`、npm source、zod 运行时校验）、gateway、`ctx.git`。

## 2. 依赖与实施顺序

依赖边（只列真实存在的）：

1. **toml → 文件树**：隐藏规则有两条输入（内置默认、`ignore`）；先做树就要把过滤写两遍。
2. **toml → watch**：在 `node_modules` 上挂监听是灾难，忽略规则必须在 fs 层先生效。
3. **toml → palette（文件检索）**：同一条规则的第三个读者（M2 不做文件检索，但规则仍是共用面）。
4. **命令/绑定 → watch**：“自动刷新”是 §3.7 的“开关型命令”（O8）。
5. **多 tab / 命令 / watch 之间无直接边**，但三者共用两个基础设施：
   - **命令 = 插件注册面**：今天的半边都是 `ctx.provide(...)` 平铺写法，没有可设置 `inject` 的
     插件对象，也没有“插件卸载 = 退役”的结构。§3.7 要让命令住进插件，先有 `openSidecar()`。
   - **RPC 事件今天没有 session**：广播 + `rpc.on()`，订阅表无法按 mount / 连接释放。
     命令（页面级注册表）会先遇到这个问题，它是 watch 的前置。

| 步 | 内容 | 结束时的验收 |
|---|---|---|
| **S0** | contract v0.3 + 本文 | 文档；无代码 |
| **S1** | `diorama.toml`：子集解析器、查找顺序、CLI 优先级、`--all`/`--config`；`ignore` 在 `fs.list` 生效；`/plugin.json` 带 `config` | `--dump-plan` 显示合成配置；单测（toml 解析、ignore 匹配、优先级）；e2e：`node_modules` 不出现在树里，`mount.fs.list()` 与树一致 |
| **S2** | 文件树：隐藏规则（走 `list`）+ 每目录阈值与「显示更多」 | e2e：隐藏项不可见、大目录只列前 N 条、加载更多追加、被隐藏目录不应能展开 |
| **S3** | 多 tab：`TabInfo.path`、`ctx.tabs` 定稿、`tabs.content` keyed（每个 tab 一个座位）、关闭/循环 | 单测（tabs 服务）；e2e：开 3 个切换、关闭后的激活规则、每 tab 滚动独立、M1 回归用例仍绿 |
| **S4** | 命令内核：`openSidecar`、`ctx.commands`（register/bind/run/when/CommandContext）、按键分发、`layout.overlay`；内置命令 | 单测（键记法、冲突、when、分发）；e2e：`mod+alt+w` 关 tab、`mod+alt+f` 聚焦树、`mod+alt+→` 切 tab |
| **S5** | `palette` 插件：`layout.overlay` 条目、`mod+k`、过滤、执行、Esc | e2e：打开/过滤/执行/关闭；去掉 palette 时快捷键仍可用 |
| **S6** | watch：`FsService.watch`（目录、300ms、ignore 感知）、订阅端点 + session、连接关闭自动取消；树与内容刷新、`view.refresh` / `view.toggleAutoRefresh` | 单测（debounce、type 定夺）；e2e：改盘上文件 → 内容变；新建 → 出现在树里；删除 → 明确提示；取消后不再推送 |
| **S7** | 文档收尾：features.md 档位、本文实现记录 | 三件套全绿 |

每一步结束都跑：`pnpm build` → `pnpm typecheck` → `pnpm test:unit` →
`pnpm --filter diorama-web exec playwright test`。

## 3. 实现形态（契约之外的具体选择）

| 项 | 选择 | 理由 |
|---|---|---|
| toml 解析 | 引 `smol-toml` | 子集解析器写不全；与 M1 引 `ws` 同一取舍 |
| ignore 匹配 | 自写 gitignore 子集（`name` / `dir/` / 相对根 / `*?[]` / `**`） | 规则面小，单测可穷尽 |
| `fs.list` 的隐藏 | `FsService` 构造时拿到 `{ ignore, watch }` | 唯一强制点（§3.1） |
| watch 监听 | 每个 watch 端点一个 `fs.watch(dir)`（M2 单目录，M3 再谈共享） | 最简且可预期；端点关闭即关 |
| debounce | server 侧 300ms 窗口 + client 侧同规则合并 | 双端同一套规则（§3.1） |
| 键分发 | 内核 `commands` 在 `document` 上挂一个 `keydown` | 只一个监听者，避免互相抢键 |
| `CommandContext` 采集 | 内核在分发/palette 查询时现采 | §3.7：插件不各自查询 |
| 大目录阈值 | 每目录折叠前 500 条（常量，不进 toml） | M2 只解决“别卡”，不引入配置面 |

## 4. 验收（M2 演示脚本）

演示：打开三个文件（三个 tab，各自滚动位置独立）→ `mod+k` 打开 palette 搜“关闭”执行 →
在终端改一个已打开的文件，页面自己刷新（不动鼠标）→ 新建一个文件，树里出现 →
`diorama.toml` 里加一条 `ignore`，树里对应的目录消失 → `--all` 后重新出现。

| # | 验收点 | 复现 |
|---|---|---|
| 1 | `diorama.toml` 的 `host/port/plugins/ignore` 生效，CLI 覆盖 toml | 单测 + `--dump-plan` |
| 2 | toml 写错 fail loud（退出码 2，点名原因） | e2e（CLI 退出码） |
| 3 | 被 ignore 的目录不出现在树里，`fs.list` 也不返回 | e2e |
| 4 | 大目录折叠 | e2e |
| 5 | 多 tab：打开/切换/关闭，关闭后的激活规则 | e2e |
| 6 | 每个 tab 的滚动位置独立 | e2e |
| 7 | 快捷键：`mod+alt+w`、`mod+alt+f`、`mod+alt+→/←`、`ctrl+tab` | e2e |
| 8 | palette：`mod+k` → 过滤 → 回车执行 → Esc | e2e |
| 9 | 去掉 palette 插件，快捷键仍生效 | e2e |
| 10 | 改盘上文件 → 打开的 tab 自动刷新 | e2e |
| 11 | 新建文件 → 树出现；删除已打开文件 → 明确提示 | e2e |
| 12 | M0 5 条、M1 7 条仍全绿 | e2e |

## 5. 风险与已知取舍

- **`TabInfo` 换形**：`renderer-registry` 与 `tabs` 是唯一两个读者，改动面已收敛。
- **每个 tab 一个 `tabs.content` 座位**：非活动座位隐藏不卸载，内存随 tab 数增长；`MAX_TABS` 不设上限（M2）。
- **watch 的 inotify 上限**：Linux 每个 watch 端点一个句柄；M3 多目录时再谈共享与回收。
- **`diorama.toml` 的 CLI 默认值要区分“未给”**：`parseArgs` 的默认值改 `undefined`，合成在
  `resolveConfig()` 里一次完成；M0 的端口/主机相关 e2e 必须保持绿。
- **contract 0.3 需要全量重建**：kernel 与所有内置半边一起 build，否则 manifest 被拒。

## 6. 实现记录（2026-10-19，M2 落地后）

### 6.1 验收结果

```
pnpm test:unit                                   # 58 passed
pnpm -r --no-sort run typecheck                  # clean（见 §6.3 第 1 条）
pnpm --filter diorama-web exec playwright test   # 33 passed（--repeat-each=2：66/66，无 flaky）
```

| 用例文件 | 覆盖 |
|---|---|
| `m0-acceptance`（5） | 原 5 条验收全绿（多 tab 后只改了断言的作用域） |
| `m1-acceptance`（7） | matcher、回退链、RPC、不再卡死（断言随多 tab DOM 调整） |
| `m2-config`（4） | toml 查找/校验/CLI 覆盖、写错 fail loud、ignore 在树与 `fs.list`、`--all` |
| `m2-tree`（2） | 大目录分页 + 加载更多、隐藏目录不可展开 |
| `m2-tabs`（3） | 打开/切换/关闭与回退、每 tab 独立滚动、删除文件报 ENOENT |
| `m2-commands`（4） | `mod+alt+w/←/→`、`mod+alt+f`、输入框内不触发、注册表内容 |
| `m2-palette`（3） | `mod+k`、过滤/回车/ Esc、只列可执行、去掉 palette 后快捷键仍可用 |
| `m2-watch`（3） | 改盘上文件 → 内容刷新、新建/删除 → 树与报错、自动刷新开关 |
| `m2-server-halves`（2） | 服务端树里每个内置插件都能干净启动（一个模块两个半边） |

### 6.2 实测踩到的坑（M3 起请先读这一节）

1. **Cordis 会剥掉插件返回对象上的自定义字段。** 一个半边的 `apply` 里建出来的对象，
   经 `ctx.<service>` 的方法返回后，**多出来的字段**（包括数组、以及 `Object.keys` 都看不到的
   内部槽）在插件侧读出来是 `null`。所以 slot 条目上不能挂 `declarations` / `seats` 这类派生
   数据；要问「这个座位有没有主人」就调 registry 自己的谓词（`registry.owned(name)`）。
2. **boot 顺序 ≠ 图顺序。** Cordis 里一个 PENDING 的 fiber 会在它依赖的服务被 provide 时
   **就地**重跑 `apply`，于是它在图里的位置被跳过。`loadPlugins` / `bootClient` 在每个插件之后
   把 effect 队列排干（`settle()`），并且 `requires` 只决定图顺序、`inject` 决定激活顺序。
   凡是「注册进别人的座位」的插件都要把对方写进 `inject`（`renderer-registry` → `tabs`）。
3. **一个内置模块同时是 server 半边与 client 半边，`inject` 是共用的。** `ctx.commands` /
   `ctx.mount` 只存在于页面（client 内核）；把它们写进 `inject` 会让服务端的该插件永远
   PENDING（CLI 启动时 `did not activate`）。正确的读法是**可选读取**：`inject` 只列两边都有
   的服务，client-only 服务用 `clientCommands(ctx)` 这类小助手 try/catch 地读（Cordis 对
   「未 provide、未 inject」的属性读**抛错**，不是返回 undefined）。`m2-server-halves` 用例
   守这条。
4. **座位只能声明一次，且「声明」与「注册」是两件事。** 先 `ctx.slots.declare(seat)`，条目上
   就不要再写同一个 `declare`（会以「已被自己声明」被拒）。keyed 座位上的条目**必须带 key**：
   所以 `renderer-registry` 是**每个 tab 注册一条**（`renderer-registry:tab:<id>`），不是一条
   通配条目。
5. **`useSyncExternalStore` 的快照必须是稳定引用。** 内联的 `() => read()` 每次渲染都是新函数，
   React 会反复退订/重订、永远看不到更新（表现为永远「正在读取…」）。文件缓存因此暴露
   `getVersion()` + `subscribe` 两个**绑定的**稳定函数，状态另读。
6. **`fs.watch` 的 `rename` 不可信。** macOS 会为已存在的条目报 `rename`，一次保存也可能同时
   产生 `change` 与 `rename`。所以服务端会 `stat` 一次把事情定性为 add / change / unlink，并按
   **path**（不是 path+type）做窗口合并。
7. **关闭服务器时 WebSocket 必须 `terminate()`。** `ws.close()` 是握手；HTTP `server.close()`
   会等所有 socket 走完，于是 CLI 不退出（e2e 的 `stop()` 卡满 30s）。`RpcChannel.close()` 现在
   先结束会话再 `terminate()`。
8. **包声明（`lib/types`）是构建产物。** 改了 `packages/kernel/src/...` 的导出而没重建 kernel，
   下游包的 typecheck 会看到旧声明；「Cordis 找不到字段」这类怪现象先怀疑声明陈旧。
9. **e2e 的键盘 `mod` 跟随浏览器平台。** 本机 Chromium 报 macOS，所以测试里 `mod` = `Meta`；
   `ctrl+tab` 在 macOS 上被浏览器吃掉（契约 §3.7 的保留键），e2e 改从注册表驱动两条边缘命令。

### 6.3 与契约的对应

| 契约 | 实现位置 |
|---|---|
| §3.1 `watch`（目录、300ms、type 提示） | `kernel/src/server/fs.ts`、`kernel/src/client/fs.ts` |
| §3.1 `list` 忽略规则 | `kernel/src/shared/ignore.ts`、`server/fs.ts` |
| §3.4 `ctx.tabs` | `kernel/src/client/tabs.ts`、`plugins/tabs` |
| §3.7 `ctx.commands` | `kernel/src/client/commands.ts`、`kernel/src/client/boot.ts`（按键分发、focus 采集） |
| §4 订阅端点 / session | `kernel/src/shared/rpc.ts`、`server/rpc.ts`、`client/rpc.ts`、`cli/src/run.ts`（`withSubscriptions`） |
| §4.1 `diorama.toml` | `kernel/src/server/config.ts`、`cli/src/run.ts` |
| §5 `tabs.content` keyed / `layout.overlay` | `plugins/tabs`、`plugins/renderer-registry`、`plugins/layout`、`plugins/slots/src/types.ts` |
| §3.7 palette | `plugins/palette` |
| §6 contract 0.3 | `kernel/src/contract.ts`、全部内置插件 manifest |

**命令清单（M2）**：`tabs.close`(mod+alt+w) · `tabs.next`/`tabs.prev`(mod+alt+→/←) ·
`tabs.nextEdge`/`tabs.prevEdge`(ctrl+tab / ctrl+shift+tab) · `tree.focus`(mod+alt+f) ·
`view.refresh`(mod+alt+r) · `view.toggleAutoRefresh`(无键) · `palette.toggle`(mod+k)。

### 6.4 遗留（M3 前可选）

- `pnpm typecheck` 的 pnpm 任务图在 `plaintext ↔ renderer-registry` 之间有环（devDependency），
  `pnpm -r run typecheck` 会直接报 `ERR_PNPM_TASK_CYCLE`；用 `pnpm -r --no-sort run typecheck`。
  这是 M1 起就有的问题，不在 M2 范围。
- `jsdom`/单测没有覆盖 UI 组件；命令、tabs、watch、config、ignore 是纯逻辑层单测。
