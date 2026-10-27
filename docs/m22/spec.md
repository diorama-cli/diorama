# 实施说明：默认主题写在配置文件里（`[ui] theme`）

> 记录于 2026-10-27。用户要求：**支持在配置文件中设置默认主题**。契约不升号（§6）：没有新增
> 服务、没有改 `ctx.*` 的签名、没有加座位——变的是 `diorama.toml` 的一张新表（`[ui] theme`）、
> `diorama config` 的一个可写键，以及 `ctx.theme` 的优先级多一档。契约正文补在 §4.1 / §4.2 /
> §3.10，变更清单在 contract.md **§33**。

## 1. 出发点

主题在 v0.9（[m9/spec.md](../m9/spec.md)）落成了三档：跟随系统、锁定亮 / 暗、以及插件注册的
第三方主题。但**偏好只活在浏览器里**（`localStorage` + URL hash）。于是有一个缺口：

- 一个目录如果本来就该是暗色的（看代码、看图表），每换一台机器、每换一个浏览器，都得重新选一次；
- 分享一个链接能带上 `#theme=dark`，但那个链接指向的是**某一次选择**，不是这个目录的样子；
- 「这个仓库用暗色」这类信息属于**目录**，而 `localStorage` 属于浏览器 profile。

配置文件的其余部分（`[html] scripts`）已经在回答「这个目录该怎么被看」，主题只是它的另一面。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 放在哪 | `diorama.toml` 的新表 `[ui] theme` | 与 `[html]` 同一条：**关于「怎么看」的设置归配置**，不新开文件、不新开环境变量 |
| 是什么 | **起点，不是锁定** | 与 `[html] scripts` 的「只管起始阶段」（contract §28）同一条规矩：配置回答「打开时怎样」，不回答「读者刚点了什么」。锁定会让读者在「这个目录被钉死成暗色」时无路可走 |
| 与读者的选择 | 读者的赢 | 读者选过（palette、`mod+alt+t`、分享的 `#theme=…`）之后改文件不再动他；否则改一次文件所有人被拽走，比没有这个功能更烦 |
| 默认值 | `"system"` | 与 v0.9 完全一致：没有配置的目录行为一点不变 |
| 存进 `localStorage` 吗 | **不存**（只存解析出的 scheme） | 记住的默认值会**盖住之后改的配置**——读者把文件改成 `dark` 会看起来毫无效果。所以 `diorama.theme` 只在读者选过时存在 |
| 值的字符集 | `[A-Za-z0-9_.-]+` | 它同时是 `#theme=…` 的值和命令 id 的一部分（§3.10）；写一个 URL 里说不出来的值没有意义，读文件时就拒绝 |
| 首帧怎么拿到 | 服务端把 `light` / `dark` 注入 `window.__diorama_theme__` | 壳的内联脚本跑在任何 `fetch` 之前，配置却在 `/plugin.json` 里；只有服务端同时持有这两样东西 |
| 主题 id 也注入吗 | **不** | 一个主题属于哪个 scheme 由注册它的插件决定，壳无从得知。那种页面首帧跟随系统，服务启动后由 `ctx.theme` 重绘一次——§3.10 的「偏好可以走在注册前面」本来就允许这一帧 |

## 3. 语义细则

- **优先级**（`Themes` 的构造）：URL hash > `localStorage` > `options.fallback`（配置给的）> `system`。
  运行中最后一次 `set()` 赢，并且从那以后 `chosen = true`。
- **`chosen` 是一个显式标记**，不是「preference 与 fallback 相等」推出来的：读者选了 `dark`、文件
  也恰好写着 `dark`，两者相等但选择仍然属于读者——文件之后改成 `light` 不该把他拽走。
- **`ThemeHost.store(preference | undefined, scheme)`**：没选过时传 `undefined`，浏览器半边
  `removeItem('diorama.theme')`；scheme 照旧每次都写，壳靠它首帧上色。
- **服务端注入只认 `light` / `dark`**：`system` 等于「什么都不注入」（跟随 OS），主题 id 见上。
- **`MountHandle.config.ui.theme`**：与 `html.scripts` 同一条链路——`EffectiveConfig` →
  `MountConfig`（`shared/config.ts`）→ `createMountHandle`。服务端没给（单测、旧清单）时用
  `DEFAULT_MOUNT_CONFIG`，值来自 `shared/config.ts` 的 `DEFAULT_THEME_PREFERENCE`，与服务端
  `defaultConfig()` 是同一个常量。
- **gateway 的校验**：`mount` 请求的 `config` 现在要求带 `ui.theme`（`isUiConfig`），与
  `html.scripts` 一样——配置是 CLI 合成后整份交过去的，少一个字段就是 `EBADREQUEST`。

## 4. 改动清单

