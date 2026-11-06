# 便捷提示词（snow-prompt-chips）

Snow App 客户端脚本：把若干条自定义提示词渲染成输入框上方的芯片按钮，点一下就发送。

## 功能

- **提示词条**：挂在聊天输入区插槽 `data-snow-slot="chat.input.actions"` 内，与其它插件按钮（如语音输入）同处一行并排在行首，位于输入框正上方。
- **点击即发送**：点击任意芯片，内容作为一条消息发给当前会话（可在设置里改成"只填入输入框"）。
- **设置弹窗**：点提示词条右侧的齿轮图标打开；支持增删提示词、上下移动排序、显示名称与内容分离编辑、删除二次确认、Esc 关闭。
- **JSON 备份**：弹窗底部「备份与恢复」可把当前列表导出成 JSON（复制进系统剪贴板）或粘贴 JSON 导入到草稿；导入只改草稿，点「保存」才写入存储。
- **持久化**：数据写在脚本自己的 `GM_*` 命名空间（键 `spc.prompts` 与 `spc.config`），不依赖应用数据库；重装/更新脚本只覆盖源码，不会清空这些值。

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
- **发送通道**：点击即发送走宿主**输入区自己的发送链路** `snow.write.run("chatInput.sendMessage", { text })`（宿主派发 `PLUGIN_SEND_INPUT_MESSAGE_EVENT` → `restoreContent(text)` → `handleSend("queue")`），因此这次发送会带上输入区里选中的**模型 / API 档案 / 思考强度 / 快速模式**，与手打一条再回车完全一致；输入区是新建会话草稿时，也由宿主自己的发送链路建会话，所以新会话用的就是你在对话框里选的模型。宿主处理器的 `setTimeout(0)` 与 React 提交存在竞态（0.5.8 实测过「只填不发」），脚本按「输入框是否被清空」校验，未清空会重试（最多 3 次），仍失败则如实提示「已填入输入框，请按回车发送」。发送会清空输入区，脚本会把点芯片前已输入的内容（纯文本）回填回去。
  - **降级通道**：宿主没有 `chatInput.sendMessage` 时退回 `conversations.sendMessage` / `conversations.create({ text, autoReply: true })`（宿主内部发送器直接投递到会话，不经过输入区）。这两个动作**不接受 `model` 参数**，会话会回落到 API 档案的默认模型——v1.0.2 及以前只走这条链路，新会话才会出现「用默认模型而不是对话框里选的模型发送」。
  - 用到的写动作都属于 `conversations` 隐私域，脚本已在元数据头声明 `@snow-privacy conversations`。
- **重挂兜底**：`MutationObserver` 监听 DOM，节点被 React 重建后自动重挂；卸载时清理节点、样式、监听与弹窗。
- **主题跟随**：全部颜色取宿主 CSS 变量（`--bg-primary`、`--bg-secondary`、`--text-primary`、`--border-color`、`--accent-blue` 等），自动适配明暗主题。
- 图标为内嵌 Lucide 路径（客户端脚本环境没有全局 lucide 对象），无外部依赖、无网络访问。

## 验证（Snow App 0.5.10，真机）

一次性探测脚本 `probe/probe25-chip-model.user.js`：把输入区模型切到非默认值，再点芯片，然后读落库消息的 `model`（临时会话 / 新建会话草稿两条路径，自带清理）。

| 场景 | 输入区选中模型 | 落库消息的 `model` |
| --- | --- | --- |
| 已有会话（临时会话内点芯片） | `cline-free/solar-mini4` | 用户消息与 AI 回复都是 `cline-free/solar-mini4` |
| 新建会话草稿（新建会话 → 点芯片） | `cline-free/solar-mini4` | 宿主新建的会话里，两条消息都是 `cline-free/solar-mini4` |

档案 `agent2api` 的默认模型是 `deepseek-v4.1-flash`，上表与它不同，即证明发送用的是输入区里选中的模型（v1.0.2 走 `conversations.create` / `conversations.sendMessage` 时会回落成默认模型）。附带证据：宿主写域清单里 `chatInput.sendMessage`（`scope: conversations`）为 `granted: true`；点击后 toast 为「已发送」，输入框被清空，新建会话由宿主自己的发送链路创建。

首次探测 `probe/probe24-chip-model.user.js` 因下拉交互写错（把根视图里带 `title` 的「快速模式」项误判成模型清单）没切成模型，结论无效，保留作对照。

## 元数据

```text
@snow-target  client     注入桌面窗口
@snow-scope   global     常驻，不随视图卸载（找不到插槽时不渲染）
@snow-privacy conversations   仅为发送回退动作声明
@grant        GM_getValue / GM_setValue
```

## 已知限制

- 提示里的「已发送」按宿主的输入区状态推断（输入框被清空即视为已发出）：发送由宿主内部流程完成，脚本拿不到逐次投递回执；走降级通道（写动作）时才有 `ok/error` 回执。
- 点芯片发送会清空输入区，脚本只按**纯文本**回填原内容；原草稿里的文件 chip 无法还原（会在 toast 里提示已保留原输入内容）。
- 提示词条高度上限 56px，提示词非常多时条内滚动，不会把输入区撑高。

## 卸载

插件页面 → 插件列表 → 脚本插件 → 该脚本行 → 删除（会同时删除脚本文件与它自己的 `GM_*` 数据）。
