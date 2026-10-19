# M1 实施说明（插件内核成型）

> 记录于 2026-10-18。契约以 [contract.md](../contract.md) v0.2 为准，本文只记 M1 的
> **范围、顺序、实现形态与验收**，不重复契约内容。

## 0. 用户决定（2026-10-18）

1. **外部插件全部推迟**（`~/.diorama/plugins` 动态加载、npm source、zod 运行时校验、外部
   半边 URL 下发）到**最后一个里程碑**。M1 **只在设计上保留可能性**：
   - 保留 `PluginSource` 接口（contract §9）与 manifest 的 `server` / `client` 字段；
   - `fs` 按 contract §2.5 写成**服务插件**（`apply` 一次、`mounts.onMount` 每目录实例），
     而不是内核内联的单例——外部 server 半边就是照这个形状接入。
2. 其余按 2026-10-18 的推荐值执行（见 contract §12 变更清单）。

## 1. M1 六块工作在「无外部插件」下的重排

| 块 | 处理 | 原因 |
|---|---|---|
| ① 动态加载（Loader + 模块表；外部目录加载） | **拆开**：浏览器 Loader / 模块表（M0 已落地最小版，contract §8 收口）；**外部目录扫描不做** | 用户决定 |
| ② 契约（manifest、contract version、zod） | **做 manifest + contract version 检查（强制）**；zod 规则写进契约、入口就位，无调用者 | zod 只服务外部插件 |
| ③ RPC | **做**：WebSocket 自动代理，替换 `/api/fs/*` | 内核成型核心 |
| ④ `ctx.fs` 签名 | **做**：`list / stat / readText / readBytes / watch`（`watch` 签名定、实现 M2） | 契约必须现在定 |
| ⑤ 失败处理 | **做**：加载/契约/slot/渲染/RPC 五层 fail loud + 单点降级；`file.renderer` 回退链 | 内核成型核心 |
| ⑥ 新插件 `markdown` / `code` | **做**，同时把 `file.renderer` 从 M0 的 list 形态升级为 contract §5.1 的 matcher | 演示：`.md` → HTML、去掉 markdown 回退 plaintext |

## 2. 实施顺序（每步结束时能演示或能跑测试）

| 步 | 内容 | 验收 |
|---|---|---|
| S1 | 契约冻结：contract v0.2 + 本文 | 文档 |
| S2 | contract version 范围检查（semver 子集）+ 所有内置插件升 `>=0.2 <0.3` | 单测：范围解析与拒绝 |
| S3 | RPC：`fs` 改成服务插件（`mounts` + `onMount`），服务端 dispatcher、WebSocket 通道；客户端 `mountCtx.fs` 走代理；删除 `/api/fs/*` | M0 5 条 e2e 在新通道全绿 |
| S4 | `ctx.fs` 最终签名：`stat`、`readBytes`、`ETOOLARGE`、`MAX_BINARY_BYTES`、`watch` 存根 | fs 单测（越界、二进制、超大、stat） |
| S5 | slot 收口：`id` 冲突抛错、(name,key) 共存、同 order 按 id + warn | slots 单测 |
| S6 | `file.renderer` matcher：keyed slot、ext/mime/probe 三档、兜底、失败回退；props 改 `text/bytes/mime` | registry 单测 + e2e |
| S7 | 新插件 `markdown`（marked + 消毒）与 `code`（highlight.js）；`plaintext` 改为兜底（无 matcher） | e2e：`.md` → HTML，`.js` 高亮 |
| S8 | 失败处理收口 + M1 验收 e2e + 文档（features.md 档位） | 全部 e2e |

## 3. 实现形态（契约之外的具体选择）

| 项 | 选择 | 理由 |
|---|---|---|
| RPC 传输 | Node 没有内置 WebSocket 服务端 → 依赖 `ws`；客户端用原生 `WebSocket` | 不引框架，单进程最小面 |
| semver 子集 | 自写：`>=`、`>`、`<=`、`<`、`^`、`~`、精确版本，空格分隔为 AND（`||` 不做） | 不引 `semver` 包，规则面小 |
| markdown | `marked` + DOM 消毒（`dompurify` 或内核最小白名单） | 防止渲染任意 HTML 注入 |
| 高亮 | `highlight.js`（按需注册常用语言） | 体积可控；不引 shiki（重） |
| mime 推断 | 内核小表 + `text/*` 默认 | 只支撑 §5.1 的 mime 档 |
| `fs` 的 `describe()` | 返回方法名列表 | 作为 RPC 白名单 |
| 单测位置 | `packages/kernel/test/*.test.ts`、`packages/plugins/slots/test/*.test.ts`，`node --test` 直接跑 TS（strip types） | 不引 vitest/jest |

## 4. 验收（M1 演示脚本）

演示：打开 `.md` 看到渲染后的 HTML；用 `--plugins` 去掉 `markdown` 后同一个 `.md` 回退成等宽原文。
与 M0 的 `--plugins` 开关同一机制，不需要外部插件目录。

| # | 验收点 | 复现 |
|---|---|---|
| 1 | 内置插件通过 contract `>=0.2 <0.3` 检查；范围写错的插件被拒绝并解释 | 单测 + 把某内置包 `contract` 临时改成 `>=0.1 <0.2` 跑 CLI |
| 2 | `.md` 渲染为 HTML（标题、列表、代码块） | e2e |
| 3 | 去掉 `markdown` 后 `.md` 回退 plaintext | e2e |
| 4 | `.js` 用 code 高亮；无匹配扩展名的文件落到 plaintext | e2e |
| 5 | 二进制文件显示「二进制文件，无法以文本显示」而不是乱码 | e2e |
| 6 | `/api/fs/*` 已删除；`mountCtx.fs` 走 WebSocket RPC | e2e（`page.evaluate` 调 `mount.fs.list` + HTTP 探测 404） |
| 7 | 渲染器抛错 → 标记失败 → 回退到下一个；全失败 → 显示原因而非白屏 | 单测 |
| 8 | 同一 seat 内多个条目按 order 排序、同 order 按 id 并 warn；`id` 重复抛错 | 单测 |
| 9 | M0 的 5 条验收仍全绿 | e2e |

