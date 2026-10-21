# 实施说明：主题切换（`ctx.theme` + `theme` piece）

> 记录于 2026-10-20。用户要求：**实现主题切换（跟随系统或指定暗黑/亮色），当然要预留第三方插件
> 来增加主题的能力**。契约 v0.8 → **v0.0.2**（contract.md §19）；新增内核服务 `ctx.theme`（§3.10）、
> 内置 piece `theme`、以及样式表的 token 化（§5.3）。这份说明记「怎么做的」与「§6.2 的坑」。

## 1. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 内核服务还是插件？ | **内核内置**（`ctx.theme`，与 `ctx.commands` / `ctx.router` 同级） | 一个不能跟随系统、记不住选择、又挡不住白屏闪烁的页面是「页面坏了」，不是某个可选插件没装；features.md 里 P9 两轮拍板「不做」的正是这种半吊子形态，这次做完整的就放到内核 |
| 状态模型 | **一个偏好，三个面**：`localStorage`（记忆）、URL hash（分享）、`<html data-scheme/data-theme>`（CSS） | 每个面回答一个不同的问题；都从同一份偏好派生，`Themes.paint()` 是唯一同时更新三处的地方 |
| 默认值 | **`system`**：跟随 `prefers-color-scheme`，OS 切换实时重绘 | 「跟随系统」是第一公民，不是「没选过」的别称；锁定的 scheme 才写 hash |
| 主题的形态 | **数据，不是 CSS 文件**：`{ id, title, scheme, tokens }`，tokens 是样式表调色板的**子集覆盖** | 预留第三方能力的最小接口：一个主题就是一组自定义属性，内核、UI 与所有 piece 都不必知道它的名字；要换皮肤不必改布局 |
| 第三方主题的 UI | `theme` piece 把注册表**同步成命令**（`theme.use:<id>`），palette 即界面 | 主题作者零 UI 成本；注册表变化时命令跟着增删；去掉 `theme` piece，跟随系统与第三方主题照常工作（只是没有命令） |
| 暗色调色板 | **手写一套**（GitHub Dark 风格），不是 CSS 滤镜 | `filter: invert()` 会毁掉图片与语法高亮的色相；`light-dark()` 需要 token 化之后才可用，且带 `color-scheme` 切换的浏览器差异。约 30 个 token 一套手写值，可控且可审 |
| 防白闪 | **页面壳 `index.html` 里一段内联脚本**，样式表生效前读 `diorama.theme.scheme` 写 `data-scheme` | bundle 在首帧之后才到；内核的 `ctx.theme` 再快也快不过第一次绘制。service 每次 paint 都把解析出的 scheme 写回 storage，壳只需要读 |
| 契约版本 | `0.0.2`（全部内置 manifest + kernel 一起升） | 新增服务 = 破环（contract §6 的 pre-1.0 规则） |

## 2. 语义细则

- **优先级**：boot 时 hash > storage > `system`；运行中最后一次 `set()` 赢。
  「分享的链接显示它说的」比「记得的偏好」更不意外。
- **`system` 是 hash 的缺席**，不是 `#theme=system`：hash 键只在 piece 有话可说时存在（§3.8）。
- **偏好可以走在注册前面**：`set('night-owl')` 时主题还没注册 → 页面先跟随系统 + `warn` 一次
  （同一偏好只 warn 一次），主题注册后立即生效。这与「覆盖层先于 piece 到达」同一类问题，
  注册表条目本来就是后到的。
- **主题注销不清偏好**：偏好是读者的选择，主题是它的实现；实现走了，页面回到跟随系统
  （而不是掉回 light），主题回来立即恢复。
- **tokens 只收 `--` 开头的键**：主题是重新着色，不是注入 CSS；非自定义属性被静默丢弃
  （数据校验失败就 fail loud 的另一半是「不是校验的就不校验」——这里过滤而非抛错，因为
  token 集合本来就开放，多写一个键无害）。
- **预览 iframe 不跟主题**：预览的 HTML 是「文件是内容」，`--dio-frame-bg` 默认白底。

## 3. 改动清单

