# 实施说明：停止服务一个目录（`diorama stop`）

> 记录于 2026-10-26。用户要求：**增加命令，用于停止当前目录/指定目录实例**。契约不升号（§6）：
> 控制面早就有 `unmount`（§7.3），缺的只是 CLI 的一个入口——本档只加 CLI 行为，没有新增服务、
> 没有加座位、没有改 `ctx.*` 与 RPC。契约正文补在 **§7.6**，变更清单在 contract.md **§32**。

## 1. 出发点

在此之前「让一个目录不再被服务」有两条路，都不顺手：

- `diorama restart <dir>` 是**卸了又挂**，不能只停；
- `diorama gateway stop` 停的是**整个进程**，会连带停掉所有其它目录。

读者手里最常见的诉求是「把刚才那个目录关掉」——一条只卸一个挂载的动词。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 无参数时的目标 | **当前目录**（包含 `process.cwd()` 的那个挂载） | 用户原话是「停止当前目录」。**包含**而不是相等：在 `proj/src` 里敲 `diorama stop` 也该停掉 `proj` 的挂载 |
| 路径怎么比 | 先 realpath，再 `resolve` 后的字符串 | 挂载键是 realpath（§7.3），所以符号链接要先解开；目录**已被删掉**时 realpath 失败，字符串比较仍认得 |
| 嵌套挂载 | 取**最深**的包含者 | 与外层仓库里的嵌套仓库（§24）同一直觉：越具体的那个才是读者指的那个 |
| 匹配方向 | **只向上**：`stop proj` 不动 `proj/vendor/lib` 上的挂载 | `stop` 是「我在这个目录，把它关了」，不是「把这个目录下面的一切都关了」。要那种语义是 `--all`（但 `--all` 是**整个 gateway**，不是子树——不做子树，见 §5） |
| 不匹配时 | 打印 `no mount for "<dir>"` + 现有挂载清单，**退出码 0** | 与 `gateway stop` 未运行时同一口径：查询不到不是错误。脚本重试不会炸 |
| gateway 未运行时 | `gateway is not running (nothing to stop)`，**退出码 0** | 同上 |
| `--all` | 停这个 gateway 的**全部**挂载，进程照旧运行 | 「清场」的常用动作；停进程仍是 `gateway stop`，两个动词不混 |
| 与 `gateway stop` 的边界 | `stop` **永不**停进程 | 用户说的是「停止…实例」，不是「停止服务」；混在一个动词里会误伤其它目录 |
| `--json` | `{ stopped: [{ mountId, root, url }], target, all }` | 与 `ls --json` / `restart --json` 同一形态（§7.6）。**url 要带**：卸载之后就再也算不出来了 |
| 部分失败 | stdout 只报真停掉的，stderr 逐个报失败的，退出码 1 | 与 `mount` 的 `pluginFailures` 同一手法：成功的东西照常给，失败的东西不吞 |

## 3. 语义细则

- **选择是纯函数**（`packages/cli/src/stop.ts` 的 `planStop`）：挂载表 + 路径进，计划出。
  它不连 gateway，所以 `node --test` 能直接钉住「路径在挂载里 / 兄弟目录同名前缀 / 已删掉的
  目录 / 嵌套取最深 / --all」这几条容易写错的地方。
- **一个挂载一个 `unmount`**：循环里逐条走控制面，一条失败不遮住后面的。
- **`target` 保留用户写的那个路径**（`resolve` 后），不换成 realpath：打印的是「你说停的那个」，
  而 `stopped[].root` 才是挂载真实的根。两者不同正好说明「匹配到了包含它的挂载」。
- **没有「按 mountId 停」**：`restart` 已经收 mountId，`stop` 只认目录——「当前目录」这个诉求
  用 id 表达不出来，而两个都能收会让 `stop abc12345` 到底是 id 还是相对目录变成猜谜。
  要按 id 停，`ls` 拿到 id 之后用 `restart` 的既有路径或以后再加（见 §5）。

## 4. 改动清单

| 包 | 改动 |
|---|---|
| `cli/src/stop.ts` | 新文件：`parseStopArgs`（一个目录或 `--all`，加 `--json`）、`planStop`（纯选择：realpath → 字符串 → 最深包含者）、`stopLines` / `stopDocument`（两种输出）、`noMountMessage`、`stopPath` |
| `cli/src/main.ts` | `stop` 动词 + `stopMount()`；`controlUsage` 多一行 |
| `cli/test/stop.test.ts` | 新文件 18 条：解析、`stopPath`、选择（精确 / 包含 / 兄弟前缀 / realpath / 已删除 / 嵌套 / --all / 不匹配）、两种输出、无挂载消息 |
| `apps/web/tests/m3-cli.spec.ts` | 另加 2 条：`5g` 无参数停当前目录（子目录里执行）→ 该 mount 从 `ls` 消失、端口关闭、另一个挂载与 gateway 都还在；`5h` `--all` + 用法错误退出码 2 + 未运行 gateway 退出码 0。helper 多一个 `cwd`（`stop` 要看当前目录）与 `serves(url)`（端口真的关了） |
| `docs/contract.md` | §7.6 新增 `diorama stop` 一节与退出码一行；新 **§32** |
| `docs/features.md` | 新增 C12 |
| `README.md` | 命令表一行 + 一段说明 |

## 5. 没做的（明确）

- **按子树停**（`stop --recursive <dir>`）：挂载是「目录 → 端口」的一对一关系，子树停只在嵌套
  挂载时才有意义，而那是少数场景。先只做「一个目录」与「全部」两档。
- **按 mountId 停**：见 §3 最后一条。
- **`diorama stop` 不写任何状态**：与 `gateway` 一致，gateway 不持久化（architecture.md §10）。

## 6. 验证

1. `pnpm build`
2. `pnpm test:unit`（377 条，含新的 18 条）
3. `pnpm -r --no-sort run typecheck`
4. `pnpm --filter diorama-web exec playwright test`（含 m3-cli 的 8 条）

## 7. 坑

1. **`--all` 是 `diorama <dir> --all` 的既有选项**（「不隐藏任何条目」）。同一个 flag 在两个
   动词下含义不同，这不是笔误：`stop` 的 argv 由 `parseStopArgs` 自己解析，与 `parseArgs`
   完全不共享代码，所以「`--all` = 全部挂载」只在这个动词里成立。**别把两个解析器合并**。
2. **不能拿 `restart` 的路径写法凑**：`restart` 用 `realDirectory()` 要求目录**存在**，而
   `stop` 必须能在目录已被删掉时仍然按字符串匹配——realpath 失败要**吞掉**再退回 `resolve`。
3. **`/a/b` 与 `/a/bc`**：包含关系要按分隔符判（`within`），`startsWith` 单独用会把兄弟目录
   当成子目录——这条有单测钉着。
4. **`stop` 不是 `gateway stop` 的别名**：e2e 里两条都断言了——`stop` 之后
   `gateway status` 仍然是 0。改这个动词时先想清楚用户说的「停止」指哪一个。
5. **`stop` 从此是个保留字**：以前 `diorama stop` 会把当前目录下名叫 `stop` 的目录挂起来，
   现在它是一条子命令。要挂这种目录写 `diorama ./stop`——`main()` 只把**第一个参数**当动词，
   带路径分隔符的写法不会被当成子命令。与 `ls` / `restart` / `config` / `gateway` 同一代价，
   不额外处理。
