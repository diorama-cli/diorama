# 实施说明：断网之后，页面自己接回来

> 记录于 2026-10-23。用户报告：**断网后 websocket 断了，网络重连后没有自动重连**。
> 契约不升号（§6）：没有新增服务、没有改 `ctx.*` 的签名、没有加 slot；变的是 **§4 里那条
> WebSocket 的存活与重连语义**，外加 `RpcClient` 上多两个方法。契约正文补在 **§4**，
> 变更清单在 contract.md **§26**。

## 1. 现象与出发点

页面与挂载之间只有一条 WebSocket（contract §4「连接在页面 boot 时建立」）。客户端
`createRpcClient` 在 `onclose` 里做的事只有三件：把所有在途调用以 `EDISCONNECTED` 拒掉、
让 `ready()` 落定、然后**什么都不做**：

```ts
socket.onclose = () => {
  failAll(codedError('EDISCONNECTED', 'the RPC connection closed'))
  ...
}
```

于是断网之后：

1. **没有下一次 `new WebSocket`**。`open` 这个 Promise 早已落定，`call()` 只会看到
   `socket === undefined` 并立刻抛 `EDISCONNECTED`；页面从此永久离线，直到手动刷新。
2. **订阅全死了**。服务端在 socket 关闭时按契约取消该连接的全部订阅端点（`RpcChannel.drop`），
   而客户端那边 `fs.watch` 拿到的 session 还留在自己的闭包里——重连之后也不会有事件，
   文件树、内容区、变更视图全部静止。
3. **断网本身还不一定立刻被发现**。网络断了，浏览器**不会**马上触发 `onclose`（TCP 要等
   keep-alive 超时，常常是几分钟）；期间页面看起来「活着」，写进 socket 的帧石沉大海，
   在途调用一直挂着。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 重连 | **自动**，指数退避 500ms → 10s（`RETRY_INITIAL_MS` / `RETRY_MAX_MS`），永不放弃 | 页面是长时间开着的；网络抖动、睡眠唤醒、VPN 切换都是常态 |
| 断线期间的新调用 | 立刻 `EDISCONNECTED`（不排队） | 契约 §4 的 fail loud 不变：排队会让一个写盘动作在几分钟后突然生效 |
| 订阅端点 | 由通道**托管**：`watchEndpoint(method, args, listener)`，重连后自动重放 | 每个订阅方自己记住「断了要重订」是重复劳动，而且谁都可能忘 |
| 订阅方的写法 | `fs.watch` 内部改用 `watchEndpoint`，签名与 disposer 语义不变 | `ctx.fs` 的契约（§3.1）一个字没改，插件无感 |
| 断线期间发生的变化 | `onReconnect(listener)`：**读者自己重读** | 断网时的文件改动不会产生事件；只重订阅等于「从重连那一刻起才看得见」 |
| 谁订阅了 `onReconnect` | 文件树（重列已展开目录）、内容区（`view.refresh` 的同一动作）、变更视图（重扫 watch 集 + 重读 status）、页面壳（重读 `/plugin.json` 的降级状态） | 这四处都是「派生自服务端状态」的界面 |
| 存活探测（客户端） | 每 **5s** 发一帧 `{type:'ping'}`；**20s** 没收到任何帧即判定为死连接，主动重连 | 断网不产生 `onclose`；不发帧就永远发现不了。5s 也让重连在十秒量级完成 |
| 存活探测（服务端） | 每 **15s** 对每条连接发 WebSocket ping，连续两轮无 pong 即 `terminate()` | 反向同理：断网的页面会留下一条「永远开着」的 socket，它的订阅继续占着 OS watcher |
| 定时器 | `unref()`（服务端） | 短命 CLI 不能被心跳吊住 |
| 首次连接 | **不算**重连：`onReconnect` 只在「曾经连上过、或第 2 次以上的尝试成功」时触发 | 页面刚打开时不会白重读一遍 |

## 3. 语义细则

- **`watchEndpoint` 的返回值**：disposer。它撤掉登记、在活连接上发 `{type:'cancel'}`；
  连接不在时只撤登记（重连后不会再重放）。
- **重放顺序**：连接 `onopen` 后**先**重放全部订阅端点，**再**通知 `onReconnect`；
  所以重读发生时 watch 已经就位，重读与事件之间不会漏。
- **旧 session 的监听器**：重放成功后把监听器从旧 session 挪到新 session 上，旧 session
  的键随之删掉，不会在 `listeners` 里越积越多。
- **`ping` / `pong`**：`{type:'ping'}` 由服务端 `handleFrame` 直接回 `{type:'pong'}`，
  不碰 dispatcher、不进 `describe()`；`pong` 在客户端只是「收到帧」的证据。
