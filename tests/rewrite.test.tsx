import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ORIGINAL =
  '这个改动吃掉了缓存命中率预算，所以我顺手 footnote 了一下相关的会话状态同步重试逻辑。另外这次修复把旧的超时兜底整个吞掉了，读者耐心预算会更紧。'
const BY_SONNET = '这个改动让缓存命中率下降了。（Sonnet）'
const BY_HAIKU = '缓存命中率下降了。（Haiku）'

const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

function engine(on: On, answer?: (model: string, calls: number) => unknown) {
  const asks: { model: string; prompt: string }[] = []
  const efforts: unknown[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'readable' } }))
  on('command.run', () => ({ text: '' }))
  on('model.complete', (_, e) => {
    asks.push({ model: e.model, prompt: String(e.prompt) })
    efforts.push(e.effort)
    const custom = answer?.(e.model, asks.length)
    if (custom) return { value: custom }
    return { value: { isAnswered: true, text: e.model.includes('haiku') ? BY_HAIKU : BY_SONNET, usage } }
  })
  // Stands for the engine's own drawing of a reply block.
  on('ui.render', ($, e) => {
    const { Markdown } = $.ui.resolve(e)
    return <Markdown text={(e.props as { text: string }).text} />
  })
  return { asks, efforts, clock: mock.clock(on), session: mock.session(on) }
}

function reply(uuid: string, text = ORIGINAL, agentId?: string) {
  return {
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
    door: 'response',
    origin: { kind: 'model', model: 'claude-opus-5-5' },
    uuid,
    ...(agentId ? { agentId } : {}),
  } as never
}

function block(surface: 'desktop' | 'terminal', requestId: string) {
  return {
    plugin: 'readable-rewrite',
    surface,
    component: 'AssistantMessage',
    requestId,
    props: { text: ORIGINAL, isFirstOfReply: true },
  } as never
}

type Drawing = { find: (q: { type: string; text: string }) => Promise<unknown>; press: (q: { key: string }) => Promise<void> }
async function press(ui: Drawing, label: string) {
  const button = (await ui.find({ type: 'Button', text: label })) as { key: string }
  await ui.press({ key: button.key })
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`three buttons; each model rewrites only when asked (${surface})`, async ($, on) => {
    const { asks, clock, session } = engine(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.session.append(reply('row-1'))
    await clock.settle()
    expect(asks).toEqual([])

    const ui = await $.ui.mount(block(surface, 'row-1'))
    expect((await ui.find({ type: 'Markdown' }))?.text).toContain(ORIGINAL)
    expect(JSON.stringify(await ui.find({ type: 'Button', text: '原文' }))).toContain('primary')

    await press(ui, 'Sonnet 5.5 改写')
    await clock.settle()
    expect((await ui.find({ type: 'Markdown' }))?.text).toContain(BY_SONNET)

    await press(ui, 'Haiku 5.5 改写')
    await clock.settle()
    expect((await ui.find({ type: 'Markdown' }))?.text).toContain(BY_HAIKU)
    expect(asks.map(a => a.model)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5'])

    // Back and forth: cached, no new calls.
    await press(ui, '原文')
    expect((await ui.find({ type: 'Markdown' }))?.text).toContain(ORIGINAL)
    await press(ui, 'Sonnet 5.5 改写')
    await clock.settle()
    expect((await ui.find({ type: 'Markdown' }))?.text).toContain(BY_SONNET)
    expect(asks.length).toBe(2)
    await ui.unmount()

    // The stored row — what the model reads next turn — is the original.
    const stored = JSON.stringify(session.appended())
    expect(stored).toContain(ORIGINAL)
    expect(stored).not.toContain(BY_SONNET)
    expect(stored).not.toContain(BY_HAIKU)
  })
}

test('/readable haiku rewrites each new main-thread reply up front', async ($, on) => {
  const { asks, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'readable', args: 'haiku' } as never)
  await $.session.append(reply('row-a'))
  await $.session.append(reply('row-short', '好的。'))
  await $.session.append(reply('row-sub', ORIGINAL + '子代理', 'a1'))
  await clock.settle()
  expect(asks).toEqual([{ model: 'claude-haiku-5-5', prompt: ORIGINAL }])

  const ui = await $.ui.mount(block('desktop', 'row-a'))
  expect((await ui.find({ type: 'Markdown' }))?.text).toContain(BY_HAIKU)
  await ui.unmount()
})

test('a failed rewrite shows its reason; pressing again retries', async ($, on) => {
  const { clock } = engine(on, (_, calls) =>
    calls === 1 ? { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage } : undefined,
  )
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.append(reply('row-f'))
  const ui = await $.ui.mount(block('desktop', 'row-f'))
  await press(ui, 'Sonnet 5.5 改写')
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /529/ }))?.text).toContain('overloaded')

  await press(ui, 'Sonnet 5.5 改写')
  await clock.settle()
  expect((await ui.find({ type: 'Markdown' }))?.text).toContain(BY_SONNET)
  await ui.unmount()
})

test('a reply stored before the mod loaded still gets the buttons', async ($, on) => {
  const { asks, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(block('desktop', 'row-unseen'))
  expect((await ui.find({ type: 'Markdown' }))?.text).toContain(ORIGINAL)
  await press(ui, 'Haiku 5.5 改写')
  await clock.settle()
  expect(asks).toEqual([{ model: 'claude-haiku-5-5', prompt: ORIGINAL }])
  expect((await ui.find({ type: 'Markdown' }))?.text).toContain(BY_HAIKU)
  await ui.unmount()
})

test('a short reply gets no buttons', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({
    plugin: 'readable-rewrite',
    surface: 'desktop',
    component: 'AssistantMessage',
    requestId: 'row-tiny',
    props: { text: '好的。', isFirstOfReply: true },
  } as never)
  expect(await ui.find({ type: 'Button', text: '原文' })).toBeFalsy()
  await ui.unmount()
})

test('rewrites ask for low effort and show how long they took', async ($, on) => {
  const { clock, efforts } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(block('desktop', 'row-t'))
  await press(ui, 'Haiku 5.5 改写')
  await clock.settle()
  expect(efforts).toEqual(['low'])
  expect(await ui.find({ type: 'Text', text: /Haiku 5\.5 改写 · \d+\.\d 秒/ })).toBeTruthy()
  await ui.unmount()
})