## 5. 风险与已知取舍

- **`ws` 是新增的服务端依赖**（纯 JS、无 native）；客户端用浏览器原生 `WebSocket`。
- **M0 e2e 的 `/api/fs/list` 断言要改**：验收点 4 直接用 HTTP 探测目录，改走 RPC。
- **`plaintext` 保留 M0 的 `data-testid`**，M0 验收点 2 的断言不变。
- **`code` / `markdown` 体积**：按需注册 highlight.js 语言，控制在数百 KB 内。

## 6. 实现记录（2026-10-18，M1 落地后）

### 6.1 验收结果

```
pnpm test:unit                                   # 18 passed
pnpm --filter diorama-web exec playwright test   # 11 passed
```

| 用例 | 覆盖 |
|---|---|
| M0 1–5 | 原样全绿（验收点 4 的目录探测改走 RPC） |
| M1 2 | `.md` → `<h1>` + 列表；`/api/fs/*` 返回 404 |
| M1 3 | 去掉 markdown → `plaintext:fallback` |
| M1 4 | `.js` 高亮；`.md` 不再被 code 接管；无扩展名 → plaintext |
| M1 5 | 二进制 → 「二进制文件，无法以文本显示」 |
| M1 6 | `mountCtx.fs` 走 RPC：list / stat / readBytes(200B) / `EOUTSIDE` / `ESERVICE` |
| M1 8 | `--plugins` 缺少 `requires` → 拒绝并点名两个插件 |

### 6.2 实测踩到的坑（M2/M3 参考）

1. **模块表必须含 `react`，不只是 `react/jsx-runtime`**。半边里的错误边界继承
   `React.Component`；缺 `react` 时工厂在求值时抛 `Class extends value undefined`，
   Cordis 把它当"加载失败"静默跳过——页面上只剩别的一半。现在是启动时 fail loud
   （`boot.ts` 检查 fiber 未 ACTIVE 即记 failure）。
2. **半边是各 build 自己的类**。`ctx.slots.register` 是 `SlotRegistry` 的方法；某个半边
   不带接收者地调用它，会往另一份 registry 里注册（看似成功、实际丢失）。规则：
   一律经由服务对象调用（`provideEntry(ctx, …)` 辅助），服务方法在 `provide` 前
   `bindMethods`。这是 M0 §11.3 规则的延续。
3. **声明与注册的顺序**：boot 顺序是 `slots → layout → file-tree → tabs → plaintext →
   renderer-registry → markdown → code`，渲染器先于它的 seat 声明者执行。`ctx.slots`
   为此增加 **`declare(seats)`**：声明者（如 `renderer-registry`）先声明，条目再注册；
   未声明的注册进 pending 队列，声明到达后自动落地。
4. **`fs` 是服务端基础设施，不进客户端 boot 图**，`--plugins` 只能选择有客户端半边的
   插件；CLI 无条件把 `fs` 加进服务端插件树。
5. **渲染器跨 key 读取**：`file.renderer` 的条目各带自己的 key（插件 id），派发器用
   `registry.all()` 过滤 `name === 'file.renderer'`，而不是按某一个 key 查座位。
6. **markdown 与 code 的扩展名不能重叠**：`.md` 只归 markdown；去掉 markdown 后落到
   plaintext，而不是被 code 当源码高亮。

7. **渲染期读 store 会让页面在几次点击后卡死**（用户反馈，2026-10-19 修复）。
   `renderer-registry` 的派发器把“读文件”放在 `getSnapshot` 里，并且 effect 的依赖是
   每次渲染都新建的 `loaded` / `entries` / `file` 对象：一次渲染触发一次
   `setChoice`，再触发下一次渲染，几万帧后标签页失去响应（实测 36k 次渲染、0 次桥通知）。
   规则（现在已经是代码结构）：
   - `getSnapshot` 必须是**纯函数或稳定引用**——`FileCache.snapshot()` 不发起 IO，
     读文件在 `useEffect` 里由 `cache.ensure()` 启动；
   - 异步结果以**内容键**（`path:size:mtime|seat ids|mime`）缓存，键不变就不再
     `setState`；
   - effect 依赖用原始值（stamp、版本号），不用每次渲染新建的对象；
   - `slotRegistry` 新增 `version`，座位列表按它记忆化。

### 6.3 与契约的对应

| 契约 | 实现位置 |
|---|---|
| §3.1 `ctx.fs` 签名 / 上限 / 错误码 | `kernel/src/server/fs.ts`、`shared/errors.ts` |
| §3.3 slot 冲突三类 | `plugins/slots/src/registry.ts` |
| §3.5 `ctx.diorama.mounts` | `kernel/src/server/plugins.ts`（`createMounts`） |
| §4 RPC | `kernel/src/server/rpc.ts`、`kernel/src/client/rpc.ts`、`shared/rpc.ts` |
| §5.1 matcher | `plugins/slots/src/select.ts`、`plugins/renderer-registry/src/index.tsx` |
| §6 contract 检查 | `kernel/src/server/manifest.ts`、`shared/semver.ts` |
| §8 模块表 | `apps/web/src/main.tsx`、`kernel/src/client/boot.ts` |
| §9 `PluginSource` | `kernel/src/server/plan.ts`（`BuiltinSource`） |
