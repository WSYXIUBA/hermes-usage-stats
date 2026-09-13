# usage-stats — Hermes 使用统计插件

基于**本地会话库真实记录**的 Token 消耗面板（官方统计的 365 天窗口 / UTC 分组 / 跨天归属问题都在这里绕开了）。

## 功能（样式对标 Z.ai 使用统计页）

- **五格汇总卡**：累计 Token 数（全库口径，含子代理与压缩续接）、峰值 Token 数、最长聊天时长、当前连续天数、最长连续天数
- **Token 活动热力图**：GitHub 风格 53 周格子，每日 / 每周 / 累计三种聚合
- **每日 Token 趋势图**：近 7 / 30 / 90 日，Top3 模型分色平滑折线 + 总量虚线
- **模型用量环图**：Top5 模型占比 + 图例

## 数据口径（对齐 API 平台统计）

**Token 总数 = 输入 + 输出 + 缓存读取**。API 平台报的「输入」本身包含缓存读取（如输入 486.5M 其中缓存读取 467.47M），对应 Hermes 会话库 `input_tokens + cache_read_tokens + output_tokens` 三列相加。官方 analytics 页只加 input+output，数字会小一个量级，不要拿它对表。

| 数据 | 来源 | 说明 |
|---|---|---|
| 累计 Token 数 / 模型占比（全库） | `GET /api/analytics/usage?days=365` | 全行聚合（含子代理、压缩续接行），最完整 |
| 热力图 / 趋势 / 连续天数 / 范围内模型环 | `GET /api/sessions` 全量深分页遍历 | 按本地自然日（0 点日界）重叠时长加权分摊，跨午夜会话按小时切分 |
| 压缩链补齐 | `GET /api/sessions/{id}`（经 `_lineage_ids`） | 续接行的 tokens 归到各自开始日期 |

通道：`window.hermesDesktop.api`（渲染层 preload 桥）。结果缓存在 `ctx.storage`，进页面先出缓存再后台刷新。

## 安装 / 更新

```bash
cp plugin.js "$LOCALAPPDATA/hermes/desktop-plugins/usage-stats/plugin.js"
```

然后在 Hermes 里 `Ctrl+K` → 「重载桌面插件」。入口：侧栏「使用统计」、路由 `/usage-stats`、命令面板「打开使用统计」。

## 已知口径限制

- 遍历端点不返回委托子代理（delegate）行，其用量只计入「累计」（analytics 口径），不进图表
- 跨天会话按活动区间均摊，不是逐消息精确归属（需要逐消息数据得另走 messages 接口，代价大）
