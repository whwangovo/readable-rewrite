import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entry, Rewrite, Rewriter, Rewrites, View } from '../types'
import { RUBRIC } from './rubric'

const MODELS: Record<Rewriter, { id: string; label: string; color: string }> = {
  sonnet: { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', color: 'suggestion' },
  haiku: { id: 'claude-haiku-5-5', label: 'Haiku 5.5', color: 'merged' },
}
const REWRITERS = Object.keys(MODELS) as Rewriter[]
/** Blocks shorter than this are shown as written. */
const MIN_CHARS = 60
const KEEP = 400

const modeAtom = atom({ plugin: 'readable-rewrite', key: 'mode' } as const, 'original' as View, {
  shape: 'mode-2',
})
const rewritesAtom = atom(
  { plugin: 'readable-rewrite', key: 'rewrites' } as const,
  { entries: {}, byRow: {}, order: [] } as Rewrites,
  { shape: 'rewrites-2' },
)

async function hashOf(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text.trim())
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest).slice(0, 12), b => b.toString(16).padStart(2, '0')).join('')
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n\n')
}

function setEntry(r: Rewrites, hash: string, entry: Entry): Rewrites {
  const entries = { ...r.entries, [hash]: entry }
  let order = r.order.includes(hash) ? r.order : [...r.order, hash]
  let byRow = r.byRow
  if (order.length > KEEP) {
    const dropped = new Set(order.slice(0, order.length - KEEP))
    order = order.slice(-KEEP)
    for (const h of dropped) delete entries[h]
    byRow = Object.fromEntries(Object.entries(byRow).filter(([, h]) => !dropped.has(h)))
  }
  return { entries, byRow, order }
}

function setRewrite(r: Rewrites, hash: string, model: Rewriter, rewrite: Rewrite): Rewrites {
  const one = r.entries[hash]
  return one ? setEntry(r, hash, { ...one, [model]: rewrite }) : r
}

async function attempt($: EngineInterface, model: Rewriter, original: string): Promise<Rewrite & { isAborted?: boolean }> {
  try {
    const r = await $.model.complete({
      model: MODELS[model].id,
      system: RUBRIC,
      prompt: original,
      maxTokens: Math.min(16000, Math.max(1024, original.length * 3)),
      timeoutMs: 180_000,
      // Rewriting needs no deep thinking; low effort keeps the wait short.
      effort: 'low',
    })
    if (r.isAnswered) {
      const text = r.text.trim()
      return text ? { status: 'done', text } : { status: 'failed', error: '模型返回空文本' }
    }
    if (r.reason === 'api-error') return { status: 'failed', error: `API 错误 ${r.status ?? '无响应'} ${r.error}` }
    if (r.reason === 'aborted') return { status: 'failed', error: '请求被中断或超时', isAborted: true }
    return { status: 'failed', error: r.reason }
  } catch (err) {
    return { status: 'failed', error: `请求被拒绝：${err instanceof Error ? err.message : String(err)}` }
  }
}

async function rewrite($: EngineInterface, hash: string, model: Rewriter, original: string) {
  const startedAt = Date.now()
  let result = await attempt($, model, original)
  if (result.isAborted) result = await attempt($, model, original)
  const { isAborted: _, ...done } = result
  const ms = Date.now() - startedAt
  await update($, rewritesAtom, cur => setRewrite(cur, hash, model, { ...done, ms }))
}

