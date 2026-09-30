# 西晋通婚谱系图 · 源码结构

## 文件说明

- `export_data.py` —— 读 Excel（人物表/婚姻关系表/亲子关系表/家族及配色表），导出成 `data.json`。
  Excel 结构变了（比如换了列名、加了新的工作表）才需要改这个文件。
- `data.json` —— 纯数据，不含任何页面/样式代码。数据更新后这个文件会被重新生成。
- `core.js` —— 布局引擎。只认识"人物 ID / 婚姻类型 / 父ID母ID"这些抽象字段，不认识任何具体人名，
  不需要因为数据变化而修改。
- `app.js` —— 渲染与交互（拖拽、缩放、搜索、点击展开/收起）。同样跟具体数据无关。
- `template.html` —— 页面外壳：整体样式、按钮、图例文字。
- `build.py` —— 把 `data.json` + `core.js` + `app.js` 塞进 `template.html`，生成一个可以直接
  双击打开的单文件网页（`pedigree.html`）。

## 数据更新流程

1. 你更新 Excel（表结构不变，只是增删行）。
2. 运行 `python3 export_data.py 新的Excel路径.xlsm data.json`
3. 运行 `python3 build.py pedigree.html`
4. 用浏览器打开 `pedigree.html` 查看。

第 2、3 步几秒钟就能跑完，不需要碰 core.js / app.js。

## 依赖

- Python 3 + openpyxl（只有 export_data.py 需要）
- 浏览器（打开 pedigree.html 不需要联网、不需要安装任何东西）
