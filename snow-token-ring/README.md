# TokenRing增强（snow-token-ring）

Snow App **客户端脚本插件**（油猴脚本，`@snow-target client`）。**增强**聊天输入区上下文圆环：
宿主原生的 hover 用量（输入 / 输出 / 缓存写 / 缓存读 / 合计 / 缓存命中率 / 上下文上限）不再单独弹一层，
而是并入同一块面板底部；分解里的**消息量**与**内置开销**来自真实请求 token，只有基线内部三类按文本比例分摊。

```
snow-token-ring/
  snow-token-ring.user.js   # 脚本本体（安装用）
  selftest.mjs                     # 口径自检（node，23 项）
  dom-test.mjs                     # 假 DOM 渲染 / 响应式自检（Chrome headless）
```

## 安装

```text
config-set scope=userscripts key="new" value={sourcePath: "<绝对路径>/snow-token-ring.user.js"}
```

或在 **插件 → 插件列表 → 脚本插件** 里「导入文件」选择 `.user.js`。

## 实测口径（v2.1.0）

```
首轮请求 input_tokens（真实，usage.records 里本会话最早一条）
  ├─ 首条用户消息（估算，唯一扣减项）
  └─ 系统基线（真实）───── 系统提示词      ≈ 文本分摊
                          ├ 技能清单        ≈ 文本分摊
                          ├ MCP 工具        ≈ 文本分摊
                          └ 内置工具与框架   = 基线 − 三项估算（真实余量）

当前上下文 tokenUsage.total（真实）
  ├─ 系统基线（上面那块，真实）
  └─ 消息（真实）= total − 基线
```

| 项 | 来源 | 口径 |
| --- | --- | --- |
| 已使用 / 总量 / 可用空间 | `runtime.tokenUsage`、`chatInput.maxContextTokens` | **实测** |
| 消息 | 当前 total − 首轮基线 | **实测** |
| 内置工具与框架 | 首轮 baseline − 三类估算 | **实测**（余量） |
| 系统提示词 | `personalization` + 激活的 `systemPrompts` | ≈ 文本分摊 |
| 技能清单 | `skills.available` 的 name/description/allowedTools | ≈ 文本分摊 |
| MCP 工具 | `mcp.tools` + `projectServersWithTools[].tools` 的 name/description/inputSchema | ≈ 文本分摊 |
| 首轮 input | `usage.records` 里本会话最早一条（`since/until` 由首条消息时间推出） | **实测** |

界面约定：带 `≈` 的数值是分摊值，不带的是实测值；底部一行说明当前是实测模式还是退化估算模式。
恒等式：`各项合计 === 宿主真实上下文总量`。

降级路径：
1. 拿不到首轮 usage 记录（usage 域未授权 / 会话太老查不到）→ 全部按文本估算，并在浮层注明；
2. 首轮基线大于当前上下文（长会话被压缩过）→ 消息归零并注明「已按实际总量裁剪」；
3. 三类估算之和超过基线 → 三类等比压缩，内置开销为 0（说明基线被工具定义吃满）。

## 界面（一块面板，信息不丢）

```
上下文                          ⌄
已使用 36%              362k / 1M
[██████████░░░░░░░░░░░░]
● 消息 · 218        132k  13.2%     ← 实测
○ 内置工具与框架     116k  11.6%     ← 实测余量
● MCP 工具 · 164    ≈95k   9.5%
● 技能清单 · 161    ≈13k   1.3%
● 系统提示词         ≈5k   0.5%
○ 可用空间          638k  63.8%     ← 实测
──────────────────────────────
● 输入 1.03K      ● 输出 241        ← 宿主原生 tooltip 的行
● 缓存命中 360K   ● 合计 362K         运行时读出、合并进来
   缓存命中率 99.7%   上下文 1.00M
──────────────────────────────
实测 · ≈ 为文本分摊（首轮 233k input）
```

- 宿主原生 tooltip 的每一行（label / value / 圆点颜色）在 hover 后从 DOM 读出，合并到面板底部两列排布；
- 读到了才用 CSS 隐藏宿主 tooltip，**读不到就自动退回让宿主 tooltip 照常显示**，不会因为宿主改类名而丢信息；
- 定位：圆环上方 → 空间不足时左侧 → 再不行放下方，水平始终夹在视口内；
- 标题可折叠（状态存 GM `scb.collapsed`）；配色与圆角用宿主 CSS 变量，跟随主题；
- React 重渲染后由 `MutationObserver` 重新挂载，卸载时移除注入属性与节点。

## 自检

```text
node snow-token-ring/selftest.mjs    # 23 项：估算公式、首轮选取、基线/消息/余量、归一、空态
node snow-token-ring/dom-test.mjs    # 180/280/380/480 宽度 + 退化口径：挂载、hover、行内容、折叠、无溢出、无金额
```

## 限制

- 宿主不暴露内置工具 schema、上下文压缩缓冲、指令/记忆分区，这些只能以「内置工具与框架」的**真实余量**整体呈现；
- 基线里扣掉的「首条用户消息」是估算（其余全是真数），首条消息越长，基线误差越大；
- 会话被压缩后，消息量 = 当前 total − 原基线，会把压缩后的实际消息量算准，但压缩前的历史不可见；
- 只在**已有 token 记录**的会话出现（宿主无 `tokenUsage` 时不渲染圆环）。
