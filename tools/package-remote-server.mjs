import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.env.npm_execpath
if (!npm) throw new Error('Run through npm run remote:package')
const result = spawnSync(
  process.execPath,
  [npm, 'run', 'build', '-w', '@bigdogoffice/remote-server'],
  { cwd: root, stdio: 'inherit', windowsHide: true },
)
if (result.status !== 0) process.exit(result.status || 1)
const output = join(root, 'apps/remote-server/dist')
mkdirSync(output, { recursive: true })
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')),
  ws = lock.packages['node_modules/ws']
const pkg = {
  name: 'bigdog-remote-runtime',
  version: JSON.parse(readFileSync(join(root, 'apps/remote-server/package.json'), 'utf8')).version,
  private: true,
  type: 'module',
  dependencies: { ws: ws.version },
}
writeFileSync(join(output, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
writeFileSync(
  join(output, 'package-lock.json'),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies },
        'node_modules/ws': ws,
      },
    },
    null,
    2,
  ) + '\n',
)
cpSync(join(root, 'apps/remote-server/LICENSE'), join(output, 'LICENSE'))
cpSync(join(root, 'apps/remote-server/RUNTIME.md'), join(output, 'README.md'))
writeFileSync(
  join(output, 'THIRD-PARTY-NOTICES.txt'),
  [
    'Pinned ds-harness-remote MIT source; local BigDog courier and integration additions. See repository packages/remote-core/UPSTREAM.md.',
    readFileSync(join(root, 'apps/remote-server/LICENSE'), 'utf8'),
    readFileSync(join(root, 'node_modules/zod/LICENSE'), 'utf8'),
    readFileSync(join(root, 'node_modules/ws/LICENSE'), 'utf8'),
  ].join('\n\n'),
)
cpSync(join(root, 'apps/remote-server/public'), join(output, 'public'), { recursive: true })
console.log('Packaged self-hosted Remote server with locked runtime dependency.')
