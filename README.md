# 红书笔记导航

`红书笔记导航` 是基于 Obsidian 社区插件 [Notebook Navigator](https://github.com/johansan/notebook-navigator) 改造的独立 fork。

这个版本保留了原插件优秀的文件夹树、标签、属性、快捷方式、最近文件、双栏浏览和移动端适配能力，并在此基础上加入更适合图片笔记、灵感库和内容流浏览的小红书风格图库体验。

## 原作者与致谢

本项目的原始插件是 **Notebook Navigator**，原作者是 [Johan Sanneblad](https://github.com/johansan)。

感谢 Johan Sanneblad 创建并维护 Notebook Navigator。这个 fork 的基础架构、核心交互、导航能力和大量稳定性设计都来自原项目。

如果你想了解原版插件，或者支持原作者，可以访问：

- 原项目仓库：[johansan/notebook-navigator](https://github.com/johansan/notebook-navigator)
- 原插件文档：[notebooknavigator.com](https://notebooknavigator.com/docs.html)
- 支持原作者：[GitHub Sponsors](https://github.com/sponsors/johansan)

## 这个 fork 更新了什么

这个 fork 的目标是把 Obsidian 的笔记浏览体验从传统文件列表，扩展成更适合图文内容消费的视觉化导航。

主要更新：

- 插件身份改为独立插件，不覆盖原版 Notebook Navigator
- 插件 id：`little-red-gallery`
- 插件显示名称：`红书笔记导航`
- 新增 `gallery` 图库外观模式
- 支持小红书风格双列图片卡片
- 优化图片型 Markdown 笔记的浏览体验
- 支持标准、紧凑、图库、图文流等多种列表模式
- 导航顶部新增笔记统计和热力图
- 热力图支持按当天笔记数区间变色
- 新增热力图设置页，可自定义每个区间的规则和颜色
- 支持一键恢复默认热力图配置
- 针对中文界面和本地使用场景调整了部分文案

## 手动安装

这个 fork 目前没有上传到 Obsidian 插件市场，需要使用手动安装方式。

点击下面的链接进入插件文件夹：

👉 [little-red-gallery 插件文件夹](./little-red-gallery)

把整个 `little-red-gallery` 文件夹复制到你的 Obsidian 仓库插件目录：

```text
你的仓库/.obsidian/plugins/little-red-gallery
```

文件夹内应包含：

```text
little-red-gallery/
├── main.js
├── manifest.json
└── styles.css
```

然后在 Obsidian 中：

1. 打开 `设置`
2. 进入 `第三方插件`
3. 关闭并重新打开第三方插件列表，或重启 Obsidian
4. 找到 `红书笔记导航`
5. 启用插件

## 开发与构建

如果你想从源码构建：

```powershell
npm install
npm run build
```

构建后复制以下文件到 Obsidian 插件目录：

```text
main.js
styles.css
manifest.json
```

## 与原版插件的关系

这个项目是 Notebook Navigator 的定制 fork，不是原项目的官方版本。

你可以同时保留原版 `notebook-navigator` 和本 fork 的 `little-red-gallery`，它们使用不同的插件 id，不会互相覆盖。

## 许可证

本项目继承原项目的许可证。详细信息请查看 [LICENSE](./LICENSE)。
