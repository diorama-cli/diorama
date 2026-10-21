# 实施说明：挂载输出为 JSON（`diorama [dir] --json`）

> 记录于 2026-10-21。用户要求：**加参数控制 diorama 在目录启动后输出 JSON，方便其它程序调用后
> 获取 URL**。契约不升号（§6）：只加 CLI 的输出形态，`ctx.*` / slot / RPC / 控制面协议一律不动。
> 新增条款是 contract.md **§7.6** 的「`--json`」一段，变更清单在 **§21**。

## 1. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 开关叫什么 | **`--json`** | 与 `diorama ls --json`、`config show --json` 同一个词、同一个含义（「同一次回答，机器可读」）。另起 `--format json` / `--machine` 会让三个地方各说一套 |
| 输出几个文档 | **一个**，stdout 只有它 | 调用方要的是「读一行、解析、拿 URL」。混排人类可读的行，就得让每个调用方再写一遍「哪一行才是 JSON」 |
| 顶层字段 | `url` / `root` / `mountId` / `created` + **完整** `mount` | 顶层四个键是脚本真正会用的（尤其 `url`），`mount` 是控制面 `MountStatus` 原文——需要端口、状态、配置来源、插件清单的人不必再看 `ls --json`，而 CLI 也不必发明第二套字段名 |
| 失败时 stdout | **空** | 「stdout 上有东西 = 挂载成功」是最省事的判据。错误走 stderr 与既有退出码（§7.6 的表一个都没变） |
| `pluginFailures` | 进文档，退出码仍 1 | 人类可读形式把它写进 stderr；机器调用方同样该知道「起来了，但某个插件坏了」。与 `already mounted` 不同，它不是成功路径的常态 |
| `restart --json` | 也支持，另加 `remounted` | 「重启后拿到新 URL」是同一个需求；`remounted` 补上人类可读形式里 `A → B` 那半句 |
| `--foreground` + `--json` | **允许** | 前台模式本来就永不退出，多打印一个文档不改变它的语义；包一层的调用方读第一行、自己管子进程，是正常用法。第一版选了「互斥」，实测发现它否掉的正是最需要 JSON 的场景（容器/编辑器里拉一个前台服务） |
| 默认输出 | **一个字节都不动** | 五行文本是 §7.6 的既有条款，e2e 与用户脚本都在抓它 |
| 实现位置 | 新模块 `cli/src/mount-output.ts`（两个纯函数） | 短命路径（`main.ts`）与前台路径（`run.ts`）都要打印同一个东西；两处各写一遍就是两份会漂移的真源。纯函数也让它能单测，不必起 gateway |

## 2. 语义细则

- **`--json` 是挂载路径的选项**，与 `--dump-config` / `--dump-plan` 一样由 `parseArgs` 解析；
  `diorama ls --json` 早就存在，形状不变（`{ running, gateway, mounts }`）。
- **`created`**：`true` = 这次调用挂上了目录；`false` = 目录本来就在（幂等命中，§7.3），
  此时 `url` 是**已有** mount 的地址。与人类可读形式的 `already mounted (…)` 同义。
- **`mount`** 是 gateway 的回答原样（含 `since`、`state`、`configFile`、`hidden`），
  不裁剪、不改名——它是 §7.3 的契约形状，CLI 只是转述。
- **前台模式**（`run.ts`）也认 `--json`：打印同一个文档，随后照常前台等待信号、不退出。
  `run.ts` 的 `main` 在不带 `--foreground` 时仍是 `--dump-config` / `--dump-plan` 的入口，
  所以它那边同样用这两个纯函数打印，避免第二份五行文本。
- **`remounted`**：`restart` 先 `unmount` 再 `mount`；`remounted` 是**被卸下的** mountId
  （原来就没有 mount 时为 `null`，对应人类可读形式的 `(none)`）。
- **退出码**：成功 0；插件故障 1；参数 / 目录 / 配置错 2；连不上 1——与 §7.6 的表逐条一致。

## 3. 改动清单

