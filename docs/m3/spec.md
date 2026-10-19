# M3 实施说明（gateway 化）

> 记录于 2026-10-19。契约以 [contract.md](../contract.md) **v0.4** 为准，本文只记 M3 的
> **范围、顺序、实现形态与验收**，不重复契约内容（条款编号指向 contract.md）。
> 开工前用户逐条拍板：推荐值全采纳；配置文件**沿用 TOML**（`~/.diorama/diorama.toml`），
> socket 定名 `~/.diorama/diorama.sock`，`diorama ls` **不做 `--watch`** 但**必须输出 URL**。

## 1. 范围（五块）

| 块 | 契约条款 | 主要落点 |
|---|---|---|
| 进程模型 | §7、§11（architecture §10） | `cli/src/gateway/*`（常驻进程）、`kernel/src/server/gateway/*`（mount 表） |
| 多目录 / fork | §2.5、§3.5 | `kernel/src/server/plugins.ts`（root ctx 只建一次）、`kernel/src/server/gateway/*` |
| 命令 | §7.3–§7.6 | `cli/src/commands/ls.ts`、`cli/src/commands/gateway.ts`、`cli/src/main.ts` |
| 隔离 / degraded | §11.1 | RPC/HTTP 边界的归因、mount 状态机、页面横幅 |
| watch 共享 | §3.1、§4.1 | `kernel/src/server/fs.ts`（共享 + 引用计数 + 上限） |

不碰：外部插件（`~/.diorama/plugins`、npm source、zod 运行时校验）、`ctx.git`、`ctx.layout`。

## 2. 依赖与实施顺序

依赖边：

1. **契约 v0.4 → 所有步骤**：manifest 范围与 `CONTRACT_VERSION` 一起升，否则 boot 被拒。
2. **控制面库 → gateway**：mount 表只能经控制面到达。
3. **fork 语义 → watch 共享 / degraded**：两者都需要“mount 内唯一的服务实例”。
4. **gateway 骨架 → CLI 迁移**：e2e 的 33 条全部依赖启动方式。

| 步 | 内容 | 结束时的验收 |
|---|---|---|
| **S0** | contract v0.4 + 本文 + `CONTRACT_VERSION`/manifest 范围 | 文档；四件套全绿（无代码行为变化） |
| **S1** | 控制面库：NDJSON 帧、请求/响应配对、错误码、客户端封装、单行上限；最小 `ping` server | 单测：帧往返、错误码、并发/乱序、超限断连、连接关闭 |
| **S2** | gateway 进程骨架：root ctx 只建一次、mount 表、每 mount 一个 HTTP 端口；`mount`/`unmount`/`list`/`ping` | 手工演示：一个 gateway 挂两个目录，**两个端口各打开一个可用页面** |
| **S3** | `ctx.fork()` 生命周期：子 ctx、`mountId`/`fs` 只在子 ctx、卸载四步顺序、`onMount` 时机 | 单测：两 mount 两份 `FsService`、root 读 `ctx.fs` 抛错、卸载后回调不再触发 |
| **S3b** | watch 共享 + `watch.maxDirectories` | 单测：同 path 共享一个守卫、最后一个订阅释放即关、超限 no-op + warn、跨 mount 不串 |
| **S4** | `diorama ls`（含 URL、`--json`）、`gateway start/stop/status/restart`、`diorama restart <mount>` | e2e：CLI 退出码表（§7.6）、`ls` 表格、stop 幂等、status 未运行 = 1 |
| **S5** | degraded：RPC/HTTP/fiber 错误归因、自动重启一次、页面横幅、`mount.state` 广播、`ls` 显示 degraded | e2e：A degraded 时 B 仍正常；恢复后横幅消失 |
| **S6** | CLI 迁到 gateway（默认）、`--foreground` 保留；e2e 支持层改为“每测试一个 `DIORAMA_HOME` + gateway” | 四件套全绿，M0/M1/M2 用例断言不变 |
| **S7** | 文档收尾：features.md 档位、本文 §6 实现记录、plan.md 勾掉 M3 | 四件套全绿 |

每步结束跑（AGENTS.md §3）：

```bash
pnpm build
pnpm test:unit
pnpm -r --no-sort run typecheck
pnpm --filter diorama-web exec playwright test
```

## 3. 实现形态（契约之外的具体选择）

| 项 | 选择 | 理由 |
|---|---|---|
| 控制面服务端 | `node:net` + 自写 NDJSON 分帧 | 帧极简，不引依赖；与 RPC 的 WebSocket 分开 |
| 控制面客户端 | `net.connect` + 行缓冲 | 同上 |
| gateway 进程入口 | `diorama gateway run`（内部命令，前台运行，被 `start` 拉起或 `--foreground` 直接调用） | 测试可前台跑、日志可观察 |
| mount ctx | `root.isolate(mountId)` | Cordis 现成的 fork 语义（§2.5 写“fork 出的子 ctx”） |
| 端口重试 | 随机端口被占重试 20 次；显式端口直接 `EADDRINUSE` | §7.3 |
| 失败归因 | `AsyncLocalStorage` 在 RPC/HTTP 处理期间标出 mountId；fiber 错误按 mount 子树归因 | §11 |
| watch 共享 | mount 内 `Map<path, WatcherEntry>` + 引用计数 | §3.1 |
| 页面横幅 | 壳读 `/plugin.json` 的 `state`，并订阅 RPC `mount.state` 广播 | 不改 slot 面 |

