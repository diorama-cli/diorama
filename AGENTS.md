# AGENTS.md

> 给在本仓库里工作的 agent（以及新加入的人）。读完这一页再改代码。
> 只写**每次都要知道的事实**，不写流程叙事；细节在链接的文档里。
> 当前契约 **v0.0.5**（变更清单自 §20 起按版本分段：`0.0.3` 是 §20–§22，此后每版一档）。

## 1. 先读什么

| 顺序 | 文档 | 读它为了 |
|---|---|---|
| 1 | [docs/contract.md](docs/contract.md) | **能不能**：内核与插件的唯一约定，带版本号（当前 **v0.0.5**）。改任何 `ctx.*` / slot 签名都算改契约 |
| 2 | [docs/architecture.md](docs/architecture.md) | **为什么**：已拍板的决定、放弃项、代价。不要重新讨论已拍板的事 |
| 3 | [docs/features.md](docs/features.md) | **有什么**：能力清单与档位（✅ / v1 / 未来 / 不做） |
| 4 | 最近一档的 `docs/mN/spec.md` | **怎么实现的** + **§6.2 的坑**（见下面 §5） |

最近一档是 [docs/m25/spec.md](docs/m25/spec.md)（文件行右键 → **下载 / 复制链接 / 独立浏览器窗口打开**，
三个动作都指向同一个**原件 URL** `/~raw~/<path>`：默认 `inline`、按文件类型返回真实 `content-type`，
只有 `?download=1` 才 `attachment`；复制出来的链接与在新窗口里打开的都是那个文件本身，不是 diorama
页面。同一件事另有三条命令 `file.download` / `file.copyLink` / `file.openInWindow`（无键位，作用于
活动 tab 的文件）。**新文件若 `import` 了 `diorama-kernel` 却没先 `import 'cordis'`，整个包的
`Context.provide` 类型增强会静默消失**——本档踩到的坑，见 m25/spec §6 坑 1）；
上一档是 [docs/m24/spec.md](docs/m24/spec.md)（文件视图有自己的**工具栏**：视图面板顶部一条，一颗
「定位到正在浏览的文件」按钮——沿路展开目录、按需把分页的目录长到落点、把那一行滚到中间并给一段淡出
高亮；**不是导航**（不打开、不切 tab、不改选中、不动 URL），没有 tab 时按钮禁用；同一动作是命令
`tree.revealActive`（`mod+shift+l`）。工具栏画在**视图自己的组件**里，不用座位——与 §5.2「切换器由
`layout` 画」同一分工；`ctx.tree` 多一个 `reveal(path)`，快照多 `reveal: { path, at }`）；
上一档是 [docs/m23/spec.md](docs/m23/spec.md)（网页标题是这个挂载的**目录名**：壳是静态 HTML，
配置在 `/plugin.json` 里，两者只在 `serveShell` 相遇——所以标题由服务端写进文档，
`shellTitle` / `withShellTitle` 是纯函数；`/` 没有名字时保留壳自己的标题）；
更早是 [docs/m22/spec.md](docs/m22/spec.md)（默认主题写在 `diorama.toml` 的 `[ui] theme`：是
**起点不是锁定**（读者选过就以读者的为准），`system` / `light` / `dark` / 主题 id；没选过时
`diorama.theme` **不写** `localStorage`（记住的默认值会盖住之后改的配置），首帧由 `serveShell`
注入 `window.__diorama_theme__`）；
更早是 [docs/m21/spec.md](docs/m21/spec.md)（CLI 新增 `diorama stop [dir] [--all]`：只卸**一个**
挂载（无参数 = 当前目录**所在的**那个，嵌套取最深的包含者），gateway 与其它挂载照旧——停进程仍是
`gateway stop`；不匹配 / 未运行 gateway 都是退出码 0）；
更早是 [docs/m20/spec.md](docs/m20/spec.md)（快捷键能力增强，v0.16 按 cmux 的体验重做：tab 条
键位对齐 IDE（`mod+w` 关、`mod+shift+[ / ]` 循环、`mod+1..9` 跳，撞浏览器也不让步）、中键关 tab，
以及**按住 ⌘ / Ctrl 或 ⌥ 时关键快捷键以浮层标签显示**——浮层不参与布局，几何不变；只显示 tab 键与
切换器键，关闭 / 收起不显示；状态在页面全局 `__diorama_keys__`，文本来自注册表快照的 `label`）；
更早是 [docs/m19/spec.md](docs/m19/spec.md)（diff 的单栏「整个文件」与双栏「新旧对照」按文件语言
上色：引擎由 `code` 半边发布到页面全局 `__diorama_highlight__`，`git-changes` 读它，每行一个完整
HTML 片段；行内那档是 git 的文本，不上色）；
再往前是 [docs/m18/spec.md](docs/m18/spec.md)（侧栏可收起：切换器脚下有「收起 / 展开」按钮与
`mod+b`，收起后只剩 36px 的一竖条、面板隐藏不卸载，收起是**偏好**、与"选了哪个视图"正交）。

