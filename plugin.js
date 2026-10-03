import { host, SegmentedControl, ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA } from '@hermes/plugin-sdk'
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { jsx } from 'react/jsx-runtime'

// ═══════════════════════════════════════════════════════════════
//  使用统计 v1.5 — 本地会话库 Token 消耗面板
//
//  口径（对齐 API 平台统计）：Token 总数 = 输入 + 输出 + 缓存读取。
//  平台报的「输入」本身包含缓存读取，对应会话库三个独立列相加：
//  input_tokens + cache_read_tokens + output_tokens。
//  官方 analytics 页只加 input+output（约 1/20），不要拿它对表。
//
//  按模型/按日（v1.5 重写）：数据源是 state.db 的 session_model_usage
//  表——Hermes 每次真实 API 调用都把该次的 tokens 记在「当时实际用的
//  模型」名下（官方 #51607 就是为此建的表）。会话中途切换模型时，
//  各模型的消耗各归各家，不再全部记到最后使用的模型。行上带
//  first_seen/last_seen（真实调用时间窗），跨午夜的行按本地自然日
//  重叠时长切分，当日 00:00–23:59 的边界是精确的。
//
//  通道：本插件自带 Python 后端（plugins/usage-stats/dashboard/
//  plugin_api.py，只读打开 state.db），经 ctx.rest('/daily') 访问，
//  挂载在 /api/plugins/usage-stats/*。后端不可用时整页报错。
//
//  其余卡片（最长聊天/连续天数）仍走 /api/sessions 会话级接口。
// ═══════════════════════════════════════════════════════════════

const VERSION = 'v1.5'
const ID = 'usage-stats'

const SERIES_COLORS = ['#3b82f6', '#22c55e', '#a855f7', '#f97316', '#ef4444', '#14b8a6']
const DAY = 86400
const DAY_MS = 86400000
const MAX_WALK_PAGES = 400        // 100/页 → 4 万会话的保险上限
const CACHE_DAYMODELS_MAX = 8000  // 持久化时每日×模型明细的条数上限

// jsx 的第三参是 key 不是 children，包一层免得每次都写 props.children
function h(type, props, ...children) {
  const p = { ...props }
  if (children.length === 1) p.children = children[0]
  else if (children.length > 1) p.children = children
  return jsx(type, p)
}

// ── 基础工具 ────────────────────────────────────────────────────

function dayKey(sec) {
  const d = new Date(sec * 1000)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
function todayKey() { return dayKey(Date.now() / 1000) }

function trim1(n) {
  const s = n >= 100 ? String(Math.round(n)) : (Math.round(n * 10) / 10).toFixed(1)
  return s.endsWith('.0') ? s.slice(0, -2) : s
}
function fmtTokens(n) {
  n = Math.max(0, Math.round(n || 0))
  if (n >= 1e8) return trim1(n / 1e8) + ' 亿'
  if (n >= 1e4) return trim1(n / 1e4) + ' 万'
  return String(n)
}
function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0))
  const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60)
  if (d > 0) return d + ' 天 ' + hh + ' 小时'
  if (hh > 0) return hh + ' 小时 ' + m + ' 分钟'
  if (m > 0) return m + ' 分钟'
  return sec + ' 秒'
}
function fmtDayCN(key) { const parts = key.split('-'); return (+parts[1]) + '月' + (+parts[2]) + '日' }

const muted = 'var(--dt-muted-foreground, rgba(128,128,128,0.85))'
const MUTED = { color: muted }
const cardBg = 'var(--dt-card, var(--ui-bg-elevated, rgba(128,128,128,0.08)))'
const BORDER = '1px solid var(--dt-border, rgba(128,128,128,0.18))'
const POPOVER_BG = 'var(--dt-popover, rgba(24,24,28,0.96))'
const POPOVER_FG = 'var(--dt-popover-foreground, #f5f5f5)'

// ── 数据层 ──────────────────────────────────────────────────────

function bridgeApi() {
  const b = typeof window !== 'undefined' && window.hermesDesktop
  return b && typeof b.api === 'function' ? (req) => b.api(req) : null
}

async function apiGet(path, timeoutMs = 60000) {
  const api = bridgeApi()
  if (!api) throw new Error('未检测到 Hermes 桥接（请在 Hermes 桌面端内使用）')
  return api({ path, timeoutMs })
}

