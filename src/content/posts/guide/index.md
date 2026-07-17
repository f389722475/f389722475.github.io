---
title: Mizuki 简明指南
published: 2024-04-01T00:00:00.000Z
description: 如何使用这个博客模板。
image: ./cover.webp
tags:
  - Mizuki
  - 博客
  - 自定义
category: 指南
draft: false
updated: 2026-07-17T04:50:28.567Z
hidden: true
---



这个博客模板使用 [Astro](https://astro.build/) 构建。本指南没有涉及的内容，可以在 [Astro 文档](https://docs.astro.build/)中查找答案。

## 文章的 Frontmatter

```yaml
---
title: My First Blog Post
published: 2023-09-09
description: This is the first post of my new Astro blog.
image: ./cover.jpg
tags: [Foo, Bar]
category: Front-end
draft: false
---
```




| 属性          | 说明                                                                                                                                                                                                        |
|---------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `title`       | 文章标题。                                                                                                                                                                                                  |
| `published`   | 文章发布日期。                                                                                                                                                                                              |
| `pinned`      | 是否将文章置顶显示在文章列表中。                                                                                                                                                                            |
| `priority`    | 置顶文章的优先级。数值越小，优先级越高（0、1、2……）。                                                                                                                                                       |
| `description` | 文章的简短说明，会显示在首页上。                                                                                                                                                                            |
| `image`       | 文章封面图片路径。<br/>1. 以 `http://` 或 `https://` 开头：使用网络图片<br/>2. 以 `/` 开头：使用 `public` 目录中的图片<br/>3. 不含上述前缀：路径相对于 Markdown 文件 |
| `tags`        | 文章标签。                                                                                                                                                                                                  |
| `category`    | 文章分类。                                                                                                                                                                                                  |
| `licenseName` | 文章内容所用的许可协议名称。                                                                                                                                                                                |
| `author`      | 文章作者。                                                                                                                                                                                                  |
| `sourceLink`  | 文章内容的来源链接或参考资料。                                                                                                                                                                              |
| `draft`       | 文章是否仍为草稿；草稿不会显示。                                                                                                                                                                            |

## 文章文件的存放位置



文章文件应放在 `src/content/posts/` 目录中。也可以创建子目录，以便更好地整理文章与资源文件。

```
src/content/posts/
├── post-1.md
└── post-2/
    ├── cover.webp
    └── index.md
```