`docs/plan.md` 是**阶段性排期**，会退役；不要把它当长期真源，也不要在新代码里引用它。
一次会话的最小读法：`contract.md` 目录 → `features.md` 表 → 最近 spec 的「坑」一节。

## 2. 文档分工（写文档时按这个分）

- **契约**回答"能不能"，**架构**回答"为什么"，**features** 回答"有什么"，**spec** 回答"当时怎么做的"。
- 不要用里程碑编号（M1/M2/M4）作为**长期引用**。契约与架构里写"未排期""v1 之外"，不写"M4"——排期会变，能力不会。
- **契约号只在发版时升**（contract.md §6）：日常开发改 `ctx.*` / slot / 加插件都**不动** `CONTRACT_VERSION`，只照常改 `contract.md` 正文与变更清单；发版才升号，并一次性把全部内置 manifest 的 `contract` 范围升到新值。发版走 `pnpm release`，流程见 [docs/release.md](docs/release.md)——**不要手工改这 24 个文件**，漏一个就是新内核拒绝加载自己的插件。

## 3. 验证（改完必跑，顺序固定）

```bash
pnpm build
pnpm test:unit                                   # node --test --experimental-transform-types
pnpm -r --no-sort run typecheck                  # 注意：不要用 pnpm typecheck
pnpm --filter diorama-web exec playwright test   # 真实 CLI + Chromium
```

- **`pnpm typecheck` 会直接失败**：`plaintext ↔ renderer-registry` 的 devDependency 在 pnpm 任务图里成环（`ERR_PNPM_TASK_CYCLE`）。用 `-r --no-sort`。这是已知问题，别顺手"修"成大改动。
- **必须先 `pnpm build` 再跑 e2e**：e2e 跑的是构建产物（`packages/*/lib`、`apps/web/dist`），不是源码。改了源码没重建，测试跑的是旧代码。
- **类型声明也是构建产物**：`packages/kernel/lib/types/**` 与各插件 `lib/types/**` 由 `tsc -p tsconfig.emit.json` 生成。改了某个包的**导出**（新增/改名类型、函数），必须重建**那个包**，否则下游 typecheck 会看到旧声明，症状是"找不到成员"——先怀疑声明陈旧，再怀疑代码。
- 遇到难以解释的"改了没用"，先删 `lib`/`dist` 重建一次再继续排查。

## 4. 仓库地图

```
packages/kernel/          内核：服务端（HTTP/RPC/fs/config/plan）、客户端（boot/rpc/fs/tabs/tree/commands）、shared
packages/plugins/<id>/    内置插件，一包两半边：lib/index.mjs（server 半边）+ lib/client.cjs（页面工厂）
packages/ui/              页面渲染原语（Slot、useKernel、useStore、错误边界、样式、图标）
packages/cli/             命令行：参数、diorama.toml 合成、服务端插件树装配
apps/web/                 页面壳（Vite）+ Playwright e2e（tests/）
docs/                     契约、架构、能力、排期、逐档 spec
scripts/                  生成器（图标表；`pnpm icons` 重新生成）
```

### 内核里改哪里