// 单 profile 会话级数据（最长聊天 / 连续天数用，与用量归因无关）
async function walkSessions(profile, onProgress) {
  const rows = []
  let offset = 0
  for (let page = 0; page < MAX_WALK_PAGES; page++) {
    const r = await apiGet(`/api/sessions?limit=100&offset=${offset}&min_messages=0&archived=include&order=recent`)
    const list = (r && r.sessions) || []
    rows.push(...list)
    if (onProgress) onProgress(list.length)
    if (list.length < 100) break
    offset += 100
  }
  return rows
}

function streaksFromDays(dayKeys) {
  const set = new Set(dayKeys)
  const nowSec = Date.now() / 1000
  let current = 0
  if (set.has(todayKey()) || set.has(dayKey(nowSec - DAY))) {
    let cursor = set.has(todayKey()) ? nowSec : nowSec - DAY
    while (set.has(dayKey(cursor))) { current++; cursor -= DAY }
  }
  const sorted = [...set].sort()
  let best = 0, run = 0, prev = null
  for (const k of sorted) {
    const t = new Date(k + 'T00:00:00').getTime() / 1000
    run = prev != null && Math.round(t - prev) === DAY ? run + 1 : 1
    if (run > best) best = run
    prev = t
  }
  return { current, best }
}

// ── 汇总构建 ────────────────────────────────────────────────────

// 每日×模型：来自插件 Python 后端（session_model_usage 逐调用归因）。
// 返回 days: Map(dayKey → {input, output, cache, total}) 与
// dayModels: Map(dayKey\1model → total)。
async function ctxRest(path, timeoutMs) {
  const b = typeof window !== 'undefined' && window.hermesDesktop
  if (!b || typeof b.api !== 'function') throw new Error('未检测到 Hermes 桥接（请在 Hermes 桌面端内使用）')
  return b.api({ path: `/api/plugins/usage-stats${path}`, timeoutMs })
}

async function fetchDailyByModel() {
  const r = await ctxRest('/daily?days=400', 120000)
  const days = new Map(), dayModels = new Map()
  const byDay = (r && r.days) || {}
  // 后端按 (day, model) 只给总量；输入/输出拆分按全库比例还原（只影响
  // 悬浮明细里的两行小字，总量与归因不受影响）
  const totals = await ctxRest('/totals?days=3650', 60000)
  const grand = (totals.input_tokens || 0) + (totals.output_tokens || 0) + (totals.cache_read || 0)
  const inR = grand > 0 ? (totals.input_tokens || 0) / grand : 0
  const outR = grand > 0 ? (totals.output_tokens || 0) / grand : 0
  const cacheR = grand > 0 ? (totals.cache_read || 0) / grand : 0
  for (const [day, models] of Object.entries(byDay)) {
    let cell
    for (const total of Object.values(models)) {
      cell = cell || { input: 0, output: 0, cache: 0, total: 0 }
      cell.input += total * inR; cell.output += total * outR; cell.cache += total * cacheR
      cell.total += total
    }
    if (cell) days.set(day, cell)
    for (const [model, total] of Object.entries(models)) {
      dayModels.set(day + '\u0001' + model, (dayModels.get(day + '\u0001' + model) || 0) + total)
    }
  }
  return { days, dayModels, totals }
}

async function buildAggregate(onProgress) {
  // 1) 每日×模型（精确归因）——失败直接抛，让 UI 走错误分支
  const { days, dayModels, totals: modelTotals } = await fetchDailyByModel()

  // 2) 会话级元数据（最长聊天 / 连续天数）
  let longest = null
  let sessionCount = 0
  try {
    const rows = await walkSessions('default', n => { sessionCount = n; if (onProgress) onProgress(n) })
    for (const s of rows) {
      const start = s.started_at || 0
      const end = Math.max(s.last_active || 0, start)
      if (start && end > start && (!longest || end - start > longest.seconds)) {
        longest = { title: s.title || '未命名会话', seconds: end - start, day: dayKey(start) }
      }
    }
  } catch { /* 元数据拿不到不阻塞，卡片显示占位 */ }

  const totals = {
    input: modelTotals.input_tokens || 0,
    output: modelTotals.output_tokens || 0,
    cache: modelTotals.cache_read || 0,
  }
  return {
    totals, walkTotals: { sessions: sessionCount },
    models: [], days, dayModels, longest,
    streaks: streaksFromDays([...days.keys()].filter(k => days.get(k).total > 0)),
    profileErrors: [], profiles: ['default'], fetchedAt: Date.now(),
  }
}

