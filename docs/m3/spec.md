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

## 6. 实现记录

（每步完成后追加：验收结果、踩到的坑、与契约的对应。）