| 要改的东西 | 文件 |
|---|---|
| `ctx.fs` 语义、错误码、watch | `kernel/src/server/fs.ts`、`kernel/src/client/fs.ts` |
| 忽略规则（`ignore`） | `kernel/src/shared/ignore.ts` |
| RPC 帧、订阅端点、session | `kernel/src/shared/rpc.ts`、`server/rpc.ts`、`client/rpc.ts` |
| `ctx.commands`、按键分发 | `kernel/src/client/commands.ts`、`client/boot.ts` |
| 键记法（解析 / 匹配 / 打印）与「按住修饰键」状态 | `kernel/src/client/keys.ts`、`client/modifiers.ts`（页面全局 `__diorama_keys__`；控件显示快捷键用 `diorama-ui` 的 `useHeldModifier` + `KeyHint`） |
| `ctx.tabs` / `ctx.tree` | `kernel/src/client/tabs.ts`、`client/tree.ts` |
| `ctx.git`（仓库探测、status/diff/log/show/showCommit/blob、上限） | `kernel/src/server/git.ts`、`kernel/src/shared/types.ts`、`kernel/src/client/git.ts` |
| 仓库发现（向下走查、深度/忽略/上限、嵌套） | `kernel/src/server/repos.ts`、`kernel/src/server/config.ts` 的 `[git]` 表 |
| `ctx.fs` 的大小上限（两端共用一个数） | `kernel/src/shared/limits.ts` |
| 页面配色 token（light / dark 调色板、主题覆盖的集合） | `ui/src/styles.css`（`:root` 与 `[data-scheme='dark']` 两处**一起改**）；防白闪脚本在 `apps/web/index.html` |
| `ctx.search`（文件名 / 内容搜索、上限、reveal store） | `kernel/src/server/search.ts`、`kernel/src/shared/search.ts`、`kernel/src/client/search.ts`、`ui/src/reveal.ts` |
| `ctx.router`（`/~/` URL 与活动 tab） | `kernel/src/client/router.ts`、`kernel/src/server/http.ts`（`/~/` 回壳） |
| `ctx.theme`（配色偏好、主题注册表、`data-scheme`） | `kernel/src/client/theme.ts` |
| 插件图、boot 顺序、`settle`、mount fork / `onMount` | `kernel/src/server/plugins.ts`、`client/boot.ts`、`server/plan.ts` |
| gateway 的 mount 表、端口、degraded 状态机 | `kernel/src/server/gateway.ts` |
| 控制面协议（帧、方法、错误码） | `kernel/src/shared/control.ts`、`kernel/src/server/control.ts` |
| CLI 子命令、`ls` 表格、后台 gateway | `cli/src/main.ts`、`cli/src/control-client.ts`、`cli/src/gateway.ts`、`cli/src/gateway-command.ts` |
| `diorama stop`（按目录卸一个挂载；选择规则是纯函数） | `cli/src/stop.ts`（`planStop` 不连 gateway，`node --test` 直接测） |
| `diorama.toml` | `kernel/src/server/config.ts`；页面能读的那一段（`mountCtx.config`）在 `kernel/src/shared/config.ts`（`MountConfig`） |
| 新内核服务的「每 mount 一份」接线 | `KERNEL_SERVICE_IDS`（plan.ts）、`MOUNT_SERVICES`（plugins.ts）、CLI 的 `PROXYABLE` 与 server 半边选择（`cli/src/gateway.ts`、`run.ts`、`plugins-server.ts`）——**四处一起改**，漏一处就是 RPC `ESERVICE` |
| 契约版本 | `kernel/src/contract.ts`（**只在这里改**） |

### 加一个内置插件：7 处要一起改

1. `packages/plugins/<id>/` 新包：`package.json`（`diorama.id` / `contract: ">=0.0.5 <0.1.0"` / `client.entry` / `requires`）、`vite.config.ts`、`tsconfig.json`、`tsconfig.emit.json`（从任意现有插件复制）。
2. `packages/kernel/src/server/plan.ts` 的 `BUILTIN_PLUGIN_IDS`（顺序 = boot 顺序）。**插件的 id 不能与内核服务 id 相同**（`KERNEL_SERVICE_IDS`：`fs` / `git` / `search`；`theme` 这个 id 也已被内置 piece 占用）——同名会让 `halves` 表出现重复键，服务被静默覆盖；照 `git` / `git-changes` 的样子分开命名。
3. `packages/cli/src/plugins-server.ts` 的 `halves` 映射（server 半边）。
4. `packages/cli/package.json` 的 `dependencies` 加 `workspace:*`。
5. 根 `package.json` 的 `build` 脚本加一条 `pnpm --filter diorama-plugin-<id> run build`（放在依赖它的包之前）。
6. 需要新座位时：`packages/plugins/slots/src/types.ts` 的 `SlotMap`；左侧栏的新视图注册进 `sidebar.views`（key = 视图 id），不要新开侧栏座位。
7. 默认清单 / 计数：`kernel/test/config.test.ts` 的默认插件断言要加这个 id；有 `node --test` 单测的新包，记得把 `test/<name>.test.ts` 加进根 `package.json` 的 `test:unit`（`node --test` 不认 `.tsx`，纯函数单独放一个 `.ts`）。

`pnpm-workspace.yaml` 已覆盖 `packages/plugins/*`，无需改；新包第一次要跑一次 `pnpm install` 建链接。

## 5. 陷阱（M2/M3 实测，按症状查）

完整叙述见 [docs/m2/spec.md §6.2](docs/m2/spec.md) 与 [docs/m3/spec.md §6.2](docs/m3/spec.md)；这里是最容易再犯的几条。