// ── 缓存序列化（Map → 数组）────────────────────────────────────

function serializeAggregate(a) {
  return {
    v: 5, at: a.fetchedAt,
    totals: a.totals, walkTotals: a.walkTotals,
    models: a.models, longest: a.longest, streaks: a.streaks,
    profiles: a.profiles, profileErrors: a.profileErrors,
    days: [...a.days.entries()],
    dayModels: [...a.dayModels.entries()].slice(0, CACHE_DAYMODELS_MAX),
  }
}
function deserializeAggregate(o) {
  if (!o || o.v !== 5) return null   // 旧口径缓存的分摊算法/口径不同，直接作废
  return {
    totals: o.totals || {}, walkTotals: o.walkTotals || { sessions: 0 },
    models: o.models || [], longest: o.longest || null, streaks: o.streaks || { current: 0, best: 0 },
    profiles: o.profiles || [], profileErrors: o.profileErrors || [],
    days: new Map(o.days || []), dayModels: new Map(o.dayModels || []),
    fetchedAt: o.at || 0,
  }
}

// ── 范围选择（趋势图与模型环共享）──────────────────────────────

const RANGE_OPTIONS = [
  { id: '7', label: '近 7 日' },
  { id: '30', label: '近 30 日' },
  { id: '90', label: '近 90 日' },
  { id: 'all', label: '全部' },
]
function rangeKeys(range, days) {
  if (range === 'all') {
    let earliest = todayKey()
    for (const k of days.keys()) if (k < earliest) earliest = k
    const keys = []
    let t = new Date(earliest + 'T00:00:00').getTime()
    const end = new Date(todayKey() + 'T00:00:00').getTime()
    for (; t <= end; t += DAY_MS) keys.push(dayKey(t / 1000))
    return keys.length ? keys : [todayKey()]
  }
  const n = +range || 7
  const keys = []
  for (let i = n - 1; i >= 0; i--) keys.push(dayKey(Date.now() / 1000 - i * DAY))
  return keys
}

// ── 悬浮提示（原生 title 在应用里不弹，用自绘浮层）─────────────

function Tooltip({ tip }) {
  if (!tip) return null
  return h('div', {
    style: {
      position: 'fixed', left: tip.x, top: tip.y, transform: 'translate(-50%, -100%)',
      background: POPOVER_BG, color: POPOVER_FG, borderRadius: 8, padding: '7px 11px',
      fontSize: 12, lineHeight: 1.55, pointerEvents: 'none', zIndex: 9999,
      boxShadow: '0 4px 16px rgba(0,0,0,0.35)', whiteSpace: 'nowrap',
      border: '1px solid rgba(255,255,255,0.08)',
    },
  }, ...(Array.isArray(tip.body) ? tip.body : [tip.body]))
}

function detailCell(cell) {
  // 与平台口径一致：输入(含缓存读取) + 输出
  return '输入(含缓存) ' + fmtTokens((cell?.input || 0) + (cell?.cache || 0))
    + ' · 输出 ' + fmtTokens(cell?.output)
    + (cell?.cache ? ' ｜ 其中缓存读取 ' + fmtTokens(cell.cache) : '')
}

// ── UI 原子（内联样式为主，避免依赖宿主编译出的 Tailwind 类）────

function SectionCard(title, right, body, key) {
  return h('div', { style: { background: cardBg, borderRadius: 16, padding: '18px 24px 16px' }, key },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 } },
      h('div', { style: { fontSize: 14, fontWeight: 600 } }, title),
      right ? h('div', {}, right) : null),
    body)
}

// ── 五格汇总卡片 ────────────────────────────────────────────────