/** Starts a model's rewrite unless it is done or under way. */
async function ensureRewrite($: EngineInterface, hash: string, model: Rewriter) {
  let source: string | undefined
  await update($, rewritesAtom, cur => {
    const one = cur.entries[hash]
    const status = one?.[model]?.status
    if (!one || status === 'pending' || status === 'done') return cur
    source = one.source
    return setRewrite(cur, hash, model, { status: 'pending' })
  })
  if (source) await rewrite($, hash, model, source)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'readable',
      description: 'Rewritten replies: /readable off (rewrite on request, default) | sonnet | haiku (rewrite every reply)',
    })
    // A reload drops calls in flight: offer a retry for whatever was still pending.
    await update($, rewritesAtom, cur => {
      let out = cur
      for (const [hash, one] of Object.entries(cur.entries))
        for (const model of REWRITERS)
          if (one[model]?.status === 'pending')
            out = setRewrite(out, hash, model, { status: 'failed', error: 'mod 重新加载，请求中断' })
      return out
    })
    return next(e)
  })

  on('command.run', { command: 'readable' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const picked: View | undefined =
      arg === 'off' ? 'original' : arg === 'on' || arg === 'sonnet' ? 'sonnet' : arg === 'haiku' ? 'haiku' : undefined
    if (!picked) {
      const cur = await read($, modeAtom)
      return {
        text: `当前：${cur === 'original' ? '默认显示原文，点按钮才改写' : `每条回复自动用 ${MODELS[cur].label} 改写`}。用法：/readable off | sonnet | haiku`,
      }
    }
    await update($, modeAtom, () => picked)
    return {
      text:
        picked === 'original'
          ? '默认显示原文，点按钮才改写。'
          : `之后的每条回复都会自动用 ${MODELS[picked].label} 改写，默认显示改写版。`,
    }
  })

  // Observe the model's reply rows as they are stored; the row itself goes on
  // unchanged, so the model's context keeps the original.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId || e.message.type !== 'assistant') return stored
    const original = textOf(e.message.content)
    if (original.trim().length < MIN_CHARS) return stored

    const hash = await hashOf(original)
    const mode = await read($, modeAtom)
    const auto = mode === 'original' ? undefined : mode
    let isNew = false
    await update($, rewritesAtom, cur => {
      isNew = !cur.entries[hash]
      const withRow = { ...cur, byRow: { ...cur.byRow, [e.uuid]: hash } }
      if (!isNew) return withRow
      const entry: Entry = { source: original, ...(auto ? { [auto]: { status: 'pending' } } : {}) }
      return setEntry(withRow, hash, entry)
    })
    if (isNew && auto) void rewrite($, hash, auto, original)
    return stored
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary) return next(e)
    const rewrites = await read($, rewritesAtom)
    const hash = rewrites.byRow[e.requestId] ?? (await hashOf(e.props.text))
    // A reply stored before the mod loaded (or before a reload reset its
    // cache) has no entry yet: offer the buttons anyway, from its drawn text.
    const entry: Entry | undefined =
      rewrites.entries[hash] ?? (e.props.text.trim().length >= MIN_CHARS ? { source: e.props.text } : undefined)
    if (!entry) return next(e)

    const mode = await read($, modeAtom)
    const { Box, Text, Button } = $.ui.resolve(e)
    const view: View = entry.view ?? mode
    const shown = view === 'original' ? undefined : entry[view]

    const show = (pick: View) => async () => {
      await update($, rewritesAtom, cur => {
        const one = cur.entries[hash] ?? { source: entry.source }
        return setEntry({ ...cur, byRow: { ...cur.byRow, [e.requestId]: hash } }, hash, { ...one, view: pick })
      })
      if (pick !== 'original') $.clock.after(0, () => void ensureRewrite($, hash, pick))
    }
    const status =
      view !== 'original' && shown?.status === 'pending' ? (
        <Text size="caption" color="subtle">
          {MODELS[view].label} 改写中…
        </Text>
      ) : view !== 'original' && shown?.status === 'failed' ? (
        <Text size="caption" color="warning">
          {MODELS[view].label} 改写失败（{shown.error ?? '未知原因'}），再点一次重试
        </Text>
      ) : null
    const switcher = (
      <Box flexDirection="row" gap={1} marginTop={1} alignItems="center">
        <Button
          key={`show-original-${hash}`}
          label="原文"
          variant={view === 'original' ? 'primary' : 'secondary'}
          onPress={show('original')}
        />
        {REWRITERS.map(model => (
          <Button
            key={`show-${model}-${hash}`}
            label={`${MODELS[model].label} 改写`}
            variant={view === model ? 'primary' : 'secondary'}
            onPress={show(model)}
          />
        ))}
        {status}
      </Box>
    )

    if (view === 'original' || shown?.status !== 'done' || !shown.text) {
      return (
        <Box flexDirection="column">
          {await next(e)}
          {switcher}
        </Box>
      )
    }
    const drawn = await next({ ...e, props: { ...e.props, text: shown.text } })
    return (
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="round" borderColor={MODELS[view].color} paddingX={1}>
          <Text size="caption" color={MODELS[view].color}>
            {MODELS[view].label} 改写{shown.ms === undefined ? '' : ` · ${(shown.ms / 1000).toFixed(1)} 秒`}
          </Text>
          {drawn}
        </Box>
        {switcher}
      </Box>
    )
  })
}
