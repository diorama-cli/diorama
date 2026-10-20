# Diorama

> A live diorama of your files.

在任意目录执行一条命令，这个目录就变成浏览器里一个可以走进去看的场景。代码文件有语法高亮，Markdown 会被渲染，之后还会有 git diff——每一样能力都是场景里的一块景片，装上插件就多一块。

**状态**：M0 完成（左树右文、单 tab、5 条验收全绿），见 [M0 实现说明](docs/m0/spec.md)。

## 为什么叫 Diorama

`diorama` 来自希腊语 **dia-**（穿过）+ **horama**（所见），本义是"透过一个窗口看到的景象"。1822 年 Daguerre 在巴黎造的同名装置，让人坐进暗室，看巨幅画面随光线变化而"活"起来——常被视为电影的前身。

这个名字同时说了两件事：

- **你能看见什么**：一条命令，目录变成一个可看、可走的场景。这是功能。
- **它是怎么来的**：场景不是画出来的，是一块块景片搭出来的——高亮一块、Markdown 一块、diff 一块。这是扩展。

它不是"一个能扩展的文件服务器"，而是"一幅由许多块组成的画面"。功能和扩展在同一个词里，谁也不压过谁。

## 品牌小件

| 项 | 值 |
|---|---|
| 命令 | `diorama` |
| 配置 | `diorama.toml` |
| 插件 | **piece**（一块景片） |
| 一组插件 | **scene** |
| Slogan | A live diorama of your files. / 把你的目录，摆成一个场景。 |

```bash
# 发布版：从 npm 安装，命令名是 diorama
npm install -g @diorama-cli/diorama
diorama .                                   # 目录 → 浏览器里的场景

# 开发版（本仓库）：link 进来后命令名是 diorama-beta，永不覆盖已安装的 diorama
pnpm install && ./link.sh
diorama-beta .                              # 目录 → 浏览器里的场景（打开打印出的 URL）
diorama-beta . --port 8080 --host 127.0.0.1
diorama-beta ls                             # 目录 → URL → 状态
diorama-beta gateway start|stop|status|restart
```

`link.sh` 用 `npm link` 把本仓库 `packages/cli` 接到 npm 全局 bin（nvm 装 node 时可写）；它
**只**创建 `diorama-beta`，并移除同一 checkout 产生的 `diorama` 软链——`diorama` 这个名字留给
registry 安装。

两个版本默认**互不干扰**：beta 的 gateway 用 `$DIORAMA_HOME/diorama-beta.sock`、
`gateway-beta.pid`、`gateway-beta.log`；发布版用 `diorama.sock`、`gateway.pid`、`gateway.log`。
`diorama-beta ls` 看不到发布版的挂载，反之亦然（契约 §7.1/§7.4）。

发布版是**一个包**：内核、UI 原语与 15 个内置插件都内联在里面，装完即可用，不需要再装插件
（见 [docs/m8/spec.md](docs/m8/spec.md)）。`diorama --version` 与 gateway 报的版本取自包自己的
`package.json`。

也可以不 link：`node packages/cli/bin/diorama-beta <dir>`，或 `source ./link.sh` 只给当前
shell 加 PATH。

## 文档

- [计划](docs/plan.md) / [契约](docs/contract.md) / [架构](docs/architecture.md) / [功能清单](docs/features.md)
- [M0 实现说明](docs/m0/spec.md)：M0 确认的契约补充、实现记录与验收结果
- [命名记录](docs/naming.md)：完整候选、排除项与撞名检查