function StatCards({ data }) {
  const t = data.totals
  // 平台口径：Token 总数 = 输入 + 缓存读取 + 输出（平台「输入」含缓存读取）
  const headline = (t.input || 0) + (t.cache || 0) + (t.output || 0)
  let peak = null
  for (const [k, v] of data.days) if (!peak || v.total > peak.total) peak = { key: k, total: v.total }
  const cells = [
    { label: '累计 Token 数', value: fmtTokens(headline),
      sub: '输入 ' + fmtTokens((t.input || 0) + (t.cache || 0)) + ' · 输出 ' + fmtTokens(t.output),
      title: '口径与 API 平台一致：输入+输出（输入含缓存读取）'
        + '\n输入 ' + fmtTokens((t.input || 0) + (t.cache || 0))
        + '（其中缓存读取 ' + fmtTokens(t.cache) + '）'
        + '\n输出 ' + fmtTokens(t.output) },
    { label: '峰值 Token 数', value: peak ? fmtTokens(peak.total) : '0', sub: peak ? fmtDayCN(peak.key) : '',
      title: peak ? peak.key + ' 单日消耗（输入+输出）' : '' },
    { label: '最长聊天时长', value: data.longest ? fmtDuration(data.longest.seconds) : '—',
      sub: data.longest ? data.longest.title.slice(0, 18) : '', title: data.longest ? data.longest.title : '' },
    { label: '当前连续天数', value: data.streaks.current + ' 天', sub: '',
      title: '连续有会话活动的天数（含今天或昨天）' },
    { label: '最长连续天数', value: data.streaks.best + ' 天', sub: '', title: '历史最长的连续活动天数' },
  ]
  return h('div', {
    style: { background: cardBg, borderRadius: 16, padding: '18px 12px', display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0,1fr))' },
  }, cells.map((c, i) => h('div', {
    key: String(i), title: c.title || undefined,
    style: { textAlign: 'center', padding: '6px 4px', borderLeft: i > 0 ? BORDER : 'none' },
  },
    h('div', { style: { fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1.25 } }, c.value),
    c.sub ? h('div', { style: { fontSize: 11, marginTop: 2, color: muted }, title: c.sub }, c.sub) : null,
    h('div', { style: { fontSize: 12, marginTop: 4, color: muted } }, c.label))))
}

// ── Token 活动热力图 ────────────────────────────────────────────

function withAlpha(varExpr, a) {
  return `color-mix(in srgb, ${varExpr} ${Math.round(a * 100)}%, transparent)`
}
function heatColor(v, max) {
  const primary = 'var(--dt-primary, #3b82f6)'
  if (!v || max <= 0) return 'var(--dt-muted, rgba(128,128,128,0.16))'
  const r = v / max
  if (r < 0.25) return withAlpha(primary, 0.3)
  if (r < 0.5) return withAlpha(primary, 0.55)
  if (r < 0.75) return withAlpha(primary, 0.78)
  return primary
}
const CELL = 11, GAP = 3
function cellBox(v, max, height) {
  return { width: CELL, height: height || CELL, borderRadius: 3, background: heatColor(v, max) }
}

