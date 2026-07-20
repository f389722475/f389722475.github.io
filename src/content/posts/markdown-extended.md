---
title: Markdown 扩展功能
published: 2024-05-01T00:00:00.000Z
updated: 2026-07-20T02:44:37.311Z
description: 进一步了解 Mizuki 中的 Markdown 功能
tags:
  - 演示
  - 示例
  - Markdown
  - Mizuki
category: 示例
draft: false
hidden: true
---

## GitHub 仓库卡片
可以添加指向 GitHub 仓库的动态卡片。页面加载时，会从 GitHub API 获取仓库信息。

::github{repo="matsuzaka-yuki/Mizuki"}

使用代码 `::github{repo="matsuzaka-yuki/Mizuki"}` 创建 GitHub 仓库卡片。

```markdown
::github{repo="matsuzaka-yuki/Mizuki"}
```

## 提示框

支持以下类型的提示框：`note`、`tip`、`important`、`warning`、`caution`

:::note
突出显示即使快速浏览时也应注意的信息。
:::

:::tip
帮助用户更顺利完成操作的补充信息。
:::

:::important
用户成功完成操作所必需的关键信息。
:::

:::warning
因存在潜在风险而需要用户立即关注的重要内容。
:::

:::caution
某项操作可能带来的不良后果。
:::

### 基本语法

```markdown
:::note
Highlights information that users should take into account, even when skimming.
:::

:::tip
Optional information to help a user be more successful.
:::
```

### 自定义标题

提示框的标题可以自定义。

:::note[我的自定义标题]
这是一条带有自定义标题的备注。
:::

```markdown
:::note[MY CUSTOM TITLE]
This is a note with a custom title.
:::
```

### GitHub 语法

> [!TIP]
> 同样支持 [GitHub 语法](https://github.com/orgs/community/discussions/16925)。

```
> [!NOTE]
> The GitHub syntax is also supported.

> [!TIP]
> The GitHub syntax is also supported.
```

### 剧透内容

可以在文本中添加剧透内容，其中同样支持 **Markdown** 语法。

这段内容 :spoiler[已隐藏 **哎呀**]！

```markdown
The content :spoiler[is hidden **ayyy**]!
