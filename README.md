# 写词人

一个纯静态的中文歌词搜索站。截止 2026 年 5 月，共收录 **102,760 首**歌，来自 **12,713 位**写词人。

→ Live: https://mlikeason.github.io/xieciren/

## 数据来源

- **ci_ziv 词库**（截止 2011，163K 首中文流行歌词）
- 25 位著名写词人在网易云的全集（林夕 / 黄伟文 / 林振强 / 姚谦 / 方文山 / 周耀辉 / ……）

两份数据按 `(歌名, 歌手)` 去重，词人版本因为有专辑、年份、流行度、封面，优先级更高。

## 本地跑

```bash
python3 -m http.server 8000
# 开浏览器 http://localhost:8000
```

## 重新打包数据

如果想加新的词人 JSON：

1. 把抓的 `xxx_lyrics.json` 丢到 `../*_lyrics.json`（仓库外）
2. 在 `build_corpus.py` 的 `LYRICIST_MAP` 里加一条 slug → 中文名
3. `python3 build_corpus.py`
4. 提交 `data/` 里的产物

`build_corpus.py` 不会从仓库工作，源数据（`*_lyrics.json` + `lyrics.db`）需要在仓库外的 `~/lyrical/lyrics/` 下。

## 栈

零依赖。HTML + CSS + 原生 JS。语料以两片 JSON 提供（精选 14MB / 扩展 79MB），首次访问拉精选秒开，扩展后台加载。

## 文件

```
index.html      单页骨架
style.css       样式
app.js          搜索 / 渲染 / 详情切换
build_corpus.py 构建脚本（开发期用）
data/
  corpus.json         精选 10,664 首（带封面、年份）
  corpus_extra.json   ci_ziv 扩展 92,096 首
  lyricists.json      词人 chip 元数据
  stats.json          全局统计
```