function Heatmap({ data, mode }) {
  const [tip, setTip] = useState(null)
  const grid = useMemo(() => {
    const { days } = data
    if (mode === 'day') {
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const dow = today.getDay()
      const cols = []
      let max = 0
      const startMs = today.getTime() - (52 * 7 + dow) * DAY_MS  // 末列对齐本周，行对齐星期
      for (let w = 0; w < 53; w++) {
        const col = []
        for (let d = 0; d < 7; d++) {
          const t = startMs + (w * 7 + d) * DAY_MS
          if (t > today.getTime()) { col.push(null); continue }
          const key = dayKey(t / 1000)
          const v = days.get(key)?.total || 0
          if (v > max) max = v
          col.push({ key, v })
        }
        cols.push(col)
      }
      const months = []
      let lastM = ''
      cols.forEach((col, i) => {
        const first = col.find(Boolean)
        if (!first) return
        const m = first.key.slice(0, 7)
        if (m !== lastM) { months.push({ col: i, label: (+m.slice(5)) + '月' }); lastM = m }
      })
      return { cols, max, months }
    }
    // 每周 / 累计：单行聚合
    const buckets = new Map()
    for (const [key, cell] of days) {
      const t = new Date(key + 'T00:00:00')
      let bk
      if (mode === 'week') { t.setDate(t.getDate() - t.getDay()); bk = dayKey(t.getTime() / 1000) }
      else bk = key.slice(0, 7) // YYYY-MM
      buckets.set(bk, (buckets.get(bk) || 0) + cell.total)
    }
    const list = [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    return { single: list, max: Math.max(1, ...list.map(x => x[1])) }
  }, [data, mode])

  const showTip = (e, title, cell) => {
    const r = e.currentTarget.getBoundingClientRect()
    setTip({ x: r.left + r.width / 2, y: r.top - 8, body: [h('div', { key: 't', style: { fontWeight: 600 } }, title), h('div', { key: 'd', style: { opacity: 0.85 } }, detailCell(cell))] })
  }

  if (grid.single) {
    return h('div', { style: { position: 'relative' } },
      h('div', {
        style: { display: 'flex', gap: GAP + 1, alignItems: 'flex-end', width: 'max-content', overflowX: 'auto', paddingBottom: 4 },
        onMouseLeave: () => setTip(null),
      }, grid.single.map(([k, v]) => h('div', {
        key: k,
        onMouseEnter: e => showTip(e, k, null),
        style: { ...cellBox(v, grid.max, 15), borderRadius: 4 },
      }))),
      h(Tooltip, { tip }))
  }

  return h('div', {
    style: { position: 'relative' },
    onMouseLeave: () => setTip(null),
  },
    h('div', { style: { overflowX: 'auto', paddingBottom: 4 } },
      h('div', {
        style: {
          display: 'grid', gridAutoFlow: 'column',
          gridTemplateRows: `repeat(7, ${CELL}px)`, gap: GAP, width: 'max-content',
        },
      }, grid.cols.flatMap((col, ci) => col.map((c, ri) => {
        if (!c) return h('div', { key: ci + '-' + ri, style: { width: CELL, height: CELL, visibility: 'hidden' } })
        const cell = data.days.get(c.key)
        return h('div', {
          key: ci + '-' + ri,
          onMouseEnter: e => showTip(e, c.key, cell),
          style: cellBox(c.v, grid.max),
        })
      })))),
    h('div', { style: { position: 'relative', height: 16, marginTop: 4, minWidth: '100%', width: 'max-content' } },
      grid.months.map((m, i) => {
        const left = m.col * (CELL + GAP)
        const prevRight = i > 0 ? grid.months[i - 1].col * (CELL + GAP) + 30 : 0
        if (left < prevRight) return null
        return h('div', {
          key: m.label + m.col, style: { position: 'absolute', left, top: 0, fontSize: 11, color: muted },
        }, m.label)
      })),
    h(Tooltip, { tip }))
}

function HeatmapCard({ data }) {
  const [mode, setMode] = useState('day')
  return SectionCard('Token 活动',
    h(SegmentedControl, {
      value: mode, onChange: setMode,
      options: [{ id: 'day', label: '每日' }, { id: 'week', label: '每周' }, { id: 'total', label: '累计' }],
    }),
    h('div', {},
      h(Heatmap, { data, mode, key: mode }),
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 5, marginTop: 10 } },
        h('span', { style: { fontSize: 11, color: muted } }, '少'),
        [0, 0.3, 0.55, 0.78, 1].map((r, i) => h('div', {
          key: String(i), style: {
            width: 11, height: 11, borderRadius: 3,
            background: r === 0 ? 'var(--dt-muted, rgba(128,128,128,0.16))' : withAlpha('var(--dt-primary, #3b82f6)', r),
          },
        })),
        h('span', { style: { fontSize: 11, color: muted } }, '多'))),
    'heat')
}

// ── 每日趋势图（SVG 平滑折线 + 悬浮明细）───────────────────────

