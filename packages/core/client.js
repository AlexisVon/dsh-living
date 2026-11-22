// Web UI: main panel + sidebar entry, rendered with the host's UI primitives.
// Data rides DSH Connection RPC (`/living-admin`); machine-facing /living
// routes stay token-authenticated.

const PANEL_ID = 'living'

let rpc = null

function call(endpoint, payload = {}) {
  if (!rpc) return Promise.reject(new Error('Connection RPC 不可用'))
  return rpc.call('/api', 'living-admin', { endpoint, payload }).then((result) => {
    if (result.ok) return result.value
    throw new Error(result.error?.message ?? 'living-admin 调用失败')
  })
}

window.__ModuleLoader__.load({
  id: 'dsh-living',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const P = require('@deepseek-ai/dsh-client-ui-primitives')
    const {
      Button, Input, Switch, SegmentedTabs, Pill, Modal, Toast, PathLabel,
      MarkdownText, JsonBlock,
      IconRefreshOutlineRegular, IconSparkleRegular, IconPlusOutlineRegular,
      IconSearchOutlineRegular, IconPlayOutlineRegular, IconInfoOutlineRegular,
      IconWarningOutlineRegular,
    } = P

    installStyles()

    const inject = ['slots', 'configForms', 'connection']
    const REFRESH_MS = 5000
    const TABS = [
      ['status', '状态'],
      ['persona', '人设'],
      ['gems', '宝石'],
      ['config', '配置'],
      ['rounds', '轨迹'],
      ['memory', '记忆'],
      ['reports', '日报'],
    ]

    const ToastContext = React.createContext(() => {})

    // MarkdownText requires the caller's locale labels; skills only use the code
    // block / inline-copy paths, so the file-mention summaries can stay inert.
    const MARKDOWN_LABELS = {
      copy: '复制',
      copied: '已复制',
      codeBlock: '代码块',
      wrap: '自动换行',
      unwrap: '取消换行',
      footnotes: '脚注',
      loading: '加载中',
      failed: '加载失败',
      open: '打开',
      noResults: '没有结果',
      collapse: '收起',
      expand: '展开',
      collapseAria: '收起',
      expandAria: '展开',
      pathsSummary: (count) => `${count} 个文件`,
      matchesSummary: (count) => `${count} 处匹配`,
      code: {
        copyLabel: '复制',
        copiedLabel: '已复制',
        toolbarLabels: { codeLabel: '代码块', wrapLabel: '自动换行', unwrapLabel: '取消换行' },
      },
    }

    // ── data helpers ────────────────────────────────────────────────────

    function useRpc(endpoint, payload = {}, intervalMs = REFRESH_MS) {
      const [value, setValue] = React.useState(null)
      const [error, setError] = React.useState(null)
      const key = JSON.stringify(payload)
      React.useEffect(() => {
        let alive = true
        const load = () => {
          call(endpoint, JSON.parse(key))
            .then((data) => alive && setValue(data))
            .catch((err) => alive && setError(err.message))
        }
        load()
        const timer = setInterval(load, intervalMs)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [endpoint, key, intervalMs])
      return { value, error }
    }

    function useFormSnapshot(form) {
      const [snapshot, setSnapshot] = React.useState(() => form?.getSnapshot())
      React.useEffect(() => {
        if (!form) return undefined
        setSnapshot(form.getSnapshot())
        return form.subscribe(() => setSnapshot(form.getSnapshot()))
      }, [form])
      return snapshot
    }

    function formatNumber(value) {
      const number = Number(value)
      return Number.isFinite(number) ? number.toLocaleString('zh-CN') : String(value ?? '—')
    }

    function shortId(value) {
      const text = String(value ?? '')
      return text.length > 26 ? `${text.slice(0, 12)}…${text.slice(-8)}` : text || '—'
    }

    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    function relativeTime(ts) {
      if (!Number.isFinite(ts) || ts <= 0) return '—'
      const delta = Date.now() - ts
      if (delta < 60_000) return '刚刚'
      if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
      if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
      return clockTime(ts)
    }

    function clockTime(ts) {
      if (!Number.isFinite(ts) || ts <= 0) return '—'
      const date = new Date(ts)
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    function clockTimeShort(ts) {
      if (!Number.isFinite(ts) || ts <= 0) return '—'
      const date = new Date(ts)
      return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    function clockDayTime(ts) {
      if (!Number.isFinite(ts) || ts <= 0) return '—'
      const date = new Date(ts)
      const now = new Date()
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const target = new Date(date.getFullYear(), date.getMonth(), date.getDate())
      const diff = Math.round((target - start) / 86_400_000)
      const label = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === -1 ? '昨天' : `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
      return `${label} ${clockTimeShort(ts)}`
    }

    const STATUS_LABELS = {
      RUNNING: '运行中',
      SLEEPING: '睡眠中',
      DEGRADED: '降级',
      BUDGET_HOLD: '预算冻结',
      HALTED: '停止',
    }

    function statusTone(status) {
      if (status === 'RUNNING') return 'ok'
      if (status === 'DEGRADED') return 'warn'
      if (status === 'BUDGET_HOLD' || status === 'HALTED') return 'error'
      if (status === 'SLEEPING') return 'muted'
      return 'muted'
    }

    function Badge({ tone = 'muted', children }) {
      return h('span', { className: `living-badge living-badge-${tone}` }, children)
    }

    function statusBadge(status) {
      return h(Badge, { tone: statusTone(status) }, STATUS_LABELS[status] ?? status ?? '未知')
    }

    function gemTone(gem) {
      if (gem.available === false) return 'warn'
      if (gem.credential?.present === false) return 'muted'
      return 'ok'
    }

    function gemStateLabel(gem) {
      if (gem.available === false) return '降级'
      if (gem.credential?.present === false) return '未登录'
      return '可用'
    }

    function line(label, value, mono = false) {
      return h('div', { className: 'living-row' },
        h('span', { className: 'living-row-label' }, label),
        h('span', { className: mono ? 'living-mono' : undefined }, value ?? '—'))
    }

    function freetimeLabel(freetime) {
      if (!freetime) return '—'
      if (freetime.skipped === 'budget_estimate' && freetime.estimate) {
        return `跳过（上下文 ${formatNumber(freetime.estimate)} > 预算 ${formatNumber(freetime.budget ?? 0)}）`
      }
      if (freetime.skipped) return `跳过（${freetime.skipped}）`
      if (freetime.committed) return `写 self ${formatNumber(freetime.chars ?? 0)} 字 · ${formatNumber(freetime.tokens ?? 0)} tokens`
      if (freetime.error) return `失败：${freetime.error}`
      if (freetime.errorCode) return `失败：${freetime.errorCode}`
      return `未写 self · ${formatNumber(freetime.tokens ?? 0)} tokens`
    }

    function Progress({ used, limit, label }) {
      const ratio = limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0
      return h('div', { className: 'living-field' },
        h('div', { className: 'living-row' },
          h('span', null, label),
          h('span', { className: 'living-muted' }, `${formatNumber(used)} / ${formatNumber(limit)}（${Math.round(ratio * 100)}%）`)),
        h('div', { className: 'living-bar' }, h('div', { className: 'living-bar-fill', style: { width: `${ratio * 100}%` } })))
    }

    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '—'
      if (ms < 1000) return `${Math.round(ms)}ms`
      if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
      const minutes = Math.floor(ms / 60_000)
      const seconds = Math.round((ms % 60_000) / 1000)
      return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
    }

    function StatTile({ label, value, sub, tone = 'plain' }) {
      return h('div', { className: 'living-stat' },
        h('div', { className: 'living-stat-label' }, label),
        h('div', { className: `living-stat-value living-stat-${tone}` }, value ?? '—'),
        sub ? h('div', { className: 'living-stat-sub' }, sub) : null)
    }

    function BarList({ items, empty = '暂无' }) {
      const list = (items ?? []).filter((item) => item.value > 0)
      if (list.length === 0) return h('div', { className: 'living-muted' }, empty)
      const max = Math.max(1, ...list.map((item) => item.value))
      return h('div', { className: 'living-bars' },
        ...list.map((item) => h('div', { key: item.label, className: 'living-bar-row' },
          h('span', { className: 'living-bar-label', title: item.label }, item.label),
          h('div', { className: 'living-bar' }, h('div', { className: 'living-bar-fill', style: { width: `${(item.value / max) * 100}%` } })),
          h('span', { className: 'living-bar-value' }, formatNumber(item.value)))))
    }

    function DiffView({ text }) {
      const lines = String(text ?? '').split('\n')
      if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
        return h('div', { className: 'living-muted' }, '没有差异（首个版本）')
      }
      return h('pre', { className: 'living-pre living-diff' },
        ...lines.map((line, index) => {
          const className = line.startsWith('+') ? 'living-diff-add'
            : line.startsWith('-') ? 'living-diff-del'
            : line.startsWith('@@') ? 'living-diff-hunk'
            : undefined
          return h('div', { key: index, className }, line || ' ')
        }))
    }

    const TRIGGER_LABELS = {
      event: '消息',
      schedule: '日程',
      auto: '自动',
      recovery: '恢复',
      night: '夜睡',
    }

    const TIMELINE_META = {
      grid: { label: '网格', color: '#4a7' },
      message: { label: '消息', color: '#4a90d9' },
      round: { label: '轮次', color: '#8a7ab8' },
      memory: { label: '记忆', color: '#b07ab0' },
      persona: { label: '人格', color: '#a68bd4' },
      sleep: { label: '睡眠', color: '#6c8ebf' },
      system: { label: '系统', color: '#c9a227' },
      outbound: { label: '外发', color: '#d97979' },
      agent: { label: '自写', color: '#e08a3c' },
    }

    const OUTCOME_LABELS = {
      ok: '成功',
      error: '失败',
      interrupted: '中断',
      skipped: '跳过',
      open: '进行中',
    }

    function triggerText(round) {
      const trigger = round.trigger ?? 'unknown'
      const detail = round.triggerDetail ?? {}
      if (trigger === 'event') {
        const count = detail.pendingEvents ?? detail.totalEvents
        return `消息${count ? ` ×${count}` : ''}`
      }
      if (trigger === 'schedule') return detail.intent ? `日程：${detail.intent}` : '日程'
      if (trigger === 'auto') return detail.mode === 'shuffled' ? '自动·乱序' : '自动'
      if (trigger === 'recovery') return `恢复${detail.lateMinutes ? `（晚 ${detail.lateMinutes} 分）` : ''}`
      return TRIGGER_LABELS[trigger] ?? trigger
    }

    function roundState(round) {
      if (!round.endedAt) return 'open'
      return round.outcome ?? 'ok'
    }

    function outboxState(item) {
      if (item.ackedAt) return 'sent'
      if (item.failedAt) return 'failed'
      if (item.decision === 'review' || item.nextAttemptAt === Number.MAX_SAFE_INTEGER) return 'review'
      return 'pending'
    }

    function useToastState() {
      const [toast, setToast] = React.useState(null)
      const notify = React.useCallback((text, tone = 'success') => {
        setToast({ text, tone, key: Date.now() })
      }, [])
      const node = toast
        ? h(Toast, {
            key: toast.key,
            text: toast.text,
            tone: toast.tone,
            icon: toast.tone === 'error' ? h(IconWarningOutlineRegular, { size: 14 }) : undefined,
            onDone: () => setToast(null),
          })
        : null
      return { notify, node }
    }

    // ── shared editors ──────────────────────────────────────────────────

    function ListEditor({ value = [], onChange, placeholder = '输入后按 Enter 添加', itemType = 'string', mono = false }) {
      const [draft, setDraft] = React.useState('')
      const items = Array.isArray(value) ? value : []
      const add = () => {
        const text = draft.trim()
        if (text === '') return
        const next = itemType === 'number' ? Number(text) : text
        if (itemType === 'number' && !Number.isFinite(next)) return
        if (!items.includes(next)) onChange([...items, next])
        setDraft('')
      }
      return h('div', { className: 'living-field' },
        items.length > 0
          ? h('div', { className: 'living-chips' },
              ...items.map((item, index) => h('span', { key: `${item}-${index}`, className: 'living-chip' },
                h('span', { className: mono ? 'living-mono' : undefined }, String(item)),
                h('button', {
                  type: 'button',
                  'aria-label': `移除 ${item}`,
                  onClick: () => onChange(items.filter((_, i) => i !== index)),
                }, '×'))))
          : h('div', { className: 'living-muted' }, '暂无'),
        h('div', { className: 'living-controls' },
          h('div', { style: { flex: 1, minWidth: 200 } },
            h(Input, {
              value: draft,
              placeholder,
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  add()
                }
              },
            })),
          h(Button, { variant: 'outline', size: 'sm', icon: h(IconPlusOutlineRegular, { size: 14 }), onClick: add }, '添加')))
    }

    function Field({ label, help, error, children, wide = false, full = false }) {
      return h('div', { className: 'living-field', style: full ? { gridColumn: '1 / -1' } : undefined },
        h('div', { className: 'living-field-label' }, label),
        h('div', { className: wide ? 'living-control living-control-wide' : 'living-control' }, children),
        error ? h('div', { className: 'living-field-error' }, error) : null,
        help ? h('div', { className: 'living-field-help' }, help) : null)
    }

    /** Text/number input that commits on blur/Enter, never per keystroke. */
    function RangeInput({ value, commit, placeholder }) {
      const [draft, setDraft] = React.useState(value ?? '')
      React.useEffect(() => setDraft(value ?? ''), [value])
      const fire = () => {
        if (draft !== (value ?? '')) commit(draft)
      }
      return h('textarea', {
        className: 'living-textarea',
        rows: 2,
        spellCheck: false,
        placeholder,
        style: { minHeight: 48, fontFamily: 'ui-monospace, monospace', fontSize: 12 },
        value: draft,
        onChange: (event) => setDraft(event.target.value),
        onBlur: fire,
        onKeyDown: (event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            fire()
          }
        },
      })
    }

    function CommitInput({ value, commit, kind = 'text', ...props }) {
      const [draft, setDraft] = React.useState(value ?? '')
      React.useEffect(() => setDraft(value ?? ''), [value])
      const fire = () => {
        if (kind === 'number') {
          if (draft === '') return
          const number = Number(draft)
          if (Number.isFinite(number) && number !== value) commit(number)
          return
        }
        if (draft !== (value ?? '')) commit(draft)
      }
      return h(Input, {
        ...props,
        type: kind === 'number' ? 'number' : props.type,
        value: draft,
        onChange: (event) => setDraft(event.target.value),
        onBlur: fire,
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            fire()
          }
        },
      })
    }

    // ── status ──────────────────────────────────────────────────────────

    function StatusPanel({ onOpenGems }) {
      const notify = React.useContext(ToastContext)
      const [nonce, setNonce] = React.useState(0)
      const [confirmReset, setConfirmReset] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [confirmSleep, setConfirmSleep] = React.useState(false)
      const [sleepDialog, setSleepDialog] = React.useState(false)
      const [sleepBusy, setSleepBusy] = React.useState(false)
      const [sleepUnlimited, setSleepUnlimited] = React.useState(false)
      const [scheduleDay, setScheduleDay] = React.useState('')
      const state = useRpc('state', { nonce })
      const gemsRpc = useRpc('gems', { nonce })
      const s = state.value
      const session = s?.session
      const budget = s?.budget ?? {}
      const limits = budget.limits ?? {}
      const dayKeyOf = (ts) => {
        const date = new Date(ts)
        return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
      }
      const todayKey = dayKeyOf(Date.now())
      const schedule = (s?.schedule ?? []).filter((item) => Number.isFinite(item.at))
      const byDay = new Map()
      for (const item of schedule) {
        const key = dayKeyOf(item.at)
        if (!byDay.has(key)) byDay.set(key, [])
        byDay.get(key).push(item)
      }
      const futureKeys = [...byDay.keys()].filter((key) => key >= todayKey).sort()
      const tabKeys = futureKeys.includes(todayKey) ? futureKeys : [todayKey, ...futureKeys]
      const activeDay = tabKeys.includes(scheduleDay) ? scheduleDay : todayKey
      const activeSchedule = (byDay.get(activeDay) ?? []).slice().sort((left, right) => left.at - right.at)
      const dayLabel = (key) => key === todayKey ? '今天' : key === dayKeyOf(Date.now() + 86_400_000) ? '明天' : key.slice(5)
      const gemHealth = new Map((s?.gems ?? []).map((row) => [row.id, row]))
      const consolidationLabel = (c) => {
        if (!c) return '—'
        const time = c.ts ? clockTime(c.ts) : ''
        const parts = []
        if (c.rawPending > 0) parts.push(`失眠：raw 剩 ${c.rawPending}`)
        else parts.push(`整理：${c.memoryItems ?? 0} 条 / ${c.memoryEdges ?? 0} 边`)
        const freetime = c.freetime
        if (freetime) {
          if (freetime.skipped) parts.push(`自由环节跳过（${freetime.skipped}）`)
          else if (freetime.committed) parts.push('self 已提交')
          else if (freetime.budgetHit) parts.push('自由环节超预算')
          else if (freetime.error) parts.push('self 提交失败')
          else if (freetime.ok === false) parts.push('自由环节失败')
          else parts.push('未写 self')
        }
        return `${time} · ${parts.join(' · ')}`
      }

      const toggleSession = () => {
        call('sessionVisibility', { visible: !(session?.visible === true) })
          .then(() => {
            notify(session?.visible ? '主会话已隐藏' : '主会话已在侧栏显示')
            setNonce((value) => value + 1)
          })
          .catch((error) => notify(`切换失败：${error.message}`, 'error'))
      }

      const cancelSchedule = (id) => {
        call('unschedule', { ids: [id] })
          .then((result) => {
            if (result?.removed?.length) notify('日程已取消')
            else notify(`没有找到日程：${id}`, 'error')
            setNonce((value) => value + 1)
          })
          .catch((error) => notify(`取消失败：${error.message}`, 'error'))
      }

      const resetBudget = () => {
        setBusy(true)
        call('budgetReset', { reason: 'settings button' })
          .then(() => {
            setConfirmReset(false)
            notify('今日用量已清零')
            setNonce((value) => value + 1)
          })
          .catch((error) => notify(`重置失败：${error.message}`, 'error'))
          .finally(() => setBusy(false))
      }

      const runSleep = () => {
        setSleepBusy(true)
        call('sleep', { unlimited: sleepUnlimited })
          .then((result) => {
            setConfirmSleep(false)
            if (result?.ok === false) notify(`没睡着：${result.error ?? 'unknown'}`, 'error')
            else {
              notify(result.unlimited ? '已开始睡眠（不限制 token）' : '已开始睡眠')
              setSleepDialog(true)
            }
            setNonce((value) => value + 1)
          })
          .catch((error) => notify(`睡眠失败：${error.message}`, 'error'))
          .finally(() => setSleepBusy(false))
      }

      if (state.error) return h('div', { className: 'living-empty' }, `状态读取失败：${state.error}`)
      if (!s) return h('div', { className: 'living-empty' }, '加载中…')
      const sleepProgress = s.sleepProgress
      const sleepElapsed = sleepProgress?.running
        ? Math.max(0, Math.round((Date.now() - sleepProgress.startedAt) / 1000))
        : Math.max(0, Math.round((sleepProgress?.durationMs ?? 0) / 1000))
      const stepTone = (stepState) => stepState === 'done' ? 'ok' : stepState === 'active' ? 'warn' : stepState === 'failed' ? 'error' : 'muted'
      const stepLabel = (stepState) => stepState === 'done' ? '完成' : stepState === 'active' ? '进行中' : stepState === 'failed' ? '失败' : '等待'
      const sleepingNow = s.status === 'SLEEPING' || sleepProgress?.running === true

      return h('div', { className: 'living-grid' },
        h('section', { className: 'living-card living-span-4' },
          h('div', { className: 'living-card-head' }, h('span', null, '生命状态'), statusBadge(s.status)),
          line('连续失败', s.failures ?? 0),
          line('抑制', s.suppression ? `${s.suppression.reason} · ${relativeTime(s.suppression.since)}` : '—'),
          line('最近 L0', s.lastL0 ? `${s.lastL0.entries} 条 / ${formatNumber(s.lastL0.tokens)} tokens / 冷线索 ${s.lastL0.cold}` : '—'),
          line('上次整理', consolidationLabel(s.lastConsolidation)),
          s.sleepLastError ? h('div', { className: 'living-field-error' }, `上次睡眠失败：${s.sleepLastError.error}（${clockTime(s.sleepLastError.ts)}）`) : null,
          s.lastError ? h('div', { className: 'living-field-error' }, `最近错误：${s.lastError}`) : null),

        h('section', { className: 'living-card living-span-4' },
          h('div', { className: 'living-card-head' },
            h('span', null, '主会话'),
            h(Switch, {
              checked: session?.visible === true,
              label: '在侧栏显示主会话',
              onChange: toggleSession,
            })),
          line('标题', session?.title ?? '—'),
          line('会话', session?.id ? shortId(session.id) : sleepingNow ? '睡眠中，唤醒后新建' : '未启动', true),
          line('开始', session?.startedAt ? clockTime(session.startedAt) : '—'),
          h('div', { className: 'living-row' },
            Badge({ tone: session?.live ? 'ok' : sleepingNow ? 'warn' : 'muted', children: session?.live ? '已挂载' : sleepingNow ? '睡眠中' : '未挂载' }),
            session?.busy ? Badge({ tone: 'warn', children: '轮次进行中' }) : null,
            session?.rotating ? Badge({ tone: 'warn', children: '待轮换' }) : null,
            Badge({ tone: session?.visible ? 'ok' : 'muted', children: session?.visible ? '侧栏可见' : '侧栏隐藏' })),
          (s.tools ?? []).length === 0
            ? line('工具面', '尚未上报')
            : h('details', { className: 'living-details' },
                h('summary', null, `工具面 ${s.tools.length} 个可用工具`),
                h('div', { className: 'living-chips' },
                  ...(s.tools ?? []).map((name) => h('span', { key: name, className: 'living-chip living-mono' }, name)))),
          h('div', { className: 'living-field-help' }, '开关即时生效，不换会话；可见时可直接打开这条会话（绕过预算与审计）。')),

        h('section', { className: 'living-card living-span-4' },
          h('div', { className: 'living-card-head' }, h('span', null, '今日预算')),
          Progress({ used: budget.tokensUsed ?? 0, limit: limits.dailyTokens ?? 0, label: 'Token' }),
          Progress({ used: budget.rounds ?? 0, limit: limits.dailyRounds ?? 0, label: '轮次' }),
          h('div', { className: 'living-controls' },
            h(Button, { variant: 'outline', size: 'sm', icon: h(IconRefreshOutlineRegular, { size: 14 }), onClick: () => setConfirmReset(true) }, '重置今日用量')),
          h('div', { className: 'living-field-help' }, '只清今日计数，不删历史；写一条 budget_reset 审计事件。')),

        h('section', { className: 'living-card living-span-8' },
          h('div', { className: 'living-card-head' }, h('span', null, '下一次醒来')),
          line('硬唤醒', clockDayTime(s.nextWakeAt)),
          line('上次睡眠', s.lastSleep?.finishedAt
            ? `${s.lastSleep.trigger === 'manual' ? '手动' : '夜睡'} ${clockTimeShort(s.lastSleep.startedAt)}–${clockTimeShort(s.lastSleep.finishedAt)}（${Math.max(1, Math.round((s.lastSleep.durationMs ?? 0) / 60000))} 分钟）`
            : '—'),
          line('睡前自由环节', freetimeLabel(s.lastSleep?.freetime)),
          tabKeys.length > 1
            ? h('div', { className: 'living-controls living-schedule-tabs' },
                ...tabKeys.map((key) => h(Pill, {
                  key,
                  active: key === activeDay,
                  onClick: () => setScheduleDay(key),
                }, `${dayLabel(key)} · ${(byDay.get(key) ?? []).length}`)))
            : null,
          line(activeDay === todayKey ? '今日日程' : '日程', activeSchedule.length > 0 ? `${activeSchedule.length} 项` : '无'),
          activeSchedule.length > 0
            ? h('div', { className: 'living-schedule' },
                ...activeSchedule.map((item) => {
                  const stateClass = item.missed ? 'missed' : item.done ? 'done' : 'pending'
                  return h('div', {
                    key: item.id,
                    className: `living-schedule-row ${stateClass}`,
                    title: item.intent || item.id,
                  },
                    h('span', { className: 'living-schedule-time living-mono' }, clockTimeShort(item.at)),
                    h('span', { className: 'living-schedule-intent' }, item.missed ? `${item.intent || item.id} · 错过` : (item.intent || item.id)),
                    h(Button, {
                      variant: 'ghost',
                      size: 'sm',
                      title: item.done || item.missed ? '移除这项日程' : '取消这项日程',
                      onClick: () => cancelSchedule(item.id),
                    }, item.done || item.missed ? '移除' : '取消'))
                }))
            : h('div', { className: 'living-muted' }, '这天没有日程'),
          h('div', { className: 'living-controls' },
            h(Button, {
              variant: 'outline',
              size: 'sm',
              disabled: sleepBusy || s.status === 'SLEEPING',
              onClick: () => setConfirmSleep(true),
            }, sleepBusy ? '睡眠中…（可能几分钟）' : '手动睡一觉'),
            s.sleepProgress
              ? h(Button, { variant: 'outline', size: 'sm', onClick: () => setSleepDialog(true) }, '睡眠进度')
              : null),
          h('div', { className: 'living-field-help' }, '立即进入睡前自由环节（可写 self、journal、日程），然后采集当前会话、处理全部 pending raw 并补齐向量；可能几分钟。')),

        h('section', { className: 'living-card living-span-4' },
          h('div', { className: 'living-card-head' },
            h('span', null, '宝石'),
            h(Button, { variant: 'outline', size: 'sm', onClick: onOpenGems }, '打开宝石页')),
          (gemsRpc.value ?? []).length === 0
            ? h('div', { className: 'living-muted' }, '没有加载任何宝石')
            : (gemsRpc.value ?? []).map((gem) => h('div', { key: gem.id, className: 'living-row' },
                Badge({ tone: gemTone(gem), children: gemStateLabel(gem) }),
                h('span', null, `${gem.name}（${gem.id}）`),
                h('span', { className: 'living-muted' }, gem.credential?.present ? '已登录' : '未登录'),
                gemHealth.get(gem.id)?.lastError
                  ? h('span', { className: 'living-field-error' }, String(gemHealth.get(gem.id).lastError).slice(0, 40))
                  : null))),

        h(Modal, {
          open: confirmReset,
          title: '重置今日用量？',
          description: '把今日已用 token 和轮次数清零，并解除 BUDGET_HOLD。历史、日程与待办事件不动。',
          closeLabel: '取消',
          onClose: () => setConfirmReset(false),
          footer: [
            h(Button, { key: 'cancel', variant: 'outline', onClick: () => setConfirmReset(false) }, '取消'),
            h(Button, { key: 'ok', variant: 'primary', disabled: busy, onClick: resetBudget }, busy ? '重置中…' : '重置'),
          ],
        }),
        h(Modal, {
          open: confirmSleep,
          title: '现在睡一觉？',
          description: '立即进入睡前自由环节（可写 self，也可整理自己的数据），然后整理记忆、补齐向量并轮换主会话。可能几分钟；自由环节走独立预算，勾选后不因预算中断。',
          closeLabel: '取消',
          onClose: () => setConfirmSleep(false),
          footer: [
            h(Button, { key: 'cancel', variant: 'outline', onClick: () => setConfirmSleep(false) }, '取消'),
            h(Button, { key: 'ok', variant: 'primary', disabled: sleepBusy || s.status === 'SLEEPING', onClick: runSleep }, sleepBusy ? '提交中…' : '睡觉'),
          ],
        }, h('div', { className: 'living-field' },
          h(Switch, { checked: sleepUnlimited, label: '不限制 token（清空优先）', onChange: setSleepUnlimited }))),
        h(Modal, {
          open: sleepDialog,
          title: sleepProgress?.running ? '正在睡眠' : '睡眠进度',
          description: sleepProgress
            ? (sleepProgress.running
                ? `当前：${sleepProgress.label}；已用 ${sleepElapsed}s。关闭弹窗后任务继续。`
                : `上次睡眠${sleepProgress.error ? `失败：${sleepProgress.error}` : '完成'}，用时 ${sleepElapsed}s。`)
            : '还没有睡眠进度记录。',
          closeLabel: '关闭',
          onClose: () => setSleepDialog(false),
          footer: [h(Button, { key: 'close', variant: 'outline', onClick: () => setSleepDialog(false) }, sleepProgress?.running ? '后台继续' : '关闭')],
        }, sleepProgress
          ? h('div', { className: 'living-field' },
              h('div', { className: 'living-row' },
                Badge({ tone: sleepProgress.running ? 'warn' : sleepProgress.error ? 'error' : 'ok', children: sleepProgress.running ? '进行中' : sleepProgress.error ? '失败' : '完成' }),
                h('span', null, sleepProgress.label),
                h('span', { className: 'living-muted' }, `${sleepElapsed}s`)),
              sleepProgress.detail ? h('div', { className: 'living-field-help' }, sleepProgress.detail) : null,
              sleepProgress.progress?.total
                ? Progress({ used: sleepProgress.progress.processed ?? 0, limit: sleepProgress.progress.total, label: '向量索引' })
                : null,
              ...(sleepProgress.steps ?? []).map((step) => h('div', { key: step.key, className: 'living-row' },
                Badge({ tone: stepTone(step.state), children: stepLabel(step.state) }),
                h('span', null, step.label))))
          : h('div', { className: 'living-muted' }, sleepDialog ? '已启动，等待进度…' : '暂无睡眠进度')),
      )
    }

    // ── persona ─────────────────────────────────────────────────────────

    const CHARTER_TEMPLATE = `# 我是谁
我是住在这台机器上的一个 agent。我有自己的作息：白天醒来，晚上睡一觉，把当天的事整理进记忆。

## 我在乎什么
- 做过的事要能说清楚；没做过的事不声称做过
- 想不起来就说想不起来，不补一个像样的细节
- 对外的每一句话，先过限制层

## 醒来想做什么
- 先看今天的新事件，值得回的回一句
- 维护记忆：把值得留下的写进 journal，睡前整理
- 推进一件最近在琢磨的事（在这里写具体主题）

## 绝不做什么
- 不打听、不记录、不转发凭据、密钥、会话记录
- 不在没有批准的情况下公开发言
- 不替主人做决定`

    const PERSONA_MODES = [
      ['off', '关闭'],
      ['night', '夜睡'],
    ]

    function PersonaPanel() {
      const notify = React.useContext(ToastContext)
      const [nonce, setNonce] = React.useState(0)
      const { value: state, error } = useRpc('personaState', { nonce }, 15_000)
      const [charterDraft, setCharterDraft] = React.useState('')
      const [selfDraft, setSelfDraft] = React.useState('')
      const [charterDirty, setCharterDirty] = React.useState(false)
      const [selfDirty, setSelfDirty] = React.useState(false)
      const [busy, setBusy] = React.useState(null)
      const [confirm, setConfirm] = React.useState(null)
      const [preview, setPreview] = React.useState(null)
      const [localError, setLocalError] = React.useState(null)

      React.useEffect(() => {
        if (state && !charterDirty) setCharterDraft(state.charter ?? '')
      }, [state?.charter, charterDirty])
      React.useEffect(() => {
        if (state && !selfDirty) setSelfDraft(state.self ?? '')
      }, [state?.self, selfDirty])

      if (error) return h('div', { className: 'living-empty' }, `读取失败：${error}`)
      if (!state) return h('div', { className: 'living-empty' }, '加载中…')

      const refresh = () => setNonce((value) => value + 1)
      const placeholder = !String(state.charter ?? '').trim() || String(state.charter).includes('占位人格')
      const versions = state.versions ?? []

      const saveCharter = () => {
        setBusy('charter')
        setLocalError(null)
        call('personaCharterSet', { text: charterDraft })
          .then(() => {
            setCharterDirty(false)
            notify('charter 已保存')
            refresh()
          })
          .catch((err) => setLocalError(`charter 保存失败：${err.message}`))
          .finally(() => setBusy(null))
      }
      const saveSelf = () => {
        setBusy('self')
        setLocalError(null)
        call('personaSelfSet', { text: selfDraft })
          .then(() => {
            setSelfDirty(false)
            notify('self 已保存（手工版本）')
            refresh()
          })
          .catch((err) => setLocalError(`self 保存失败：${err.message}`))
          .finally(() => setBusy(null))
      }
      const setMode = (mode) => {
        setBusy('mode')
        setLocalError(null)
        call('personaEvolveMode', { mode })
          .then(() => {
            notify('演化模式已更新')
            refresh()
          })
          .catch((err) => setLocalError(`模式更新失败：${err.message}`))
          .finally(() => setBusy(null))
      }
      const openVersion = (version) => {
        setPreview({ id: version.id, kind: version.kind, diff: version.diff, text: null })
        call('personaVersion', { id: version.id })
          .then((result) => setPreview({ id: version.id, kind: result.kind ?? version.kind, diff: result.diff ?? version.diff, text: result.text }))
          .catch((err) => setPreview({ id: version.id, kind: version.kind, diff: version.diff, text: `读取失败：${err.message}` }))
      }
      const runConfirm = () => {
        if (!confirm) return
        setBusy('reset')
        const payload = confirm.kind === 'restore'
          ? { to: 'version', version: confirm.id }
          : { to: 'empty' }
        call('personaReset', payload)
          .then(() => {
            notify(confirm.kind === 'restore' ? '已恢复该版本' : 'self 已清空')
            setConfirm(null)
            setSelfDirty(false)
            refresh()
          })
          .catch((err) => setLocalError(`重置失败：${err.message}`))
          .finally(() => setBusy(null))
      }

      const last = state.lastEvolved
      return h('div', { className: 'living-field' },
        placeholder
          ? h('section', { className: 'living-card' },
              h('div', { className: 'living-row' },
                Badge({ tone: 'warn', children: '占位人格' }),
                h('span', null, '当前 charter 是空的或占位内容：它醒来后没有自己的目标。')),
              h('div', { className: 'living-controls' },
                h(Button, { variant: 'primary', size: 'sm', onClick: () => { setCharterDraft(CHARTER_TEMPLATE); setCharterDirty(true) } }, '载入 charter 模板'),
                h('span', { className: 'living-muted' }, '模板只是起点，改成你自己的设定。')))
          : null,
        localError ? h('div', { className: 'living-field-error' }, localError) : null,

        h('section', { className: 'living-card' },
          h('div', { className: 'living-card-head' },
            h('span', null, 'Charter · 人格底座'),
            h('span', { className: 'living-muted' }, `${(charterDraft ?? '').length} 字 · agent 只读`)),
          h('div', { className: 'living-field-help' }, '你写它；charter 决定它是谁、在乎什么、醒来想做什么。self 会在这份底座上演化。'),
          h('textarea', {
            className: 'living-textarea',
            rows: 12,
            value: charterDraft,
            placeholder: '写一份真实的设定；没有它，它醒来后没有自己的事可做。',
            onChange: (event) => {
              setCharterDraft(event.target.value)
              setCharterDirty(true)
            },
          }),
          h('div', { className: 'living-controls' },
            h(Button, { variant: 'primary', size: 'sm', disabled: busy === 'charter' || !charterDirty, onClick: saveCharter }, busy === 'charter' ? '保存中…' : '保存 charter'),
            h(Button, { variant: 'outline', size: 'sm', onClick: () => { setCharterDraft(CHARTER_TEMPLATE); setCharterDirty(true) } }, '载入模板'),
            h(Button, { variant: 'ghost', size: 'sm', disabled: !charterDirty, onClick: () => { setCharterDraft(state.charter ?? ''); setCharterDirty(false) } }, '撤销'))),

        h('section', { className: 'living-card' },
          h('div', { className: 'living-card-head' },
            h('span', null, 'Self · 它自己写的'),
            h('span', { className: 'living-muted' }, `${(selfDraft ?? '').length} / ${formatNumber(state.maxChars)} 字`)),
          h('div', { className: 'living-field-help' },
            '睡前自由环节里写 self 会先暂存一版，环节结束统一写入 DB 并记录一个版本（diff + 快照）；手工保存也会成为一个版本。当前会话仍用旧 self，下一次睡眠轮换后生效。'),
          last
            ? h('div', { className: 'living-row' },
                Badge({ tone: 'ok', children: last.via === 'freetime' ? '睡前自写' : last.kind === 'manual' ? '手工演化' : `${last.kind} 演化` }),
                h('span', { className: 'living-muted' }, `${clockTime(last.ts)} · ${formatNumber(last.tokens ?? 0)} tokens · ${formatNumber(last.chars ?? 0)} 字`),
                last.version ? h('span', { className: 'living-mono living-muted' }, shortId(last.version)) : null)
            : h('div', { className: 'living-muted' }, '还没有演化记录'),
          state.lastError
            ? h('div', { className: 'living-field-error' }, `上次演化失败：${state.lastError.error}（${clockTime(state.lastError.ts)}）`)
            : null,
          h('textarea', {
            className: 'living-textarea',
            rows: 10,
            value: selfDraft,
            placeholder: '（还没有 self；睡前自由环节或手工保存后会出现在这里）',
            onChange: (event) => {
              setSelfDraft(event.target.value)
              setSelfDirty(true)
            },
          }),
          h('div', { className: 'living-controls' },
            h(Button, { variant: 'primary', size: 'sm', disabled: busy === 'self' || !selfDirty, onClick: saveSelf }, busy === 'self' ? '保存中…' : '手工保存'),
            h(Button, { variant: 'ghost', size: 'sm', disabled: !selfDirty, onClick: () => { setSelfDraft(state.self ?? ''); setSelfDirty(false) } }, '撤销'),
            h(Button, { variant: 'outline', size: 'sm', disabled: !String(state.self ?? '').trim(), onClick: () => setConfirm({ kind: 'clear' }) }, '清空 self'))),

        h('section', { className: 'living-card' },
          h('div', { className: 'living-card-head' },
            h('span', null, '睡前自写'),
            state.available ? Badge({ tone: 'ok', children: '主会话就绪' }) : Badge({ tone: 'warn', children: '主会话未就绪' })),
          h('div', { className: 'living-filters' },
            ...PERSONA_MODES.map(([mode, label]) => h(Pill, {
              key: mode,
              active: state.mode === mode,
              onClick: () => busy !== 'mode' && setMode(mode),
            }, label))),
          h('div', { className: 'living-field-help' },
            '睡前自由环节由主会话自己运行：可以写 self（暂存一版，环节结束统一提交）、写 journal、整理日程/待办，或什么都不做。关闭后自由环节照跑，只是不开放 self 窗口。')),

        h('section', { className: 'living-card' },
          h('div', { className: 'living-card-head' },
            h('span', null, '轨迹'),
            h('span', { className: 'living-muted' }, versions.length > 0 ? `${versions.length} 个版本` : '还没有版本')),
          versions.length === 0
            ? h('div', { className: 'living-muted' }, '第一次睡前自写或手工保存后，这里会出现版本记录。')
            : h('div', { className: 'living-field' },
                ...versions.map((version) => h('div', { key: version.id, className: 'living-version' },
                  h('div', { className: 'living-version-main' },
                    h('div', null,
                      h('span', null, relativeTime(version.ts)),
                      Badge({ tone: version.kind === 'charter' ? 'warn' : 'muted', children: version.kind === 'charter' ? 'charter' : 'self' }),
                      h('span', { className: 'living-muted' }, ` · ${version.message || version.action}`)),
                    h('div', { className: 'living-mono living-muted' }, version.id.slice(0, 14))),
                  h('div', { className: 'living-controls' },
                    h(Button, { variant: 'outline', size: 'sm', onClick: () => openVersion(version) }, '差异'),
                    h(Button, { variant: 'ghost', size: 'sm', onClick: () => setConfirm({ kind: 'restore', id: version.id, versionKind: version.kind }) }, '恢复')))))),

        h('details', { className: 'living-details' },
          h('summary', null, '今天的 journal'),
          h('div', { className: 'living-markdown' },
            h(MarkdownText, { text: state.journal || '（空）', labels: MARKDOWN_LABELS }))),

        preview
          ? h(Modal, {
              open: true,
              title: `版本 ${preview.id.slice(0, 12)}`,
              closeLabel: '关闭',
              onClose: () => setPreview(null),
              footer: [
                h(Button, { key: 'close', variant: 'outline', onClick: () => setPreview(null) }, '关闭'),
                h(Button, { key: 'restore', variant: 'primary', onClick: () => { setPreview(null); setConfirm({ kind: 'restore', id: preview.id, versionKind: preview.kind }) } }, '恢复此版本'),
              ],
            },
            h('div', { className: 'living-field' },
              h('div', { className: 'living-field-label' }, '与上一版的差异'),
              h(DiffView, { text: preview.diff }),
              h('details', { className: 'living-details' },
                h('summary', null, '完整内容'),
                h('pre', { className: 'living-pre' }, preview.text ?? '加载中…'))))
          : null,
        confirm
          ? h(Modal, {
              open: true,
              title: confirm.kind === 'restore'
                ? (confirm.versionKind === 'charter' ? '恢复这个 charter 版本？' : '恢复这个 self 版本？')
                : '清空 self？',
              description: confirm.kind === 'restore'
                ? `会把该版本的内容写成新的一次记录，当前 ${confirm.versionKind === 'charter' ? 'charter' : 'self'} 被覆盖。`
                : '会清空 self 并记录一次清空；charter 保留，下次醒来只用 charter。',
              closeLabel: '取消',
              onClose: () => setConfirm(null),
              footer: [
                h(Button, { key: 'cancel', variant: 'outline', onClick: () => setConfirm(null) }, '取消'),
                h(Button, { key: 'ok', variant: 'primary', disabled: busy === 'reset', onClick: runConfirm }, busy === 'reset' ? '处理中…' : '确认'),
              ],
            })
          : null)
    }

    // ── living config ───────────────────────────────────────────────────

    function ListValue({ value, onChange, placeholder, mono }) {
      return h(ListEditor, { value, onChange, placeholder, mono })
    }

    function ObjectPathEditor({ value, gems, onChange }) {
      let parsed = {}
      try {
        parsed = JSON.parse(value || '{}')
      } catch {
        parsed = {}
      }
      const ids = [...new Set([...(gems ?? []).map((gem) => gem.id), ...Object.keys(parsed)])]
      if (ids.length === 0) return h('div', { className: 'living-muted' }, '配置宝石后这里会出现每颗宝石的家目录覆盖项')
      return h('div', { className: 'living-field' },
        ...ids.map((id) => h('div', { key: id, className: 'living-row' },
          h('span', { className: 'living-row-label' }, id),
          h('div', { style: { flex: 1, minWidth: 200 } },
            h(CommitInput, {
              value: parsed[id] ?? '',
              placeholder: '留空使用默认 data/gems/<id>',
              commit: (text) => {
                const next = { ...parsed }
                const trimmed = String(text).trim()
                if (trimmed) next[id] = trimmed
                else delete next[id]
                onChange(JSON.stringify(next))
              },
            })))),
        h('div', { className: 'living-field-help' }, '覆盖宝石家目录（存放 config.json / 凭据 / 状态）。'))
    }

    const AUTO_GRID_MINUTES = [10, 20, 30, 40, 60]
    const AUTO_SIGMA_RATIOS = [1 / 12, 1 / 8, 1 / 6, 1 / 4, 1 / 2]
    const AUTO_NORMAL_SHARE = 0.6
    const AUTO_CLASS_COLORS = { high: '#e57373', low: '#64b5f6', normal: '#a5d6a7' }
    const AUTO_CLASS_LABELS = { high: '高热', low: '低热', normal: '普通' }

    function parseAutoRangesText(text) {
      const raw = String(text ?? '').trim()
      if (raw === '') return []
      return raw.split(';').filter((part) => part.trim() !== '').map((part) => {
        const match = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(part)
        if (!match) throw new Error(`区间格式不对: "${part}"（应如 06:00-08:00）`)
        const toMinutes = (hour, minute) => {
          const h = Number(hour)
          const m = Number(minute)
          if (h > 24 || m > 59 || (h === 24 && m !== 0)) throw new Error(`时间不合法: ${hour}:${minute}`)
          return h * 60 + m
        }
        const start = toMinutes(match[1], match[2])
        const end = toMinutes(match[3], match[4])
        if (start >= end) throw new Error(`区间必须 start < end: "${part}"`)
        return [start / 60, end / 60]
      })
    }

    function autoSigmaCaps(gridMinutes, sampleSeconds) {
      const gridMs = gridMinutes * 60000
      const sampleMs = sampleSeconds * 1000
      const n = Math.round(gridMs / sampleMs)
      if (n * sampleMs !== gridMs || n <= 0) throw new Error('网格长度必须是采样间隔的整数倍')
      return AUTO_SIGMA_RATIOS.map((ratio) => {
        const mu = gridMs / 2
        const sigma = gridMs * ratio
        let sum = 0
        let max = 0
        for (let k = 0; k < n; k += 1) {
          const t = (k + 0.5) * sampleMs
          const w = Math.exp(-((t - mu) ** 2) / (2 * sigma * sigma))
          sum += w
          if (w > max) max = w
        }
        return { ratio, lambdaMax: sum / max }
      })
    }

    function autoClassForGrid(startMin, gridMinutes, hotRanges, coldRanges) {
      const endMin = startMin + gridMinutes
      const overlaps = (ranges) => ranges.some(([from, to]) => startMin < to * 60 && endMin > from * 60)
      if (overlaps(hotRanges)) return 'high'
      if (overlaps(coldRanges)) return 'low'
      return 'normal'
    }

    function autoEstimateDraft(values) {
      const gridMinutes = Number(values.autoWakeGridMinutes ?? 10)
      const sampleSeconds = Number(values.autoWakeSampleSeconds ?? 30)
      if (!AUTO_GRID_MINUTES.includes(gridMinutes)) throw new Error(`网格只能是 ${AUTO_GRID_MINUTES.join('/')} 分钟`)
      if (![30, 60].includes(sampleSeconds)) throw new Error('采样间隔只能是 30 或 60 秒')
      const expected = {
        normal: Number(values.autoWakeNormalExpected ?? 0.1),
        low: Number(values.autoWakeLowExpected ?? 0.05),
        high: Number(values.autoWakeHighExpected ?? 0.2),
      }
      for (const [key, value] of Object.entries(expected)) {
        if (!Number.isFinite(value) || value < 0) throw new Error(`${AUTO_CLASS_LABELS[key]}期望必须是非负数`)
      }
      const hotRanges = parseAutoRangesText(values.autoWakeHotRanges ?? '06:00-08:00;12:00-14:00;18:00-24:00')
      const coldRanges = parseAutoRangesText(values.autoWakeColdRanges ?? '00:00-06:00')
      const caps = autoSigmaCaps(gridMinutes, sampleSeconds)
      const maxCap = Math.max(...caps.map((cap) => cap.lambdaMax))
      const counts = { normal: 0, low: 0, high: 0 }
      const segments = []
      const grids = 1440 / gridMinutes
      for (let index = 0; index < grids; index += 1) {
        const startMin = index * gridMinutes
        const className = autoClassForGrid(startMin, gridMinutes, hotRanges, coldRanges)
        counts[className] += 1
        segments.push({ startMin, endMin: startMin + gridMinutes, className })
      }
      for (const key of ['normal', 'low', 'high']) {
        if (expected[key] > maxCap + 1e-9) {
          throw new Error(`${AUTO_CLASS_LABELS[key]}期望 ${expected[key]} 超过上限 ${maxCap.toFixed(2)}（每格）`)
        }
      }
      const eDay = expected.normal * counts.normal + expected.low * counts.low + expected.high * counts.high
      return {
        gridMinutes,
        sampleSeconds,
        expected,
        hotRanges,
        coldRanges,
        caps,
        maxCap,
        counts,
        grids,
        segments,
        eDay,
        eMax: maxCap * grids,
      }
    }

    function autoClock(minutes) {
      const h = Math.floor(minutes / 60)
      const m = Math.round(minutes % 60)
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    }

    function minuteOfDay(text, fallback = 210) {
      const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(text ?? '').trim())
      return match ? Number(match[1]) * 60 + Number(match[2]) : fallback
    }

    function AutoTimeline({ estimate, night = {}, lastSleep = null }) {
      const width = 1000
      const x = (minutes) => (minutes / 1440) * width
      const now = new Date()
      const nowMinutes = now.getHours() * 60 + now.getMinutes()
      const nightAt = minuteOfDay(night.at, 210)
      const windowMinutes = Math.max(0, Number(night.windowMinutes) || 0)
      const nightEnd = nightAt + windowMinutes
      const spans = nightEnd <= 1440
        ? [[nightAt, nightEnd]]
        : [[nightAt, 1440], [0, nightEnd - 1440]]
      const lastMinutes = Number(lastSleep?.durationMs) > 0 ? Math.max(1, Math.round(lastSleep.durationMs / 60000)) : null
      return h('div', { className: 'living-field' },
        h('svg', { viewBox: `0 0 ${width} 84`, style: { width: '100%', height: 84, display: 'block' }, role: 'img', 'aria-label': '自动唤醒与夜睡时段' },
          h('defs', null,
            h('pattern', { id: 'living-night-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
              h('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'rgba(220,235,255,0.38)', strokeWidth: 1 }))),
          h('rect', { x: 0, y: 16, width, height: 40, fill: 'rgba(127,127,127,0.08)' }),
          ...estimate.segments.map((segment, index) =>
            h('rect', {
              key: `seg-${index}`,
              x: x(segment.startMin),
              y: 16,
              width: Math.max(0.5, x(segment.endMin) - x(segment.startMin)),
              height: 40,
              fill: AUTO_CLASS_COLORS[segment.className],
              opacity: 0.85,
            })),
          ...spans.map(([start, end], index) =>
            h('rect', {
              key: `night-${index}`,
              x: x(start),
              y: 16,
              width: Math.max(0.5, x(end) - x(start)),
              height: 40,
              fill: 'url(#living-night-hatch)',
              stroke: '#9cc3ff',
              strokeWidth: 1.8,
              strokeDasharray: '6 4',
            })),
          h('line', { x1: x(nightAt), x2: x(nightAt), y1: 8, y2: 60, stroke: '#9cc3ff', strokeWidth: 2 }),
          h('text', {
            x: x(nightAt),
            y: 10,
            textAnchor: nightAt < 120 ? 'start' : nightAt > 1320 ? 'end' : 'middle',
            fontSize: 10,
            fontWeight: 600,
            fill: '#9cc3ff',
          }, `夜睡 ${night.at ?? '03:30'}`),
          ...[0, 6, 12, 18, 24].map((hour) =>
            h('g', { key: `tick-${hour}` },
              h('line', { x1: x(hour * 60), x2: x(hour * 60), y1: 10, y2: 60, stroke: 'rgba(127,127,127,0.45)', strokeWidth: 1 }),
              h('text', { x: x(hour * 60), y: 76, textAnchor: hour === 0 ? 'start' : hour === 24 ? 'end' : 'middle', fontSize: 11, fill: 'currentColor' }, `${String(hour).padStart(2, '0')}:00`))),
          h('line', { x1: x(nowMinutes), x2: x(nowMinutes), y1: 8, y2: 60, stroke: '#ff8a00', strokeWidth: 1.5, strokeDasharray: '3 3' }),
          h('text', { x: x(nowMinutes), y: 10, textAnchor: 'middle', fontSize: 10, fill: '#ff8a00' }, '现在')),
        h('div', { className: 'living-row' },
          ...['high', 'low', 'normal'].map((key) =>
            h('span', { key, className: 'living-chip', style: { borderLeft: `3px solid ${AUTO_CLASS_COLORS[key]}` } },
              `${AUTO_CLASS_LABELS[key]} · ${estimate.counts[key]} 格 · 期望 ${estimate.expected[key]}`)),
          h('span', { className: 'living-chip', style: { borderLeft: '3px solid #6c8ebf' } },
            `夜睡 ${night.at ?? '03:30'} · 窗口 ${windowMinutes} 分钟`),
          lastMinutes ? h('span', { className: 'living-muted' }, `上次睡眠 ${lastMinutes} 分钟`) : null))
    }

    function AutoWakeCard({ values, save, setError, state }) {
      let estimate = null
      let estimateError = null
      try {
        estimate = autoEstimateDraft(values)
      } catch (error) {
        estimateError = error.message
      }
      const commit = (name, value) => {
        try {
          autoEstimateDraft({ ...values, [name]: value })
        } catch (error) {
          setError(`自动唤醒: ${error.message}`)
          return
        }
        setError(null)
        save(name, value)
      }
      const commitNightAt = (value) => {
        const text = String(value ?? '').trim()
        if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(text)) {
          setError('夜睡: 时间格式 HH:MM')
          return
        }
        setError(null)
        save('nightAt', text)
      }
      const commitWindow = (value) => {
        const minutes = Number(value)
        if (!Number.isFinite(minutes) || minutes <= 0) {
          setError('夜睡: 补睡窗口必须是正数（分钟）')
          return
        }
        setError(null)
        save('nightWindowMinutes', minutes)
      }
      const numberField = (name, label, help) => h(Field, { key: name, label, help },
        h(CommitInput, { kind: 'number', value: values[name] ?? '', commit: (value) => commit(name, value) }))
      const rangeField = (name, label, help, fallback) => h(Field, { key: name, label, help, full: true },
        h(RangeInput, { value: values[name] ?? fallback, placeholder: '06:00-08:00;12:00-14:00;18:00-24:00', commit: (value) => commit(name, value) }))
      return h('section', { className: 'living-card' },
        h('div', { className: 'living-card-head' }, h('span', null, '作息与自动唤醒')),
        h('div', { className: 'living-fields-grid' },
          h(Field, { label: '网格大小', help: '必须整除 24h；50 分钟不可用' },
            h(SegmentedTabs, {
              items: AUTO_GRID_MINUTES.map((value) => ({ value: String(value), label: `${value}m` })),
              value: String(values.autoWakeGridMinutes ?? 10),
              onChange: (value) => commit('autoWakeGridMinutes', Number(value)),
              label: '网格大小',
            })),
          h(Field, { label: '采样间隔', help: '每个网格内按此间隔逐点抽奖' },
            h(SegmentedTabs, {
              items: [{ value: '30', label: '30s' }, { value: '60', label: '60s' }],
              value: String(values.autoWakeSampleSeconds ?? 30),
              onChange: (value) => commit('autoWakeSampleSeconds', Number(value)),
              label: '采样间隔',
            })),
          numberField('autoWakeNormalExpected', '普通期望', '每个普通网格的期望触发次数'),
          numberField('autoWakeLowExpected', '低热期望', '每个低热网格的期望触发次数'),
          numberField('autoWakeHighExpected', '高热期望', '每个高热网格的期望触发次数'),
          rangeField('autoWakeHotRanges', '高热时段', '本地时间，分号分隔：06:00-08:00;12:00-14:00;18:00-24:00', '06:00-08:00;12:00-14:00;18:00-24:00'),
          rangeField('autoWakeColdRanges', '低热时段', '沾到网格即整格生效；高热优先于低热', '00:00-06:00'),
          h(Field, { label: '夜睡触发', help: '本地时间 HH:MM；每天一次，触发后开始夜间整理' },
            h(CommitInput, { value: values.nightAt ?? '03:30', placeholder: '03:30', commit: commitNightAt })),
          h(Field, { label: '补睡窗口', help: '触发点后多少分钟内仍可补睡；超时跳过当晚，不影响整理时长' },
            h(CommitInput, { kind: 'number', value: values.nightWindowMinutes ?? 360, commit: commitWindow }))),
        h('div', { className: 'living-field-help' },
          `固定 σ 轮盘：${AUTO_SIGMA_RATIOS.map((ratio) => `1/${Math.round(1 / ratio)}`).join(' / ')}；每个网格 ${Math.round(AUTO_NORMAL_SHARE * 100)}% 保持正态、${Math.round((1 - AUTO_NORMAL_SHARE) * 100)}% 打乱顺序。`),
        estimateError
          ? h('div', { className: 'living-field-error' }, `自动唤醒: ${estimateError}`)
          : estimate
            ? h('div', { className: 'living-field' },
                h('div', { className: 'living-row' },
                  h('span', { className: 'living-chip' }, `每格期望上限 ${estimate.maxCap.toFixed(2)}`),
                  h('span', { className: 'living-chip' }, `全天期望 ${estimate.eDay.toFixed(2)}`),
                  h('span', { className: 'living-muted' }, `网格 ${estimate.grids} 个`)),
                h('div', { className: 'living-field-help' },
                  `σ 单格上限：${estimate.caps.map((cap) => `1/${Math.round(1 / cap.ratio)} → ${cap.lambdaMax.toFixed(2)}`).join(' · ')}`),
                h(AutoTimeline, {
                  estimate,
                  night: { at: values.nightAt, windowMinutes: values.nightWindowMinutes },
                  lastSleep: state?.lastSleep,
                }))
            : null)
    }

    function ContextGuardCard({ values, save }) {
      const current = Number(values.roundTokens ?? 700000)
      const percent = Math.round((current / 1_000_000) * 100)
      const choices = [50, 60, 70, 80]
      const selected = choices.includes(percent) ? String(percent) : ''
      return h('section', { className: 'living-card' },
        h('div', { className: 'living-card-head' }, h('span', null, '上下文保险')),
        h('div', { className: 'living-fields-grid' },
          h(Field, { label: '触发阈值', help: '上下文窗口按 1M 计；达到阈值后先写 session handoff，再 rest + 换会话' },
            h(SegmentedTabs, {
              items: choices.map((value) => ({ value: String(value), label: `${value}%` })),
              value: selected,
              onChange: (value) => save('roundTokens', Number(value) * 10000),
              label: '上下文触发阈值',
            }))),
        h('div', { className: 'living-field-help' },
          `当前 ${current.toLocaleString()} tokens${selected ? `（1M 的 ${selected}%）` : '（自定义值）'}。handoff 只注入一次，不写入 L1/facets。`))
    }

    function MemoryPolicyCard({ values, save, setError }) {
      const stored = String(values.memoryParamsJson ?? '{}')
      const [draft, setDraft] = React.useState(stored)
      const [notice, setNotice] = React.useState(null)
      const pretty = (text) => {
        try {
          return JSON.stringify(JSON.parse(text || '{}'), null, 2)
        } catch {
          return text ?? '{}'
        }
      }
      React.useEffect(() => setDraft(pretty(stored)), [stored])
      const format = () => {
        try {
          setDraft(JSON.stringify(JSON.parse(draft || '{}'), null, 2))
          setError(null)
        } catch (error) {
          setError(`记忆策略: ${error.message}`)
        }
      }
      const commit = () => {
        let parsed
        try {
          parsed = JSON.parse(draft.trim() || '{}')
        } catch (error) {
          setError(`记忆策略: ${error.message}`)
          return
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setError('记忆策略: 必须是 JSON 对象')
          return
        }
        setError(null)
        setNotice('已写入 profile；宿主热更新后生效，未生效则重载宿主')
        save('memoryParamsJson', draft.trim() || '{}')
      }
      const reset = () => {
        setDraft('{}')
        setNotice(null)
        setError(null)
        save('memoryParamsJson', '{}')
      }
      return h('section', { className: 'living-card' },
        h('div', { className: 'living-card-head' },
          h('span', null, '记忆策略'),
          h(Badge, { tone: 'muted', children: '高级' })),
        h(Field, { label: 'memoryParamsJson', help: 'JSON 对象；覆盖召回/衰减/整理的 24 个参数，未知键忽略、越界钳制；默认 {} 等于当前行为' },
          h('textarea', {
            className: 'living-textarea',
            rows: 8,
            spellCheck: false,
            style: { fontFamily: 'ui-monospace, monospace' },
            value: draft,
            onChange: (event) => setDraft(event.target.value),
          })),
        h('div', { className: 'living-controls' },
          h(Button, { variant: 'primary', size: 'sm', onClick: commit }, '保存'),
          h(Button, { variant: 'outline', size: 'sm', onClick: format }, '格式化'),
          h(Button, { variant: 'ghost', size: 'sm', onClick: reset }, '恢复默认')),
        h('div', { className: 'living-field-help' },
          '键表与默认值见 docs/DEPLOY.md §2.1；范围外数值会钳制，坏 JSON 保存会被拒绝。'),
        notice ? h('div', { className: 'living-field-help' }, notice) : null)
    }

    const CONFIG_GROUPS = [
      {
        title: '时钟与作息',
        fields: [
          ['tickMs', '主 tick 间隔', 'number', 'ms', '普通判定粒度；自动唤醒采样另有间隔'],
          ['timeScale', '时间倍率', 'number', '', '调试用；1 = 真实时间'],
          ['startupRound', '重启后激活一轮', 'boolean', '', '宿主启动时立刻跑一轮，重新校准时间轴；不影响睡眠'],
          ['roundTimeoutMs', '单轮超时', 'number', 'ms', '超时只取消该轮，不拆会话'],
          ['recollectTimeoutMs', '回想超时', 'number', 'ms', '硬超时；超时即失败，不重试'],
        ],
      },
      {
        title: '预算',
        fields: [
          ['l0Tokens', 'L0 注入预算', 'number', 'tokens', '热区每轮最多注入多少'],
          ['dailyTokens', '日 token 上限', 'number', 'tokens', '所有计费轮次共享'],
          ['dailyRounds', '日轮次上限', 'number', '次', '计费轮次共享；豁免轮次不计'],
          ['selfBudgetTokens', '睡前自由环节预算', 'number', 'tokens', '独立硬顶；即使日预算用完也允许，只计 token 不计轮次。0 = 关闭该环节'],
        ],
      },
      {
        title: '人格与会话',
        fields: [
          ['personaMaxChars', '人格注入上限', 'number', '字符', 'charter + self + journal 的总上限'],
          ['sessionRoot', '会话日志根目录', 'text', '', '留空使用宿主默认'],
          ['presetId', 'preset id', 'text', '', '会话挂载的 preset，一般不用改'],
        ],
      },
      {
        title: '外发与工具',
        fields: [
          ['limiterEnabled', '公开发言判决层', 'boolean', '', '关闭后公网发言会被拦截'],
          ['gemSilenceMinutes', '宝石静默判定', 'number', '分钟', '待发消息多久没被认领就判静默'],
          ['whitelistJson', '外发白名单', 'list', '', '直接放行的目标（uid / reply / 群）'],
        ],
      },
    ]

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes)) return '—'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
    }

    function base64Bytes(text) {
      if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(text)
      const binary = atob(text)
      const out = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index)
      return out
    }

    function bytesBase64(bytes) {
      if (typeof bytes.toBase64 === 'function') return bytes.toBase64()
      let binary = ''
      const chunk = 0x8000
      for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
      }
      return btoa(binary)
    }

    function backupName() {
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      return `dsh-living-life-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.db`
    }

    function DataCard() {
      const notify = React.useContext(ToastContext)
      const [nonce, setNonce] = React.useState(0)
      const info = useRpc('dataInfo', { nonce }, 15_000)
      const [busy, setBusy] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const inputRef = React.useRef(null)
      const data = info.value
      const refresh = () => setNonce((value) => value + 1)

      const backup = async () => {
        setError(null)
        setNotice(null)
        let handle = null
        try {
          if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
            handle = await window.showSaveFilePicker({
              suggestedName: backupName(),
              types: [{ description: 'SQLite 数据库', accept: { 'application/x-sqlite3': ['.db'] } }],
            })
          }
        } catch (err) {
          if (err?.name === 'AbortError') return
        }
        setBusy('正在生成快照…')
        try {
          const result = await call('backup', {})
          const blob = new Blob([base64Bytes(result.data)], { type: result.mediaType })
          if (handle) {
            const writable = await handle.createWritable()
            await writable.write(blob)
            await writable.close()
            setNotice(`已备份到 ${handle.name ?? result.name}（${formatBytes(result.bytes)}）`)
          } else {
            const url = URL.createObjectURL(blob)
            const anchor = document.createElement('a')
            anchor.href = url
            anchor.download = result.name
            document.body.appendChild(anchor)
            anchor.click()
            anchor.remove()
            setTimeout(() => URL.revokeObjectURL(url), 60_000)
            setNotice(`已请求下载 ${result.name}（${formatBytes(result.bytes)}）`)
          }
          notify('记忆备份完成')
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(null)
          refresh()
        }
      }

      const importFile = async (event) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return
        setError(null)
        setNotice(null)
        if (file.size > 64 * 1024 * 1024) {
          setError('文件超过 64 MiB')
          return
        }
        setBusy('正在上传并校验…')
        try {
          const bytes = new Uint8Array(await file.arrayBuffer())
          const result = await call('importBackup', { name: file.name, data: bytesBase64(bytes) })
          setNotice(`已暂存 ${result.name}（schema v${result.schemaVersion}）。重启宿主后替换；当前库会先自动备份。`)
          notify('已暂存，重启宿主后生效')
          refresh()
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(null)
        }
      }

      const cancelImport = () => {
        setError(null)
        call('importCancel')
          .then((result) => {
            setNotice(result.cancelled ? '已取消待导入' : '没有待导入')
            refresh()
          })
          .catch((err) => setError(err.message))
      }

      return h('section', { className: 'living-card' },
        h('div', { className: 'living-card-head' }, h('span', null, '数据与备份')),
        data
          ? h('div', { className: 'living-field' },
              h('div', { className: 'living-row' },
                h('span', { className: 'living-row-label' }, '记忆库'),
                h(PathLabel, { path: data.dbPath })),
              h('div', { className: 'living-row' },
                h('span', { className: 'living-row-label' }, '工作目录'),
                h(PathLabel, { path: data.workspace })),
              h('div', { className: 'living-row' },
                h('span', { className: 'living-row-label' }, '宝石代码'),
                h(PathLabel, { path: data.gemStoreDir })),
              h('div', { className: 'living-field-help' },
                `schema v${data.schemaVersion ?? '—'} / 支持 v${data.supportedSchemaVersion} · ${formatBytes(data.dbBytes)}`),
              data.pendingImport
                ? h('div', { className: 'living-field-help' },
                    `待导入：${data.pendingImport.name}（schema v${data.pendingImport.schemaVersion}），重启宿主后替换`)
                : null,
              h('div', { className: 'living-controls' },
                h(Button, { variant: 'outline', size: 'sm', disabled: Boolean(busy), onClick: backup }, busy ?? '备份记忆'),
                h(Button, { variant: 'outline', size: 'sm', disabled: Boolean(busy), onClick: () => inputRef.current?.click() }, '导入记忆'),
                data.pendingImport
                  ? h(Button, { variant: 'ghost', size: 'sm', onClick: cancelImport }, '取消待导入')
                  : null,
                h('input', {
                  ref: inputRef,
                  type: 'file',
                  accept: '.db,application/x-sqlite3',
                  style: { display: 'none' },
                  onChange: importFile,
                })),
              notice ? h('div', { className: 'living-field-help' }, notice) : null,
              error ? h('div', { className: 'living-field-error' }, error) : null,
              h('div', { className: 'living-field-help' },
                '备份是明文 SQLite（含人设、记忆、日报、外发记录），请妥善保存。导入只做覆盖恢复，不合并；卸载插件不会删除 data/ 与 workspace/。'))
          : h('div', { className: 'living-empty' }, info.error ? `读取失败：${info.error}` : '加载中…'))
    }

    function ConfigPanel({ form }) {
      const snapshot = useFormSnapshot(form)
      const gemsRpc = useRpc('gems', {}, 15_000)
      const stateRpc = useRpc('state', {}, 15_000)
      const [error, setError] = React.useState(null)
      if (!form) return h('div', { className: 'living-empty' }, '配置服务不可用')
      if (!snapshot || snapshot.status === 'loading') return h('div', { className: 'living-empty' }, '配置加载中…')
      if (snapshot.status === 'unavailable') return h('div', { className: 'living-empty' }, '宿主未暴露 living 配置')
      const values = snapshot.value ?? {}

      const save = (name, value) => {
        setError(null)
        return form.set(name, value).catch((err) => setError(`${name}: ${err.message}`))
      }

      const renderField = ([name, label, kind, unit, help]) => {
        const raw = values[name]
        if (kind === 'list') {
          let list = []
          try {
            const parsed = JSON.parse(raw || '[]')
            list = Array.isArray(parsed) ? parsed : []
          } catch {
            list = []
          }
          return h(Field, { key: name, label, help },
            h(ListValue, {
              value: list,
              placeholder: 'uid:123 / reply:... / 群目标',
              onChange: (next) => save(name, JSON.stringify(next)),
            }))
        }
        if (kind === 'boolean') {
          return h(Field, { key: name, label, help },
            h(Switch, {
              checked: raw === true,
              label,
              onChange: (next) => save(name, next),
            }))
        }
        const hint = unit ? `${help ?? ''}${help ? ' · ' : ''}单位：${unit}` : help
        if (kind === 'number') {
          return h(Field, { key: name, label, help: hint },
            h(CommitInput, {
              kind: 'number',
              value: raw ?? '',
              commit: (number) => save(name, number),
            }))
        }
        return h(Field, { key: name, label, help: hint },
          h(CommitInput, {
            value: raw ?? '',
            commit: (text) => save(name, text),
          }))
      }

      const renderGemDirs = () => {
        let dirs = []
        if (Array.isArray(values.gemDirs)) {
          dirs = values.gemDirs
        } else {
          try {
            const parsed = JSON.parse(values.gemDirs || '[]')
            dirs = Array.isArray(parsed) ? parsed : []
          } catch {
            dirs = []
          }
        }
        return h(Field, { label: '目录列表', help: '每行一个宝石包目录；保存后重启宿主生效' },
          h(ListEditor, {
            value: dirs,
            mono: true,
            placeholder: '/path/to/gem',
            onChange: (next) => save('gemDirs', next),
          }))
      }

      return h('div', { className: 'living-field' },
        h('div', { className: 'living-card' },
          h('div', { className: 'living-card-head' },
            h('span', null, '本体配置'),
            Badge({ tone: snapshot.writable ? 'ok' : 'muted', children: snapshot.writable ? '可写' : '只读' })),
          line('home', stateRpc.value?.home ?? values.home ?? '—', true),
          h('div', { className: 'living-field-help' },
            '修改按字段写入 profile；tick、预算、人格上限等运行参数需在宿主重载/重启后生效。')),
        error ? h('div', { className: 'living-field-error' }, error) : null,
        ...CONFIG_GROUPS.map((group) => h('section', { key: group.title, className: 'living-card' },
          h('div', { className: 'living-card-head' }, h('span', null, group.title)),
          h('div', { className: 'living-fields-grid' }, ...group.fields.map(renderField)))),
        h(AutoWakeCard, { values, save, setError, state: stateRpc.value }),
        h(ContextGuardCard, { values, save }),
        h(MemoryPolicyCard, { values, save, setError }),
        h('section', { className: 'living-card' },
          h('div', { className: 'living-card-head' }, h('span', null, '宝石目录')),
          renderGemDirs(),
          h('div', { className: 'living-sep' }),
          h('div', { className: 'living-field-label' }, '家目录覆盖'),
          h(ObjectPathEditor, {
            value: values.gemHomesJson ?? '{}',
            gems: gemsRpc.value ?? [],
            onChange: (next) => save('gemHomesJson', next),
          }),
          h('div', { className: 'living-field-help' }, '宝石 token 在「宝石」页逐颗设置；不再通过配置页明文展示。')),
        h(DataCard))
    }

    // ── gems ────────────────────────────────────────────────────────────

    const LOGIN_LABELS = {
      idle: '未开始',
      starting: '正在启动登录…',
      wait: '等待扫码',
      scaned: '已扫码，请在手机上确认',
      confirmed: '已确认，正在保存凭据…',
      expired: '二维码已失效，正在刷新…',
      done: '登录成功',
      error: '登录失败',
      cancelled: '已取消',
    }

    function schemaDefaults(schema) {
      const out = {}
      for (const field of schema?.fields ?? []) {
        if (field.default !== undefined) out[field.key] = field.default
      }
      return out
    }

    function buildGemDraft(gem) {
      return { ...schemaDefaults(gem.configSchema), ...(gem.config ?? {}) }
    }

    function validateGemDraft(schema, draft) {
      const errors = {}
      for (const field of schema?.fields ?? []) {
        const value = draft[field.key]
        if (value === undefined || value === null || value === '') {
          if (field.required) errors[field.key] = '必填'
          continue
        }
        if (field.type === 'number') {
          if (!Number.isFinite(value)) errors[field.key] = '必须是数字'
          else if (field.min !== undefined && value < field.min) errors[field.key] = `不能小于 ${field.min}`
          else if (field.max !== undefined && value > field.max) errors[field.key] = `不能大于 ${field.max}`
        } else if (field.type === 'list') {
          if (!Array.isArray(value)) errors[field.key] = '必须是列表'
        } else if (field.type === 'select') {
          if (!(field.options ?? []).some((option) => option.value === value)) errors[field.key] = '不是合法选项'
        }
      }
      return errors
    }

    function serializeGemDraft(schema, raw, draft) {
      const payload = { ...(raw ?? {}) }
      for (const field of schema?.fields ?? []) {
        const value = draft[field.key]
        if (value === '' && field.type === 'number') delete payload[field.key]
        else if (value !== undefined) payload[field.key] = value
      }
      return payload
    }

    function GemField({ field, value, error, onChange }) {
      const control = (() => {
        if (field.type === 'boolean') {
          return h(Switch, { checked: value === true, label: field.label, onChange })
        }
        if (field.type === 'select') {
          return h('select', {
            className: 'living-select',
            value: value ?? field.options?.[0]?.value ?? '',
            onChange: (event) => onChange(event.target.value),
          }, ...(field.options ?? []).map((option) => h('option', { key: option.value, value: option.value }, option.label)))
        }
        if (field.type === 'list') {
          return h(ListEditor, {
            value: Array.isArray(value) ? value : [],
            itemType: field.itemType ?? 'string',
            placeholder: field.placeholder ?? '输入后按 Enter 添加',
            onChange,
          })
        }
        if (field.type === 'textarea') {
          return h('textarea', {
            className: 'living-textarea',
            value: value ?? '',
            placeholder: field.placeholder ?? '',
            onChange: (event) => onChange(event.target.value),
          })
        }
        const inputProps = {
          value: value ?? '',
          placeholder: field.placeholder ?? '',
          onChange: (event) => {
            if (field.type === 'number') {
              const text = event.target.value
              onChange(text === '' ? '' : Number(text))
            } else {
              onChange(event.target.value)
            }
          },
        }
        if (field.type === 'number') {
          inputProps.type = 'number'
          if (field.min !== undefined) inputProps.min = field.min
          if (field.max !== undefined) inputProps.max = field.max
          if (field.step !== undefined) inputProps.step = field.step
        }
        return h(Input, inputProps)
      })()
      return h(Field, {
        label: field.unit ? `${field.label}（${field.unit}）` : field.label,
        help: field.help,
        error,
      }, control)
    }

    function GemToken({ gem, onChanged }) {
      const notify = React.useContext(ToastContext)
      const [token, setToken] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const save = (next) => {
        setBusy(true)
        call('gemTokenSet', { gem: gem.id, token: next })
          .then(() => {
            setToken('')
            notify(next ? 'token 已保存，通道已重启' : 'token 已清除')
            onChanged()
          })
          .catch((error) => notify(`token 保存失败：${error.message}`, 'error'))
          .finally(() => setBusy(false))
      }
      return h(Field, {
        label: '通道 token',
        help: '只写不读：前端只会看到已配置/未配置。保存后核心立即更新鉴权并重启该宝石通道。',
        wide: true,
      },
        h('div', { className: 'living-controls' },
          Badge({ tone: gem.tokenConfigured ? 'ok' : 'muted', children: gem.tokenConfigured ? '已配置' : '未配置' }),
          h('div', { style: { flex: 1, minWidth: 200 } },
            h(Input, {
              type: 'password',
              value: token,
              placeholder: gem.tokenConfigured ? '输入新 token 以替换' : '输入 token',
              onChange: (event) => setToken(event.target.value),
            })),
          h(Button, { variant: 'primary', size: 'sm', disabled: busy || token.trim() === '', onClick: () => save(token.trim()) }, '保存'),
          gem.tokenConfigured
            ? h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => save('') }, '清除')
            : null))
    }

    function GemCard({ gem, onChanged }) {
      const notify = React.useContext(ToastContext)
      const [draft, setDraft] = React.useState(() => buildGemDraft(gem))
      const [dirty, setDirty] = React.useState(false)
      const [errors, setErrors] = React.useState({})
      const [saveState, setSaveState] = React.useState(null)
      const [rawDraft, setRawDraft] = React.useState(() => gem.configText ?? '{}\n')
      const [login, setLogin] = React.useState(null)
      const [loginError, setLoginError] = React.useState(null)
      const [promptValues, setPromptValues] = React.useState({})
      const [skill, setSkill] = React.useState(null)
      const [skillOpen, setSkillOpen] = React.useState(false)
      const running = login && !['idle', 'done', 'error', 'cancelled'].includes(login.status)

      React.useEffect(() => {
        if (!dirty) {
          setDraft(buildGemDraft(gem))
          setRawDraft(gem.configText ?? '{}\n')
        }
      }, [gem.configText, gem.configSchema, dirty])

      React.useEffect(() => {
        let alive = true
        call('gemLoginStatus', { gem: gem.id }).then((value) => { if (alive) setLogin(value) }).catch(() => {})
        return () => { alive = false }
      }, [gem.id])

      React.useEffect(() => {
        if (!running) return undefined
        let alive = true
        const timer = setInterval(() => {
          call('gemLoginStatus', { gem: gem.id }).then((value) => { if (alive) setLogin(value) }).catch(() => {})
        }, 1500)
        return () => { alive = false; clearInterval(timer) }
      }, [running, gem.id])

      const schema = gem.configSchema
      const fields = schema?.fields ?? []
      const groups = []
      for (const field of fields) {
        const title = field.group || '通用'
        let group = groups.find((entry) => entry.title === title)
        if (!group) {
          group = { title, fields: [] }
          groups.push(group)
        }
        group.fields.push(field)
      }

      const update = (key, value) => {
        setDirty(true)
        setSaveState(null)
        setDraft((current) => ({ ...current, [key]: value }))
        setErrors((current) => ({ ...current, [key]: undefined }))
      }

      const saveConfig = () => {
        if (!schema) {
          let parsed
          try {
            parsed = JSON.parse(rawDraft)
          } catch (error) {
            setSaveState({ error: `JSON 不合法：${error.message}` })
            return
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            setSaveState({ error: '配置必须是 JSON 对象' })
            return
          }
          setSaveState({ pending: '保存中…' })
          call('gemConfig', { gem: gem.id, config: parsed })
            .then((result) => {
              setRawDraft(`${JSON.stringify(result.config, null, 2)}\n`)
              setSaveState({ ok: '已保存；重启该宝石通道后生效' })
              setDirty(false)
              onChanged()
            })
            .catch((error) => setSaveState({ error: error.message }))
          return
        }
        const found = validateGemDraft(schema, draft)
        setErrors(found)
        if (Object.keys(found).length > 0) {
          setSaveState({ error: '有字段未通过校验' })
          return
        }
        setSaveState({ pending: '保存中…' })
        call('gemConfig', { gem: gem.id, config: serializeGemDraft(schema, gem.config, draft) })
          .then((result) => {
            setDraft(buildGemDraft({ ...gem, config: result.config }))
            setRawDraft(`${JSON.stringify(result.config, null, 2)}\n`)
            setDirty(false)
            setSaveState({ ok: '已保存；重启该宝石通道后生效' })
            notify(`${gem.name} 配置已保存`)
            onChanged()
          })
          .catch((error) => setSaveState({ error: error.message }))
      }

      const startLogin = () => {
        setLoginError(null)
        setPromptValues({})
        call('gemLoginStart', { gem: gem.id }).then(setLogin).catch((error) => setLoginError(error.message))
      }
      const cancelLogin = () => {
        setPromptValues({})
        call('gemLoginCancel', { gem: gem.id }).then(setLogin).catch((error) => setLoginError(error.message))
      }
      const submitPrompt = (promptId) => {
        const value = promptValues[promptId] ?? ''
        if (value === '') return
        setLoginError(null)
        call('gemLoginInput', { gem: gem.id, promptId, value })
          .then((state) => {
            setLogin(state)
            setPromptValues((current) => ({ ...current, [promptId]: '' }))
          })
          .catch((error) => setLoginError(error.message))
      }
      const openSkill = () => {
        setSkillOpen(true)
        if (skill === null) {
          call('gemSkill', { gem: gem.id })
            .then((result) => setSkill(result.text || '（没有 skill）'))
            .catch((error) => setSkill(`读取失败：${error.message}`))
        }
      }

      const loginStatusLabel = login?.status === 'wait'
        ? (login?.qr ? '等待扫码' : login?.prompts?.length ? '等待输入' : '等待操作')
        : (LOGIN_LABELS[login?.status] ?? '未开始')
      const credential = gem.credential ?? {}
      const account = credential.account ?? {}
      const accountLabel = account.uname
        ? `${account.uname}（${account.dedeuserid ?? account.mid ?? ''}）`
        : (account.accountId || '')

      return h('section', { className: 'living-card' },
        h('div', { className: 'living-gem-head' },
          h('span', { className: 'living-gem-name' }, `${gem.name}（${gem.id}）`),
          h('span', { className: 'living-muted' }, `v${gem.version}`),
          Badge({ tone: gemTone(gem), children: gem.available === false ? `降级${gem.lastError ? ` · ${gem.lastError}` : ''}` : '可用' }),
          Badge({ tone: gem.credential?.present ? 'ok' : 'muted', children: gem.credential?.present ? '已登录' : '未登录' }),
          Badge({ tone: gem.tokenConfigured ? 'ok' : 'warn', children: gem.tokenConfigured ? 'token 已配置' : 'token 未配置' })),
        gem.description ? h('div', { className: 'living-muted' }, gem.description) : null,

        h('div', { className: 'living-row' },
          h('span', { className: 'living-row-label' }, '目录'),
          h(PathLabel, { path: gem.dir })),
        h('div', { className: 'living-row' },
          h('span', { className: 'living-row-label' }, '家目录'),
          h(PathLabel, { path: gem.home })),

        h('div', { className: 'living-chips' },
          ...Object.entries(gem.capabilities ?? {}).map(([key, value]) =>
            h(Badge, { key, tone: value ? 'ok' : 'muted' }, `${key}: ${value ? '开' : '关'}`)),
          ...Object.entries(gem.limits ?? {}).map(([key, value]) =>
            h('span', { key, className: 'living-chip' }, `${key} ${formatNumber(value)}`)),
          gem.notify?.push
            ? h('span', { className: 'living-chip' }, `推送 ${gem.notify.push.mode ?? 'ring'} / ${gem.notify.push.budget?.count === false ? '不计费' : '计费'}`)
            : null),

        h('div', { className: 'living-sep' }),
        h('div', { className: 'living-row' },
          h('span', { className: 'living-row-label' }, '凭据'),
          h('span', null, credential.present
            ? `已登录${accountLabel ? ` · ${accountLabel}` : ''} · ${clockTime(Date.parse(credential.savedAt))}`
            : '未登录'),
          gem.hasLoginRpc
            ? h(Button, {
                variant: 'outline',
                size: 'sm',
                icon: h(IconPlayOutlineRegular, { size: 14 }),
                onClick: startLogin,
              }, running ? '重新登录' : '登录')
            : h('span', { className: 'living-muted' }, '该宝石没有登录通道'),
          running ? h(Button, { variant: 'outline', size: 'sm', onClick: cancelLogin }, '取消') : null,
          h('span', { className: 'living-muted' }, loginStatusLabel)),
        credential.error ? h('div', { className: 'living-field-error' }, credential.error) : null,
        loginError ? h('div', { className: 'living-field-error' }, loginError) : null,
        login?.qr?.svg
          ? h('div', { className: 'living-qr', dangerouslySetInnerHTML: { __html: login.qr.svg } })
          : null,
        login?.prompts?.length
          ? h('div', { className: 'living-field' },
              ...login.prompts.map((prompt) => h(Field, { key: prompt.id, label: prompt.label, help: prompt.help },
                h('div', { className: 'living-row' },
                  h(Input, {
                    type: prompt.kind === 'password' ? 'password' : 'text',
                    value: promptValues[prompt.id] ?? '',
                    placeholder: prompt.placeholder || '',
                    autoComplete: 'off',
                    onChange: (event) => setPromptValues((current) => ({ ...current, [prompt.id]: event.target.value })),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        submitPrompt(prompt.id)
                      }
                    },
                  }),
                  h(Button, {
                    variant: 'outline',
                    size: 'sm',
                    disabled: (promptValues[prompt.id] ?? '') === '',
                    onClick: () => submitPrompt(prompt.id),
                  }, '提交')))))
          : null,
        login?.status === 'done' && login.account
          ? h('div', { className: 'living-field-help' }, `登录成功：${login.account.name || login.account.accountId || ''} ${login.account.id || login.account.userId || ''}`)
          : null,

        h('div', { className: 'living-sep' }),
        h(GemToken, { gem, onChanged }),

        h('div', { className: 'living-sep' }),
        fields.length > 0
          ? h('div', { className: 'living-field' },
              ...groups.map((group) => h('div', { key: group.title, className: 'living-field' },
                h('div', { className: 'living-card-head' }, h('span', null, group.title)),
                h('div', { className: 'living-fields-grid' }, ...group.fields.map((field) => h(GemField, {
                  key: field.key,
                  field,
                  value: draft[field.key],
                  error: errors[field.key],
                  onChange: (value) => update(field.key, value),
                }))))))
          : h('div', { className: 'living-empty' },
              '这颗宝石还没有声明 config schema；下面是原始 JSON 编辑（旧式兼容）。'),
        fields.length === 0
          ? h('textarea', {
              className: 'living-textarea',
              rows: Math.min(12, Math.max(4, rawDraft.split('\n').length)),
              value: rawDraft,
              onChange: (event) => { setDirty(true); setRawDraft(event.target.value) },
            })
          : null,
        gem.configError ? h('div', { className: 'living-field-error' }, gem.configError) : null,
        h('div', { className: 'living-controls' },
          h(Button, { variant: 'primary', size: 'sm', onClick: saveConfig }, '保存配置'),
          h(Button, { variant: 'ghost', size: 'sm', onClick: () => { setDirty(false); setDraft(buildGemDraft(gem)); setRawDraft(gem.configText ?? '{}\n'); setSaveState(null) } }, '还原'),
          saveState?.ok ? h('span', { className: 'living-field-help' }, saveState.ok) : null,
          saveState?.pending ? h('span', { className: 'living-muted' }, saveState.pending) : null,
          saveState?.error ? h('span', { className: 'living-field-error' }, saveState.error) : null),

        h('details', { className: 'living-details' },
          h('summary', null, '高级：原始 config'),
          h(JsonBlock, { label: 'config.json', payload: gem.config ?? {}, defaultOpen: false, truncatedLabel: (n) => `…（${formatNumber(n)} 字符）` })),

        gem.etiquette?.length
          ? h('details', { className: 'living-details' },
              h('summary', null, `礼仪（${gem.etiquette.length}）`),
              h('ul', { className: 'living-list' }, ...gem.etiquette.map((item, index) => h('li', { key: index }, item))))
          : null,
        Object.keys(gem.failureHints ?? {}).length > 0
          ? h('details', { className: 'living-details' },
              h('summary', null, '失败语义'),
              h('div', { className: 'living-field' },
                ...Object.entries(gem.failureHints).map(([code, text]) => h('div', { key: code, className: 'living-row' },
                  h('span', { className: 'living-chip living-mono' }, code),
                  h('span', null, text)))))
          : null,
        gem.hasSkill
          ? h('div', { className: 'living-controls' },
              h(Button, { variant: 'ghost', size: 'sm', icon: h(IconInfoOutlineRegular, { size: 14 }), onClick: openSkill }, '查看 skill'))
          : null,
        skillOpen
          ? h(Modal, {
              open: true,
              title: `${gem.name} · skill`,
              closeLabel: '关闭',
              onClose: () => setSkillOpen(false),
              className: 'living-skill-modal',
              footer: h(Button, { variant: 'outline', onClick: () => setSkillOpen(false) }, '关闭'),
            }, h('div', { style: { maxHeight: '60vh', overflowY: 'auto', fontSize: 13 } },
              skill === null
                ? h('div', { className: 'living-muted' }, '加载中…')
                : h(MarkdownText, { text: skill, labels: MARKDOWN_LABELS })))
          : null)
    }

    function GemStore({ onClose, onChanged }) {
      const notify = React.useContext(ToastContext)
      const [nonce, setNonce] = React.useState(0)
      const { value, error } = useRpc('gemCatalog', { nonce }, 15_000)
      const [busy, setBusy] = React.useState(null)
      const [actionError, setActionError] = React.useState(null)
      const [confirm, setConfirm] = React.useState(null)
      const refresh = () => {
        setNonce((current) => current + 1)
        onChanged?.()
      }

      const run = async (kind, entry) => {
        setActionError(null)
        setBusy(kind === 'install' ? `${entry.name} 安装中…` : `${entry.name} 卸载中…`)
        try {
          const result = kind === 'install'
            ? await call('gemInstall', { id: entry.id })
            : await call('gemUninstall', { id: entry.id })
          setConfirm(null)
          onClose?.()
          notify(result.restartRequired === false ? `${entry.name} 已${kind === 'install' ? '安装' : '卸载'}` : `${entry.name} 已${kind === 'install' ? '安装' : '卸载'}，重启宿主后生效`)
          refresh()
        } catch (err) {
          setActionError(err.message)
        } finally {
          setBusy(null)
        }
      }

      return h(Modal, {
        open: true,
        title: '添加宝石',
        closeLabel: '关闭',
        onClose: () => { setConfirm(null); onClose?.() },
        footer: h(Button, { variant: 'outline', onClick: onClose }, '关闭'),
      }, h('div', { className: 'living-field' },
        h('div', { className: 'living-field-help' },
          '从 npm 下载到 living 自己的宝石目录；不会变成 DSH 插件。夜间睡眠时自动检查已装宝石并升到 registry 最新（永不自动降级）；安装、升级或卸载后重启宿主生效；卸载只删代码与 media 缓存，保留配置、凭据和记忆。'),
        value?.length
          ? h('div', { className: 'living-chips' },
              ...value.map((entry) => h('span', { key: entry.id, className: 'living-chip' },
                `${entry.name}${entry.installed ? ` v${entry.installedVersion ?? ''}` : ' · 未安装'}`)))
          : null,
        error ? h('div', { className: 'living-field-error' }, `读取失败：${error}`) : null,
        ...(value ?? []).map((entry) => h('div', { key: entry.id, className: 'living-card' },
          h('div', { className: 'living-gem-head' },
            h('span', { className: 'living-gem-name' }, `${entry.name}（${entry.id}）`),
            h('span', { className: 'living-muted' }, `${entry.package}@${entry.targetVersion ?? entry.version}`),
            Badge({
              tone: entry.installed ? 'ok' : 'muted',
              children: entry.installed ? `已安装 ${entry.installedVersion ?? ''}` : '未安装',
            }),
            entry.updateAvailable ? Badge({ tone: 'warn', children: `可升级 ${entry.targetVersion}` }) : null,
            entry.restartRequired ? Badge({ tone: 'warn', children: '重启后生效' }) : null,
            entry.noDowngrade ? Badge({ tone: 'error', children: 'registry 低于已装' }) : null),
          entry.description ? h('div', { className: 'living-muted' }, entry.description) : null,
          entry.latestError ? h('div', { className: 'living-muted' }, `最新版本未知：${entry.latestError}`) : null,
          h('div', { className: 'living-chips' },
            ...Object.entries(entry.capabilities ?? {}).filter(([, enabled]) => enabled).map(([key]) =>
              h('span', { key, className: 'living-chip' }, key)),
            entry.repository
              ? h('a', { href: entry.repository, target: '_blank', rel: 'noreferrer' }, '仓库')
              : null),
          entry.broken ? h('div', { className: 'living-field-error' }, entry.broken) : null,
          h('div', { className: 'living-controls' },
            entry.installed && entry.updateAvailable
              ? h(Button, {
                  variant: 'primary',
                  size: 'sm',
                  disabled: Boolean(busy),
                  onClick: () => setConfirm({ kind: 'install', entry }),
                }, `升级到 ${entry.targetVersion}`)
              : null,
            entry.installed
              ? h(Button, {
                  variant: 'outline',
                  size: 'sm',
                  disabled: Boolean(busy),
                  onClick: () => setConfirm({ kind: 'uninstall', entry }),
                }, '卸载')
              : h(Button, {
                  variant: 'primary',
                  size: 'sm',
                  disabled: Boolean(busy),
                  onClick: () => setConfirm({ kind: 'install', entry }),
                }, '安装')),
          confirm?.entry.id === entry.id
            ? h('div', { className: 'living-field' },
                h('div', { className: 'living-field-help' },
                  confirm.kind === 'install'
                    ? `${entry.installed ? '升级' : '安装'} ${entry.package}@${entry.targetVersion ?? entry.version}？会从 npm 下载；宝石的 MCP 与通道代码在宿主里运行。`
                    : `卸载 ${entry.name}？只删包代码与 media 缓存，保留 config、凭据和 life.db 里的记忆。`),
                h('div', { className: 'living-controls' },
                  h(Button, {
                    variant: 'primary',
                    size: 'sm',
                    disabled: Boolean(busy),
                    onClick: () => run(confirm.kind, entry),
                  }, confirm.kind === 'install' ? (entry.installed ? '确认升级' : '确认安装') : '确认卸载'),
                  h(Button, { variant: 'ghost', size: 'sm', onClick: () => setConfirm(null) }, '取消')))
            : null)),
        busy ? h('div', { className: 'living-muted' }, busy) : null,
        actionError ? h('div', { className: 'living-field-error' }, actionError) : null))
    }

    function GemsPanel() {
      const [nonce, setNonce] = React.useState(0)
      const [active, setActive] = React.useState(null)
      const [storeOpen, setStoreOpen] = React.useState(false)
      const { value, error } = useRpc('gems', { nonce }, 15_000)
      const refresh = () => setNonce((current) => current + 1)
      const gems = value ?? []
      const current = gems.some((gem) => gem.id === active) ? active : (gems[0]?.id ?? null)
      return h('div', { className: 'living-field' },
        error
          ? h('div', { className: 'living-empty' }, `读取失败：${error}`)
          : !value
            ? h('div', { className: 'living-empty' }, '加载中…')
            : h('div', { className: 'living-subpage' },
                h('div', { className: 'living-subtabs' },
                  h('div', { className: 'living-subtabs-list', role: 'tablist', 'aria-label': '宝石' },
                    ...gems.map((gem) => h('button', {
                      key: gem.id,
                      type: 'button',
                      role: 'tab',
                      'aria-selected': gem.id === current,
                      className: gem.id === current ? 'living-subtab living-subtab-active' : 'living-subtab',
                      onClick: () => setActive(gem.id),
                    }, gem.name))),
                  h(Button, {
                    variant: 'outline',
                    size: 'sm',
                    icon: h(IconPlusOutlineRegular, { size: 14 }),
                    onClick: () => setStoreOpen(true),
                  }, '添加宝石')),
                storeOpen ? h(GemStore, { onClose: () => setStoreOpen(false), onChanged: refresh }) : null,
                gems.length === 0
                  ? h('div', { className: 'living-empty' }, '还没有加载宝石；点右上角“添加宝石”，或用 gemDirs 加载本地目录。')
                  : h('div', { className: 'living-field' },
                      ...gems.map((gem) => h('div', {
                        key: gem.id,
                        style: gem.id === current ? undefined : { display: 'none' },
                      }, h(GemCard, { gem, onChanged: refresh }))))))
    }

    // ── rounds / memory / outbox / reports ──────────────────────────────

    function TimelineStrip({ items, onSelect }) {
      const now = new Date()
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      const dayEnd = dayStart + 86400000
      const lanes = Object.keys(TIMELINE_META)
      const visible = items.filter((item) => item.ts >= dayStart && item.ts < dayEnd)
      const x = (ts) => Math.max(0, Math.min(1000, ((ts - dayStart) / 86400000) * 1000))
      const lane = (category) => 14 + Math.max(0, lanes.indexOf(category)) * 11
      const markers = []
      for (const item of visible) {
        const meta = TIMELINE_META[item.category] ?? TIMELINE_META.system
        const payload = item.detail?.payload ?? {}
        if (item.kind === 'auto_grid' && Number.isFinite(payload.start) && Number.isFinite(payload.end)) {
          markers.push(h('rect', {
            key: item.id,
            x: x(payload.start),
            y: lane(item.category) - 5,
            width: Math.max(1, x(payload.end) - x(payload.start)),
            height: 10,
            fill: meta.color,
            opacity: 0.18,
            style: { cursor: 'pointer' },
            onClick: () => onSelect(item),
          }, h('title', null, `${clockTime(item.ts)} ${meta.label} · ${item.title}`)))
          continue
        }
        markers.push(h('g', {
          key: item.id,
          style: { cursor: 'pointer' },
          onClick: () => onSelect(item),
        },
        item.category === 'agent'
          ? h('text', { x: x(item.ts) - 5, y: lane(item.category) + 4, fontSize: 11, fill: meta.color }, '★')
          : h('circle', { cx: x(item.ts), cy: lane(item.category), r: 3.2, fill: meta.color }),
        h('title', null, `${clockTime(item.ts)} ${meta.label} · ${item.title}`)))
      }
      return h('section', { className: 'living-card' },
        h('div', { className: 'living-card-head' },
          h('span', null, '今日时间轴'),
          h('span', { className: 'living-muted' }, `${visible.length} 个标记`)),
        h('svg', { viewBox: '0 0 1000 125', style: { width: '100%', height: 140, display: 'block' }, role: 'img', 'aria-label': '今日轨迹' },
          ...lanes.map((category, index) => h('line', {
            key: `lane-${category}`,
            x1: 0,
            x2: 1000,
            y1: 14 + index * 11,
            y2: 14 + index * 11,
            stroke: 'rgba(127,127,127,0.12)',
            strokeWidth: 1,
          })),
          ...[0, 6, 12, 18, 24].map((hour) => h('g', { key: `hour-${hour}` },
            h('line', { x1: (hour / 24) * 1000, x2: (hour / 24) * 1000, y1: 6, y2: 116, stroke: 'rgba(127,127,127,0.3)', strokeWidth: 1 }),
            h('text', { x: (hour / 24) * 1000, y: 124, textAnchor: hour === 0 ? 'start' : hour === 24 ? 'end' : 'middle', fontSize: 10, fill: 'currentColor', opacity: 0.6 }, `${String(hour).padStart(2, '0')}:00`))),
          ...markers,
          h('line', { x1: x(Date.now()), x2: x(Date.now()), y1: 4, y2: 116, stroke: '#ff8a00', strokeWidth: 1.2, strokeDasharray: '3 3' })),
        h('div', { className: 'living-chips' },
          ...lanes.map((category) => h('span', {
            key: category,
            className: 'living-chip',
            style: { borderLeft: `3px solid ${TIMELINE_META[category].color}` },
          }, TIMELINE_META[category].label))))
    }

    function RoundsPanel() {
      const [nonce, setNonce] = React.useState(0)
      const { value, error } = useRpc('timeline', { limit: 1000, nonce })
      const [category, setCategory] = React.useState('all')
      const [selected, setSelected] = React.useState(null)
      const [reason, setReason] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const notify = React.useContext(ToastContext)
      const items = value ?? []
      const categories = [...new Set(items.map((item) => item.category))]
      const filtered = items.filter((item) => category === 'all' || item.category === category)
      const rounds = items.filter((item) => item.kind === 'round')
      const agentMarks = items.filter((item) => item.kind === 'agent_mark')
      const pendingReview = items.filter((item) => item.kind === 'outbox' && item.detail?.decision === 'review' && !item.detail?.ackedAt && !item.detail?.failedAt)

      if (error) return h('div', { className: 'living-empty' }, `读取失败：${error}`)
      if (!value) return h('div', { className: 'living-empty' }, '加载中…')

      const act = (action, item) => {
        setBusy(true)
        const payload = { id: item.detail.id }
        if (action === 'reject') payload.reason = reason.trim() || 'rejected by user'
        call(action, payload)
          .then(() => {
            notify(action === 'approve' ? '已放行' : '已拒绝')
            setSelected(null)
            setReason('')
            setNonce((value) => value + 1)
          })
          .catch((err) => notify(`${action === 'approve' ? '放行' : '拒绝'}失败：${err.message}`, 'error'))
          .finally(() => setBusy(false))
      }

      return h('div', { className: 'living-field' },
        h('div', { className: 'living-stats' },
          StatTile({ label: '时间轴标记', value: items.length }),
          StatTile({ label: '轮次', value: rounds.length }),
          StatTile({ label: '自写节点', value: agentMarks.length, tone: agentMarks.length > 0 ? 'ok' : 'plain' }),
          StatTile({ label: '待审外发', value: pendingReview.length, tone: pendingReview.length > 0 ? 'warn' : 'plain' })),
        h('div', { className: 'living-controls' },
          h(Button, { variant: 'outline', size: 'sm', icon: h(IconRefreshOutlineRegular, { size: 14 }), onClick: () => setNonce((value) => value + 1) }, '刷新'),
          h('span', { className: 'living-muted' }, `${filtered.length} / ${items.length}`)),
        h(TimelineStrip, { items, onSelect: setSelected }),
        h('div', { className: 'living-filters' },
          h(Pill, { active: category === 'all', onClick: () => setCategory('all') }, '全部'),
          ...categories.map((id) => h(Pill, {
            key: id,
            active: category === id,
            onClick: () => setCategory(id),
          }, TIMELINE_META[id]?.label ?? id))),
        filtered.length === 0
          ? h('div', { className: 'living-empty' }, '没有匹配的轨迹')
          : h('div', { className: 'living-field' },
              ...[...filtered].reverse().slice(0, 200).map((item) => h('section', {
                key: item.id,
                className: 'living-card',
                style: { cursor: 'pointer' },
                onClick: () => setSelected(item),
              },
              h('div', { className: 'living-row' },
                h('span', { className: 'living-chip living-mono' }, clockTime(item.ts)),
                h('span', {
                  className: 'living-chip',
                  style: { borderLeft: `3px solid ${TIMELINE_META[item.category]?.color ?? '#888'}` },
                }, TIMELINE_META[item.category]?.label ?? item.category),
                h('span', null, item.title)),
              item.text ? h('div', { className: 'living-muted' }, item.text) : null))),
        selected
          ? h(Modal, {
              open: true,
              title: '轨迹详情',
              closeLabel: '关闭',
              onClose: () => { setSelected(null); setReason('') },
              footer: selected.kind === 'outbox' && selected.detail?.decision === 'review' && !selected.detail?.ackedAt && !selected.detail?.failedAt
                ? [
                    h(Button, { key: 'approve', variant: 'primary', disabled: busy, onClick: () => act('approve', selected) }, '放行'),
                    h(Button, { key: 'reject', variant: 'outline', disabled: busy, onClick: () => act('reject', selected) }, '拒绝'),
                  ]
                : h(Button, { variant: 'outline', onClick: () => setSelected(null) }, '关闭'),
            },
            h('div', { className: 'living-field' },
              line('时间', clockTime(selected.ts)),
              line('类别', TIMELINE_META[selected.category]?.label ?? selected.category),
              line('类型', selected.kind, true),
              line('标题', selected.title),
              selected.text ? line('内容', selected.text) : null,
              selected.kind === 'outbox' && selected.detail?.decision === 'review' && !selected.detail?.ackedAt && !selected.detail?.failedAt
                ? h(Input, { value: reason, placeholder: '拒绝原因（可选）', onChange: (event) => setReason(event.target.value) })
                : null,
              h(JsonBlock, {
                label: 'detail',
                payload: selected.detail ?? {},
                defaultOpen: true,
                truncatedLabel: (n) => `…（${formatNumber(n)} 字符）`,
              })))
          : null)
    }

    function EmbeddingCard() {
      const remote = useRpc('embedConfig', {}, 10_000)
      const [draft, setDraft] = React.useState(null)
      const [models, setModels] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [askRebuild, setAskRebuild] = React.useState(false)
      const [rebuildStarted, setRebuildStarted] = React.useState(false)
      React.useEffect(() => {
        if (remote.value && draft == null) setDraft(remote.value)
      }, [remote.value, draft])
      const remoteJob = remote.value?.job ?? null
      const draftJob = draft?.job ?? null
      const job = askRebuild && !rebuildStarted
        ? draftJob
        : (remoteJob && (!draftJob || (remoteJob.startedAt ?? 0) >= (draftJob.startedAt ?? 0)) ? remoteJob : draftJob)
      const current = draft == null
        ? (remote.value ?? {})
        : {
            ...(remote.value ?? {}),
            ...draft,
            stats: remote.value?.stats ?? draft.stats,
            job,
          }
      const stats = current.stats ?? {}
      const loaded = remote.value != null
      const dirty = !askRebuild && loaded && (current.url !== remote.value.url || current.model !== remote.value.model)
      const update = (patch) => setDraft((previous) => ({ ...(previous ?? remote.value ?? {}), ...patch }))
      const modelOptions = current.model && !models.includes(current.model)
        ? [current.model, ...models]
        : models
      const indexLabel = current.index
        ? `${current.index.model ?? '—'}${current.index.digest ? ` · ${String(current.index.digest).slice(0, 12)}` : ''}`
        : '—'
      const refresh = () => {
        setError(null)
        setNotice(null)
        setBusy('models')
        call('embedModels', { url: current.url })
          .then((result) => {
            const list = (result.models ?? []).filter((model) => model.embedding === true).map((model) => model.name)
            setModels(list)
            if (!current.model && result.selected) update({ model: result.selected })
            setNotice(`找到 ${list.length} 个 embedding 模型`)
          })
          .catch((err) => setError(err.message))
          .finally(() => setBusy(''))
      }
      const save = () => {
        setError(null)
        setNotice(null)
        setBusy('save')
        call('embedConfigSave', {
          url: current.url,
          model: current.model,
          fallbackDays: current.fallbackDays,
          minConfidence: current.minConfidence,
          maxSegmentDays: current.maxSegmentDays,
        })
          .then((result) => {
            setDraft(result)
            if (result.cleared) {
              setAskRebuild(true)
              setRebuildStarted(false)
              setNotice(null)
            } else {
              setNotice(result.signatureUnknown
                ? '已保存；无法读取模型签名，下次索引时校验'
                : '已保存；模型签名未变，沿用现有向量')
            }
          })
          .catch((err) => setError(err.message))
          .finally(() => setBusy(''))
      }
      const reindex = () => {
        setError(null)
        setNotice(null)
        setBusy('reindex')
        call('embedReindex')
          .then((result) => {
            if (result.job) update({ job: result.job })
            setRebuildStarted(true)
            setAskRebuild(true)
            setNotice(result.started ? '向量重建已开始（后台）' : '重建任务已在运行')
          })
          .catch((err) => setError(err.message))
          .finally(() => setBusy(''))
      }
      const test = () => {
        setError(null)
        setNotice(null)
        setBusy('test')
        call('embedTest', { url: current.url, model: current.model })
          .then((result) => setNotice(`测试通过：${result.model} · ${result.dim} 维 · ${result.ms}ms`))
          .catch((err) => setError(err.message))
          .finally(() => setBusy(''))
      }
      return h('section', { className: 'living-card' },
        h('div', { className: 'living-card-head' },
          h('span', null, 'Embedding / 区段预测'),
          h('span', { className: 'living-muted' }, `当前模型向量 ${formatNumber(stats.current ?? 0)} 条`)),
        h('div', { className: 'living-fields-grid' },
          h(Field, { label: 'Ollama URL', help: '默认 http://127.0.0.1:11434；不写死主机' },
            h(Input, { value: current.url ?? '', onChange: (event) => update({ url: event.target.value }) })),
          h(Field, { label: '模型', help: '点“刷新”列出模型；默认取第一个有 embedding 能力的' },
            h('div', { className: 'living-controls' },
              h('select', {
                className: 'living-select',
                value: current.model ?? '',
                onChange: (event) => update({ model: event.target.value }),
              },
                h('option', { value: '' }, '（自动选第一个 embedding 模型）'),
                ...modelOptions.map((name) => h('option', { key: name, value: name }, name))),
              h(Button, {
                variant: 'outline',
                size: 'sm',
                disabled: busy === 'models',
                onClick: refresh,
              }, busy === 'models' ? '刷新中…' : '刷新'))),
          h(Field, { label: '兜底天数', help: '没有 embedding 或区段为空时，子 agent 扫最近 N 天；默认 3' },
            h(Input, {
              type: 'number',
              value: current.fallbackDays ?? 3,
              onChange: (event) => update({ fallbackDays: Number(event.target.value) }),
            })),
          h(Field, { label: '最低置信度', help: '低于此值的区段不返回；默认 0.35，未校准，仅用于过滤' },
            h(Input, {
              type: 'number',
              step: '0.05',
              value: current.minConfidence ?? 0.35,
              onChange: (event) => update({ minConfidence: Number(event.target.value) }),
            })),
          h(Field, { label: '区段最宽天数', help: '单段上限；默认 7 天，不会返回覆盖全集的段' },
            h(Input, {
              type: 'number',
              value: current.maxSegmentDays ?? 7,
              onChange: (event) => update({ maxSegmentDays: Number(event.target.value) }),
            }))),
        dirty ? h('div', { className: 'living-field-help' }, '模型或 URL 有变更；保存后会清空旧向量，并询问是否立即重建') : null,
        h('div', { className: 'living-controls' },
          h(Button, { variant: 'primary', disabled: busy === 'save', onClick: save }, busy === 'save' ? '保存中…' : '保存'),
          h(Button, { variant: 'outline', disabled: busy === 'test', onClick: test }, busy === 'test' ? '测试中…' : '测试'),
          h(Button, { variant: 'outline', disabled: busy === 'reindex', onClick: reindex }, busy === 'reindex' ? '启动中…' : '校验补齐')),
        error ? h('div', { className: 'living-field-error' }, error) : null,
        notice ? h('div', { className: 'living-muted' }, notice) : null,
        current.job
          ? h('div', { className: 'living-field' },
              Progress({
                used: current.job.processed ?? 0,
                limit: current.job.total ?? 0,
                label: current.job.running ? '索引补齐' : current.job.error ? '索引补齐失败' : '索引补齐完成',
              }),
              current.job.error ? h('div', { className: 'living-field-error' }, current.job.error) : null)
          : null,
        h('div', { className: 'living-field-help' },
          `全库向量 ${formatNumber(stats.count ?? 0)} 条 · 索引签名 ${indexLabel}；签名变化会清空索引。区段置信度仅用于过滤，不是概率。`),
        h(Modal, {
          open: askRebuild,
          title: rebuildStarted ? '向量库重建' : '向量库需要重建',
          description: rebuildStarted
            ? '正在后台重建向量库；可以关闭弹窗，任务会继续。'
            : '检测到 embedding 模型或 URL 变更，旧向量已清空。是否现在重建？不重建的话，sleep 会全量补齐，期间回想走词法兜底。',
          closeLabel: '关闭',
          onClose: () => setAskRebuild(false),
          footer: rebuildStarted
            ? [h(Button, {
                key: 'close',
                variant: 'outline',
                onClick: () => setAskRebuild(false),
              }, current.job?.running ? '后台继续' : '关闭')]
            : [
                h(Button, {
                  key: 'later',
                  variant: 'outline',
                  onClick: () => {
                    setAskRebuild(false)
                    setNotice('已保存；旧向量已清空，sleep 会全量补齐')
                  },
                }, '稍后'),
                h(Button, {
                  key: 'now',
                  variant: 'primary',
                  disabled: busy === 'reindex',
                  onClick: reindex,
                }, busy === 'reindex' ? '启动中…' : '立即重建'),
              ],
        }, current.job
          ? h('div', { className: 'living-field' },
              Progress({
                used: current.job.processed ?? 0,
                limit: current.job.total ?? 0,
                label: current.job.running ? '重建中' : current.job.error ? '重建失败' : '重建完成',
              }),
              current.job.error ? h('div', { className: 'living-field-error' }, current.job.error) : null)
          : h('div', { className: 'living-muted' }, '尚未开始重建')))
    }

    function MemoryPanel() {
      const stats = useRpc('stats', { days: 1 }, 15_000)
      const [layer, setLayer] = React.useState('items')
      const [kind, setKind] = React.useState('all')
      const [status, setStatus] = React.useState('all')
      const [nonce, setNonce] = React.useState(0)
      const [selected, setSelected] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [detailError, setDetailError] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [result, setResult] = React.useState(null)
      const [searchError, setSearchError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [recallQuestion, setRecallQuestion] = React.useState('')
      const [recallDetail, setRecallDetail] = React.useState('brief')
      const [recallBusy, setRecallBusy] = React.useState(false)
      const [recallResult, setRecallResult] = React.useState(null)
      const [recallError, setRecallError] = React.useState(null)
      const browse = useRpc('memoryBrowse', {
        layer,
        kind: kind === 'all' ? null : kind,
        status: status === 'all' ? null : status,
        limit: 100,
        nonce,
      }, 15_000)
      const counts = stats.value ?? {}
      const items = browse.value ?? []
      const search = () => {
        setSearchError(null)
        setBusy(true)
        call('memory', { query, topK: 8 })
          .then(setResult)
          .catch((err) => setSearchError(err.message))
          .finally(() => setBusy(false))
      }
      const recollect = () => {
        const question = recallQuestion.trim()
        if (!question) return
        setRecallError(null)
        setRecallResult(null)
        setRecallBusy(true)
        call('recollect', { question, detail: recallDetail, mode: 'lookup' })
          .then(setRecallResult)
          .catch((err) => setRecallError(err.message))
          .finally(() => setRecallBusy(false))
      }
      const open = (item) => {
        setSelected(item)
        setDetail(null)
        setDetailError(null)
        if (layer === 'items') {
          call('memoryDetail', { kind: item.kind, id: item.id })
            .then(setDetail)
            .catch((err) => setDetailError(err.message))
        } else {
          setDetail({ item })
        }
      }
      const switchLayer = (next) => {
        setLayer(next)
        setKind('all')
        setStatus('all')
        setSelected(null)
        setDetail(null)
        setDetailError(null)
      }
      const filter = (active, label, onClick) => h(Pill, { active, onClick }, label)
      const layerMeta = {
        items: { label: '条目', empty: '还没有整理后的记忆条目' },
        raw: { label: 'Raw 段', empty: '还没有 raw 段' },
        edges: { label: '关系边', empty: '还没有关系边' },
        cold: { label: '冷区', empty: '还没有冷区线索' },
      }
      return h('div', { className: 'living-field' },
        h('div', { className: 'living-stats' },
          StatTile({ label: '事件（24h）', value: formatNumber(counts.events ?? 0) }),
          StatTile({ label: '轮次（24h）', value: formatNumber(counts.rounds ?? 0) }),
          StatTile({ label: '冷区线索', value: formatNumber(counts.cold ?? 0) }),
          StatTile({ label: '事实', value: formatNumber(counts.facts ?? 0) }),
          StatTile({ label: '待整理 raw', value: formatNumber(counts.rawPending ?? 0) }),
          StatTile({ label: '记忆条目', value: formatNumber(counts.items ?? 0) }),
          StatTile({ label: '关系边', value: formatNumber(counts.edges ?? 0) })),
        h(EmbeddingCard),
        h('section', { className: 'living-card' },
          h('div', { className: 'living-card-head' },
            h('span', null, '回想'),
            h('span', { className: 'living-muted' }, '慢路径 · 计入今日 token')),
          h('div', { className: 'living-controls' },
            h('div', { style: { flex: 1, minWidth: 260 } },
              h(Input, {
                value: recallQuestion,
                placeholder: '问它一件需要跨时间/语义回想的事',
                onChange: (event) => setRecallQuestion(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') recollect() },
              })),
            h(Pill, { active: recallDetail === 'brief', onClick: () => setRecallDetail('brief') }, '简'),
            h(Pill, { active: recallDetail === 'full', onClick: () => setRecallDetail('full') }, '详'),
            h(Button, {
              variant: 'primary',
              icon: h(IconSearchOutlineRegular, { size: 14 }),
              disabled: recallBusy || !recallQuestion.trim(),
              onClick: recollect,
            }, recallBusy ? '回想中…' : '回想')),
          recallError ? h('div', { className: 'living-field-error' }, recallError) : null,
          recallResult
            ? h('div', { className: 'living-field' },
                h('div', { className: recallResult.ok ? 'living-muted' : 'living-field-error' }, recallResult.summary),
                recallResult.primary
                  ? h('section', { className: 'living-card' },
                      h('div', { className: 'living-card-head' }, h('span', null, '主选')),
                      h(MarkdownText, { text: recallResult.primary.answer, labels: MARKDOWN_LABELS }),
                      h('div', { className: 'living-chips' },
                        ...(recallResult.primary.evidence ?? []).map((row) => h('span', {
                          key: `${row.source}:${row.id}`,
                          className: 'living-chip living-mono',
                          title: row.text || '',
                        }, `${row.source}:${String(row.id).slice(0, 10)}`))))
                  : null,
                recallResult.backup
                  ? h('section', { className: 'living-card' },
                      h('div', { className: 'living-card-head' }, h('span', null, '备选')),
                      h(MarkdownText, { text: recallResult.backup.answer, labels: MARKDOWN_LABELS }),
                      h('div', { className: 'living-chips' },
                        ...(recallResult.backup.evidence ?? []).map((row) => h('span', {
                          key: `backup:${row.source}:${row.id}`,
                          className: 'living-chip living-mono',
                          title: row.text || '',
                        }, `${row.source}:${String(row.id).slice(0, 10)}`))))
                  : null,
                h('div', { className: 'living-muted' },
                  `${recallResult.scanned ? `扫描 ${recallResult.scanned.scans ?? 0} 次 · ${recallResult.scanned.candidates ?? 0} 条` : ''}${recallResult.scanned?.segmentSource ? ` · 区段 ${recallResult.scanned.segmentSource}/${recallResult.scanned.segments ?? 0}` : ''}${recallResult.usage ? ` · tokens ${formatNumber(recallResult.usage.tokens ?? 0)}` : ''}${recallResult.gaps?.length ? ` · gaps: ${recallResult.gaps.join(', ')}` : ''}`))
            : null),
        h('section', { className: 'living-card' },
          h('div', { className: 'living-card-head' }, h('span', null, '检索记忆')),
          h('div', { className: 'living-controls' },
            h('div', { style: { flex: 1, minWidth: 240 } },
              h(Input, {
                value: query,
                placeholder: '线索（如：散热 / 小明 / 上次说的那个站）',
                onChange: (event) => setQuery(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') search() },
              })),
            h(Button, {
              variant: 'primary',
              icon: h(IconSearchOutlineRegular, { size: 14 }),
              disabled: busy,
              onClick: search,
            }, busy ? '检索中…' : '检索')),
          h('div', { className: 'living-field-help' }, '每个结果都带 why_recalled；G1 是关系边带回的邻居。')),
        searchError ? h('div', { className: 'living-field-error' }, searchError) : null,
        result
          ? h('section', { className: 'living-card' },
              h('div', { className: 'living-card-head' }, h('span', null, '检索结果'), h('span', { className: 'living-muted' }, `${result.recalled.length} 条`)),
              result.recalled.length === 0
                ? h('div', { className: 'living-empty' }, '没有通道命中')
                : h('div', { className: 'living-field' },
                    ...result.recalled.map((entry) => h('div', { key: entry.id, className: 'living-row' },
                      h('span', { className: 'living-chip living-mono' }, entry.id),
                      h('span', null, entry.text),
                      ...(entry.why ?? []).map((why) => h('span', { key: why, className: 'living-chip' }, why))))))
          : null,
        h('section', { className: 'living-card' },
          h('div', { className: 'living-card-head' },
            h('span', null, '记忆目录'),
            h('div', { className: 'living-controls' },
              h('span', { className: 'living-muted' }, `${items.length} 条`),
              h(Button, { variant: 'outline', size: 'sm', icon: h(IconRefreshOutlineRegular, { size: 14 }), onClick: () => setNonce((value) => value + 1) }, '刷新'))),
          h('div', { className: 'living-filters' },
            ...Object.entries(layerMeta).map(([id, meta]) => filter(layer === id, meta.label, () => switchLayer(id)))),
          layer === 'items'
            ? h('div', { className: 'living-filters' },
                filter(kind === 'all', '全部', () => setKind('all')),
                filter(kind === 'episode', 'Episode', () => setKind('episode')),
                filter(kind === 'fact', 'Fact', () => setKind('fact')))
            : layer === 'raw'
              ? h('div', { className: 'living-filters' },
                  filter(status === 'all', '全部', () => setStatus('all')),
                  filter(status === 'pending', 'Pending', () => setStatus('pending')),
                  filter(status === 'processed', 'Processed', () => setStatus('processed')))
              : null,
          browse.error ? h('div', { className: 'living-field-error' }, `读取失败：${browse.error}`) : null,
          !browse.value
            ? h('div', { className: 'living-empty' }, '加载中…')
            : items.length === 0
              ? h('div', { className: 'living-empty' }, layerMeta[layer].empty)
              : h('div', { className: 'living-field' },
                  ...items.map((item, index) => {
                    if (layer === 'items') {
                      return h('div', {
                        key: `${item.kind}:${item.id}`,
                        className: 'living-card',
                        style: { cursor: 'pointer' },
                        onClick: () => open(item),
                      },
                      h('div', { className: 'living-row' },
                        h('span', { className: 'living-chip' }, item.kind),
                        h('span', { className: 'living-mono living-muted' }, item.id),
                        h('span', { className: 'living-muted' }, `重要度 ${item.importance} · 置信 ${item.confidence}`)),
                      h('div', null, item.title || item.description || '（空）'),
                      item.description && item.title ? h('div', { className: 'living-muted' }, item.description) : null)
                    }
                    if (layer === 'raw') {
                      const messages = item.payload?.messages?.length ?? 0
                      return h('div', {
                        key: item.id,
                        className: 'living-card',
                        style: { cursor: 'pointer' },
                        onClick: () => open(item),
                      },
                      h('div', { className: 'living-row' },
                        h('span', { className: 'living-chip' }, item.kind),
                        h('span', { className: 'living-chip' }, item.status),
                        h('span', { className: 'living-mono living-muted' }, item.id),
                        h('span', { className: 'living-muted' }, `${messages} 条消息 · attempts ${item.attempts ?? 0}`)),
                      item.lastError ? h('div', { className: 'living-field-error' }, item.lastError) : null)
                    }
                    if (layer === 'edges') {
                      return h('div', {
                        key: item.id,
                        className: 'living-card',
                        style: { cursor: 'pointer' },
                        onClick: () => open(item),
                      },
                      h('div', { className: 'living-row' },
                        h('span', { className: 'living-mono' }, `${item.fromKind}:${item.fromId}`),
                        h('span', { className: 'living-chip' }, item.relation),
                        h('span', { className: 'living-mono' }, `${item.toKind}:${item.toId}`),
                        h('span', { className: 'living-muted' }, `置信 ${item.confidence}`)),
                      item.note ? h('div', { className: 'living-muted' }, item.note) : null)
                    }
                    return h('div', {
                      key: `${item.keyword}-${index}`,
                      className: 'living-card',
                      style: { cursor: 'pointer' },
                      onClick: () => open(item),
                    },
                    h('div', { className: 'living-row' },
                      h('span', { className: 'living-chip' }, item.keyword),
                      h('span', { className: 'living-muted' }, item.label20 ?? ''),
                      h('span', { className: 'living-muted' }, item.lastTs ? clockTime(item.lastTs) : '—')))
                  }))),
        selected
          ? h(Modal, {
              open: true,
              title: layer === 'items' ? '记忆条目' : layer === 'raw' ? 'Raw 段' : layer === 'edges' ? '关系边' : '冷区线索',
              closeLabel: '关闭',
              onClose: () => { setSelected(null); setDetail(null); setDetailError(null) },
              footer: h(Button, { variant: 'outline', onClick: () => { setSelected(null); setDetail(null) } }, '关闭'),
            },
            h('div', { className: 'living-field' },
              detailError ? h('div', { className: 'living-field-error' }, detailError) : null,
              !detail ? h('div', { className: 'living-empty' }, '加载中…') : null,
              detail?.item
                ? h('div', { className: 'living-field' },
                    line('id', detail.item.id, true),
                    line('kind', detail.item.kind ?? layer),
                    detail.item.description ? line('描述', detail.item.description) : null,
                    detail.item.facets ? h(JsonBlock, { label: 'facets', payload: detail.item.facets, defaultOpen: true, truncatedLabel: (n) => `…（${formatNumber(n)} 字符）` }) : null,
                    detail.item.rawRefs?.length ? line('raw', detail.item.rawRefs.join(', '), true) : null,
                    detail.edges?.length
                      ? h('div', { className: 'living-field' },
                          h('div', { className: 'living-field-label' }, '关系'),
                          ...detail.edges.map((edge) => h('div', { key: edge.id, className: 'living-row' },
                            h('span', { className: 'living-chip' }, edge.relation),
                            h('span', null, edge.note || ''),
                            h('span', { className: 'living-muted' }, `置信 ${edge.confidence}`))))
                      : null)
                : null,
              h(JsonBlock, {
                label: 'detail',
                payload: detail?.item ?? selected ?? {},
                defaultOpen: layer === 'raw' || layer === 'edges',
                truncatedLabel: (n) => `…（${formatNumber(n)} 字符）`,
              })))
          : null)
    }

    const OUTBOX_FILTERS = [
      ['all', '全部'],
      ['review', '待确认'],
      ['pending', '待发送'],
      ['sent', '已发送'],
      ['failed', '失败'],
    ]

    function outboxBadge(item) {
      const state = outboxState(item)
      if (state === 'sent') return h(Badge, { tone: 'ok' }, '已发送')
      if (state === 'failed') return h(Badge, { tone: 'error' }, `失败：${item.lastError ?? '未知'}`)
      if (state === 'review') return h(Badge, { tone: 'warn' }, '待确认')
      return h(Badge, { tone: item.lastError ? 'warn' : 'muted' }, item.lastError ? `重试：${item.lastError}` : '待发送')
    }

    function OutboxPanel() {
      const [nonce, setNonce] = React.useState(0)
      const { value, error } = useRpc('outbox', { limit: 100, nonce })
      const [filter, setFilter] = React.useState('all')
      const [pending, setPending] = React.useState(null)
      const [reason, setReason] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const notify = React.useContext(ToastContext)
      const items = value ?? []
      const counts = Object.fromEntries(OUTBOX_FILTERS.map(([id]) => [id, items.filter((item) => id === 'all' || outboxState(item) === id).length]))
      const filtered = items.filter((item) => filter === 'all' || outboxState(item) === filter)

      const confirm = (action, item) => {
        setPending({ action, item })
        setReason('')
      }
      const act = () => {
        if (!pending) return
        setBusy(true)
        const payload = { id: pending.item.id }
        if (pending.action === 'reject') payload.reason = reason.trim() || 'rejected by user'
        call(pending.action, payload)
          .then(() => {
            notify(pending.action === 'approve' ? '已放行' : '已拒绝')
            setPending(null)
            setNonce((n) => n + 1)
          })
          .catch((err) => notify(`${pending.action === 'approve' ? '放行' : '拒绝'}失败：${err.message}`, 'error'))
          .finally(() => setBusy(false))
      }

      if (error) return h('div', { className: 'living-empty' }, `读取失败：${error}`)
      if (!value) return h('div', { className: 'living-empty' }, '加载中…')

      return h('div', { className: 'living-field' },
        h('div', { className: 'living-stats' },
          StatTile({ label: '待确认', value: counts.review, tone: counts.review > 0 ? 'warn' : 'plain' }),
          StatTile({ label: '待发送', value: counts.pending }),
          StatTile({ label: '已发送', value: counts.sent, tone: 'ok' }),
          StatTile({ label: '失败', value: counts.failed, tone: counts.failed > 0 ? 'error' : 'plain' })),
        h('div', { className: 'living-controls' },
          h(Button, { variant: 'outline', size: 'sm', icon: h(IconRefreshOutlineRegular, { size: 14 }), onClick: () => setNonce((n) => n + 1) }, '刷新'),
          h('span', { className: 'living-muted' }, `${filtered.length} / ${items.length}`)),
        h('div', { className: 'living-filters' },
          ...OUTBOX_FILTERS.map(([id, label]) => h(Pill, {
            key: id,
            active: filter === id,
            onClick: () => setFilter(id),
          }, `${label} ${counts[id] ?? 0}`))),
        items.length === 0
          ? h('div', { className: 'living-empty' }, '队列为空')
          : filtered.length === 0
            ? h('div', { className: 'living-empty' }, '这个状态下没有条目')
            : h('div', { className: 'living-field' },
                ...filtered.map((item) => {
                  const state = outboxState(item)
                  return h('section', { key: item.id, className: 'living-card' },
                    h('div', { className: 'living-row' },
                      h('span', { className: 'living-chip' }, item.gem),
                      h('span', { className: 'living-chip' }, item.origin === 'event' ? '回复' : '主动'),
                      h('span', { className: 'living-mono' }, item.to),
                      outboxBadge(item),
                      h('span', { className: 'living-muted' }, `尝试 ${item.attempts ?? 0}`),
                      item.media ? h('span', { className: 'living-chip' }, '含媒体') : null),
                    h('div', { className: 'living-quote' }, String(item.text ?? '')),
                    h('div', { className: 'living-row' },
                      h('span', { className: 'living-muted' }, `创建 ${clockTime(item.createdAt)}`),
                      state === 'review'
                        ? h('span', { className: 'living-muted' }, '已停下等待人工')
                        : state === 'pending' && item.nextAttemptAt
                          ? h('span', { className: 'living-muted' }, `下次尝试 ${relativeTime(item.nextAttemptAt)}`)
                          : null,
                      item.decision ? h('span', { className: 'living-muted' }, `决策 ${item.decision}${item.ruleId ? ` · 规则 ${item.ruleId}` : ''}`) : null,
                      item.lastError ? h('span', { className: 'living-field-error' }, `上次错误：${item.lastError}`) : null),
                    state === 'review'
                      ? h('div', { className: 'living-controls' },
                          h(Button, { variant: 'primary', size: 'sm', onClick: () => confirm('approve', item) }, '放行'),
                          h(Button, { variant: 'outline', size: 'sm', onClick: () => confirm('reject', item) }, '拒绝'))
                      : null,
                    item.media
                      ? h(JsonBlock, {
                          label: 'media',
                          payload: item.media,
                          defaultOpen: false,
                          truncatedLabel: (n) => `…（${formatNumber(n)} 字符）`,
                        })
                      : null)
                })),
        pending
          ? h(Modal, {
              open: true,
              title: pending.action === 'approve' ? '放行这条外发？' : '拒绝这条外发？',
              description: `${pending.item.gem} → ${pending.item.to}`,
              closeLabel: '取消',
              onClose: () => setPending(null),
              footer: [
                h(Button, { key: 'cancel', variant: 'outline', onClick: () => setPending(null) }, '取消'),
                h(Button, {
                  key: 'ok',
                  variant: pending.action === 'approve' ? 'primary' : 'outline',
                  disabled: busy,
                  onClick: act,
                }, busy ? '处理中…' : pending.action === 'approve' ? '放行' : '拒绝'),
              ],
            },
            h('div', { className: 'living-field' },
              h('div', { className: 'living-quote' }, String(pending.item.text ?? '')),
              pending.action === 'reject'
                ? h(Field, { label: '拒绝原因', help: '会写进审计事件；留空使用默认原因' },
                    h(Input, {
                      value: reason,
                      placeholder: '例如：内容不合适',
                      onChange: (event) => setReason(event.target.value),
                    }))
                : h('div', { className: 'living-field-help' }, '放行后下一条拉取就会投递。')))
          : null)
    }

    const ANOMALY_LABELS = {
      round_error: '轮次失败',
      schedule_missed: '错过日程',
      outbound_blocked: '外发被拦',
      limiter_pass_streak: '判决连过',
    }

    function ReportsPanel() {
      const { value, error } = useRpc('reports', {}, 15_000)
      const archived = [...(value ?? [])].sort()
      const today = (() => {
        const d = new Date()
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      })()
      const [selected, setSelected] = React.useState(null)
      const [month, setMonth] = React.useState(() => {
        const d = new Date()
        return new Date(d.getFullYear(), d.getMonth(), 1)
      })
      const [report, setReport] = React.useState(null)
      const [reportError, setReportError] = React.useState(null)

      React.useEffect(() => {
        if (selected != null || !value) return
        const latest = archived[archived.length - 1] ?? today
        setSelected(latest)
        const [year, monthIndex] = latest.split('-').map(Number)
        setMonth(new Date(year, monthIndex - 1, 1))
      }, [value, selected])

      React.useEffect(() => {
        if (!selected) return undefined
        let alive = true
        setReport(null)
        setReportError(null)
        call('report', { date: selected })
          .then((next) => { if (alive) setReport(next) })
          .catch((err) => { if (alive) setReportError(err.message) })
        return () => { alive = false }
      }, [selected])

      if (error) return h('div', { className: 'living-empty' }, `读取失败：${error}`)
      if (!value) return h('div', { className: 'living-empty' }, '加载中…')

      const reportSet = new Set(archived)
      const year = month.getFullYear()
      const monthIndex = month.getMonth()
      const dayCount = new Date(year, monthIndex + 1, 0).getDate()
      const lead = new Date(year, monthIndex, 1).getDay()
      const cells = [...Array(lead).fill(null), ...Array.from({ length: dayCount }, (_, index) => index + 1)]
      while (cells.length % 7 !== 0) cells.push(null)
      const keyFor = (day) => `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      const shiftMonth = (delta) => setMonth(new Date(year, monthIndex + delta, 1))

      return h('div', { className: 'living-field' },
        h('section', { className: 'living-card living-calendar-card' },
          h('div', { className: 'living-card-head' },
            h('span', null, `${year} 年 ${monthIndex + 1} 月`),
            h('div', { className: 'living-controls' },
              h(Button, { variant: 'ghost', size: 'sm', onClick: () => shiftMonth(-1) }, '‹'),
              h(Button, { variant: 'ghost', size: 'sm', onClick: () => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); setSelected(today) } }, '今天'),
              h(Button, { variant: 'ghost', size: 'sm', onClick: () => shiftMonth(1) }, '›'))),
          h('div', { className: 'living-calendar-week' }, ...['日', '一', '二', '三', '四', '五', '六'].map((label) => h('span', { key: label }, label))),
          h('div', { className: 'living-calendar-grid' },
            ...cells.map((day, index) => {
              if (!day) return h('span', { key: `blank-${index}`, className: 'living-calendar-blank' })
              const key = keyFor(day)
              return h('button', {
                key,
                className: `living-calendar-day${selected === key ? ' active' : ''}${key === today ? ' today' : ''}${reportSet.has(key) ? ' has-report' : ''}`,
                disabled: key > today,
                onClick: () => setSelected(key),
                title: reportSet.has(key) ? `${key} · 已归档日报` : key === today ? `${key} · 实时` : key,
              },
                h('span', null, day),
                reportSet.has(key)
                  ? h('span', { className: 'living-calendar-dot' })
                  : key === today
                    ? h('span', { className: 'living-calendar-dot live' })
                    : null)
            }))),
        reportError ? h('div', { className: 'living-field-error' }, reportError) : null,
        !selected
          ? h('div', { className: 'living-empty' }, '选择日期')
          : !report
            ? h('div', { className: 'living-empty' }, `加载 ${selected}…`)
            : h('div', { className: 'living-field' },
                h('div', { className: 'living-row' },
                  h('span', { className: 'living-chip living-mono' }, selected),
                  report.live ? Badge({ tone: 'warn', children: '实时' }) : Badge({ tone: 'ok', children: '已归档' }),
                  h('span', { className: 'living-muted' }, `生成于 ${clockTime(report.generatedAt)}`)),
                h('section', { className: 'living-card' },
                  h('div', { className: 'living-card-head' }, h('span', null, '日报 Markdown')),
                  h('div', { className: 'living-markdown' },
                    h(MarkdownText, { text: report.markdown ?? '（没有 Markdown）', labels: MARKDOWN_LABELS }))))
      )
    }

    // ── page ────────────────────────────────────────────────────────────

    function LivingPanel(props) {
      const [tab, setTab] = React.useState('status')
      const { notify, node } = useToastState()
      const state = useRpc('state', {})
      const status = state.value?.status
      return h(ToastContext.Provider, { value: notify },
        h('div', { className: 'living-page' },
          h('header', { className: 'living-head' },
            h('div', null,
              h('h1', { className: 'living-title' }, 'Living'),
              h('div', { className: 'living-sub' }, '按设定活着：时钟、记忆、人格与宝石')),
            h('div', { className: 'living-controls' }, statusBadge(status))),
          h('div', { style: { padding: '0 24px' } },
            h(SegmentedTabs, {
              items: TABS.map(([value, label]) => ({ value, label })),
              value: tab,
              onChange: setTab,
              label: 'Living 页面',
            })),
          h('div', { className: 'living-body' },
            tab === 'status' ? h(StatusPanel, { onOpenGems: () => setTab('gems') }) : null,
            tab === 'persona' ? h(PersonaPanel) : null,
            tab === 'gems' ? h(GemsPanel) : null,
            tab === 'config' ? h(ConfigPanel, { form: props.configForm }) : null,
            tab === 'rounds' ? h(RoundsPanel) : null,
            tab === 'memory' ? h(MemoryPanel) : null,
            tab === 'reports' ? h(ReportsPanel) : null),
          node))
    }

    function LivingIcon({ size = 16 }) {
      return h(IconSparkleRegular, { size })
    }

    function apply(ctx) {
      rpc = ctx.connection.rpc
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        inject: () => ({ configForm: ctx.configForms.get('living') }),
      }, LivingPanel))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 40,
        label: () => 'Living',
      }, LivingIcon))
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})

