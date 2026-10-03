# usage-stats — Hermes 使用统计插件

基于**本地会话库真实记录**的 Token 消耗面板（官方统计的 365 天窗口 / UTC 分组 / 跨天归属问题都在这里绕开了）。

## 功能（样式对标 Z.ai 使用统计页）

- **五格汇总卡**：累计 Token 数（全库口径）、峰值 Token 数、最长聊天时长、当前连续天数、最长连续天数
- **Token 活动热力图**：GitHub 风格 53 周格子，每日 / 每周 / 累计三种聚合
- **每日 Token 趋势图**：近 7 / 30 / 90 日，Top3 模型分色平滑折线 + 总量虚线
- **模型用量环图**：Top5 模型占比 + 图例

## 数据口径（对齐 API 平台统计）

**Token 总数 = 输入 + 输出 + 缓存读取**。API 平台报的「输入」本身包含缓存读取，对应会话库 `input_tokens + cache_read_tokens + output_tokens` 三列相加。官方 analytics 页只加 input+output，数字会小一个量级，不要拿它对表。

| 数据 | 来源 | 说明 |
|---|---|---|
| 每日×模型 / 模型环 / 趋势 / 热力图 / 累计 | 自带 Python 后端（`plugin_api.py`） | 直读 state.db 的 `session_model_usage` 表 |
| 最长聊天时长 / 连续天数 / 会话数 | `GET /api/sessions` 全量深分页遍历 | 会话级元数据 |

### v1.5 归因口径（session_model_usage）

Hermes 每次真实 API 调用都把该次的 tokens 记在**调用时刻实际使用的模型**名下（官方 #51607 为解决会话中途切模型归因错误而建）。因此：

- 会话中切换多个模型时，各模型的消耗各归各家，不会全部记到最后使用的模型
- 每条记录带 `first_seen`/`last_seen`（真实调用时间窗），跨午夜的记录按本地自然日重叠时长切分——当日 00:00–23:59 的边界是精确的
- 只统计主循环调用（`task = ''`）；压缩 / 后台审查等辅助调用的模型各自独立计费，不在对话用量里

## 安装 / 更新

插件是「桌面 UI + Python 后端」一体包，首次安装需要两步：

```bash
# 1) 桌面 UI
cp plugin.js "$LOCALAPPDATA/hermes/desktop-plugins/usage-stats/plugin.js"
# 2) Python 后端（需在 config.yaml 的 plugins.enabled 里加 usage-stats）
mkdir -p "$LOCALAPPDATA/hermes/plugins/usage-stats/dashboard"
cp plugin_api.py "$LOCALAPPDATA/hermes/plugins/usage-stats/dashboard/plugin_api.py"
cp manifest.json "$LOCALAPPDATA/hermes/plugins/usage-stats/dashboard/manifest.json"
```

然后在 Hermes 里 `Ctrl+K` → 「重载桌面插件」。入口：侧栏「使用统计」、路由 `/usage-stats`、命令面板「打开使用统计」。

Python 后端由 `hermes serve`（桌面后端）在启动时挂载到 `/api/plugins/usage-stats/*`，只读打开 state.db。改动 `plugins.enabled` 或首次安装后端后需要重启 Hermes（或后端进程）才会生效。

## 已知口径限制

- 悬浮明细里的「输入/输出」两行按全库比例从总量还原（`session_model_usage` 的每日聚合只取总量），总量与模型归因不受影响
- 8月17日之前的历史会话无逐模型记录（表建立前的数据），那部分用量不计入图表
