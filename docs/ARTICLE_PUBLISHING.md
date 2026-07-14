# 文章与图片发布指南

当前阶段采用最简单、可靠的方式保存内容：**文章和图片与网站源码一起交给 Git 管理，GitHub 仓库是内容的持久化存储，GitHub Pages 负责展示构建结果。**

这种方式不需要数据库，也不需要注册、登录或在线管理后台。每次文章修改都有 Git 历史，可以查看差异或回退。

## 推荐目录结构

每篇包含图片的文章使用一个独立文件夹：

```text
src/content/posts/
└── my-first-post/
    ├── index.md
    ├── cover.webp
    └── detail.webp
```

这样文章和图片会一起移动、提交和备份，也不会依赖 GitHub Pages 的站点子路径。

## 创建文章

在项目根目录执行：

```powershell
pnpm run new-post -- my-first-post/index.md
```

然后编辑 `src/content/posts/my-first-post/index.md`。建议写作期间先设置 `draft: true`，准备发布时再改成 `draft: false`。

一个最小的 Frontmatter 示例：

```yaml
---
title: 文章标题
published: 2026-07-14
description: 文章摘要
image: "./cover.webp"
tags: [随笔]
category: 生活
draft: true
lang: zh-CN
---
```

其中 `title` 和 `published` 是必填字段。`published`、`updated` 建议统一使用 `年-月-日` 格式。

## 添加图片

把图片放进文章自己的文件夹，并使用相对路径：

```markdown
![图片说明](./detail.webp)
```

封面同样使用相对路径：

```yaml
image: "./cover.webp"
```

建议优先使用 WebP、AVIF、JPEG 或 PNG。提交前确认图片已经放入项目目录；只粘贴电脑上的绝对路径不会把图片上传到 GitHub。

## 发布前检查

依次执行：

```powershell
pnpm run content:check
pnpm run check
pnpm run build
```

`content:check` 会检查：

- 每篇文章是否包含有效的 Frontmatter；
- `title`、`published`、`updated`、`draft` 的基本格式；
- 封面和正文引用的本地图片是否真实存在。

## 提交并发布

检查本次改动，只提交准备发布的文章和图片：

```powershell
git status
git add src/content/posts/my-first-post
git commit -m "发布文章：文章标题"
git push
```

推送后，项目现有的 GitHub Actions 会重新构建网站并发布到 GitHub Pages。不要提交 `node_modules` 或 `dist`；它们不是文章源文件。

## 修改或撤回文章

- 修改：编辑 Markdown 或替换图片，再次检查、提交并推送。
- 暂时隐藏：把 `draft` 改为 `true` 后重新发布。
- 删除：删除文章目录后提交并推送；Git 历史中仍保留旧版本。

## 当前边界

目前不提供浏览器内的在线写作和图片上传功能。GitHub Pages 是静态托管服务，不能在网站运行时直接写入文件；现阶段的写作入口是本地项目，保存入口是 Git 和 GitHub。