## 4. 验收（M3 演示脚本）

1. `diorama gateway start` → `diorama <dirA>`、`diorama <dirB>` 各打印 URL；
2. `diorama ls` 列出两个目录及各自 URL；两个页面各自可用；
3. `diorama <dirA>` 再次执行 → 打印 `already mounted` 与同一 URL；
4. 改盘上文件 → 两个页面各自刷新，互不串；
5. `diorama gateway status` / `restart` / `stop`；`stop` 后 `ls` 说未运行；
6. 人为让 dirA 的插件抛异步错误 → dirA 页头横幅、`ls` 显示 degraded、dirB 不受影响；
7. `diorama restart <dirA>` 恢复；
8. M0 5 条、M1 7 条、M2 21 条仍全绿。

## 5. 风险与已知取舍

- **启动竞态不追求并发正确性**（用户明确暂缓）：bind 成功者胜出 + CLI 重试连接。
- **gateway 单点**：进程级崩溃带走所有目录（architecture §10 的代价）；supervisor 不做（O6）。
- **不持久化**：gateway 重启后 URL 全失效，`diorama ls` 为空。
- **e2e 隔离**：测试用临时 `DIORAMA_HOME` 起自己的 gateway，避免共享 `~/.diorama`。
- **`DIORAMA_HOME` 语义收窄**：不再兼作 web 资源目录；现有 e2e 不依赖它（已确认）。

## 6. 实现记录（2026-10-19，M3 落地后）

### 6.1 验收结果

```
pnpm test:unit                                   # 92 passed
pnpm -r --no-sort run typecheck                  # clean
pnpm --filter diorama-web exec playwright test   # 49 passed
```

| 用例文件 | 覆盖 |
|---|---|
| `m0-acceptance`（5） | 原 5 条；启动方式改为“短命 CLI + 独立 gateway” |
| `m1-acceptance`（7） | matcher、回退链、RPC、不卡死 |
| `m2-*`（21） | 配置、树、多 tab、命令、palette、watch、服务端半边（`--foreground` 读控制台） |
| `m3-gateway`（6） | 两目录两端口、各自页面互不串、幂等挂载、`ENOTDIR`、卸载一个不影响另一个、两页面共享目录监听 |
| `m3-cli`（6） | 退出码（`ls` 0 / `status` 1 / `stop` 0）、`ls` 表格含 URL、`--json`、start 幂等、`restart` 换 URL、全局 toml、`gateway restart` 不保留挂载 |
| `m3-degraded`（4） | 横幅只出现在受影响的页面、邻居不受影响、自动重启一次（新 id/端口）、不重启风暴、测试钩子默认关闭 |

单测：控制面 11（帧、错误码、乱序、订阅、行缓冲边界）、gateway 10（端口/幂等/卸载顺序/
degraded 状态机/一次重启）、fork 8（apply 一次、每 mount 服务、卸载顺序、隔离回归）、
watch 9（窗口合并、共享、上限、跨 mount 不串）、config 7；其余沿用 M2。

### 6.2 踩到的坑（按症状查）

1. **`isolate(name)` 不能共享标签。** Cordis 的 `isolate(name, label)` 按 **label** 在
   shadow 表里登记符号；不传 label 时默认 `Symbol(name)`，**所有 mount 拿到同一个 isolate
   key**，第一个 `provide` 占槽位，卸载任一 mount 会把所有 mount 的同名服务一起注销。
   每个 mount 必须 `isolate('fs', Symbol(mountId))`。
2. **`provide` 属于 fiber 生命周期。** `ctx.provide()` 是 fiber effect：只有把 `provide`
   放在该 mount **自己的 plugin fiber**（`ctx.plugin({...})`）里，`fiber.dispose()` 才只回滚
   这个 mount。在共享 fiber 上 `provide`，卸载一个 mount 会清掉兄弟 mount 的服务
   （e2e `2e` 抓到的）。`ctx.plugin()` 的返回值是 **Fiber**，清理用 `fiber.dispose()`，
   读它提供的服务要先 `await fiber.await?.()`。
3. **`mountId` 是记录，不是服务。** `provide('mountId', …)` 在第二次挂载同一 isolate 时报
   `service "mountId" has been registered`；用 `Object.defineProperty` 设普通属性。