function smoothPath(pts) {
  if (pts.length < 2) return ''
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)]
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`
  }
  return d
}

function TrendCard({ data, range }) {
  const [tip, setTip] = useState(null)
  const wrapRef = useRef(null)
  const W = 860, HH = 240, padL = 10, padR = 10, padT = 14, padB = 30
  const chart = useMemo(() => {
    const keys = rangeKeys(range, data.days)
    const n = keys.length
    const sums = new Map()
    for (const k of keys) {
      const prefix = k + '\u0001'
      for (const [mk, v] of data.dayModels) {
        if (mk.startsWith(prefix)) {
          const model = mk.slice(prefix.length)
          sums.set(model, (sums.get(model) || 0) + v)
        }
      }
    }
    const top = [...sums.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0])
    const totalByDay = keys.map(k => data.days.get(k)?.total || 0)
    const series = top.map(model => ({
      model,
      values: keys.map(k => data.dayModels.get(k + '\u0001' + model) || 0),
    }))
    const ymax = Math.max(1, ...totalByDay, ...series.flatMap(s => s.values))
    const x = i => padL + (i * (W - padL - padR)) / Math.max(1, n - 1)
    const y = v => HH - padB - (v / ymax) * (HH - padT - padB)
    const labelEvery = Math.max(1, Math.ceil(n / 8))
    const tickIdx = []
    for (let i = 0; i < n; i += labelEvery) tickIdx.push(i)
    if (tickIdx[tickIdx.length - 1] !== n - 1) tickIdx.push(n - 1)
    return { keys, series, totalByDay, ymax, x, y, tickIdx }
  }, [data, range])

  const onMove = useCallback(e => {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return
    const px = e.clientX - rect.left
    const plotW = W - padL - padR
    const scale = rect.width / W
    let i = Math.round((px / scale - padL) / (plotW / Math.max(1, chart.keys.length - 1)))
    i = Math.max(0, Math.min(chart.keys.length - 1, i))
    setTip({
      x: e.clientX, y: rect.top + 6,
      body: [
        h('div', { key: 't', style: { fontWeight: 600, marginBottom: 2 } },
          fmtDayCN(chart.keys[i]) + (chart.keys[i] === todayKey() ? '（今天）' : '')),
        ...chart.series.map((s, j) => h('div', { key: 'm' + j, style: { display: 'flex', gap: 8, justifyContent: 'space-between' } },
          h('span', { key: 'n', style: { color: SERIES_COLORS[j % SERIES_COLORS.length] } }, s.model),
          h('span', { key: 'v', style: { fontVariantNumeric: 'tabular-nums' } }, fmtTokens(s.values[i])))),
        h('div', { key: 'sum', style: { marginTop: 2, borderTop: '1px solid rgba(255,255,255,0.15)', paddingTop: 2, display: 'flex', gap: 8, justifyContent: 'space-between' } },
          h('span', { key: 'n', style: { opacity: 0.8 } }, '合计'),
          h('span', { key: 'v', style: { fontVariantNumeric: 'tabular-nums' } }, fmtTokens(chart.totalByDay[i]))),
      ],
      hoverIndex: i,
    })
  }, [chart])

  const hoverI = tip ? tip.hoverIndex : null
  const hoverX = hoverI != null ? chart.x(hoverI) : 0

  return SectionCard('每日 Token 趋势图', null,
    h('div', {},
      h('div', { style: { display: 'flex', gap: 18, marginBottom: 8, flexWrap: 'wrap' } },
        chart.series.map((s, i) => h('div', { key: 'lg' + i, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 } },
          h('div', { style: { width: 8, height: 8, borderRadius: 4, background: SERIES_COLORS[i % SERIES_COLORS.length] } }),
          h('span', {}, s.model)))),
      h('div', {
        ref: wrapRef, style: { position: 'relative', cursor: 'crosshair' },
        onMouseMove: onMove, onMouseLeave: () => setTip(null),
      },
        h('svg', { viewBox: `0 0 ${W} ${HH}`, style: { width: '100%', height: 'auto', display: 'block' } },
          [0.25, 0.5, 0.75, 1].map(f => h('line', {
            key: 'g' + f, x1: padL, x2: W - padR,
            y1: padT + (1 - f) * (HH - padT - padB), y2: padT + (1 - f) * (HH - padT - padB),
            stroke: 'var(--dt-border, rgba(128,128,128,0.15))', strokeWidth: 1,
          })),
          hoverI != null ? h('line', {
            key: 'guide', x1: hoverX, x2: hoverX, y1: padT, y2: HH - padB,
            stroke: muted, strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.6,
          }) : null,
          chart.series.map((s, i) => h('path', {
            key: 's' + i,
            d: smoothPath(s.values.map((v, j) => ({ x: chart.x(j), y: chart.y(v) }))),
            fill: 'none', stroke: SERIES_COLORS[i % SERIES_COLORS.length], strokeWidth: 2.5, strokeLinecap: 'round',
          })),
          h('path', {
            d: smoothPath(chart.totalByDay.map((v, j) => ({ x: chart.x(j), y: chart.y(v) }))),
            fill: 'none', stroke: muted, strokeWidth: 1.5, strokeDasharray: '4 4', opacity: 0.45,
          }),
          hoverI != null ? chart.series.map((s, i) => h('circle', {
            key: 'pt' + i, cx: hoverX, cy: chart.y(s.values[hoverI]), r: 4,
            fill: SERIES_COLORS[i % SERIES_COLORS.length], stroke: 'var(--dt-background, #1a1a1e)', strokeWidth: 1.5,
          })) : null,
          chart.tickIdx.map(i => h('text', {
            key: 'x' + i, x: chart.x(i), y: HH - 8, textAnchor: 'middle',
            fontSize: 11, fill: muted,
          }, fmtDayCN(chart.keys[i]))))),
      h(Tooltip, { tip })),
    'trend')
}

// ── 模型用量环图（跟随时间范围联动）────────────────────────────

function DonutCard({ data, range }) {
  const parts = useMemo(() => {
    const keys = rangeKeys(range, data.days)
    const sums = new Map()
    for (const k of keys) {
      const prefix = k + '\u0001'
      for (const [mk, v] of data.dayModels) {
        if (mk.startsWith(prefix)) {
          const model = mk.slice(prefix.length)
          sums.set(model, (sums.get(model) || 0) + v)
        }
      }
    }
    const sorted = [...sums.entries()].sort((a, b) => b[1] - a[1])
    const list = sorted.slice(0, 5).map(([model, tokens]) => ({ model, tokens }))
    const restSum = sorted.slice(5).reduce((a, x) => a + x[1], 0)
    if (restSum > 0) list.push({ model: '其他', tokens: restSum })
    return { all: list, total: list.reduce((a, m) => a + m.tokens, 0) }
  }, [data, range])
  const R = 70, C = 2 * Math.PI * R

  const body = parts.all.length === 0
    ? h('div', { style: { fontSize: 13, color: muted, padding: '18px 0', textAlign: 'center' } }, '该时间范围内暂无模型用量')
    : h('div', { style: { display: 'flex', alignItems: 'center', gap: 32, flexWrap: 'wrap', justifyContent: 'center' } },
      h('svg', { viewBox: '0 0 200 200', style: { width: 210, height: 210, flex: 'none' } },
        (() => {
          let acc = 0
          return [
            h('circle', { key: 'bg', cx: 100, cy: 100, r: R, fill: 'none', stroke: 'var(--dt-muted, rgba(128,128,128,0.12))', strokeWidth: 26 }),
            parts.all.map((m, i) => {
              const frac = parts.total > 0 ? m.tokens / parts.total : 0
              const dash = frac * C
              const el = h('circle', {
                key: 'seg' + i, cx: 100, cy: 100, r: R, fill: 'none',
                stroke: SERIES_COLORS[i % SERIES_COLORS.length], strokeWidth: 26,
                strokeDasharray: `${dash} ${C - dash}`, strokeDashoffset: -acc,
                transform: 'rotate(-90 100 100)',
              })
              acc += dash
              return el
            }),
            h('text', { key: 'ct', x: 100, y: 96, textAnchor: 'middle', fontSize: 20, fontWeight: 700, fill: 'var(--dt-foreground, currentColor)' }, fmtTokens(parts.total)),
            h('text', { key: 'cl', x: 100, y: 118, textAnchor: 'middle', fontSize: 11, fill: muted }, 'Token 合计'),
          ]
        })()),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 220, flex: 1 } },
        parts.all.map((m, i) => {
          const pct = parts.total > 0 ? Math.round((m.tokens / parts.total) * 100) : 0
          return h('div', { key: 'row' + i, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 } },
            h('div', { style: { width: 9, height: 9, borderRadius: 5, background: SERIES_COLORS[i % SERIES_COLORS.length], flex: 'none' } }),
            h('div', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: m.model }, m.model),
            h('div', { style: { color: muted, fontVariantNumeric: 'tabular-nums' } }, fmtTokens(m.tokens)),
            h('div', { style: { color: muted, width: 44, textAlign: 'right' } }, pct + '%'))
        }))
    )

  return SectionCard('模型用量', null, body, 'donut')
}

// ── 主页面 ──────────────────────────────────────────────────────

function UsagePage({ ctx }) {
  const [data, setData] = useState(null)
  const [phase, setPhase] = useState('loading')   // loading | ready | error
  const [error, setError] = useState('')
  const [progress, setProgress] = useState(0)
  const [range, setRange] = useState('7')          // 趋势图 + 模型环共享
  const runningRef = useRef(false)

  const refresh = useCallback(async () => {
    if (runningRef.current) return
    runningRef.current = true
    setPhase(p => (p === 'ready' ? 'ready' : 'loading'))
    setProgress(0)
    try {
      const agg = await buildAggregate(n => setProgress(n))
      setData(agg)
      setPhase('ready')
      try { ctx.storage.set('cache', JSON.stringify(serializeAggregate(agg))) } catch {}
    } catch (e) {
      setError(String((e && e.message) || e))
      setPhase('error')
    } finally {
      runningRef.current = false
    }
  }, [ctx])

  useEffect(() => {
    try {
      const raw = ctx.storage.get('cache', null)
      if (raw) {
        const agg = deserializeAggregate(JSON.parse(raw))
        if (agg) { setData(agg); setPhase('ready') }
      }
    } catch {}
    refresh()
  }, [ctx, refresh])

  if (phase === 'error') {
    return h('div', { style: { padding: 40, textAlign: 'center' } },
      h('div', { style: { fontSize: 15, marginBottom: 8 } }, '使用统计暂时不可用'),
      h('div', { style: { fontSize: 13, color: muted, marginBottom: 16 } }, error),
      h('button', {
        onClick: refresh,
        style: { padding: '6px 18px', borderRadius: 8, border: BORDER, background: 'transparent', color: 'inherit', cursor: 'pointer' },
      }, '重试'))
  }

  return h('div', { style: { maxWidth: 980, margin: '0 auto', padding: '28px 32px 48px' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 } },
      h('h1', { style: { fontSize: 26, fontWeight: 800, margin: 0 } }, '使用统计'),
      h('span', { style: { fontSize: 12, padding: '3px 10px', borderRadius: 999, border: BORDER, color: muted } },
        '本地会话 ' + (data ? data.walkTotals.sessions + ' 条' : '…')),
      h('div', { style: { flex: 1 } }),
      data ? h('span', { style: { fontSize: 12, color: muted } }, '更新于 ' + new Date(data.fetchedAt).toLocaleTimeString()) : null,
      h('button', {
        onClick: refresh, disabled: phase === 'loading',
        style: {
          padding: '5px 14px', borderRadius: 8, border: BORDER, cursor: 'pointer',
          background: 'transparent', color: 'inherit', fontSize: 12, opacity: phase === 'loading' ? 0.5 : 1,
        },
      }, phase === 'loading' ? '统计中…' : '刷新')),

    phase === 'loading' && !data
      ? h('div', { style: { padding: '60px 0', textAlign: 'center', fontSize: 13, color: muted } },
          '正在读取会话记录… 已扫描 ' + progress + ' 个会话')
      : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
        h(StatCards, { data, key: 'cards' }),
        h(HeatmapCard, { data, key: 'heat' }),
        // 时间范围：趋势图与模型环共用
        h('div', {
          key: 'range', style: {
            background: cardBg, borderRadius: 16, padding: '12px 24px',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          },
        },
          h('div', { style: { fontSize: 13, color: muted } }, '时间范围（趋势图与模型用量联动）'),
          h(SegmentedControl, { value: range, onChange: setRange, options: RANGE_OPTIONS })),
        h(TrendCard, { data, range, key: 'trend' }),
        h(DonutCard, { data, range, key: 'donut' }),
        h('div', { key: 'note', style: { fontSize: 11, lineHeight: 1.7, padding: '0 6px', color: muted } },
          h('div', {}, '口径与 API 平台一致：Token 总数 = 输入 + 输出（输入含缓存读取）。每日/每模型数据来自 state.db 的 session_model_usage 逐调用记录：会话中切换模型时各模型各归各家，跨午夜的调用按本地自然日切分，当日边界为 00:00–23:59。会话中每次调用的模型由 Hermes 在调用时刻记录。'),
          data && data.profileErrors.length ? h('div', {}, '部分档案读取失败：' + data.profileErrors.join('；')) : null)))
}

// ── 注册 ────────────────────────────────────────────────────────

export default {
  id: ID,
  register(ctx) {
    ctx.register({
      id: 'usage-page',
      area: ROUTES_AREA,
      title: '使用统计',
      data: { path: '/usage-stats' },
      render: () => jsx(UsagePage, { ctx }),
    })
    ctx.register({
      id: 'usage-nav',
      area: SIDEBAR_NAV_AREA,
      data: { path: '/usage-stats', label: '使用统计', codicon: 'graph' },
    })
    ctx.register({
      id: 'usage-cmd',
      area: PALETTE_AREA,
      data: {
        label: '打开使用统计', keywords: ['usage', 'token', '统计', '消耗', '用量'],
        run: () => host.navigate('/usage-stats'),
      },
    })
  },
}
