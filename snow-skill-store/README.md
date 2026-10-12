# Skill Store for Snow App

一个 Snow App 面板插件：在右侧面板浏览聚合自公开源的社区技能索引，支持搜索、分类过滤（可展开/收起）、全局或项目级一键安装，以及「让 AI 安装」兜底路径。

## 功能

- 四个数据源标签页：
  - **官方技能**：各大团队（Anthropic、Vercel、Cloudflare、Trail of Bits、Hugging Face 等）发布的 agent skills；
  - **本地技能**：中文社区精选技能（内容创作、视频、电商、PPT、语音等分类）；
  - **社区源**：自动发现的 GitHub 技能仓库源（4000+），按发现时间排序；
  - **skills.sh**：[skills.sh](https://www.skills.sh/)（The Agent Skills Directory）的技能目录，取自其公开 sitemap，保留热度前列的 6000 条，按站点排序展示；卡片描述会在浏览时自动从各技能详情页的 og:description 补齐并缓存（30 天）。
- 搜索（名称 / 描述 / 分类）+ 分类 chips 过滤；分类过多时默认折叠，点「更多」展开。
- 长列表分页加载（每页 80 条，「加载更多」）。
- 安装位置选择：**全局**（所有项目可用）或 **项目**（仅当前项目）。
- 两种安装方式：
  - **安装**：调用 Snow App 公开写动作 `skills.installGithub`；
  - **让 AI 安装**：把安装请求写入聊天输入框，由 AI 按内置文档执行安装。
- 已安装检测：读取 `skills` 元数据域，按技能名匹配并显示「已安装」徽章。
- 索引缓存 12 小时（插件私有 storage），「刷新」按钮强制重拉。
- 界面语言：简体中文 / 繁體中文 / English，跟随应用主题配色。

## 数据来源与致谢

本插件本身是一个索引浏览器。技能索引数据聚合自以下上游项目，在此致谢：

- [anbeime/skill](https://github.com/anbeime/skill) —— 技能商店（Skill Store）索引仓库，提供官方技能列表（`data/skills.json`）、本地技能列表（`data/local_skills.json`）与社区技能源清单（`SKILL_SOURCES.json`），其本身聚合自：
  - [VoltAgent/awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills)
  - OpenAI Skills、Awesome DSH Plugin、Matt Pocock Skills 等公开清单
- 各技能本体由其作者仓库直接提供；
- [skills.sh](https://www.skills.sh/) —— The Agent Skills Directory，其技能目录通过公开 sitemap 获取（本插件取热度前列条目）。

上游索引以 MIT 协议发布，本插件同样以 MIT 许可发布。

## 免责声明

本插件仅为技能索引聚合，**不代表对任何 SKILL 行为的安全背书**。SKILL 索引从各种公开源自动抓取，技能本体由各作者仓库直接提供，内容未经审查，请在安装前自行审查判断后再安装使用。

## 安装与开发

要求 Snow App 桌面端。安装（AI 侧）：

```text
config-set scope=plugins key="new" value={sourceDir: "<本目录绝对路径>"}
```

目录结构：

```text
skill-store-plugin/
  plugin.json     # 清单（id: com.anbeime.skill-store, renderMode: esm）
  index.js        # 面板入口（默认导出 React 组件）
  style.css       # 面板样式（.skstore- 前缀，跟随主题变量）
  locales/        # zh-CN / zh-TW / en 语言包
  README.md
```

## License

MIT