| 包 | 改动 |
|---|---|
| `kernel/src/client/theme.ts` | 新文件：`Themes` 服务 + `resolveTheme` / `nextPreference` 纯函数 + `browserThemeHost` / `inertThemeHost`（注入，单测不用浏览器） |
| `kernel/src/client/boot.ts` | `createThemeService({ host, hash: router.state('theme') })`，provide 为 `ctx.theme`；进 `LATE_SERVICES`；`dispose` 链 |
| `kernel/src/client/index.ts` | 导出服务面与类型（`ThemeDefinition`、`ThemeSnapshot`、`THEME_STORAGE_KEY`、…） |
| `kernel/test/theme.test.ts` | 12 条单测：解析规则、循环、记忆、系统跟随、注册表、hash、warn 一次 |
| `ui/src/styles.css` | **token 化**：所有颜色字面量换成 `--dio-*`（新增 `--dio-hover/-strong/-faint`、`--dio-selected*`、`--dio-syn-*`、`--dio-diff-*`、`--dio-hit/reveal-*` 等）；`:root[data-scheme='dark']` 一整块覆盖 |
| `apps/web/index.html` | 防白闪内联脚本（读 `diorama.theme.scheme`，读不到跟随 OS） |
| `packages/plugins/theme/` | 新内置 piece：五条固定命令 + 注册表同步出的 `theme.use:<id>`；`mod+alt+t` |
| `plan.ts` / `plugins-server.ts` / `cli/package.json` / 根 `package.json` / `config.test.ts` | 「加一个内置插件的 7 处」里能动的 6 处（无新座位，第 6 处不动） |
| `apps/web/tests/m9-theme.spec.ts` | 5 条 e2e：跟随系统（含实时切换）、锁定 + 刷新 + hash、`mod+alt+t` 循环、深链不白闪、第三方主题 |

## 4. 验证

1. `pnpm test:unit`：179 条（含 `theme.test.ts` 12 条；此前 167）。
2. `pnpm -r --no-sort run typecheck` 全绿（新包声明由 `tsconfig.emit.json` 生成）。
3. `pnpm build && node scripts/assemble-package.mjs`；`playwright test`：94 条全绿
   （89 旧 + 5 新；老的 19 个 spec 无一改动）。
4. 手工核对截图：暗色下侧栏 / tab 条 / markdown / 语法高亮 / 图标对比度正常；OS 切换即时重绘。

## 5. 踩到的坑

1. **`apps/web/dist` 不是 e2e 实际用的壳**：`assetsRoot()` 先找 `packages/cli/web/`（组装产物，
   gitignore 掉的），构建后不跑 `node scripts/assemble-package.mjs`，e2e 会一直用**旧的**
   `index.html`——症状是 `data-scheme` 恒为 `null`，新代码像是完全没生效。改了壳必须重新组装
   （`pnpm build` 不会代劳）。
2. **Playwright 的 `colorScheme` 改变不触发 `change` 事件的重绘断言要 `expect.poll`**：
   `emulateMedia` 是异步到达页面的，同步断言会与旧值竞争。
3. **`mod+alt+t` 在真 Mac 上是组合键**（`⌘⌥T` 产生 `†`）：内核对 `alt` 绑定已有物理键
   `code` 兜底（m4/spec §16），这里直接受益；e2e 走 CDP 合成不经过组合，测不出这个问题——
   别把「e2e 绿」当成「真机没问题」的证据，回归那条历史教训仍然成立。
4. **`Themes.set()` 先 `paint()` 再写 hash**：paint 会解析 scheme 并写 storage；顺序反了，
   `index.html` 在下一次 reload 之前拿不到 scheme。而 hash 写在 paint 后是为了 hash 的
   `onChange`（back/forward）回来时 `set()` 不重入（值相同则短路）。
5. **Cordis 对未提供服务的读取会抛**：`theme` piece 与 `help` / `palette` 同样要在 server 半边
   用 `try { ctx.theme } catch { return }`——它 `inject: ['slots']`，`ctx.theme` 是 client 树才有的。

## 6. 边界与以后

- **不做**：页面内常驻的主题切换按钮（O8：开关归命令，palette 就是入口）；`.gitignore` 式的
  每目录主题；服务端偏好同步（K14 签名未定）；`i18n`（P9 剩下的那一半）。
- **第三方主题的发现**：外部插件（`~/.diorama/plugins`）仍在 contract §9 的推迟范围里；本次
  预留的是**注册面**（`ctx.theme.register`），谁调用它不限于内置插件。
- **token 集合是契约的一部分**（§5.3）：加 token = light 与 dark 两处一起加 + 契约表补一行；
  主题只会覆盖存在的 token，不存在的键静默无害。
