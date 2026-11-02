# 实施说明：gateway 的绑定 IP 与「卡片链接跟着读者走」

> 记录于 2026-11-01。用户要求：「gateway 支持配置绑定 ip」。
>
> 契约不升号（§6）：没有新增内核服务、没有加座位、没有改 `ctx.*` 签名。契约正文改在 **§7.7**
> （链接那一行 + 两条细则），变更清单是新写的 **§41**；`features.md` 的 G8 同步，README 多一节。

## 1. 出发点

「gateway 支持配置绑定 ip」这句话落到代码里，第一反应是「`[gateway] host` 还不存在」。
**它存在**（`0.0.8` 的索引页那一档就有了，§4.1 / §7.7），而且实测确实能用：

```toml
[gateway]
host = "0.0.0.0"
port = 7777
```

`gateway start` 起来之后，`curl http://<LAN-IP>:7777/` 是 200，写一个本机没有的地址
（`10.1.2.3`）则 `EADDRNOTAVAIL`、gateway 起不来、日志里写着原因。**绑定这一层没有缺口。**

缺口在**下一页**：绑到 `0.0.0.0` 之后，从别的机器（手机、另一台电脑）打开索引页，卡片上写的是
`href="http://127.0.0.1:<mount 的随机端口>/"`——在那个浏览器里，`127.0.0.1` 是**它自己**。
点一下就是「无法访问此网站」。索引页存在的理由是「一个能收藏、能点开的入口」，而在它唯一
有意义的场景（从别的机器打开）里，它是**死链**。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| `[gateway] host` 的语义 | 不变：就是 `listen(2)` 的地址 | 已经对了，只是没写清楚；这一档补文档与失败形态 |
| 卡片链接的主机名 | 卡片地址是 loopback **且**这次请求不是从 loopback 来时，换成 `Host` 头里的主机名 | `0.0.0.0` 不是一个能写进链接的地址；「哪个名字通」只有请求自己知道 |
| 其余情况 | 一字不改 | 本机访问拿到的还是原来那些链接；已报真实地址的挂载保持原样（两个真相比没有真相更糟） |
| 判据是配置还是请求 | **请求** | 绑 `0.0.0.0` 而读者从 loopback 来，`127.0.0.1` 照样对；要看的是「这条链接对这位读者通不通」 |
| 要不要顺手让 `[gateway] host` 也当挂载的默认 `host` | **不** | 挂载的 `host` 是一个目录的属性（§4.1 的归属规则），索引页的 `host` 是进程的属性。合成它们会让「只设一处」看起来能用、实际只开了一半 |

## 3. 实现

### 3.1 内核（`packages/kernel`）

- **`src/server/url.ts`**（新）：`isWildcardHost` / `isLoopbackHost` / `displayHost` / `mountUrl` /
  `requestHostname`。`mountUrl` 与 `displayHost` 原本长在 `gateway.ts` 里；索引页也要拼 URL，
  但它**不能** import 挂载表（那张表正是它要渲染的东西）。于是把「地址 ↔ URL」这一组纯函数
  搬到自己的模块，两边都从这里拿。
- **`src/server/index-page.ts`**：`cardUrl(url, { requestHost })` 是那条规则的**纯函数**——
  挂载报 loopback、请求不是 loopback → 只换主机名（端口是挂载的），IPv6 补方括号；
  `requestHostOf(request)` 读 `Host` 头；`createIndexServer` 每次请求把它交给 `renderIndexPage`。
  `data-url` 与 `href` 一起换（它们本来就是同一个事实的两个出口）。
- **`src/server/gateway.ts`**：删掉本地的 `displayHost` / `mountUrl`，改从 `url.ts` 取；
  挂载 URL 的构造不变。
- **`src/server/index.ts`**：导出 `url.ts` 的那几个（`mountUrl` 的导出位置从 `gateway.ts` 挪到这里，
  对下游是同一个名字）。

### 3.2 CLI（`packages/cli`）

- **`src/run.ts`**：`--foreground` 那条路径原本自己拼了一遍 `displayHost` + URL，改用内核的
  `mountUrl`——同一个地址规则不该有两份。

### 3.3 没改的地方

`serveGateway`、`Gateway.listenIndex`、控制面协议、`status.index`、`ls` 的 `index:` 行、
`[gateway] host` 的解析与校验、`diorama config` 的菜单：**都不动**。这一档只改「链接写什么」。

## 4. 测试

- `packages/kernel/test/index-page.test.ts`（+3 条）：
  - `cardUrl` 的四类输入：LAN 主机名换过去、裸 IPv6 补方括号、loopback 读者原样、已报真实地址的
    挂载原样；
  - 渲染层：`href` 与 `data-url` 一起换，`data-root` / `data-mount-id` 不动；
  - listener 层：`Host: 192.168.3.133:7777` 的请求拿到 LAN 链接，loopback 的请求拿到原链接。
- `apps/web/tests/m28-gateway-index.spec.ts`（+1 条 `7d`）：真实 CLI + 真机 LAN 地址——
  两处 `host` 都放宽，用 `http://<LAN-IP>:<port>/` 抓这一页，卡片的 `href` 里必须是 LAN 地址、
  不能是 `127.0.0.1`，并且**那个地址真的返回 200**（能点开）。没有非 loopback IPv4 的机器上 skip。

## 5. 验证

```bash
pnpm build
pnpm test:unit                                   # 441 条
pnpm -r --no-sort run typecheck
pnpm --filter diorama-web exec playwright test    # 真实 CLI + Chromium
```

## 6. 坑

1. **`fetch` 设不了 `Host`**。Node 的 `fetch`（undici）把 `host` 当禁止头**静默丢掉**；Playwright 的
   `extraHTTPHeaders` 与 `route.continue({ headers })` 也一样（实测服务端收到的仍是 `127.0.0.1`）。
   测这条规则只有两条路：在纯函数 `cardUrl` 上测，或者用 `node:http` 手搓请求 / 真的从 LAN 地址访问。
   e2e 选了后者——它顺带证明「那个链接真的能打开」。
2. **`[gateway] host` 与顶层 `host` 是两件事**。只放宽 `[gateway] host`，索引页能从 LAN 打开，
   但卡片指向的挂载页面仍绑在 `127.0.0.1`，点开照样不通。写文档时必须把这一句说清楚，
   否则读者会以为「设了 gateway.host 就完事了」。
3. **`0.0.0.0` 不能进链接**。它不是一个地址，`http://0.0.0.0:7777/` 在某些浏览器里能开、在别的
   地方不能——所以 `displayHost` 把它显示成 `127.0.0.1`，而**卡片**的答案来自请求。
4. **判断依据不要用配置**。第一版写的是「`bindHost` 是通配 → 换主机名」，多传了一个参数，还多一条
   分支；实际上「挂载报 loopback + 请求不是 loopback」就足够，而且绑在具体 LAN IP 上时行为也对。
   判据越靠近「这条链接对这位读者通不通」，代码越短。
