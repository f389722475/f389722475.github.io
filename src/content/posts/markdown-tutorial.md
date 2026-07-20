---
title: Markdown 教程
published: 2025-01-20T00:00:00.000Z
pinned: true
description: 一个简单的 Markdown 博客文章示例。
tags:
  - Markdown
  - 博客
category: 示例
licenseName: 未授权
author: emn178
sourceLink: https://github.com/emn178/markdown
draft: false
updated: 2026-07-20T02:28:44.057Z
---

# Markdown 教程

这个 Markdown 示例展示如何编写 Markdown 文件。本文整合了核心语法与扩展语法（GFM）。

- [块级元素](#块级元素)
  - [段落与换行](#段落与换行)
  - [标题](#标题)
  - [引用块](#引用块)
  - [列表](#列表)
  - [代码块](#代码块)
  - [水平分隔线](#水平分隔线)
  - [表格](#表格)
- [行内元素](#行内元素)
  - [链接](#链接)
  - [强调](#强调)
  - [代码](#代码)
  - [图片](#图片)
  - [删除线](#删除线)
- [其他语法](#其他语法)
  - [自动链接](#自动链接)
  - [反斜杠转义](#反斜杠转义)
- [行内 HTML](#行内-html)

## 块级元素

### 段落与换行

#### 段落

HTML 标签：`<p>`

使用一个或多个空行分隔段落。（只包含**空格**或**制表符**的行也会被视为空行。）

代码：

    This will be
    inline.

    This is second paragraph.

预览：

---

这两行会显示
在同一行中。

这是第二个段落。

---

#### 换行

HTML 标签：`<br />`

在一行末尾添加**两个或更多空格**。

代码：

    This will be not
    inline.

预览：

---

这两行不会  
显示在同一行中。

---

### 标题

Markdown 支持两种标题样式：Setext 和 atx。

#### Setext

HTML 标签：`<h1>`、`<h2>`

使用任意数量的**等号（=）**作为“下划线”表示 `<h1>`，使用**连字符（-）**表示 `<h2>`。

代码：

    This is an H1
    =============
    This is an H2
    -------------

预览：

---

# 这是一级标题

## 这是二级标题

---

#### atx

HTML 标签：`<h1>`、`<h2>`、`<h3>`、`<h4>`、`<h5>`、`<h6>`

在行首使用 1 至 6 个**井号（#）**，分别对应 `<h1>` 至 `<h6>`。

代码：

    # This is an H1
    ## This is an H2
    ###### This is an H6

预览：

---

# 这是一级标题

## 这是二级标题

###### 这是六级标题

---

也可以选择用井号“闭合”atx 样式的标题。结尾井号的数量**无需与**开头井号的数量一致。

代码：

    # This is an H1 #
    ## This is an H2 ##
    ### This is an H3 ######

预览：

---

# 这是一级标题

## 这是二级标题

### 这是三级标题

---

### 引用块

HTML 标签：`<blockquote>`

Markdown 使用电子邮件风格的 **>** 字符创建引用块。将文本手动换行，并在每一行前加上 >，可以获得最佳效果。

代码：

    > This is a blockquote with two paragraphs. Lorem ipsum dolor sit amet,
    > consectetuer adipiscing elit. Aliquam hendrerit mi posuere lectus.
    > Vestibulum enim wisi, viverra nec, fringilla in, laoreet vitae, risus.
    >
    > Donec sit amet nisl. Aliquam semper ipsum sit amet velit. Suspendisse
    > id sem consectetuer libero luctus adipiscing.

预览：

---

> 这是一个包含两个段落的引用块。第一段用于演示
> 多行引用文本的显示方式。每行都以引用符号开头，
> 因此它们会被渲染在同一个引用块中。
>
> 这是引用块中的第二个段落。
> 空引用行会将两个段落分开。

---

Markdown 允许使用简写方式：对于手动换行的段落，只需在第一行前添加 >。

代码：

    > This is a blockquote with two paragraphs. Lorem ipsum dolor sit amet,
    consectetuer adipiscing elit. Aliquam hendrerit mi posuere lectus.
    Vestibulum enim wisi, viverra nec, fringilla in, laoreet vitae, risus.

    > Donec sit amet nisl. Aliquam semper ipsum sit amet velit. Suspendisse
    id sem consectetuer libero luctus adipiscing.

预览：

---

> 这是一个包含两个段落的引用块。第一段用于演示
> 手动换行的引用文本。即使后续行没有显式的引用符号，
> 它们仍会被渲染在同一个引用块中。

> 这是引用块中的第二个段落。
> 后续行同样无需重复添加引用符号。

---

通过增加 > 的层级，可以嵌套引用块（即在引用块中再放入引用块）。

代码：

    > This is the first level of quoting.
    >
    > > This is nested blockquote.
    >
    > Back to the first level.

预览：

---

> 这是第一层引用。
>
> > 这是嵌套引用。
>
> 返回第一层引用。

---

引用块中可以包含其他 Markdown 元素，包括标题、列表和代码块。

代码：

    > ## This is a header.
    >
    > 1.   This is the first list item.
    > 2.   This is the second list item.
    >
    > Here's some example code:
    >
    >     return shell_exec("echo $input | $markdown_script");

预览：

---

> ## 这是一个标题。
>
> 1.  这是第一个列表项。
> 2.  这是第二个列表项。
>
> 下面是一些示例代码：
>
>     return shell_exec("echo $input | $markdown_script");

---

### 列表

Markdown 支持有序（编号）列表和无序（项目符号）列表。

#### 无序列表

HTML 标签：`<ul>`

无序列表可以使用**星号（\*）**、**加号（+）**或**连字符（-）**。

代码：

    *   Red
    *   Green
    *   Blue

预览：

---

- 红色
- 绿色
- 蓝色

---

等同于：

代码：

    +   Red
    +   Green
    +   Blue

以及：

代码：

    -   Red
    -   Green
    -   Blue

#### 有序列表

HTML 标签：`<ol>`

有序列表使用数字加句点：

代码：

    1.  Bird
    2.  McHale
    3.  Parish

预览：

---

1.  伯德
2.  麦克海尔
3.  帕里什

---

编写类似下面的内容时，可能会意外触发有序列表：

代码：

    1986. What a great season.

预览：

---

1986. 多么精彩的赛季。

---

可以用**反斜杠（\\）转义**句点：

代码：

    1986\. What a great season.

预览：

---

1986\. 多么精彩的赛季。

---

#### 缩进

##### 引用块

要在列表项中放置引用块，需要缩进引用块的 > 分隔符：

代码：

    *   A list item with a blockquote:

        > This is a blockquote
        > inside a list item.

预览：

---

- 包含引用块的列表项：

  > 这是列表项
  > 内部的引用块。

---

##### 代码块

要在列表项中放置代码块，需要将代码块缩进两级，即 **8 个空格**或**两个制表符**：

代码：

    *   A list item with a code block:

            <code goes here>

预览：

---

- 包含代码块的列表项：

      <code goes here>

---

##### 嵌套列表

代码：

    * A
      * A1
      * A2
    * B
    * C

预览：

---

- A
  - A1
  - A2
- B
- C

---

### 代码块

HTML 标签：`<pre>`

将代码块的每一行至少缩进 **4 个空格**或 **1 个制表符**。

代码：

    This is a normal paragraph:

        This is a code block.

预览：

---

这是一个普通段落：

    This is a code block.

---

代码块会一直延续到遇见未缩进的行（或文章结尾）为止。

在代码块中，**_与号（&）_**和**尖括号（< 与 >）**会自动转换为 HTML 实体。

代码：

        <div class="footer">
            &copy; 2004 Foo Corporation
        </div>

预览：

---

    <div class="footer">
        &copy; 2004 Foo Corporation
    </div>

---

下面的围栏代码块和语法高亮属于扩展语法，可用于以另一种方式编写代码块。

#### 围栏代码块

只需用 ` ``` ` 包住代码（如下所示），就无需再缩进四个空格。

代码：

    Here's an example:

    ```
    function test() {
      console.log("notice the blank line before this function?");
    }
    ```

预览：

---

下面是一个示例：

```
function test() {
  console.log("notice the blank line before this function?");
}
```

---

#### 语法高亮

在围栏代码块中添加可选的语言标识符，即可启用语法高亮（参见[支持的语言](https://github.com/github/linguist/blob/master/lib/linguist/languages.yml)）。

代码：

    ```ruby
    require 'redcarpet'
    markdown = Redcarpet.new("Hello World!")
    puts markdown.to_html
    ```

预览：

---

```ruby
require 'redcarpet'
markdown = Redcarpet.new("Hello World!")
puts markdown.to_html
```

---

### 水平分隔线

HTML 标签：`<hr />`
在单独一行中放置**三个或更多连字符（-）、星号（\*）或下划线（\_）**。连字符或星号之间可以加入空格。

代码：

    * * *
    ***
    *****
    - - -
    ---------------------------------------
    ___

预览：

---

---

---

---

---

---

---

---

### 表格

HTML 标签：`<table>`

这是扩展语法。

使用**竖线（|）**分隔列、使用**连字符（-）**分隔表头，并使用**冒号（:）**设置对齐方式。

两侧的**竖线（|）**和对齐标记均可省略。用于分隔表头时，每个单元格至少需要 **3 个分隔符**。

代码：

```
| Left | Center | Right |
|:-----|:------:|------:|
|aaa   |bbb     |ccc    |
|ddd   |eee     |fff    |

 A | B
---|---
123|456


A |B
--|--
12|45
```

预览：

---

| 左对齐 | 居中 | 右对齐 |
| :--- | :----: | ----: |
| aaa  |  bbb   |   ccc |
| ddd  |  eee   |   fff |

| A   | B   |
| --- | --- |
| 123 | 456 |

| A   | B   |
| --- | --- |
| 12  | 45  |

---

## 行内元素

### 链接

HTML 标签：`<a>`

Markdown 支持两种链接样式：行内链接和引用链接。

#### 行内链接

行内链接的格式如下：`[链接文本](URL "标题")`

标题是可选的。

代码：

    This is [an example](http://example.com/ "Title") inline link.

    [This link](http://example.net/) has no title attribute.

预览：

---

这是一个[示例](http://example.com/ "标题")行内链接。

[这个链接](http://example.net/)没有标题属性。

---

如果引用的是同一服务器上的本地资源，可以使用相对路径：

代码：

    See my [About](/about/) page for details.

预览：

---

详情请参阅我的[关于](/about/)页面。

---

#### 引用链接

可以预先定义链接引用，格式如下：`[id]: URL "标题"`

标题同样是可选的。引用链接时，格式如下：`[链接文本][id]`

代码：

    [id]: http://example.com/  "Optional Title Here"
    This is [an example][id] reference-style link.

预览：

---

[id]: http://example.com/ "此处为可选标题"

这是一个[示例][id]引用式链接。

---

具体来说：

- 方括号中包含链接标识符（**不区分大小写**，可以选择从左边距缩进最多三个空格）；
- 后面跟一个冒号；
- 再跟一个或多个空格（或制表符）；
- 再跟链接的 URL；
- 链接 URL 可以选择用尖括号包围；
- 最后可以选择添加标题属性，并用双引号、单引号或圆括号包围。

以下三种链接定义等效：

代码：

    [foo]: http://example.com/  "Optional Title Here"
    [foo]: http://example.com/  'Optional Title Here'
    [foo]: http://example.com/  (Optional Title Here)
    [foo]: <http://example.com/>  "Optional Title Here"

使用一对空方括号时，链接文本本身会被用作名称。

代码：

    [Google]: http://google.com/
    [Google][]

预览：

---

[Google]: http://google.com/

[Google][]

---

### 强调

HTML 标签：`<em>`、`<strong>`

Markdown 将**星号（\*）**和**下划线（\_）**作为强调标记。使用**单个分隔符**会生成 `<em>`；使用\*_两个分隔符_会生成 `<strong>`。

代码：

    *single asterisks*

    _single underscores_

    **double asterisks**

    __double underscores__

预览：

---

_单个星号_

_单个下划线_

**两个星号**

**两个下划线**

---

如果在 \* 或 \_ 两侧添加空格，它们会被视为普通的星号或下划线字符。

可以使用反斜杠对其进行转义：

代码：

    \*this text is surrounded by literal asterisks\*

预览：

---

\*这段文本被普通星号包围\*

---

### 代码

HTML 标签：`<code>`

使用**反引号（`）**将内容包围起来。

代码：

    Use the `printf()` function.

预览：

---

使用 `printf()` 函数。

---

要在行内代码中包含普通反引号字符，可以使用**多个反引号**作为开头和结尾的分隔符：

代码：

    ``There is a literal backtick (`) here.``

预览：

---

``这里有一个普通反引号（`）。``

---

包围行内代码的反引号分隔符内侧可以包含空格，即开头分隔符之后一个、结尾分隔符之前一个。这样便可在行内代码的开头或结尾放置普通反引号字符：

代码：

    A single backtick in a code span: `` ` ``

    A backtick-delimited string in a code span: `` `foo` ``

预览：

---

行内代码中的单个反引号：`` ` ``

行内代码中由反引号包围的字符串：`` `foo` ``

---

### 图片

HTML 标签：`<img />`

Markdown 的图片语法与链接语法相似，也支持行内和引用两种样式。

#### 行内图片

行内图片语法如下：`![替代文本](URL "标题")`

标题是可选的。

代码：

    ![Alt text](/path/to/img.jpg)

    ![Alt text](/path/to/img.jpg "Optional title")

预览：

---

![替代文本](https://s2.loli.net/2024/08/20/5fszgXeOxmL3Wdv.webp)

![替代文本](https://s2.loli.net/2024/08/20/5fszgXeOxmL3Wdv.webp "可选标题")

---

具体来说：

- 一个感叹号：!；
- 后面跟一对方括号，其中包含图片的替代文本；
- 再跟一对圆括号，其中包含图片的 URL 或路径，以及一个可选的标题属性；标题属性使用双引号或单引号包围。

#### 引用图片

引用式图片语法如下：`![替代文本][id]`

代码：

    [img id]: https://s2.loli.net/2024/08/20/5fszgXeOxmL3Wdv.webp  "Optional title attribute"
    ![Alt text][img id]

预览：

---

[img id]: https://s2.loli.net/2024/08/20/5fszgXeOxmL3Wdv.webp "可选标题属性"

![替代文本][img id]

---

### 删除线

HTML 标签：`<del>`

这是扩展语法。

GFM 添加了用于给文本添加删除线的语法。

代码：

```
~~Mistaken text.~~
```

预览：

---

~~错误文本。~~

---

## 其他语法

### 自动链接

Markdown 支持一种快捷方式，可为 URL 和电子邮件地址创建“自动”链接：只需用尖括号包围 URL 或电子邮件地址即可。

代码：

    <http://example.com/>

    <address@example.com>

预览：

---

<http://example.com/>

<address@example.com>

---

GFM 会自动为标准 URL 添加链接。

代码：

```
https://github.com/emn178/markdown
```

预览：

---

https://github.com/emn178/markdown

---

### 反斜杠转义

Markdown 允许使用反斜杠转义来生成普通字符；这些字符原本在 Markdown 格式语法中具有特殊含义。

代码：

    \*literal asterisks\*

预览：

---

\*普通星号\*

---

Markdown 为以下字符提供反斜杠转义：

代码：

    \   backslash
    `   backtick
    *   asterisk
    _   underscore
    {}  curly braces
    []  square brackets
    ()  parentheses
    #   hash mark
    +   plus sign
    -   minus sign (hyphen)
    .   dot
    !   exclamation mark

## 行内 HTML

对于 Markdown 语法未涵盖的标记，可以直接使用 HTML。无需添加前缀或分隔符来表明从 Markdown 切换到了 HTML，只需直接使用标签即可。

代码：

    This is a regular paragraph.

    <table>
        <tr>
            <td>Foo</td>
        </tr>
    </table>

    This is another regular paragraph.

预览：

---

这是一个普通段落。

<table>
    <tr>
        <td>Foo</td>
    </tr>
</table>

这是另一个普通段落。

---

请注意，Markdown 格式语法**不会在块级 HTML 标签内处理**。

与块级 HTML 标签不同，Markdown 语法**会在行内级标签中处理**。

代码：

    <span>**Work**</span>

    <div>
        **No Work**
    </div>

预览：

---

<span>**会生效**</span>

<div>
  **不会生效**
</div>
***
