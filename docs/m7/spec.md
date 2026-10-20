# 实施说明：图标（文件类型 + 功能按钮）

> 记录于 2026-10-20。用户要求：**调研开源图标库，找一个合适的。文件树需要文件类型图标，各种功能按钮也要图标。**
> 契约不变（contract 仍是 v0.8，§5.2 补了一段说明）；能力档位见 [features.md](../features.md)。

## 1. 调研与结论

| 候选 | 许可 | 形态 | 结论 |
|---|---|---|---|
| **Tabler Icons**（`@tabler/icons`） | MIT | 5,184 个 24×24 描边 glyph，`tabler-nodes-outline.json` 直接给路径数据 | **按钮用它**。MIT + 描边风格与本仓库 UI 同族；数据文件本身就是「路径节点 JSON」，生成表不需要 React |
| **Material Icon Theme**（VS Code 最流行的文件图标主题，~14M 安装） | MIT | 1,251 个彩色 SVG + 三张映射表（文件名 / 扩展名 / 目录名） | **文件/文件夹用它**。用户明确选了「文件用彩色」；它的价值不在画工而在**映射表**——`.ts` / `package.json` / `src` 各认什么图标是社区十年积累 |
| Lucide | ISC | 1,600+ 描边，React 包 36 MB | 按钮的备选。ISC 许可比 MIT 宽松但偏门；文件类型覆盖几乎没有（`File*` 是形状，不是语义） |
| lucide-react / @tabler/icons-react / @phosphor-icons/react | MIT | React 组件包（17–36 MB） | **不采用**：本页面一个半边 = 一份自包含 bundle，组件库会被复制进每个半边与壳（见 §3） |
| vscode-icons（`@iconify-json/vscode-icons`） | MIT | 1,711 个彩色 SVG + iconify 映射 | 文件图标的备选。命名不规范（`file-type-png` 不存在，png 叫别的），精选成本更高；Material 主题的映射表更完整 |
| react-icons | MIT | 88 MB 聚合包 | 不采用：聚合多个来源，体积与树摇都不如直接用源 |

**结论（用户拍板）：按钮 = Tabler 单色描边；文件/文件夹 = Material Icon Theme 彩色。**
两套都是 MIT，都只作为**仓库根的 devDependencies**——产物是生成出来提交的（§2），构建、测试、运行都不碰这两个包。

## 2. 形态：一份生成数据，两个读法

```
scripts/generate-icons.mjs          # 生成器（pnpm icons）
packages/ui/src/icons/
  button-icons.ts                   # 26 个按钮 glyph：语义名 → 24×24 描边路径（Tabler）
  file-icons.ts                     # 119 文件 + 76 文件夹 glyph（Material）+ 三张映射表
  page.ts                           # 读法：iconSvg / FileIcon / fileGlyph（每个半边 bundle 这一份）
  Icon.tsx                          # <Icon name/> 与 <FileIcon name/> 两个组件
install.ts                          # 装表（只有 shell import，见 §3）
```

- **精选，不整包搬**：Material 主题全量是 1,251 glyph / 87 KB 映射；这里按「这个查看器会遇到的名字」精选
  195 个 glyph、~800 个扩展名、~890 个文件名、~1,280 个目录名（按 glyph 分行后 35 KB）。
  生成器里两个清单就是全部取舍，加图标 = 在清单里加一个名字 + `pnpm icons`。
- **按钮图标用语义名**（`close` / `reload` / `caret-right` / `whole-word`…），不直接写 Tabler 的画名：
  换画工是一处改动，调用点不追着改名。
- **保留主题原色**：Material 的 SVG 是带 `fill="#..."` 的彩色插画；原样内联（id 加前缀防两个渐变撞车），
  大小由 CSS 决定。文件夹每对都有 `-open` 兄弟 glyph，树的展开态换画。
- **按钮描边继承文字色**：Tabler 路径不写颜色，`<svg stroke="currentColor">`——按钮 hover、激活、禁用
  全部由现有 CSS 管，图标不需要自己的状态。

## 3. 关键决定：插画是页面数据，不是模块导入

一个 client 半边是**自包含 closure**（m0/spec §10.3）：import 什么就把什么 bundle 进去，每个半边一份。
`diorama-ui` 被所有半边 import——若图标表走普通模块路径，~170 KB 插画会被复制进 8 个半边再加壳。

所以照页面桥（`__diorama_page__`）、reveal store、overlay store 的同一条路走：

- shell 在 boot 第一步 `installIcons()`：构建表、发布到页面全局 `__diorama_icons__`；
- 每个半边 bundle 的只是 `page.ts` 这个小读法（~4 KB）；
- `diorama-ui` 的 tsdown 出两个入口：`index`（原语）与 `icons`（插画 + 装表），`exports` 里 `./icons`
  单独导出——**只有 shell import `diorama-ui/icons`**，这是物理边界而不是口头约定。

