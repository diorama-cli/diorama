# 实施说明：命令行交互式配置（`diorama config`）

> 记录于 2026-10-21。用户要求：**支持命令行交互式配置，以及把命令行参数写进配置**。
> 契约不升号（§6）：本档只加 CLI 行为，`ctx.*` / slot / RPC / 控制面协议一律不动。
> 新增条款是 contract.md **§4.2**，变更清单在 **§20**。

## 1. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 一个子命令还是四个？ | **一个 `config`，四个形态**：无参数 = 向导，`show` / `set` / `unset` | 「配置」是同一个对象（一份 TOML）的四个动作；分成 `configure` / `config-get` / `config-set` 会让帮助文本与发现成本翻倍 |
| 写到哪 | **默认 `$DIORAMA_HOME/diorama.toml`**；`--dir <dir>` 或 `--config <path>` 才写项目文件 | 浏览是只读的（architecture §8、AGENTS §6）。「当前目录」是最容易让人以为安全的那个默认值，而它恰好会往被浏览的目录里写 |
| 写文件的方式 | **读-改-写**：读旧文件 → 只改点名的键 → 校验 → 整体写 | `set --port 8080` 不该把别人的 `ignore` 抹掉；而「校验后再写」保证编辑器不会产出读者会拒绝的文件 |
| 未指定的键 | **不写进文件**（文件只说选过的） | 否则 `config set --port 8080` 会把 16 个插件、watch 三个默认值一起冻进文件，日后改默认值就影响不到这个用户 |
| 空数组 | **保留**（`ignore = []` / `plugins = []`） | §4.1 明说 `ignore = []` 是「不隐藏任何东西」；丢掉它会把语义反转成「隐藏 .git」 |
| 交互式在哪 | **CLI 里一段纯函数 `runWizard(file, ask)`** + 一个 `streamPrompter` | 向导的逻辑（问什么、回车/`-` 的语义、不合法重问）与终端解耦，单测不需要 PTY |
| 值语法 | **CLI 与向导共用 `parseConfigValue`** | 两种入口写出不一样的值 = 两个真源；共用之后 `--port 70000` 与向导里敲 `70000` 报同一句话 |
| 拒绝的写法 | **`set` 不认识位置参数**；未知键列出已知键；**每个子命令只接受它用得上的 flag** | 把 `diorama config set port 8080`（少了 `--`）当成功，是最坏的静默错误；`show --dry-run` 这种「看起来有意义、其实什么都不做」的 flag 也一样 |
| 写完要不要重启 | **不重启** | 正在跑的 mount 用旧配置是 §11.1 已定的语义（`diorama restart <dir>` 才重载）；CLI 顺手重启一个用户没点名的 mount 更意外 |
| `--save`（`diorama <dir> … --save`） | **不做** | 见 §6：它要把「没给的值」与「给了默认值」再区分一次，而 `config set` 已经覆盖了同一个需求 |

## 2. 语义细则

- **读的一半就是服务的那一半**：`config show` 调 `resolveConfig`（目录 → `$DIORAMA_HOME` → 默认），
  与 `--dump-config`、`diorama <dir>` 逐字同源；`--json` 的输出形状也与 `--dump-config` 相同
  （`{ config, configFile }`，没有文件时 `configFile: null`）。
- **`--dir` 先 realpath**：与挂载键同一条规则（§4.1 的「realpath 挂载键」），所以 `config set --dir
  ./proj` 与 `diorama ./proj` 指向同一个文件。
- **向导的提示**：`  port [4000] (file, 0 = a free port): `——方括号里是**当前值**（文件里的，
  否则默认值），圆括号先说来源（`file` / `default`）再说含义。长列表（`plugins` 16 项）显示为
  `16 items`，否则答案会被挤到下一行，看不出在回答哪一项。
- **`-` 的语义**：清除该字段（回到默认）。字段本来就不在文件里时提示 `already the default`，
  且**不算改动**——不然「全部回车 + 一个 `-`」会写出一份和原来一模一样的文件。
- **确认**：`write this file? [Y/n]`，空回车 = 写。`--yes` 跳过确认，`--dry-run` 只预览。
- **stdin 提前结束**（`diorama config < /dev/null`）= 退出码 2，**不写**。这是有意与「一路回车」
  区分开：没有终端却静默写文件是最坏的结果。`streamPrompter` 因此不用 `readline/promises`
  ——那个 API 在流结束时既不 resolve 也不 reject。
- **写盘**：`mkdir -p` 父目录；`writeFileSync` 整体写（TOML 很小，不需要流式）；读旧文件失败
  （`invalid TOML` / `unknown key`）→ 报原文、退出 2、**原文件不动**。
- **成功输出**：`wrote <path>`；全删光时 `wrote <path> (no settings left: everything is default)`。
- **退出码**：与 §7.6 一致——成功 0，用法错误 / 文件写错 / 目录不可读 2。`config` 系列**不连
  gateway**，gateway 没在跑也能改配置。

## 3. 改动清单