| 症状 | 根因 | 规则 |
|---|---|---|
| 插件读到的对象少了字段，`Object.hasOwn` 为 false | **Cordis 会剥掉插件返回对象上的自定义字段** | 不要在 slot 条目上挂派生数据；要问状态就调 registry 的方法（如 `registry.owned(seat)`） |
| 注册顺序不对、座位"未被声明"、插件静默不生效 | **boot 顺序 ≠ 图顺序**：PENDING fiber 在依赖被 provide 时被就地重跑 | `requires` 决定图顺序、`inject` 决定激活顺序；注册进别人座位的插件把对方写进 `inject`；加载器每装完一个插件都 `settle()` 排干 effect |
| 服务端启动打印 `did not activate` / `cannot get property "x" without inject` | 一个模块两半边**共用 `inject`**；client-only 服务（`ctx.commands`、`ctx.mount`）在服务端不存在，且 Cordis 对未注入的属性读**抛错** | `inject` 只列两边都有的服务；client-only 服务用 `try { ctx.commands } catch { return }` 可选读取 |
| keyed 座位的条目被拒（`requires a key`） | keyed 座位每条都要带 `key` | 要"一条通配"就改成**按实例注册多条**（如 `tabs.content` 每个 tab 一条） |
| 座位"已被声明"被拒 | 先 `ctx.slots.declare(seat)` 又在条目上写同一个 `declare` | 声明一次；条目上的 `declare` 只给**没提前声明**的座位 |
| 界面永远「正在读取…」 | `useSyncExternalStore` 的快照每次渲染都是新引用 | store 暴露**绑定的稳定函数**（`subscribe` / `getVersion`），状态另读 |
| watch 事件重复或漏 | `fs.watch` 的 `rename` 不可信（macOS 会给已存在文件报 rename） | 服务端用 `stat` 定性 add/change/unlink，按 **path**（不是 path+type）合并 |
| 关闭时 CLI 不退出 / e2e 卡住 | `socket.close()` 是握手，HTTP `server.close()` 等所有 socket | `RpcChannel.close()` 先结束会话再 `terminate()` |
| 卸载一个目录后，另一个目录 RPC 报 `ESERVICE: no service "fs"` | 两个 mount 共用了 isolate key 或共享 fiber 上的 `provide` | 每个 mount `isolate('fs', Symbol(mountId))`，`provide` 放进该 mount 自己的 `ctx.plugin()` fiber（m3/spec §6.2 1–2）|
| `service "mountId" has been registered` | `mountId` 被 `provide` 成服务 | 它是普通属性（`Object.defineProperty`），不要 inject |
| 随机端口挂载 404 / `/plugin.json` 没有 port | manifest 在 bind 前建好 | 先探端口 → boot fork → 建 server（带最终 URL）→ listen |
| 改子命令没有生效 | tsdown 入口仍是 `src/run.ts` | `packages/cli/tsdown.config.ts` 入口是 `src/main.ts` |
| 左栏视图「注册了但不显示」 | `layout` 只画它知道的座位 | 视图用 `sidebar.views`（keyed，key = 视图 id）；非活动视图隐藏不卸载 |
| URL 深链不生效 / 刷新丢文件 | 路由与 tabs 的写回方向搞反 | URL 只记活动 tab 的路径；`ctx.router` 订阅 tabs 回写，`popstate` 只反向打开 |
| 新的字节渲染器（图片/PDF）永远不被选中 | `ext` 档永远赢 `mime` 档（§5.1 rule 2），别的渲染器按扩展名认领了它 | 一个扩展名只有一个 owner：把 `.svg` 之类从别的 `ext` 表里拿掉（m4/spec §9.2）|
| 两个 mount 的 `git` 串了（`service "git" has been registered at <git:…>`，或 root 解析到某个 mount 的 git） | **Cordis 按服务名隔离，不按 fiber**：`isolate` 只命名一个名字，其余落回 root 的默认键 | 每个 mount 提供的服务名都要进 `MOUNT_SERVICES`（`kernel/src/server/plugins.ts`）；插件自己的按目录服务用 `isolateMountService(ctx, name)`（m4/spec §13）|
| git 读到别的仓库 / 历史与文件树不是同一个目录 | 进程环境里的 `GIT_DIR` / `GIT_WORK_TREE` 优先于 `-C` | `runGit` 用 `gitEnvironment()`（丢掉所有 `GIT_*`）；别把 `process.env` 直接交给 git（m4/spec §13）|
| 日志里健康 mount 反复 `degraded: ENOENT` / `EBINARY` → `recovered` | RPC 调用报的**回答码**被当成 mount 故障 | 内核错误表里的码都不 degrade；只有无码/未知码才算故障（`cli/src/gateway.ts` 的 `ANSWER_CODES`）|
| HTML 预览「样式全没了」 | DOMPurify 默认**只消毒 `<body>`**，`<head>` 里的 `<style>` 被整段丢掉 | `WHOLE_DOCUMENT: true`，再把返回文档的 head/body 分别取出来（m4/spec §14）|
| 页面读不到配置（`mountCtx.config` 是 `undefined`） | `MountHandle` 的 `config` 只在 `createMountHandle` 里从 `/plugin.json` 的 `config` 取；渲染器自己 `stat`/读字节，但**配置不是它取的** | 要新配置项：`EffectiveConfig` + `MountConfig`（`kernel/src/shared/config.ts`）+ `createMountHandle` 三处一起加，缺一处页面就退回默认（contract §28）|
| `node --test` 报 `ERR_UNKNOWN_FILE_EXTENSION: .tsx` | Node 不认 `.tsx` | 单测只导入 `.ts`；把要测的纯函数从组件文件里拆出来（m4/spec §12）|
| 「找不到成员 `mountCtx`」/ props 里还有 `bytes` | `FileRendererProps` 曾在内核与 slots 各有一份且漂移 | 只有内核一份；slots re-export 它。`export type {X} from` 后同文件不能再用 `X` |
| e2e 里快捷键不生效（mac 上写 `Control+Alt+x`） | `mod` 在 macOS 上是 Meta | 测试用 `MOD = darwin ? 'Meta' : 'Control'`；别用裸 `Control` |
| **真实 Mac 上 `mod+alt+*` 全是死键、按键透传给浏览器，而 e2e 全绿** | macOS 的 **Option 是组合键**：⌘⌥W 的 `key` 是 `∑`、⌘⌥R 是 `®`、⌘⌥1 是 `¡`。**Playwright 的 `keyboard.press` 走 CDP 合成 `key:'w'`，不经过组合**，所以测不出 | `matchesKeys` 在 `alt` 绑定上按物理键 `KeyboardEvent.code` 兜底；测这类行为要 `dispatchEvent` 一个带组合字符 + `code` 的真实形状事件（m4/spec §16）|
| 提交详情不出现在右侧 | 提交不是 tab，不进 `tabs.content` | `tabs` 声明 `seats.git-commit`，hash 里有 `history=<sha>` 时改画它；tab 仍然挂载 |
| 进过历史视图后点文件，右侧仍是提交详情 | 提交详情没有「离开」的判据：`#history` 只在有人删它时才消失 | 两条判据都要：`ctx.tabs.openCount` 没变（打开文件，**含打开当前那个**）且侧栏 `shown() === 'history'`；判据用到的东西必须进 `useSyncExternalStore` 的快照（m4/spec §6.2 10–13） |
| 状态已变、画面不变 | 判断用的值不在订阅的快照里（另一个半边的 store、或计数） | 计数与别的 store 的版本都进快照；跨半边用页面 `globalThis`（`__diorama_layout__`、`__diorama_overlay__`），不 `import` |
| e2e 里 `press('?')` 打不开快捷键说明 | Playwright 把 `'?'` 当别名，合成的事件是 `key:'?'` + **`shiftKey:false`**，而 `matchesKeys` 要求修饰键精确匹配 | 绑定写 `shift+?`，测试写 `press('Shift+Slash')`（m4/spec §15 坑 1）|
| 覆盖层打开后 `?` / `mod+k` 全失效 | 给根元素贴了 `data-command-keys`，`inTextEntry` 把整棵子树从分发里摘掉 | 只有**输入面**（palette）贴它；速查表这类不接管按键的面不贴（m4/spec §15 坑 2）|
| 启动即 `commands.bind: "escape" is already bound to …` | 同键 + 两个普通 `when` → `mayCoexist` 认为可同时为真，`bind` 抛错；跨半边 `exclusive()` 也救不了（Symbol 是各自构建的） | 一个键只注册一条绑定；palette 的 Esc 留在输入框自己的 `onKeyDown` 里 |
| 第二个覆盖层注册被 warn 拒绝 | `layout.overlay` 曾是 `single` | v0.7 起是 **list**；显隐用 `diorama-ui` 的 `overlayStore`（页面全局），开一个关一个 |
| 新服务在 `onMount` 里报「no "fs" on this mount」 | `onMount` 跑在 mount fiber 还在 `apply` 的时候，`provide` 是 effect，要等 fiber 激活 | 需要别的 mount 服务的服务插件：要么在子 fiber 里 `provide`（`gitHalf`），要么把查找**推迟到第一次使用**（`SearchService` 收 `() => FsService`）|
| 浏览器报 `does not declare the expected name "x" (got y)`，整个插件被跳过 | 模块的 `name` 导出必须等于 manifest 的 `diorama.id` | 改 id 时三处一起改：`package.json` 的 `diorama.id`、`src` 里的 `export const name`、`BUILTIN_PLUGIN_IDS` |
| RPC 对某个内核服务一直 `ESERVICE`，日志没有报错 | 服务的 server 半边没被 CLI 选中（`selectPlugins` 的固定清单漏了它） | 新内核服务的四处接线见 §4「新内核服务的『每 mount 一份』接线」 |
| 改了 `index.html`（或颜色）后 e2e 行为像没生效，`data-scheme` 是 `null` | e2e 的壳来自 `packages/cli/web/`（组装产物），`pnpm build` 不刷新它 | 改了壳 / 样式后跑 `node scripts/assemble-package.mjs` 再测（m9/spec §5.1） |
| 新 token 只加了 light，暗色下掉回奇怪的颜色 | `:root` 与 `:root[data-scheme='dark']` 两处必须成对 | 颜色一律进 token 表（contract §5.3）；两处一起加 |
| 多仓库挂载「变更」里什么都没有 / 服务报 `no usable git repository` | `GitRepoView` 假设了「挂载在仓库里」，并列多仓库时恰好反过来（仓库在挂载里） | 两个方向二选一：仓库**包含**挂载 → `repoPath` 是 `''`；仓库**在**挂载里 → `repoPath` 是它的挂载相对路径（m14/spec §6 坑 2–3）|
| 内层仓库的文件在外层仓库的变更里也出现一次 | git 对未跟踪目录报的路径**带尾斜杠**（`?? vendor/lib/`），与嵌套表里的 `vendor/lib` 不相等 | 比较嵌套前去掉尾斜杠；`nested` 一律用**挂载**路径（m14/spec §6 坑 4–5）|
| 多仓库挂载里点开子目录仓库的提交，右侧报 `ENOENT: no such commit` | 提交座位只拿到 sha，`showCommit` / `show` / `blob` 都没带仓库，落回「挂载自己的仓库」 | `#history` 的值是 `<repo>:<sha>`（挂载根仓库时是裸 sha），`tabs` 解出来交给 `seats.git-commit` 的 `repo`（m14/spec §7）|
| 提交座位里点「新旧对照」没反应（工作区 tab 正常） | 同一个 `DiffView` 有两处调用点，取数条件各写各的：提交座位只在 `mode === 'file'` 时读文件正文，`split` 模式下 `whole` 是 `idle`，双栏分支不成立 | 两处都用 `mode !== 'inline'`；`DiffView` 的 props 让调用方决定 `whole`，写错不会报错，只会静默少画（m14/spec §8）|
| RPC 调用多传一个参数就 `EBADREQUEST` | `describe()` 的 `arity` 是白名单，加参数必须同步改 | `ctx.git` 的每个方法都加了可选 `repo`：`METHODS` 里的 arity 要一起放宽（m14/spec §6 坑 6）|
| 主题「注册了但 palette 里没有」 | `theme` piece 不在 boot 图（`--plugins` 没选它），或注册发生在 piece 同步之后又被 dispose | 命令由 `theme` piece 从注册表同步；确认 piece 在图中、注册方没有立刻注销 |
| 点了提交什么都没发生 / 座位里某个 `data-testid` 永远找不到 | 新加的 hook 写在组件的**提前 `return`**（loading / error）之后，两次渲染的 hook 数量不同，React 抛错整棵子树不渲染 | 所有 hook 写在任何条件返回之前（m15/spec §6 坑 1）|
| `MISSING_EXPORT "X" is not exported by src/y.d.ts`，导出明明写着 | 同一目录里 `y.ts` 与 `y.tsx` 同名，声明 bundle 里抢一个 `.d.ts` | 纯函数与组件分开命名（`splitpane.ts` + `splitter.tsx`）（m15/spec §6 坑 2）|
| 窗格怎么都横滚不动、长名字只剩省略号 | 行被 `width: 100%` 钉在容器宽度上，名字又 `overflow: hidden` | 行 `width: max-content; min-width: 100%`，名字不收缩不省略；**新窗格一律照此办理**（contract §5.2、m15/spec）|
| 断网重连后页面「活着但不动」 | 只重连、没重订订阅；或只重订、没让读者重读（断网期间的改动**没有事件**） | 订阅走 `rpc.watchEndpoint`（通道重放），派生状态在 `rpc.onReconnect` 里重读；两端都要心跳，**断网不触发 `onclose`**（contract §4、m16/spec §6）|
| 新加的订阅在断线后再也不推事件 | 直接 `rpc.call('fs.watch')` + `onSession`，重连后 session 是旧的（服务端已随连接关闭取消） | 订阅端点一律用 `rpc.watchEndpoint(method, args, listener)`（m16/spec §6 坑 2）|
| 渲染出来的东西「源码是空的」（Mermaid 图变空白、公式变空串） | **DOMPurify 会删掉值里含 `-->` / `]>` 的属性**（XML 重解析风险），而 Mermaid 的每条边都是 `-->` | 渲染器要交给 DOM 的**源码是文本内容，不是属性**（`<pre><code>` / 元素文本），读回用 `textContent`（m17/spec §6 坑 2）|
| 单个文件的东西被做成了左栏视图（大纲、目录、统计…） | 左栏（`sidebar.views`）是**整个挂载**共用的，所有 tab 共用一份；一个文件的属性放进去，就得追着活动 tab 换内容、还要编空态 | **一个文件的范围不要扩展到侧边栏**：画在渲染器自己里面（m17/spec §6 坑 1）；侧栏只放「关于这个挂载」的东西 |
| 跳转之后「当前」标记停在上一项 | 跳转的落点与判定的阅读线用了同一个常量（`scroll-margin-top: 8px` 让标题停在 +8，阅读线也取 +8） | 阅读线要**越过**落点（+24），别和 `scroll-margin` 相等（m17/spec §6 坑 4）|
| 「旁边的栏占了太多空间」（宽屏上内容贴一边、栏悬在空白里） | 两栏布局忘了把**整块内容居中**；多余的宽度全堆到一侧 | `.diorama-markdown-body` 用 `justify-content: center` 让文章 + 目录作为一块居中；定宽文章的 flex 要写 `0 1 <measure>`（可收缩），别写 `1 1 auto`（m17/spec §6 坑 10）|
| 插件的运行时文件（字体、样式表、大库）浏览器 404 | 半边是自足的闭包，只有 `client.cjs` 被服务；放它旁边的文件没有路由 | 放 `<pkg>/lib/vendor/`，浏览器从 `/plugins/<id>/vendor/…` 取（contract §4）；`scripts/assemble-package.mjs` 会一起带进发布包（m17/spec §6 坑 6–7）|
| 侧栏「收起」做成宽度 0，收起后点不到展开 | 宽度归零把切换器一起带走了，页面上再没有能展开它的控件 | 收起后仍可见的那一竖条（`SIDEBAR_RAIL_PX`）里放展开按钮；收起 ≠ 选了一个空视图（两个 store）；收起时 `Splitter` **不挂载**（m18/spec §6 坑 1–3）|
| 折叠状态下点视图图标「什么都没发生」 | 改的是 `display: none` 的面板 | 折叠时切换器与 `sidebar.show*` 都先展开再切视图（m18/spec §6 坑 4）；**活动图标点击 = 收起**（activity bar 手势，m18/spec §3）|
| 点了「收起」没反应 | 看的是**旧页面**（layout 半边带 hash 缓存），代码已更新 | 半边 URL 是 `?h=<hash>` 缓存的：重建后**刷新页面**（或重启 gateway）再验 |
| diff 的整文件 / 双栏里「有的行没颜色、有的行整行变色」 | highlight.js 的块注释、多行字符串是**一个** span；按 `\n` 直接切会留下没闭合的标签 | 引擎按行输出：断行处闭合、下一行重开（`splitHighlightedHtml` 的开标签栈）；读法的每一行拿到的都是完整片段（m19/spec §6 坑 1）|
| 双栏里配对行（`-` 与 `+` 同行）的新增格没有颜色 | 把"左侧是删除"当成了"整行只有删除" | 左格取成段的删除文本，**右格各自**按自己的行号从文件里取（m19/spec §6 坑 2）|
| 用了页面全局的引擎之后一直重渲染 / 「正在读取…」 | 把引擎**对象**当 `useSyncExternalStore` 的快照 | 快照必须是**版本号**（数字）；引擎本身在订阅之后另读（m19/spec §6 坑 3）|
| 想让 A 半边用 B 半边的表 / 库 | 半边是自足闭包，import 会把库复制进第二个 bundle，两份表还会漂 | 跨半边共享的只读能力由发布方写到页面全局（`__diorama_highlight__` / `__diorama_layout__` / `__diorama_reveal__`），另一方读它（contract §8、m19/spec §6 坑 4）|
| 按住 ⌘ 后「状态变了但芯片不出现」 | 页面全局 store 是**懒创建**的（第一次写才建），而组件在**首次渲染**就 `subscribe` 了——订阅到一个稍后出现的对象等于没订阅 | 页面全局 store 由发布方在 boot 时**先建出来**（`ensureHeldModifierStore`），别等第一次写；快照必须是字符串 / 数字，不是对象（m20/spec §6 坑 2）|
| 新快捷键在真实浏览器里毫无反应、e2e 却全绿 | `mod+1..9`、`mod+w` 是**浏览器自己的**键，Chrome / Safari / Firefox 不交给页面；Playwright 的 `keyboard.press` 走 CDP 合成，绕过了保留键 | 键位对齐 IDE 是拍板的决定（m20/spec §6 坑 1）：键的正确性优先于「每次按键都到页面」；测 `alt` 绑定要 `dispatchEvent` 带组合字符 + `code` 的事件（m4/spec §16）|
| 提示芯片一出现，tab / 按钮就挪动 | 芯片画进了控件的行内流，撑宽 / 撑高了它 | 芯片是**浮层**（`position: absolute`），不参与布局；e2e 用「按住前后几何不变」锁住（m20/spec §6 坑 2b）|
| 编辑替换文本里写 `${…}`，构建报 `Expected ',' or '}' but found '?'` | 替换字符串里的 `${…}` 被当成插值，写出 `${{…}` | 改 `className={`…${…}`}` 这类模板后**回读一眼**（m20/spec §6 坑 4）|
| 侧栏视图按钮是个空白方块 | `iconSvg` 在没装图标表的页面返回 `''`；切换器原先只判 `undefined` | 新按钮图标先进 `scripts/generate-icons.mjs` 的 `BUTTON_ICONS`、跑 `pnpm icons`，再重建**页面壳**（表由壳安装）；`icon` 为空也要退回标题首字（m17/spec §6 坑 9）|
| **给某个插件加了新文件后，那个包里早就写着的 `ctx.provide(…)` 突然报 `TS2339: Property 'provide' does not exist on type 'Context'`** | 新文件 `import` 了 `diorama-kernel` 但**没先 `import 'cordis'`**：`cordis` 的 `declare module './context'`（`reflect.d.ts`）只有在它先被加载时才把 `provide` 合进 `Context`，于是整个包的增强静默消失。报的是旧代码，病因在新文件（文件顺序变了症状就变：叫 `actions.ts` 报、叫 `zz.ts` 不报） | 新模块**要么不 import 内核**（URL / 值由调用方拼好传进来），要么在 import 列表最前面加一行 `import type { Context } from 'cordis'`（m25/spec §6 坑 1）|

