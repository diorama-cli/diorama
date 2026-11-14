# 实施说明：diff 双栏横划的是一整栏

> 记录于 2026-11-13。用户反馈：「diff 双栏模式，文本超出显示范围不能在栏内部左右划动」，随后又指出
> 「移动的时候每一行都出现滚动条」。这是**缺陷**，不是新能力：契约不升号（§6），没有新增服务、没有改
> `ctx.*` 的签名、没有加座位。契约正文在 **§5.2 的 diff 读法**里补一句「横划的单位是一整栏」，变更
> 清单是新写的 **§51**（标注「未发版，下一个 `0.0.x`」）。

## 1. 出发点

双栏（「新旧对照」）的每一格是行模型 `.diorama-diff__line`（m32 定下的：格子**就是**行，
`white-space: pre` 让缩进与连续空格按文件原样保留），每一格里的代码列都写着 `overflow-x: auto`
——按静态阅读，**每一行自己就能横滚**。问题在于「自己」：一行只有**一行**高。

于是读者遇到的是三件事叠在一起：

1. 一条超长的行在自己的格子里确实溢出了，`scrollWidth > clientWidth`；
2. 但那一格只有一行高，**放不下一条滚动条**；鼠标也没有可拖的东西；
3. 手势是**按元素**投递的：滚轮 / 触控板的横扫落到指针下的那一格，**只有那一行**动。

再加一条浏览器行为：**Shift + 滚轮在一个只有一行高的滚动容器里不会被翻译成横向滚动**。实测
（Chromium，Playwright `mouse.wheel(0, 240)` + Shift）wheel 事件照常到达，`scrollLeft` 一动不动。

第一版修法是「把偏移同步到同侧每一行」——能滚了，但**每行仍是一个滚动容器**，于是横划一次，
整列 N 行同时浮出 N 条滚动条（实测：10 行 → 10 个 `overflow-x: auto` 容器）。用户随即指出这一点。

## 2. 决定

| 决定 | 取值 | 为什么 |
|---|---|---|
| 滚动单位 | **一侧**（左旧 / 右新），不是整栏、也不是单行 | 两栏各自滑，中缝才能一直停在中间；整栏滑会连行号、中缝一起走，等于退回单栏 |
| 怎么滑 | 偏移存 React state（每侧一个数），代码列 `transform: translateX(...)` | 不制造任何滚动容器，就没有任何滚动条；一列 N 行共用**一个**数，天然对齐 |
| 格子怎么处理溢出 | `overflow: hidden`（**不是** `auto`） | 格子只负责把超出的文字裁掉；可滚的是「这一侧」，不是这一格 |
| 谁接手势 | 双栏读者在根元素上监听 `wheel`（`passive: false`） | 行是随 diff 重画的，逐行挂监听器每次都要重挂；委托给根一次挂好 |
| 手势怎么算 | `deltaX` 优先；为 0 且按住 Shift 时用 `deltaY` | 触控板的横扫是 `deltaX`；鼠标的横扫是 Shift+滚轮（浏览器在格子里不翻译，自己算） |
| 能滑多远 | 该侧最长那行的 `scrollWidth - clientWidth`（现量） | 只有浏览器知道文本实际排出来多宽；夹在 `[0, 上限]` |
| 行号 | 在 transform **外面** | 行号不跟着滑，这是「整侧在固定的行号下面滑动」的那一半 |

## 3. 实现

### 3.1 组件（`packages/plugins/git-changes/src/index.tsx`）

`SplitFile` 用 `useColumnPan()`，它返回三样东西：挂到读者根上的 `ref`、`pan(side, delta)`、
以及每侧当前的偏移。每一格多一个 `data-side`（0 = 旧，1 = 新），代码列带上当前侧的偏移：

```tsx
const offsetStyle = offsets[side] === 0 ? undefined : { '--dio-split-shift': `-${offsets[side]}px` }
```

`wheel` 监听在读者根上（委托，一次挂好）：

```ts
const delta = event.deltaX !== 0 ? event.deltaX : event.shiftKey ? event.deltaY : 0
const side = sideOf(event.target)          // 最近的 .diorama-diff__split-cell 的 data-side
if (limit(side) <= 0) return               // 没有可滑的余地：手势留给读者（纵向滚）
event.preventDefault()
pan(side, delta)
```

### 3.2 样式（`packages/ui/src/styles.css`）

```css
.diorama-diff__split-cell {
  min-width: 0;
  padding: 0;
  overflow: hidden;      /* 裁掉超出，不制造滚动条 */
}

.diorama-diff__split-cell .diorama-diff__code {
  min-width: 0;
  transform: translateX(var(--dio-split-shift, 0));
}
```

`display` / `align-items: baseline` / `white-space: pre` 仍全部由行模型提供（m32 的规则不动）。

## 4. 测试

`apps/web/tests/m37-diff-split-scroll.spec.ts`，两条，都量几何与手势：

1. **长行被自己的栏裁掉**：读者自身 `scrollWidth <= clientWidth`；读者内部**没有任何**
   `overflow-x: auto|scroll` 的元素（**这一条就是「每行一条滚动条」的回归**）；每格宽 ≤ 半行、不越界；
   格子 `overflow-x: hidden` 且 `scrollWidth > clientWidth`。
2. **横划滑的是整侧，行号不动**：在超长行上横扫后，**同一侧多于一格**的 `transform` 位移相同且为负；
   行号的位移是 0；再按 Shift+滚轮，位移继续增大而**动的格数不变**；读者自身 `scrollLeft === 0`。

两条都在旧做法（每格 `overflow-x: auto` + 逐行同步）的构建上跑过对照：第 1 条数出 **10 个**横向
滚动容器（10 行 → 10 条滚动条），第 2 条位移全是 0。这正是用户先后报告的两个现象。

## 5. 验证

```bash
pnpm build
pnpm test:unit                                   # 524 条
pnpm -r --no-sort run typecheck
node scripts/assemble-package.mjs                # e2e 跑的是组装产物
pnpm --filter diorama-web exec playwright test
```

## 6. 坑

1. **`overflow-x: auto` 在一个只有一行高的盒子里就是「每行一条滚动条」**。它确实可滚
   （`scrollLeft` 能改），但每一行都是独立容器：横划一次，整列 N 行同时浮出 N 条。
   「能滚」不等于「像一栏在滚」。
2. **Shift+滚轮在格子里不会被浏览器翻译**。第一版把希望寄托在浏览器的横向翻译上，实测事件到了、
   什么都没动；`preventDefault` + 自己改偏移才有反应。
3. **量「滑了没有」要量 `transform` 的 `m41`，不是量盒子**。用 `scrollLeft` 的那一版里，滚动容器的
   `getBoundingClientRect()` 一像素不动（滚的是内容）；现在根本没有滚动容器，只能读 `transform`。
4. **偏移必须夹在该侧最长行的溢出宽度里**。用「当前这一格」的宽度算，短行会把它夹成 0，整侧滑到
   一半就卡住；用同侧所有行的最大值，短行只是被裁掉更多。
5. **改 `styles.css` 或壳要重装**（m32/spec §6 坑 3 同一条）：e2e 的 CSS 来自 `packages/cli/web/`，
   `pnpm build` 只刷 `apps/web/dist`。
