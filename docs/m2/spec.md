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

## 6. 实现记录

（S7 收尾时填写：三件套结果、与契约的对应表、踩到的坑。）