## 6. 边界（不要越过的线）

- **只读**：`ctx.fs` / `ctx.git` 不提供写接口；被浏览的目录永远不写。
- **文件访问只能走 `ctx.fs`**，插件里禁止 `import 'node:fs'` / `'node:fs/promises'`。
- **外部插件**（`~/.diorama/plugins`、npm source、zod 运行时校验）推迟到 v1 之外，契约位在 `contract.md §9`；不要顺手实现。
- **`TabInfo` 只带 `{ id, path }`**，不带 `FileInfo` 快照——内容由内容区自己 `stat`/读。单 tab 语义已废弃。
- **`ctx.commands` 是内核服务**，palette 只是它的一个消费面；不要给命令另开第二套注册表或第二个 keydown 监听。
- **默认只监听 loopback**；`host` 只能由 `diorama.toml` / `--host` 显式放宽。
- **列表窗格横向可滚、可拖宽的用 `diorama-ui` 的 `Splitter` + `usePaneSize`**（contract §5.2）：不要把长名字截成省略号，也不要给某个插件另写一套指针处理。

## 7. 提交与验证纪律

- **只有用户明确要求提交时才提交**：没有当次对话里的「提交」/「commit」字样，就停在工作区——
  不建分支、不 commit、不 push。验证（§3 四件套）照常跑，那是改完的证明，不是提交的理由。