- **`close()`**：清定时器、置 `closed`，此后不再拨号，在途调用以 `EDISCONNECTED` 结束。
- **`ready()`**：返回**当前**那次拨号的 Promise；断线期间它 reject，重连后重新 resolve。
  （此前它只落定一次。）
- **退避重置**：连接成功后回到 500ms；连续失败才翻倍，封顶 10s。
- **服务端的 sweep**：`RpcChannel.close()` 里 `clearInterval`；`heartbeatMs` 可注入，便于单测。

## 4. 改动清单

| 包 | 改动 |
|---|---|
| `kernel/src/shared/rpc.ts` | 帧表加 `{type:'ping'}`（client → server）与 `{type:'pong'}`（server → client） |
| `kernel/src/server/rpc.ts` | `handleFrame` 应答 `ping`；`Peer.alive` + 15s 存活扫描（ping / 两轮无 pong 即 `drop` + `terminate`）；`RpcChannelOptions.heartbeatMs`；`close()` 清定时器 |
| `kernel/src/client/rpc.ts` | 重写：拨号/退避/重连、客户端心跳（5s ping、20s 超时）、`watchEndpoint`、`onReconnect`、`close()`、`ready()` 语义；`connect` / `heartbeat` / `retry` 三个测试注入口 |
| `kernel/src/client/fs.ts` | `watch` 改用 `rpc.watchEndpoint`（签名、debounce、disposer 全不变） |
| `kernel/src/client/index.ts` | 导出 `RpcClientOptions` 与四个时序常量 |
| `plugins/file-tree/src/index.tsx` | `useDirectory` 订阅 `onReconnect` → 重列 |
| `plugins/renderer-registry/src/index.tsx` | 订阅 `onReconnect` → `contentSettings.refreshAll()`（= `view.refresh`） |
| `plugins/git-changes/src/index.tsx` | `useChanges` 订阅 `onReconnect` → 重扫 watch 集 + 重读 `status()` |
| `apps/web/src/main.tsx` | 订阅 `onReconnect` → 重读 `/plugin.json` 的 `state` / `lastError`（离线期间的降级/恢复不丢） |
| `kernel/test/rpc-reconnect.test.ts` | 新文件 5 条：调用、断线重连 + 重放订阅 + 取消、断线期间 fail loud、静默连接被判死、`close()` 后不再拨号 |
| `kernel/test/rpc.test.ts` | 加一条：`ping` 回 `pong` |
| `apps/web/tests/m2-watch.spec.ts` | 加用例 12：`context.setOffline` → 断网期间改文件 + 新建文件 → 恢复网络 → 内容与树**自动**追上（不点、不刷新），随后的事件照常到达 |
| `docs/contract.md` | §4 补存活与重连的规则；新 **§26** 变更清单 |
| `docs/features.md` | K13 补「断线自动重连、订阅重放」 |

## 5. 验证

1. `pnpm build`。
2. `pnpm test:unit`：全绿（含新的 6 条）。
3. `pnpm -r --no-sort run typecheck` 全绿。
4. `node scripts/assemble-package.mjs` 后 `pnpm --filter diorama-web exec playwright test`。

## 6. 坑

1. **`onclose` 不等于断网**。断网时浏览器可能几分钟都不触发 `close`：只靠 `onclose` 重连，
   用户会看到「网回来了但页面还是死的」。必须有自己的心跳（客户端发 `ping`，服务端发
   WebSocket ping），两边都要。
2. **重订阅不能交给订阅方**。第一版只做了「重连后让 `fs.watch` 自己再调一次」的钩子，
   结果是每个调用点都要记得重订（树、内容区、变更视图各一份），漏一个就是「那个视图永远不刷新」。
   把重放放进通道（`watchEndpoint`）之后，调用点只写一次。
3. **只重订阅不够**。断网期间磁盘上的改动**没有事件**——重订阅只保证「从这一刻起」看得见。
   所以 `onReconnect` 必须让读者重读一次；两件事缺一不可。
4. **重放要早于通知**。先 `onReconnect` 再重放订阅，会在「重读」与「watch 就位」之间留一个
   窗口：这期间的变化两处都收不到。
5. **服务端也要判死**。页面断网后它的 socket 在服务端仍然「开着」，订阅继续持有 OS watcher
   （`watch.maxDirectories` 是有上限的）；不做服务端扫描，重连几次之后旧连接会一直堆着。
6. **`ready()` 曾经只落定一次**。旧实现里 `open` 是启动时那一次拨号的 Promise；重连后
   它既不会 resolve 也不会 reject，`await rpc.ready()` 的调用方会挂住。现在它指向当前那次拨号。
7. **测试要用假 socket**。`node --test` 里没有 `WebSocket` 的事件循环语义（也没有浏览器
   的断网），所以 `rpc-reconnect.test.ts` 注入一个可手动 `open` / `close` / `receive` 的假
   连接；e2e 那边用 Playwright 的 `context.setOffline`。
