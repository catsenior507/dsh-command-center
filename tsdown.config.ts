/**
 * Two halves: the host plugin, and the browser bundle the harness loads through
 * its module table.
 */
import { clientBundle } from './build/tsdown.client.ts'

export default clientBundle('@dsh-external/dsh-client-plugin-command-center', ['src/index.ts'], {
  clientEntry: 'src/client/index.tsx',
})