| 包 | 改动 |
|---|---|
| `kernel/src/shared/config.ts` | `MountConfig` 多 `ui.theme`；新增 `DEFAULT_THEME_PREFERENCE`、`THEME_PREFERENCE_PATTERN`（服务端与页面共用一份，不各写一个） |
| `kernel/src/server/config.ts` | `EffectiveConfig` / `FileConfig` 多 `ui`；`[ui] theme` 的校验（非空 + 字符集）；`mergeConfig`；`CONFIG_KEYS` / `UI_CONFIG_KEYS`；`readConfigValue` / `patchFileConfig` / `knownKeys` / `formatFileConfig` 都认识 `ui.*` |
| `kernel/src/server/index.ts`、`src/types.ts` | 导出 `UI_CONFIG_KEYS`、`GIT_CONFIG_KEYS`、`HTML_CONFIG_KEYS`、`DEFAULT_THEME_PREFERENCE`、`THEME_PREFERENCE_PATTERN`、`MountConfig` |
| `kernel/src/client/theme.ts` | `ThemeOptions.fallback`；`chosen` 标记；`ThemeHost.store` 收 `string \| undefined`；`browserThemeHost` 在 `undefined` 时 `removeItem` |
| `kernel/src/client/mount.ts` | `DEFAULT_MOUNT_CONFIG` 多 `ui`；`createMountHandle` 从 `/plugin.json` 的 `config.ui.theme` 取值 |
| `kernel/src/client/boot.ts` | `createThemeService({ …, fallback: handle.config.ui.theme })` |
| `kernel/src/server/http.ts` | `serveShell(options, manifest, res)`：`light` / `dark` 时注入 `window.__diorama_theme__` |
| `apps/web/index.html` | 首帧脚本多一档：`localStorage` 的 scheme → `window.__diorama_theme__` → OS |
| `cli/src/config-command.ts` | `ui.theme` 的值解析（字符集）、向导字段（`theme` 菜单）、`config show` 把子表按点号打印（`ui.theme = dark`）、usage 一行 |
| `cli/src/config-candidates.ts` | `themeCandidates()`（三项内置）+ `CandidateSource` 多 `'theme'` |
| `cli/src/gateway.ts` | `isEffectiveConfig` 多校验 `ui`（`isUiConfig`） |
| `kernel/test/config.test.ts` | 默认值、合并、`[ui] theme` 的校验 / 落盘 / 点号键 |
| `kernel/test/theme.test.ts` | 配置给的起点、不写偏好只写 scheme、读者选择与 hash 都压过它 |
| `cli/test/config-command.test.ts`、`config-menus.test.ts` | 值语法、向导问答序列多一项 |
| `apps/web/tests/m9-theme.spec.ts` | 第 6 条：`[ui] theme = "dark"` 的目录首帧就是暗色、URL 不带 `#theme`、读者选了亮色之后刷新仍是亮色 |
| `apps/web/tests/m10-config.spec.ts` | 6b：`config set --ui.theme dark` 写文件、`config show` 与 `/plugin.json` 都能读到；非法值退出码 2 且不写 |
| `apps/web/tests/support.ts` | `DEFAULT_CONFIG` 多 `ui`（控制面现在要求它） |
| `docs/contract.md` | §4.1 新表 + 字段行、§4.2 键清单与值语法、§3.10 优先级与首帧、新 **§33** |
| `docs/features.md` | C9 / C10 / U12 补一句 |

## 5. 没做的（明确）

- **按目录的 `localStorage`**（「这个浏览器里这个目录用暗色」）：那是浏览器的记忆，与配置回答的
  问题不同；要「记住」就用读者自己的选择，要「规定」就写文件。
- **服务端持久化偏好**：`ctx.storage`（K14）签名仍未定，见 §3.10 最后一条。
- **CLI 里列出主题 id 的候选**：注册表在页面里（piece 注册的），CLI 看不见它。候选只是提示，
  主题 id 靠打字——这也是外部插件（contract §9）落地后才谈得上的事。
- **`[ui]` 的其他字段**：语言（P9 的 `i18n`）以后大概率也放这里，但现在只加 `theme` 一个。

## 6. 验证

1. `pnpm build`
2. `pnpm test:unit`（381 条）
3. `pnpm -r --no-sort run typecheck`
4. `node scripts/assemble-package.mjs`，再 `pnpm --filter diorama-web exec playwright test`

## 7. 坑

1. **默认值不能写进 `localStorage`**。第一版把配置给的默认也当成「记住的偏好」存了下去，结果是
   读者把文件从 `system` 改成 `dark` 之后**什么都没发生**——记忆里的 `system` 赢了。改成
   「没选过就 `removeItem`」才对。测试里 `host.writes` 断言的是 `{ preference: undefined, … }`。
2. **`chosen` 不能从「preference 与 fallback 相等」推**：读者选了 `dark`、文件也写 `dark`，相等
   但选择属于读者。多一个布尔字段，少一类难查的回归。
3. **首帧的注入在 `serveShell`，不是壳里 fetch**。壳的内联脚本必须跑在任何网络请求之前（它就是
   为了「样式表生效前」而存在的），所以配置只能由服务端塞进 HTML。`serveShell` 因此要多收两个
   参数（`MountOptions` 与本次请求的 `manifest`）。
4. **`ui` 让「`config show` 只认 `watch`」的写法露馅**：那段代码原来特判 `key === 'watch'`，
   `[git]` / `[html]` 加进来时没人注意到它们会打印成 `[object Object]`。这次改成「任何表都按
   点号打印」，`ui.theme = dark` 与 `git.maxDepth = 3` 一起对了。
5. **向导多问一项，所有脚本化的问答序列都要多一个空行**：`config-command.test.ts` 与
   `m10-config.spec.ts` 里那些 `['', '', …].join('\n')` 是靠**位置**对齐的，漏一个就会让后面的
   答案全部错位（症状是「文件里出现了莫名其妙的 host」）。给字段加进 `FIELDS` 时一并数一遍。
