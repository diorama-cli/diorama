# 实施说明：发布到 npm（`@diorama-cli/diorama` 0.0.1）

> 记录于 2026-10-20。用户要求：**发布 npm 到 `@diorama-cli/diorama`**；契约版本改回 **`0.0.x`**
> 数字递增；内置插件**打包到一起**（方案 A，只发一个包）。参考实现：DeepSeek Harness
> （`@deepseek-ai/dsh`）——304 个依赖的 monorepo 仍然只发一个可安装的入口包，内置件随包走。

## 1. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 包名 | **`@diorama-cli/diorama`** | 无 scope 的 `diorama` 在 npmjs 上是别人的项目（2.0.21，2026-02 还在更新）；scope 与 GitHub org（`diorama-cli/diorama`）一致。**只 CLI 入口用 scope**，17 个内部包保持 `diorama-*` 无 scope 的名字——它们不发布，名字只活在仓库内（实测 17 个名字全部可用，留着以后万一拆开发） |
| 版本 | **`0.0.1`**，之后 `0.0.2`、`0.0.3` 递增 | 用户明确「0.0.x，x 批数字版本号」：pre-1.0 阶段任何破环都只是 patch +1，不带 `-beta` 后缀（预发布号会让 `npm i -g` 拿不到） |
| 契约版本 | `CONTRACT_VERSION = '0.0.1'`，范围 `>=0.0.1 <0.1.0` | 与包版本同源同节奏；16 个内置 manifest + kernel 自身已同步 |
| 打包 | **一个包**：内核、UI 原语、15 个内置插件全部内联进 `lib/main.js`；随包携带 `plugins/<id>/`（manifest + client half）与 `web/`（页面壳）；运行时依赖只剩 `cordis` | `npm i -g @diorama-cli/diorama` 一条命令可用；不存在「17 个内部包要对齐版本、漏装报 ESERVICE」的问题 |
| bin | 只有 `diorama`（发布通道）。`diorama-beta` 属于 link 进来的 checkout，不随包发布 | `bin/diorama` 从自身 `package.json` 读 `DIORAMA_VERSION`，`--version` 与 gateway 的 `GatewayInfo` 自动与 npm 安装的一致 |

## 2. 修掉的两个「发出去也是坏的」

打包之前，发布版的 CLI 有两处**只在安装后才会炸**的问题，都在 kernel 的路径解析里：

1. **内置插件找不到**：`builtinPackageJson()` 只认 `<kernel>/../plugins/<id>`——checkout 的布局。
   安装后内核在 `node_modules/diorama-kernel`，插件在 `node_modules/diorama-plugin-<id>`，
   `../plugins/plaintext` 指向不存在的 `node_modules/plugins/`。
2. **页面壳不存在**：`assetsRoot()` 找 `<cli>/web/index.html`，但没有任何构建步骤把
   `apps/web/dist` 放进 CLI 包，`files` 里的 `"web"` 一直是空的。

修法（`kernel/src/server/plan.ts`）：`builtinCandidates(id)` 按顺序试三个布局——
checkout（`../plugins/<id>`）→ 分包安装（`../diorama-plugin-<id>`）→ **单包安装（`plugins/<id>`，
`import.meta.url` 在打包后指向 CLI 包根）**。checkout 排第一，仓库永远不会解析到 `node_modules`
里的陈旧拷贝。页面壳由 §3 的组装步骤补上。

## 3. 打包管线

```bash
pnpm pack:prepare     # = pnpm build && node scripts/assemble-package.mjs
cd packages/cli && npm publish
```

- **`tsdown.config.ts`（CLI）**：`deps.alwaysBundle: [/^diorama-/]`。tsdown 默认把
  `dependencies` 全部外部化，不写这条，17 个内部包会被原样写进发布 manifest，让
  `npm i` 去拉从未发布的包。`cordis` 保持外部（真正的第三方依赖）。
- **`scripts/assemble-package.mjs`**：幂等，做两件事——
  1. 从 `plan.ts` 的 `BUILTIN_PLUGIN_IDS` 读清单（不另维护一份，防漂移），把每个插件的
     `package.json` + client half 拷进 `packages/cli/plugins/<id>/`。插件**代码**已内联，
     但 kernel 启动时仍要从真实文件读 manifest（`id` / `contract` / `client.entry`）并对
     client half 做内容哈希；浏览器也要逐个 `<script>` 加载这些 closure 工厂。
  2. 把 `apps/web/dist` 拷进 `packages/cli/web/`（`assetsRoot()` 的第一落点）。
- **产物**：74 个文件、约 1.1 MB 压缩。`dependencies` 只剩 `cordis`；16 个内部包挪进
  `devDependencies`（workspace 协议在 checkout 里继续工作，但不会进发布 manifest）。
- **gitignore**：`packages/cli/plugins/`、`packages/cli/web/`、`packages/cli/LICENSE` 是
  组装产物，不进版本库。

## 4. 验证（发布前的完整链路）

1. `pnpm pack` → `diorama-cli-diorama-0.0.1.tgz`，检查内容：`bin/` + `lib/`（2.3 MB，
   `main.js` 322 KB）+ `plugins/`（15 个 manifest + client half）+ `web/` + LICENSE。
2. **在 monorepo 之外安装**：`pnpm add <tgz>` 成功，依赖树只需 `cordis`。
3. **安装版启动**：`diorama site --foreground --port 0` 打印 URL，日志列出全部
   15 个插件，`config:` / `hidden:` 两行正常。
4. **HTTP 面**：`/` 200（页面壳）、`/plugin.json` 报 `contract: "0.0.1"`、
   `/plugins/layout.js` 200（client half）、`/assets/*.js` 200。
5. **真实浏览器**：文件树渲染、图标渲染、点开 Markdown 正常、控制台零错误（截图留档）。
6. 四件套回归：`pnpm build`、`pnpm test:unit`（167）、`-r --no-sort typecheck`、
   `playwright test`（89）全绿——checkout 的行为没有因路径解析改动而变。

## 5. 踩到的坑

1. **tsdown 的 `deps.alwaysBundle` 才是内联开关**。`neverBundle` 只是把依赖标记为外部；
   默认按 `dependencies` 外部化。只写 `neverBundle: ['cordis']` 时，17 个内部包依然全部
   外部化，产物 44 KB 与改前一字不差——用产物体积/外部 import 清单核对，别信配置像对的。
2. **`workspace:*` 会被 pnpm pack 改写成字面版本 `0.0.1`**，于是发布 manifest 声明了
   16 个 npmjs 上不存在的依赖；装包立刻 `404`。解法是把内部包挪进 `devDependencies`
   （发布时被丢弃），`dependencies` 只留 `cordis`。
3. **`import.meta.url` 在打包后指向 CLI 的 `lib/main.js`**，所以 `kernelPackageDir()`
   天然就是 CLI 包根——单包布局的 `plugins/<id>` 直接相对它解析，不需要新的环境变量。
4. **`private: true` 是发布的第一道墙**，但它掩盖了真正的问题：先取消 private 再 pack，
   才能看到 404 与空 `web/`。顺序反了会以为只是权限问题。
5. **发布通道与 beta 通道的分离靠 bin 决定**：发布包只带 `diorama`；`diorama-beta` 的
   socket/pid/log 后缀语义（契约 §7.1）仍然只属于 link 进来的 checkout。
