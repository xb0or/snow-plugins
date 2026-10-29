# 便捷提示词（snow-prompt-chips）

Snow App 客户端脚本：把若干条自定义提示词渲染成输入框上方的芯片按钮，点一下就发送。

## 功能

- **提示词条**：挂在聊天输入区插槽 `data-snow-slot="chat.input.actions"` 内，与其它插件按钮（如语音输入）同处一行并排在行首，位于输入框正上方。
- **点击即发送**：点击任意芯片，内容作为一条消息发给当前会话（可在设置里改成"只填入输入框"）。
- **设置弹窗**：点提示词条右侧的齿轮图标打开；支持增删提示词、上下移动排序、显示名称与内容分离编辑、删除二次确认、Esc 关闭。
- **持久化**：数据写在脚本自己的 `GM_*` 命名空间（键 `spc.prompts` 与 `spc.config`），不依赖应用数据库。

## 安装

方式一（界面）：插件页面 → 插件列表 → 脚本插件 → **导入文件**，选择 `snow-prompt-chips.user.js`，保存即生效。

方式二（AI / config 工具）：

```text
config-set scope=userscripts key="new" value={sourcePath: "<绝对路径>/snow-prompt-chips.user.js"}
```

更新已有安装：`config-set scope=userscripts key=<scriptId> value={sourcePath: "..."}`。

## 使用

1. 点输入框上方提示词条右侧的齿轮图标，打开「便捷提示词设置」。
2. 点「添加提示词」，填显示名称（可留空）与提示词内容，可上下移动排序。
3. 点「保存」，提示词条立即刷新。
4. 点任意芯片即按当前模式处理该条内容。

两个开关：

| 开关 | 开启 | 关闭 |
| --- | --- | --- |
| 点击后直接发送 | 点击立即给当前会话发一条消息 | 只把内容填进输入框，由你确认后发送 |
| 在输入框上方显示提示词条 | 显示芯片条 | 隐藏芯片条（设置仍可用命令行/临时开启后再关） |

若提示词条未显示：脚本关掉后仍在"插件列表 → 脚本插件"里，重新打开开关并点保存即可。

## 实现要点

- **挂载位置**：只用宿主稳定契约（锚点 `chat.input`、插槽 `chat.input.actions`），不依赖内部 class。插槽是 `display:flex; flex-wrap:wrap`，容器用 `order:-1` 排在按钮行首，`flex:1 1 auto` 与其它按钮同行；条内 `flex-wrap:wrap`，提示词多时自动换行（超过 56px 高度则在条内纵向滚动）。
- **发送通道**：优先 `snow.client.sendMessage(text)`（宿主原生客户端动作，实测实现为派发 `client-action send-message`）；不可用时回退 `snow.write.run("chatInput.sendMessage", { text })`，该动作属于 `conversations` 隐私域，脚本已在元数据头声明 `@snow-privacy conversations`。
- **重挂兜底**：`MutationObserver` 监听 DOM，节点被 React 重建后自动重挂；卸载时清理节点、样式、监听与弹窗。
- **主题跟随**：全部颜色取宿主 CSS 变量（`--bg-primary`、`--bg-secondary`、`--text-primary`、`--border-color`、`--accent-blue` 等），自动适配明暗主题。
- 图标为内嵌 Lucide 路径（客户端脚本环境没有全局 lucide 对象），无外部依赖、无网络访问。

## 元数据

```text
@snow-target  client     注入桌面窗口
@snow-scope   global     常驻，不随视图卸载（找不到插槽时不渲染）
@snow-privacy conversations   仅为发送回退动作声明
@grant        GM_getValue / GM_setValue
```

## 已知限制

- 点击发送走的是宿主客户端动作，调用是"发射后不管"（宿主内部已 catch 异常），脚本无法拿到逐次发送的成功/失败回执；回退到写动作时才会有 `ok/error` 提示。
- 输入框里已有的草稿是否受影响由宿主决定，脚本不做额外处理。
- 提示词条高度上限 56px，提示词非常多时条内滚动，不会把输入区撑高。

## 卸载

插件页面 → 插件列表 → 脚本插件 → 该脚本行 → 删除（会同时删除脚本文件与它自己的 `GM_*` 数据）。