- 一个能力一块提交，提交信息写清"做了什么 + 为什么"。
- 每块完成前跑 §3 四件套；**M0/M1 的验收用例必须保持绿**（它们是多 tab / 命令 / watch 改动的回归）。
- 契约或座位类型变了：同步 `contract.md` 的正文与变更清单、`docs/features.md` 的档位——但**不升契约号**（§2、contract §6）。
- 演示脚本：`node packages/cli/bin/diorama-beta <dir>`（或 `./link.sh` 后直接用 `diorama-beta`）。短命 CLI：确保 gateway → 挂载 → 打印 URL；输出里的 `config:` 与 `hidden:` 两行能直接看出 `diorama.toml` 是否生效。其它：`diorama-beta ls`、`diorama-beta stop [dir]`（缺省停当前目录）、`diorama-beta gateway start|stop|status|restart`、`diorama-beta restart <dir>`。
- **两个入口、两条通道**：`bin/diorama`（发布名）与 `bin/diorama-beta`（`DIORAMA_CHANNEL=beta`，link 进来的 checkout 用）。beta 的 socket/pid/日志都带 `-beta`，所以与已安装的 `diorama` 可以并存；`link.sh` 只创建 `diorama-beta`。e2e 一律走 `diorama-beta`。
- **测试隔离**：e2e 每个用例用自己的 `DIORAMA_HOME`（临时目录）与自己的 gateway；不要把测试指向真实的 `~/.diorama`。
