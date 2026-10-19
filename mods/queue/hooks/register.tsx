import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Queue } from '../types'
import { renderBand } from './render.mjs'

const queue = atom({ plugin: 'queue', key: 'queue' } as const, null)

// The band's data comes from scripts/queue.mjs (board files only, no network). The mod shells out to
// it in the session's directory; DEN_ROOT (or the old ORGANISM_ROOT), when set, points it at the main checkout. A failing
// script clears the band: it renders nothing rather than a stale or broken line.
async function refresh($: any) {
  try {
    const root = (await $.env.get('DEN_ROOT')) || (await $.env.get('ORGANISM_ROOT'))
    const r = await $.process.run(['node', 'scripts/queue.mjs', '--json'], root ? { env: { DEN_ROOT: root } } : undefined)
    const next = r.exitCode === 0 ? (JSON.parse(r.stdout) as Queue) : null
    await update($, queue, () => next)
  } catch {
    await update($, queue, () => null).catch(() => {})
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await refresh($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await refresh($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const q = await read($, queue)
    const text = q ? renderBand(q) : ''
    if (!text) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {text.split('\n').map((line, i) => (
          <Text key={i} dimColor>{line}</Text>
        ))}
      </Box>
    )
  })
}