4. **`dispatcher.services` 别与服务表闭包重名。** `withSubscriptions(createDispatcher(f), f)`
   里第二个参数同名时，`{...dispatcher}` 展开会把 `services` 方法覆盖成服务表，症状是
   RPC 报 `ESERVICE: no service "fs" on this mount`。
5. **CLI 的 tsdown 入口是 `src/main.ts`**（原来写的是 `src/run.ts`），改错入口子命令不会进包。
6. **`DIORAMA_HOME` 不再兼作 web 资源目录**（契约 §4.1 v0.4）：资源来自包的 `web/` 或
   `apps/web/dist`，否则 gateway 起出来的页面 404。
7. **随机端口只能在 bind 之后知道。** manifest（`/plugin.json`）要带真实 URL，所以顺序是：
   探测空闲端口 → boot fork（拿到 dispatcher）→ 建 server（manifest 带最终 URL）→ listen。
   端口竞争按契约 §7.3 的“bind 成功者胜出 + 重试”处理。
8. **watch 只在 mount 内共享**：key 是 `resolveInside` 之后的绝对目录；跨 mount 不共享
   （计划风险清单“M3 时验证”已用单测与 e2e `2f` 固定）。上限超限时 no-op + 只 warn 一次。
9. **macOS 的旧写入会延迟上报**：测试里先建文件再挂 watch，可能收到属于 fixture 创建期的
   事件；跨 mount 断言前先等待稳定（单测里的 `150ms`）。
10. **degraded 的验收需要一个故障源**：控制面加了 `fail` 测试钩子（仅
    `DIORAMA_TEST_HOOKS=1`）。真实的归因路径见 §6.4。

### 6.3 与契约的对应

| 契约 | 实现位置 |
|---|---|
| §7.1–§7.3 控制面（NDJSON、方法、`MountStatus`、错误码） | `kernel/src/shared/control.ts`、`kernel/src/server/control.ts`、`cli/src/gateway.ts` |
| §7.4 后台进程、pid、日志、陈旧 socket、`stop`/`restart` | `cli/src/control-client.ts`、`cli/src/gateway-command.ts` |
| §7.5 `--foreground` | `cli/src/main.ts` |
| §7.6 退出码与 `ls` 输出 | `cli/src/main.ts`、`cli/src/control-client.ts` |
| §2.5 一个 mount = 一个 fork 子 ctx；卸载四步；`onMount` 时机 | `kernel/src/server/plugins.ts`（`createPluginHost` / `forkMount`）、`kernel/src/server/gateway.ts` |
| §3.1 watch 共享与 `maxDirectories` | `kernel/src/server/fs.ts` |
| §3.5 `MountInfo`、`mounts.list()` | `kernel/src/server/plugins.ts` |
| §4.1 配置在 CLI 侧合成、`/plugin.json` 带 `state`/`lastError` | `cli/src/main.ts`、`cli/src/gateway.ts`、`kernel/src/server/plan.ts` |
| §11 / §11.1 degraded | `kernel/src/server/gateway.ts`、`cli/src/gateway.ts`、`ui/src/root.tsx`、`apps/web/src/main.tsx` |
| §14 contract 0.4 | `kernel/src/contract.ts`、全部内置插件 manifest |

### 6.4 degraded 的触发与验收

契约 §11.1 定义三种触发：mount 内的 RPC/订阅/HTTP 抛错、`onMount` 回调抛错、无法归因的
进程错误。实现里的归因：

- `guardedDispatcher`：mount 内被拒绝的 RPC 调用与订阅回调错误归到该 mount（协议错误
  `EMETHOD`/`ESERVICE`/`EBADREQUEST` 不算）；随后成功的调用让它回到 `ok`。
- `onMountFailure`：服务插件在 `onMount` 里的抛错归到该 mount。
- 进程级 `uncaughtException` / `unhandledRejection`：只标 gateway 级 degraded 并记日志。

为了让 degraded **可验收**，控制面增加测试钩子 `fail { mountId, message? }`：立即让该 mount
进入 degraded 并广播 `mount.state`；**仅当 `DIORAMA_TEST_HOOKS=1`** 时存在，否则 `EMETHOD`
（e2e `6d` 守这条）。生产默认不可用。

### 6.5 遗留与取舍

- **前台单进程模式**：保留为 `--foreground`（gateway 在 CLI 进程内跑，同样建 socket），
  M2 的演示脚本照旧；生产默认走后台 gateway。
- **启动竞态**：按用户早前的决定（v0.1 §7）不追求并发正确性——socket `bind` 成功者胜出、
  CLI 重试连接；陈旧 socket 文件只在 `ping` 无响应时清理。
- **gateway 单点**：进程崩溃带走所有目录（architecture §10 的代价）；supervisor 不做（O6）。
- **`events` 订阅**：协议已实现，v1 没有 CLI 消费者（`ls` 不做 `--watch`）。
- **degraded 的页面横幅**是壳的一部分（`diorama-ui` 的 `DioramaRoot` 接收 `health`），
  不进 slot 面。