实测：壳 gzip 86 KB → 127 KB（+41 KB，插画 + 图标组件 + 样式），8 个半边每个只 +1–2 KB（读法 + 调用点）。
「每半边复制一份插画」的路线会是 8 × ~40 KB，这笔账在这里不成立。

**没有表也不会坏**：`iconSvg` 返回 `''`（切换器退回 title 首字，即 §5.2 原有缺省），
`FileIcon` 落到中性 fallback glyph（主题的 generic file/folder 画法）。单测就是这么覆盖的——
图标是装饰，缺表必须不抛错、不出白列。

## 4. 落点（按界面）

| 界面 | 图标 |
|---|---|
| 文件树 | 每行文件/目录按主题映射出彩色 glyph；目录随展开态换 `-open` 画；展开箭头 `caret-right` / `caret-down`（Tabler），文件行不再有假箭头占位；「加载更多」前加下箭头 |
| tab 条 | 标签前是文件类型 glyph（与树同源，认得出是同一个文件）；关闭按钮 `×` 文字 → `close` 图标 |
| 侧栏切换器 | 四个视图换 Tabler 家族（`files` / `git-changes` / `git-history` / `search`），从各自手写的 16×16 SVG 统一到页面按钮表；`icon` 字段机制不变 |
| 搜索视图 | 「内容/文件名」「Aa/词/.*」五个开关文字 → `file-text` / `files` / `text-case` / `whole-word` / `regex`（aria-label 保留中文）；结果文件行加类型 glyph；分组折叠箭头同树 |
| 变更/历史视图 | 行内文件类型 glyph + 原有 M/A/D/U 状态徽标（两层信息并存）；目录行用目录 glyph；「刷新」→ `reload` 图标（aria-label 保留）；「加载更多」加下箭头；提交说明折叠箭头统一 |
| HTML 渲染器 | 头部文件 glyph；「预览/源码」加 `eye` / `code` 前缀（文字保留）；「停止执行/执行脚本并预览」加 `stop` / `play` |
| 文件树/搜索的空目录行 | 与树同源的目录 glyph |

**无障碍规则**：图标一律 `aria-hidden`；按钮换掉文字的地方补 `aria-label`（中文原文），文字保留的地方
文字本身就是可访问名。e2e 的 testid 与文字断言全部未动。

## 4.1 长什么样

| | |
|---|---|
| ![文件树与 tab 条的文件类型图标](tree.png) | 树、tab 条：文件类型 glyph（Markdown / TS / CSS / JSON / SVG / git 专用…），目录随展开态换画，展开箭头是同族描边图标 |
| ![变更视图：文件图标 + 状态徽标](changes.png) | 变更视图：彩色类型 glyph 与 M/A/D 徽标并存；刷新按钮是图标（aria-label 保留） |
| ![搜索视图的图标开关](search.png) | 搜索视图：模式/大小写/全字/正则开关全部图标化，结果行带类型 glyph |

## 5. 验收

单测 9 条（`packages/ui/test/icons.test.ts`，进根 `test:unit`）：
整名压过扩展名、复合扩展名最长优先（`a.d.ts`）、dotfile 无扩展名、无表全部走 fallback 不抛错、
目录 `-open` 兄弟、未知文件落 generic、`iconSvg` 形状与空串、安装表对真实仓库文件（`.ts` / `package.json` /
`diorama.toml` / `src/`）给出预期 glyph。

四件套全绿（2026-10-20）：`pnpm build`、`pnpm test:unit`（167 条）、`pnpm -r --no-sort run typecheck`、
`pnpm --filter diorama-web exec playwright test`（89 条，选择器未改）。

## 6. 踩到的坑

1. **`.tsx` 的主题映射是 `react_ts` 不是 `typescript`**——主题把 React 系扩展指到带 React 标记的
   variant。生成表照抄主题（那是它的语义），断言按主题写；想要统一成 `typescript` 应该在生成器里改映射，
   不是在运行时特判。
2. **渐变 id 撞车**：主题文件里的 `<linearGradient id="a">`（kotlin、maven）原样内联后，两个图标共用
   `#a` 会互相串色。生成器按 glyph 加前缀（`id` / `url(#)` / `href` 三处）。
3. **少数画以根属性承重**：`typescript.svg` 的 `xml:space="preserve"` 若被剥掉会改变字形。生成器保留
   根上的非命名空间属性（`attrs` 字段），只剥 `xmlns` / `viewBox` / `width` / `height`。
4. **精选清单里有名字在主题里不存在**（`folder-assets` 在 5.39 里叫 `folder-resource`）——生成器
   fail loud，而不是静默少一个 glyph；这是「表是生成物」最要紧的一条。
5. **`node --test` 只认 `.ts`**：图标单测 import 的是 `page.ts` / `install.ts`（纯数据 + 纯函数），
   不碰 `Icon.tsx`；组件层由 e2e 覆盖（m4/spec §12 的同一条规则）。
