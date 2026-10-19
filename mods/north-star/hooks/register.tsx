import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Progress } from '../types'
import { renderBand } from './render.mjs'

const progress = atom({ plugin: 'north-star', key: 'progress' } as const, null)

// The band's numbers come from scripts/north-star.mjs (board files only, no network). The mod
// shells out to it in the session's directory; DEN_ROOT (or the old ORGANISM_ROOT), when set, points it at the main checkout.
async function refresh($: any) {
  try {
    const root = (await $.env.get('DEN_ROOT')) || (await $.env.get('ORGANISM_ROOT'))
    const r = await $.process.run(['node', 'scripts/north-star.mjs', '--json'], root ? { env: { DEN_ROOT: root } } : undefined)
    if (r.exitCode === 0) await update($, progress, () => JSON.parse(r.stdout) as Progress)
  } catch {
    // keep the last reading
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
    const p = await read($, progress)
    const text = p ? renderBand(p) : ''
    if (!text) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor>{text}</Text>
      </Box>
    )
  })
}
