# 实施说明：gateway 的索引页

> 记录于 2026-11-01。用户要求：「gateway 也增加一个页面，用来显示所有的实例路径与 URL，点击可新窗口打开。
> gateway 端口在配置文件里配置」。
>
> 契约不升号（§6）：没有新增内核服务、没有加座位、没有改 `ctx.*` 签名。契约正文改在 **§4.1**
> （多一张 `[gateway]` 表）、**§7.3**（`status` 多一个可选 `index`）、**§7.6**（`ls` 多一行）、
> 以及新写的 **§7.7**；变更清单是 **§40**，`features.md` 的 G8 同步。

## 1. 出发点

diorama 的进程模型是「一个 gateway，N 个挂载目录」，每个目录一个**随机端口**，而且 gateway
**不持久化**（architecture §10）：重启一次，所有 URL 作废，读者只能回到终端敲 `diorama ls`。

于是有两件事缺：

1. **没有一个能收藏的入口**。`diorama ls` 是终端里的答案，读者在浏览器里的时候拿不到。
2. **没有「所有实例一览」的地方**。同时开着五个目录，读者得记住五个端口号。

索引页就是这两件事的答案：一个**固定地址**（`[gateway] port`），一页列出所有挂载，点一下
在新窗口打开。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 端口写在哪 | `diorama.toml` 的 `[gateway] port` | 用户明确要求「端口在配置文件里配置」 |
| 读哪一份 `diorama.toml` | **只读 `$DIORAMA_HOME/diorama.toml`** | 一个进程服务整台机器；项目文件不该决定机器级端口 |
| 默认值 | `port = 0` = **不开** | 默认开就只能随机端口，而随机端口正好是这一页存在的理由的反面 |
| 页面内容 | 每个挂载：目录名、绝对路径、URL、状态、插件数、配置来源 | 就是 `diorama ls` 那一行，只是能点 |
| 点击行为 | 整张卡片是 `<a target="_blank" rel="noopener">` | 这一页只有一个动作；让人瞄准 12px 的 URL 是没必要的精度 |
| 渲染 | 每次请求重渲染，`cache-control: no-store` | 挂载表会变；缓存的列表是谎话 |
| 零挂载 | 一句说明 | 空列表要读者自己解释 |
| 端口被占 | `EADDRINUSE`，不重试，gateway 不启动 | 与显式 `--port` 同一条规矩（§7.3）：说了 7777 就该是 7777 |
| 它是不是挂载 | **不是** | 挂载 = 目录 + 页面壳 + 插件图 + RPC；这一页什么都没有，做成挂载会污染 `ls` / `stop --all` |

## 3. 实现

### 3.1 内核（`packages/kernel`）

- **`src/server/config.ts`**：`EffectiveConfig` / `FileConfig` 各多一张 `gateway: { host, port }` 表；
  `validateFileConfig` 校验（`gateway.port` 0–65535，未知键 fail loud）；`mergeConfig` 合并；
  `CONFIG_KEYS` / `GATEWAY_CONFIG_KEYS` 进写文件的那一半（`formatFileConfig` / `patchFileConfig` /
  `knownKeys`）；新增 `resolveGatewayConfig({ home })` —— **只**读 `$DIORAMA_HOME/diorama.toml`。
  `readConfigValue` / `patchFileConfig` 里那张 `head === 'watch' ? … : head === 'git' ? …` 的梯形表
  换成 `TABLES` + `tableKeys()`：加第五张表不再是一次嵌套三元。
- **`src/server/index-page.ts`**（新）：`renderIndexPage(mounts, { info, socket })` 是**纯函数**
  （HTML 字符串），`createIndexServer({ list, info, socket })` 是那个 listener。`escapeHtml` /
  `formatTime` 单独导出，测试直接读。
- **`src/server/static.ts`**（新）：`serveStatic` 与 `CONTENT_TYPES` 从 `http.ts` 搬出来——
  索引页是纯 HTML，不需要整套 `createMountServer`，但两处共用一个静态文件实现没有意义。
- **`src/server/gateway.ts`**：`Gateway.listenIndex({ host, port, socket }, info)` 绑端口，
  `Gateway.indexPage` 报告地址；`close()` 一并关掉。端口被占转成 `controlError('EADDRINUSE')`。
- **`src/shared/control.ts`**：`GatewayStatus.index?: string`。

### 3.2 CLI（`packages/cli`）

- **`src/gateway-command.ts`**：`runGateway` 先 `resolveGatewayConfig({ home })`，把 `index` 交给
  `serveGateway`。文件写坏 → `ConfigError`（与 `diorama <dir>` 同一条 fail loud 的路）。
- **`src/gateway.ts`**：`serveGateway` **先绑索引页、再绑 control socket**（顺序就是语义：
  socket 是 gateway 的「我起来了」信号，一个注定在索引页上失败的进程绝不能先发这个信号）；
  失败时关掉 control server 再抛，什么都不留在 `$DIORAMA_HOME` 里；`status` 回答里带上 `index`。
