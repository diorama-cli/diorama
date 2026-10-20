# AGENTS.md

> 给在本仓库里工作的 agent（以及新加入的人）。读完这一页再改代码。
> 只写**每次都要知道的事实**，不写流程叙事；细节在链接的文档里。

## 1. 先读什么

| 顺序 | 文档 | 读它为了 |
|---|---|---|
| 1 | [docs/contract.md](docs/contract.md) | **能不能**：内核与插件的唯一约定，带版本号（当前 **v0.6**）。改任何 `ctx.*` / slot 签名都算改契约 |
| 2 | [docs/architecture.md](docs/architecture.md) | **为什么**：已拍板的决定、放弃项、代价。不要重新讨论已拍板的事 |
| 3 | [docs/features.md](docs/features.md) | **有什么**：能力清单与档位（✅ / v1 / 未来 / 不做） |
| 4 | 最近一档的 `docs/mN/spec.md` | **怎么实现的** + **§6.2 的坑**（见下面 §5） |

`docs/plan.md` 是**阶段性排期**，会退役；不要把它当长期真源，也不要在新代码里引用它。
一次会话的最小读法：`contract.md` 目录 → `features.md` 表 → 最近 spec 的「坑」一节。

## 2. 文档分工（写文档时按这个分）

- **契约**回答"能不能"，**架构**回答"为什么"，**features** 回答"有什么"，**spec** 回答"当时怎么做的"。
- 不要用里程碑编号（M1/M2/M4）作为**长期引用**。契约与架构里写"未排期""v1 之外"，不写"M4"——排期会变，能力不会。
- 契约变更 = 升 `contract` 版本 + 更新内置插件 manifest 的 `contract` 范围 + 在 `contract.md` §13 记一条变更。

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
packages/ui/              页面渲染原语（Slot、useKernel、useStore、错误边界、样式）
packages/cli/             命令行：参数、diorama.toml 合成、服务端插件树装配
apps/web/                 页面壳（Vite）+ Playwright e2e（tests/）
docs/                     契约、架构、能力、排期、逐档 spec
```

### 内核里改哪里

| 要改的东西 | 文件 |
|---|---|
| `ctx.fs` 语义、错误码、watch | `kernel/src/server/fs.ts`、`kernel/src/client/fs.ts` |
| 忽略规则（`ignore`） | `kernel/src/shared/ignore.ts` |
| RPC 帧、订阅端点、session | `kernel/src/shared/rpc.ts`、`server/rpc.ts`、`client/rpc.ts` |
| `ctx.commands`、键记法、按键分发 | `kernel/src/client/commands.ts`、`client/boot.ts` |
| `ctx.tabs` / `ctx.tree` | `kernel/src/client/tabs.ts`、`client/tree.ts` |
| `ctx.git`（仓库探测、status/diff/log/show/showCommit/blob、上限） | `kernel/src/server/git.ts`、`kernel/src/shared/types.ts`、`kernel/src/client/git.ts` |
| `ctx.fs` 的大小上限（两端共用一个数） | `kernel/src/shared/limits.ts` |
| `ctx.router`（`/~/` URL 与活动 tab） | `kernel/src/client/router.ts`、`kernel/src/server/http.ts`（`/~/` 回壳） |
| 插件图、boot 顺序、`settle`、mount fork / `onMount` | `kernel/src/server/plugins.ts`、`client/boot.ts`、`server/plan.ts` |
| gateway 的 mount 表、端口、degraded 状态机 | `kernel/src/server/gateway.ts` |
| 控制面协议（帧、方法、错误码） | `kernel/src/shared/control.ts`、`kernel/src/server/control.ts` |
| CLI 子命令、`ls` 表格、后台 gateway | `cli/src/main.ts`、`cli/src/control-client.ts`、`cli/src/gateway.ts`、`cli/src/gateway-command.ts` |
| `diorama.toml` | `kernel/src/server/config.ts` |
| 契约版本 | `kernel/src/contract.ts`（**只在这里改**） |

### 加一个内置插件：7 处要一起改

1. `packages/plugins/<id>/` 新包：`package.json`（`diorama.id` / `contract: ">=0.6 <0.7"` / `client.entry` / `requires`）、`vite.config.ts`、`tsconfig.json`、`tsconfig.emit.json`（从任意现有插件复制）。
2. `packages/kernel/src/server/plan.ts` 的 `BUILTIN_PLUGIN_IDS`（顺序 = boot 顺序）。
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
| `node --test` 报 `ERR_UNKNOWN_FILE_EXTENSION: .tsx` | Node 不认 `.tsx` | 单测只导入 `.ts`；把要测的纯函数从组件文件里拆出来（m4/spec §12）|
| 「找不到成员 `mountCtx`」/ props 里还有 `bytes` | `FileRendererProps` 曾在内核与 slots 各有一份且漂移 | 只有内核一份；slots re-export 它。`export type {X} from` 后同文件不能再用 `X` |
| e2e 里快捷键不生效（mac 上写 `Control+Alt+x`） | `mod` 在 macOS 上是 Meta | 测试用 `MOD = darwin ? 'Meta' : 'Control'`；别用裸 `Control` |
| 提交详情不出现在右侧 | 提交不是 tab，不进 `tabs.content` | `tabs` 声明 `seats.git-commit`，hash 里有 `history=<sha>` 时改画它；tab 仍然挂载 |

## 6. 边界（不要越过的线）

- **只读**：`ctx.fs` / `ctx.git` 不提供写接口；被浏览的目录永远不写。
- **文件访问只能走 `ctx.fs`**，插件里禁止 `import 'node:fs'` / `'node:fs/promises'`。
- **外部插件**（`~/.diorama/plugins`、npm source、zod 运行时校验）推迟到 v1 之外，契约位在 `contract.md §9`；不要顺手实现。
- **`TabInfo` 只带 `{ id, path }`**，不带 `FileInfo` 快照——内容由内容区自己 `stat`/读。单 tab 语义已废弃。
- **`ctx.commands` 是内核服务**，palette 只是它的一个消费面；不要给命令另开第二套注册表或第二个 keydown 监听。
- **默认只监听 loopback**；`host` 只能由 `diorama.toml` / `--host` 显式放宽。

## 7. 提交与验证纪律

- 一个能力一块提交，提交信息写清"做了什么 + 为什么"。
- 每块完成前跑 §3 四件套；**M0/M1 的验收用例必须保持绿**（它们是多 tab / 命令 / watch 改动的回归）。
- 契约或座位类型变了：同步 `contract.md`（含 §13）与 `docs/features.md` 的档位。
- 演示脚本：`node packages/cli/bin/diorama-beta <dir>`（或 `./link.sh` 后直接用 `diorama-beta`）。短命 CLI：确保 gateway → 挂载 → 打印 URL；输出里的 `config:` 与 `hidden:` 两行能直接看出 `diorama.toml` 是否生效。其它：`diorama-beta ls`、`diorama-beta gateway start|stop|status|restart`、`diorama-beta restart <dir>`。
- **两个入口、两条通道**：`bin/diorama`（发布名）与 `bin/diorama-beta`（`DIORAMA_CHANNEL=beta`，link 进来的 checkout 用）。beta 的 socket/pid/日志都带 `-beta`，所以与已安装的 `diorama` 可以并存；`link.sh` 只创建 `diorama-beta`。e2e 一律走 `diorama-beta`。
- **测试隔离**：e2e 每个用例用自己的 `DIORAMA_HOME`（临时目录）与自己的 gateway；不要把测试指向真实的 `~/.diorama`。