| 包 | 改动 |
|---|---|
| `kernel/src/server/config.ts` | 新增写入原语：`CONFIG_KEYS` / `WATCH_CONFIG_KEYS` / `ConfigPatch`、`readConfigValue`、`patchFileConfig`（`undefined` = 删键，结果过 `validateFileConfig`）、`knownKeys`、`formatFileConfig`（固定键序、空表不写、空数组保留）、`readFileConfig`（缺文件 = 空配置）、`writeFileConfig`（`mkdir -p` + 注入式写盘）、`configWritePath`（默认 `$DIORAMA_HOME`） |
| `kernel/src/server/index.ts` | 导出上述符号与两个键表类型 |
| `cli/src/config-command.ts` | 新文件：`parseConfigValue` / `parseList` / `displayValue`、`runWizard`、`streamPrompter`、四个子命令与 `configUsage`；`UsageError` |
| `cli/src/main.ts` | 路由 `config`；`controlUsage` 加一行；`diorama help` 打印控制面用法 |
| `kernel/test/config.test.ts` | +8 条：patch 只动点名的键、`undefined` 删键、校验与未知键、写出的键序与回读、`mkdir` 与写失败、缺文件/坏文件、写入位置、写完能被 `resolveConfig` 读到 |
| `cli/test/config-command.test.ts` | 新文件 17 条：值语法（列表/整数/布尔/未知键）、`displayValue`、向导（回车/替换/清除/重问/提前结束/提示形态）、`streamPrompter`（CRLF、末行无换行、结束后 `undefined`）、`set`/`unset`/`--dir`/`--config`/`--dry-run`/用法错误/`show` |
| `apps/web/tests/m10-config.spec.ts` | 新文件 7 条 e2e：写项目文件并被 `--dump-config` 与 `/plugin.json` 读到、默认写 `$DIORAMA_HOME` 且不碰被浏览目录、`unset` 清空文件、向导逐项问答、拒绝/提前结束不写、坏文件不被覆盖、独立进程写盘可见 |
| `docs/contract.md` | 新 §4.2、§7.6 补一段、新 §20 变更清单 |
| `docs/features.md` | CLI 表加 C10 |
| `README.md` | 命令表加 `config`，新增「改配置」小节 |

## 4. 验证

1. `pnpm test:unit`：新增 25 条（kernel 8 + cli 17）。
2. `pnpm -r --no-sort run typecheck` 全绿。
3. `pnpm build` 后 `playwright test`：新增 `m10-config.spec.ts` 7 条；老的 20 个 spec 不动。
4. 手工：`diorama-beta config`（真终端）、`config < /dev/null`（退出 2）、
   `config set --dir . --port 8080` 后 `diorama-beta . --dump-config` 能看到 8080。

## 5. 踩到的坑

1. **`smol-toml` 的 `stringify` 末尾已经带换行**：再拼一个 `\n` 会写出结尾空行，测试按字节
   比对时一眼看不出（`port = 1\n\n` vs `port = 1\n`）。写盘前统一 `replace(/\n+$/, '') + '\n'`。
2. **`execFile` 没有 `input` 选项**：用 `promisify(execFile)` 喂 stdin 是**静默无效**的——子进程的
   stdin 继承测试进程，向导一直等，e2e 表现为 30s 超时而不是断言失败。给向导写 e2e 要用
   `spawn` + `child.stdin.end(input)`。
3. **每个子命令的 flag 集合要显式列**：一开始 `--json` / `--dry-run` / `--all` 对所有动词都收，
   于是 `config show --dry-run` 静默成功。改成 `VERB_FLAGS` 白名单后，不适用就是退出码 2 并列出
   该动词接受的 flag。
4. **`--dir` 写在子命令前面**：`diorama config --dir x` 里 `--dir` 落在 argv[0]，如果按「第一个词
   就是子命令」分发，会报 `unknown config command "--dir"`。分发要允许第一个词以 `-` 开头（那就是
   向导的选项）。
5. **空文件不是没有文件**：`unset` 掉最后一个键后文件仍在（0 字节），`config show` 会显示
   `config file: <path>` 而**不是** `none (defaults)`——后者只表示「三个查找位置都没有文件」。
   测试断言要按这个语义写。
6. **`diorama <dir>` 只在 `ignore` 非空时打印 `hidden:`**：想验证「写进去的 ignore 生效」，别抓
   CLI 的那行输出，直接看 `ls --json` 或 `/plugin.json` 的 `config`。
7. **`realpath` 在 macOS 上是 `/private/var/...`**：`config show` 报的路径与被服务的目录都过
   realpath，测试里比较路径要用 `directory.realRoot`（或 `realpathSync`），否则永远差一层。

## 6. 边界与以后

- **不做**：`diorama <dir> --save`（「把这次命令行参数写进配置」）。理由：`set` 已经能表达同一件事，
  而 `--save` 需要再区分「没给」与「给了默认值」，并且要决定「保存到项目还是全局」——两个语义都
  已经有了明确答案（`config set` + `--dir`），再多一个入口只会多一套要维护的优先级。
- **不做**：`config edit`（拉起 `$EDITOR`）、`config get <key>`（`show` 已经够读）、TOML 之外的格式、
  交互式配置的「撤销/历史」。
- **不做**：写完自动重启 mount。要用新配置就 `diorama restart <dir>`（§11.1）。
- **以后**：`ctx.storage`（K14）落地后，页面侧的偏好可以和服务端配置走同一条路径；`config` 的
  键集合由 `knownKeys()` 从 §4.1 派生，加字段时只需改内核那两张表与 `validateFileConfig`。