- **`src/main.ts`**：`gateway status` 多一行 `index:`（关着时是 `off (set [gateway] port in <path>)`）。
- **`src/control-client.ts`**：`formatMounts(mounts, index?)` 在表格前加一行 `index: <url>`；
  `startGateway` 先读一遍 `$DIORAMA_HOME/diorama.toml`（写坏 = 退出码 2，指名文件，而不是一个
  起不来又说不清的守护进程）、在子进程**已经退出**时立刻停止等待，并把 `gateway.log` 的最后几行
  引到错误里。
- **`src/config-command.ts`**：`gateway.host` / `gateway.port` 是两个正常的键（`set` / `unset` /
  交互式），排在向导最后——它们不是这个目录的属性。`host` 菜单的标题改成按字段生成
  （`${field.key} — ${field.hint}`），否则两个 host 菜单长得一模一样。

### 3.3 那一页长什么样

服务端渲染的 HTML，`<style>` 内联（不加载任何东西，索引页不能依赖挂载的静态资源）：

- 头部：`diorama gateway`、pid、版本、契约、挂载数、启动时间；
- 主体：每个挂载一张卡片，`data-testid="gateway-index-mount"` + `data-mount-id` / `data-root` /
  `data-url`（测试与脚本都能读）；degraded 时 meta 行写原因，并加 `.mount--degraded`；
- 零挂载：`data-testid="gateway-index-empty"` 的一句话；
- 页脚：说明「点一个目录就在新窗口打开」，以及 control socket 的路径（CLI 知道，内核不知道，
  所以由调用方传进来）。

## 4. 测试

- `packages/kernel/test/config.test.ts`：`[gateway]` 的校验 / 合并 / 写文件 / 点号键；
  `resolveGatewayConfig` 只认 `$DIORAMA_HOME`（没有文件 = 默认、没有 `[gateway]` = 没有来源、
  写坏 fail loud）。
- `packages/kernel/test/index-page.test.ts`（新，9 条）：链接与 `target="_blank"`、零挂载的空态、
  degraded 的原因、计数、转义、socket 页脚、时间格式，以及 listener 的两条（每次请求重渲染、
  keep-alive 连接下 `close()` 仍会 resolve）。
- `packages/cli/test/config-command.test.ts` / `config-menus.test.ts`：向导多了两个字段（脚本答案
  各多两个），`gateway.host` / `gateway.port` 的值语法。
- `apps/web/tests/m10-config.spec.ts`：交互式向导的四条用例，答案各多两个。
- `apps/web/tests/m28-gateway-index.spec.ts`（新，3 条）：真实 CLI + Chromium——两个挂载的页面
  列出两张卡片、`data-root` / `data-url` / `href` / `target` 都对、**点一下真的开了新标签页而且那是
  那个挂载自己的页面**、卸载后刷新就少一张、全卸载后是空态；没有 `[gateway] port` 时 `status` 里
  没有 `index` 且 CLI 说明怎么打开；端口被占时退出码 1、错误里带端口号、不留残余。

## 5. 验证

```bash
pnpm build
pnpm test:unit                                   # 438 条
pnpm -r --no-sort run typecheck
pnpm --filter diorama-web exec playwright test    # 真实 CLI + Chromium
```

## 6. 坑

1. **`[gateway]` 不能进 `mountCtx.config` 的页面那半边**。`MountConfig`（`shared/config.ts`）是
   「页面能读的那一段」，索引页的端口与页面无关；加进去只会让每个页面都带着一个它用不上的字段。
2. **`status` 的 `index` 用「不出现」表示关着**，不是 `null`。`diorama ls --json` 的消费者按
   `gateway.index !== undefined` 判断；写成 `null` 就得区分 `null` 与缺省两种「没有」。
3. **索引页要抢在 control socket 之前绑**。最初的写法是先 `bindSocket` 再 `listenIndex`，失败时再
   `rmSync` 掉 socket。这在本地几乎看不出问题，但它是**竞态**：socket 一旦 bind 成功，
   `diorama gateway start` 的 `ping` 轮询就可能先拿到回答、报「已启动」，然后那个进程才死掉。
   e2e 在全量套件里抓到过一次（单跑必绿），随后重排成「索引页 → socket」——顺序本身就是语义：
   **能发「我起来了」的进程，必须是已经不会再失败的那个**。同理，失败路径不再需要 `rmSync`：
   此时 socket 文件还没被创建。
4. **`gateway start` 的超时诊断**。守护进程起不来时 CLI 原本只会说「10 秒内没应答」，真正的原因在
   `gateway.log`。现在两件事一起改：子进程已退出就立刻放弃等待（`exitCode !== null`），错误里附上
   日志最后五行。没有这两条，用户看到的是「超时」，而不是「端口 7777 被占了」。
5. **向导的答案条数**是**位置式**的：加两个字段就要给每一条脚本化答案补两个 `''`，否则后面全部
   错位（`line` 拿到 `undefined` 会在 `interpretInput` 里炸 `trim`）。这不是设计缺陷，是这些测试
   本来就按顺序喂答案；补的时候顺手把「哪个答案对应哪个字段」的注释写全。
6. **`host` 菜单标题不能写死**。两个 host 字段共用一个 `menu: 'host'` 分支，标题写死成
   「where the page listens」时 `gateway.host` 的菜单会撒谎；改成 `${field.key} — ${field.hint}`。
