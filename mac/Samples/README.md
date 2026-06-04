# Samples

MDGEM 的示例与模板文件,用来演示查看器对各类文件的预览能力。

## 结构

```
Samples/
├── README.md          这个文件
├── test-sample.md     主示例文档(make open-sample 打开它)
└── templates/         各类受支持格式的模板文件
    ├── document.md    Markdown 文档模板
    ├── webpage.html   HTML 页面模板
    ├── config.json    JSON 配置模板
    ├── styles.css     CSS 样式模板
    ├── app.js         JavaScript 模板
    ├── types.ts       TypeScript 模板
    ├── script.py      Python 模板
    ├── main.go        Go 模板
    ├── main.rs        Rust 模板
    ├── Main.java      Java 模板
    ├── Example.swift  Swift 模板
    ├── notes.txt      纯文本模板
    └── diagram.svg    SVG 矢量图(作为图片预览)
```

## 查看器支持的预览方式

| 类型 | 预览方式 |
|------|----------|
| Markdown (`.md`) | 正文渲染(markdown-it + 高亮 + 公式 + 流程图) |
| 图片 / 视频 / HTML | 直接用对应标签呈现 |
| 文本 / 代码 | highlight.js 高亮(≤ 2 MB) |
| 其它 | 「暂不支持预览」卡片 + 外部打开按钮 |

点开 `templates/` 里任意文件即可看到对应的预览效果。
