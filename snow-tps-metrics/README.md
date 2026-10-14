# snow-tps-metrics

Snow App 面板插件：按行业惯例口径计算当前会话的 TPS、TTFT 等流式指标，并显示各会话当前使用的模型。

## 口径

| 指标 | 公式 |
| --- | --- |
| TTFT | run 开始到首个 token 的耗时（应用原始值） |
| 实时 TPS | `tokenCount / (时长 − TTFT)`，解码口径，剔除首 token 等待 |
| 瞬时 TPS | 3s 滚动窗口内 `Δtoken / Δt` |
| 会话平均 | `outputTokens / totalDurationMs`（含 TTFT/工具耗时）与 `outputTokens / (totalDurationMs − runTtftSumMs)`（解码口径） |
| 平均 TTFT | `runTtftSumMs / runRequestCount` |

## 数据源

- `runtime` 元数据域（免声明，live 推送）：流式 token 数、起始时间、TTFT、并发会话列表
- `conversations` 元数据域（敏感域）：会话累计 token/耗时/请求数，以及会话的 `model` / `apiProfileName`（总览表“模型”列与标题行当前模型）

## 安装

Snow App → 插件 → 插件市场搜索 "TPS"，或从 Release 下载 zip 后本地安装。

## 限制

- 会话累计均值的分母包含 run 内工具执行等非流式间隙（数据源未拆分），穿插工具调用的会话该均值偏低；实时解码口径不受影响。
- `streamTokenCount` 是否含 thinking token 取决于后端统计方式，插件侧无法拆分。

## License

MIT