| 包 | 改动 |
|---|---|
| `cli/src/mount-output.ts` | 新文件：`MountOutput`、`mountLines`（五行文本，含 `already mounted`）、`mountDocument`（JSON 文档） |
| `cli/src/main.ts` | `--json` 帮助行；`restart` 的 JSON 分支（`remounted`）；`printMount` 改为调用上面两个纯函数（前台路径同样带 `json`） |
| `cli/src/run.ts` | `CliOptions.json` + `parseArgs` 识别 `--json`；前台打印改用同一对纯函数（构造与 `MountStatus` 同形的对象） |
| `cli/test/mount-output.test.ts` | 新文件 8 条：五行顺序与内容、`hidden` 为空时省略、`already mounted`、`plugins: (none)`、JSON 顶层键、`pluginFailures` 只在有故障时出现、`created: false`、单行可往返 |
| `apps/web/tests/m11-mount-json.spec.ts` | 新文件 5 条 e2e：文档里的 URL 真能服务（`/plugin.json` 的 mountId 对得上）、与 `ls --json` 一致、重复挂载 `created: false`、`restart` 的 `remounted`、默认五行不变、`--foreground --json` 打印后仍在服务、坏目录 stdout 为空 |
| `docs/contract.md` | §7.6 补「`--json`」一段；新 §21 变更清单 |
| `docs/features.md` | CLI 表加 C11；C8 的测试计数更新 |
| `README.md` | 选项表加 `--json`，新增「给其它程序用：`--json`」小节；测试计数更新 |

## 4. 验证

1. `pnpm test:unit`：241 条全绿（233 旧 + 8 新）。
2. `pnpm -r --no-sort run typecheck` 全绿。
3. `pnpm build` 后 `playwright test`：108 条全绿（103 旧 + 5 新；老的 22 个 spec 无一改动）。
4. 手工：`diorama-beta . --json | jq -r .url`；`diorama-beta . --json --foreground`（打印后保持运行）；
   `diorama-beta restart . --json` 的 `remounted` 等于上一次的 `mountId`。

## 5. 踩到的坑

1. **「互斥」是错的，而且第一次还写错了位置**：第一版规定 `--json` 与 `--foreground` 互斥，检查却
   写进了 `mountCommand`——`--foreground` 在 `main` 里更早分发，根本走不到那里，e2e 表现为
   **30 秒超时**（前台模式正常启动、正常打印、然后一直活着）而不是断言失败。想清楚之后结论变了：
   前台模式**本来就**不退出，打印文档不改变这一点，而「在容器里拉一个前台服务并读出 URL」正是
   最需要 JSON 的场景。现在两者可以同用，前台路径走 `run.ts` 自己的打印（同一个纯函数）。
2. **前台路径的 `MountStatus` 要自己造**：`run.ts` 不走控制面，手上只有 `port` / `mountId` /
  `config`，没有 gateway 的 `MountStatus`。要么让两条路径各写一份 JSON（会漂移），要么在
  前台那边构造同形对象、两边共用 `mountDocument`。选后者；`state` 填 `'ok'`（`listen` 成功之后
   才打印），`since` 填打印时刻。
3. **`io.out` 会给每条消息补换行**：JSON 文档必须一次写完（`JSON.stringify(...)` 无缩进、
   单行），否则调用方按行读到的第一行只有 `{`。单测里直接断言「输出里没有 `\n`」。
4. **`restart` 的 `--json` 要放在卸载之后**：`remounted` 用的是 `unmount` 的回答；把 JSON 分支
   写在 `mount` 之后、`unmount` 之前，拿到的是上一轮的 `''`。

## 6. 边界与以后

- **不做**：`--format yaml`、`--quiet`、`--output <file>`。JSON 已经覆盖「给程序用」，其余是
  调用方 `jq` / 重定向就能做的事。
- **不做**：让 `--json` 跟着 `gateway run` 走（那是个常驻进程，它的「挂载」要等控制面来）。
- **以后**：`diorama ls --watch`（§7.3 的事件已定）落地时，事件帧与 `--json` 的 `mount` 字段
  应当同形——`MountStatus` 已经是同一个类型，只要别在 CLI 侧重新发明字段名。