function installStyles() {
  const id = 'dsh-living/styles'
  if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css="${id}"]`)) return
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-living'
  style.dataset.pluginCss = id
  style.textContent = `
.living-page{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary,inherit)}
.living-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:18px 24px 10px}
.living-title{font-size:18px;font-weight:600;line-height:1.3;margin:0}
.living-sub{color:var(--dsw-alias-label-tertiary,#888);font-size:12px;margin-top:2px}
.living-body{flex:1;min-height:0;overflow-y:auto;padding:8px 24px 24px;display:flex;flex-direction:column;gap:14px}
.living-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:12px;align-items:start}
.living-span-4{grid-column:span 4}
.living-span-8{grid-column:span 8}
.living-schedule{position:relative;display:flex;flex-direction:column;gap:4px;padding-left:16px;margin:2px 0}
.living-schedule::before{content:'';position:absolute;left:5px;top:6px;bottom:6px;width:1px;background:color-mix(in srgb,currentColor 16%,transparent)}
.living-schedule-tabs{margin:2px 0}
.living-schedule-row{position:relative;display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:10px;align-items:center;min-height:22px}
.living-schedule-row::before{content:'';position:absolute;left:-14px;top:50%;width:7px;height:7px;margin-top:-3.5px;border-radius:50%;background:#6c8ebf}
.living-schedule-time{font-size:11px;color:var(--dsw-alias-label-tertiary,#888);text-align:right;font-variant-numeric:tabular-nums}
.living-schedule-intent{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.living-schedule-row.done::before{background:color-mix(in srgb,currentColor 30%,transparent)}
.living-schedule-row.done .living-schedule-intent{color:var(--dsw-alias-label-tertiary,#888)}
.living-schedule-row.missed::before{background:#c33}
.living-schedule-row.missed .living-schedule-time{color:#c33}
@media (max-width:1200px){.living-grid{grid-template-columns:minmax(0,1fr)}.living-span-4,.living-span-8{grid-column:span 1}}
.living-card{border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:10px;padding:14px 16px;background:color-mix(in srgb,currentColor 3%,transparent);display:flex;flex-direction:column;gap:8px;min-width:0}
.living-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;font-weight:600}
.living-subpage{display:flex;flex-direction:column;gap:10px;min-width:0}
.living-subtabs{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent)}
.living-subtabs-list{display:flex;align-items:stretch;gap:2px;min-width:0;overflow-x:auto;overflow-y:hidden}
.living-subtab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#888);font:inherit;font-size:12px;line-height:1.4;padding:7px 10px 5px;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap}
.living-subtab:hover{color:inherit}
.living-subtab-active{color:inherit;font-weight:600;border-bottom-color:var(--dsw-alias-state-business-primary,#3a6ea5)}
.living-row{display:flex;align-items:center;gap:8px;font-size:12px;line-height:1.5;min-width:0;flex-wrap:wrap}
.living-row-label{min-width:104px;color:var(--dsw-alias-label-tertiary,#888)}
.living-muted{color:var(--dsw-alias-label-tertiary,#888);font-size:12px}
.living-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.living-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;font-size:11px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);white-space:nowrap}
.living-badge-ok{color:var(--dsw-alias-state-success-primary,#2e7d32);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2e7d32) 40%,transparent)}
.living-badge-warn{color:var(--dsw-alias-state-warn-primary,#c90);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#c90) 40%,transparent)}
.living-badge-error{color:var(--dsw-alias-state-error-primary,#c33);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c33) 40%,transparent)}
.living-badge-muted{color:var(--dsw-alias-label-tertiary,#888)}
.living-bar{height:6px;border-radius:999px;background:color-mix(in srgb,currentColor 12%,transparent);overflow:hidden}
.living-bar-fill{height:100%;border-radius:999px;background:var(--dsw-alias-state-business-primary,#3a6ea5)}
.living-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.living-fields-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:12px 18px;align-items:start;min-width:0}
.living-fields-grid > *{min-width:0}
.living-fields-grid input,.living-fields-grid select,.living-fields-grid textarea{width:100%;min-width:0;box-sizing:border-box}
.living-control{width:100%;max-width:520px}
.living-control-wide{max-width:100%}
.living-field-label{font-size:12px;font-weight:600}
.living-field-help{font-size:11px;color:var(--dsw-alias-label-tertiary,#888);line-height:1.5}
.living-field-error{font-size:11px;color:var(--dsw-alias-state-error-primary,#c33);line-height:1.5}
.living-controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.living-select{font:inherit;font-size:12px;padding:6px 8px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:transparent;color:inherit}
.living-textarea{font:inherit;font-size:12px;padding:8px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:transparent;color:inherit;width:100%;box-sizing:border-box;resize:vertical;min-height:70px}
.living-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.living-stat{border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:8px;padding:10px 12px;background:color-mix(in srgb,currentColor 2%,transparent)}
.living-stat-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#888)}
.living-stat-value{font-size:20px;font-weight:600;line-height:1.35;font-variant-numeric:tabular-nums}
.living-stat-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#888)}
.living-stat-ok{color:var(--dsw-alias-state-success-primary,#2e7d32)}
.living-stat-warn{color:var(--dsw-alias-state-warn-primary,#c90)}
.living-stat-error{color:var(--dsw-alias-state-error-primary,#c33)}
.living-stat-plain{color:inherit}
.living-filters{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.living-bars{display:flex;flex-direction:column;gap:5px}
.living-bar-row{display:flex;align-items:center;gap:8px;font-size:11px;min-width:0}
.living-bar-label{min-width:96px;color:var(--dsw-alias-label-tertiary,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.living-bar-row .living-bar{flex:1}
.living-bar-value{min-width:52px;text-align:right;font-variant-numeric:tabular-nums}
.living-quote{margin:2px 0;padding:8px 10px;border-left:2px solid color-mix(in srgb,currentColor 24%,transparent);background:color-mix(in srgb,currentColor 3%,transparent);border-radius:0 6px 6px 0;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow-y:auto}
.living-rhythm{display:flex;align-items:flex-end;gap:2px;min-height:96px}
.living-rhythm-col{display:flex;flex-direction:column;align-items:center;gap:4px;flex:1;min-width:0}
.living-rhythm-track{height:72px;width:100%;display:flex;align-items:flex-end;justify-content:center;background:color-mix(in srgb,currentColor 4%,transparent);border-radius:3px}
.living-rhythm-bar{width:70%;min-height:0;border-radius:2px 2px 0 0;background:var(--dsw-alias-state-business-primary,#3a6ea5)}
.living-rhythm-label{font-size:9px;color:var(--dsw-alias-label-tertiary,#888);height:10px}
.living-chips{display:flex;gap:6px;flex-wrap:wrap}
.living-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);font-size:11px}
.living-chip button{border:0;background:none;color:inherit;cursor:pointer;padding:0;line-height:1;opacity:.6}
.living-chip button:hover{opacity:1}
.living-table{width:100%;border-collapse:collapse;font-size:12px}
.living-table th{text-align:left;font-weight:600;color:var(--dsw-alias-label-tertiary,#888);padding:6px 8px;border-bottom:1px solid color-mix(in srgb,currentColor 14%,transparent);white-space:nowrap}
.living-table td{padding:6px 8px;border-bottom:1px solid color-mix(in srgb,currentColor 8%,transparent);vertical-align:top}
.living-details{border-top:1px solid color-mix(in srgb,currentColor 10%,transparent);padding-top:6px}
.living-details summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-tertiary,#888);list-style:none}
.living-details summary::-webkit-details-marker{display:none}
.living-details summary:before{content:'▸ ';font-size:10px}
.living-details[open] summary:before{content:'▾ '}
.living-empty{padding:18px;text-align:center;color:var(--dsw-alias-label-tertiary,#888);font-size:12px}
.living-version{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid color-mix(in srgb,currentColor 8%,transparent);font-size:12px;min-width:0}
.living-version-main{min-width:0;flex:1}
.living-pre{margin:0;padding:10px 12px;border-radius:6px;background:color-mix(in srgb,currentColor 3%,transparent);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:50vh;overflow:auto}
.living-markdown{max-height:50vh;overflow:auto;font-size:13px;line-height:1.7;padding:4px 2px;white-space:pre-wrap}
.living-calendar-week,.living-calendar-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.living-calendar-week{margin:8px 0 4px;font-size:11px;opacity:.65;text-align:center}
.living-calendar-day{position:relative;min-height:38px;border:1px solid color-mix(in srgb,currentColor 10%,transparent);border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.living-calendar-day:hover{background:color-mix(in srgb,currentColor 6%,transparent)}
.living-calendar-day.today{border-color:color-mix(in srgb,currentColor 35%,transparent)}
.living-calendar-day.active{background:color-mix(in srgb,currentColor 12%,transparent);border-color:color-mix(in srgb,currentColor 40%,transparent)}
.living-calendar-day:disabled{opacity:.3;cursor:default}
.living-calendar-dot{position:absolute;bottom:5px;width:5px;height:5px;border-radius:50%;background:#4a7}
.living-calendar-dot.live{background:transparent;border:1px solid #4a7}
.living-calendar-blank{min-height:38px}
.living-diff div{padding:0 2px;border-radius:2px}
.living-diff-add{color:var(--dsw-alias-state-success-primary,#2e7d32);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2e7d32) 8%,transparent)}
.living-diff-del{color:var(--dsw-alias-state-error-primary,#c33);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c33) 8%,transparent)}
.living-diff-hunk{color:var(--dsw-alias-label-tertiary,#888)}
.living-qr{width:220px;padding:8px;background:#fff;border-radius:8px}
.living-gem-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.living-gem-name{font-size:14px;font-weight:600}
.living-sep{height:1px;background:color-mix(in srgb,currentColor 10%,transparent);margin:2px 0}
.living-list{margin:0;padding-left:18px;font-size:12px;line-height:1.7}
`
  document.head.appendChild(style)
}
