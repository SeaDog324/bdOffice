import {
  readFileSync,
  writeFileSync,
  existsSync,
  realpathSync,
  mkdirSync,
  readdirSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { licenseText } from './license-text.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const seen = new Set(),
  sections = [],
  missing = []
function visit(directory) {
  directory = realpathSync(directory)
  if (seen.has(directory)) return
  seen.add(directory)
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const extended = readdirSync(directory)
    .filter((file) => /^(LICENSE|LICENCE|COPYING)[-_.]/i.test(file))
    .map((file) => readFileSync(join(directory, file), 'utf8'))
    .join('\n')
  const text =
    licenseText(pkg.name, directory) ||
    extended ||
    (directory.startsWith(join(root, 'packages')) && pkg.license === 'Apache-2.0'
      ? readFileSync(join(root, 'LICENSE'), 'utf8')
      : null)
  if (!text) missing.push(pkg.name)
  sections.push(
    `${pkg.name} ${pkg.version} (${pkg.license || 'see license'})\n${text || pkg.repository?.url || pkg.homepage || ''}`,
  )
}
const modules = JSON.parse(readFileSync(join(root, '.build/mobile-notice-modules.json'), 'utf8'))
for (const id of modules) {
  if (!id.includes('/node_modules/') && !id.includes('/packages/remote-')) continue
  let directory = dirname(id.replaceAll('\\', '/').split('?')[0])
  if (!existsSync(directory)) continue
  while (
    directory !== dirname(directory) &&
    (!existsSync(join(directory, 'package.json')) ||
      !JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name)
  )
    directory = dirname(directory)
  if (existsSync(join(directory, 'package.json'))) visit(directory)
}
const native =
  'Android libraries: org.unifiedpush.android:connector:3.3.5 (Copyright 2021 Simon Gougeon); OkHttp 4.12.0 / Okio (Square); Kotlin (JetBrains); AndroidX (Android Open Source Project); ZXing Android Embedded 4.3.0 (Journey Mobile) and ZXing Core 3.4.1 (ZXing authors), https://github.com/journeyapps/zxing-android-embedded and https://github.com/zxing/zxing. Apache-2.0.\n' +
  readFileSync(join(root, 'LICENSE'), 'utf8')
sections.push(
  'UI design reference: dsh-Go, https://github.com/ccch1mneyyy/dsh-Go, commit 1c5b220093295f8d069f6bfb06d8b4fc97b9e9c2. Navigation and visual conventions were implemented independently in uni-app for BigDog. No Flutter/Dart application source, golden screenshots or upstream brand artwork is bundled. See apps/mobile/UI-PROVENANCE.md. The dsh-Go Flutter application uses AGPL-3.0; the separately reused MIT TypeScript transport is documented in packages/remote-core/UPSTREAM.md.',
  native,
  readFileSync(join(root, 'apps/mobile/licenses/WEBRTC-SDK.txt'), 'utf8'),
  readFileSync(join(root, 'apps/mobile/licenses/WEBRTC.md'), 'utf8'),
)
const output = join(root, 'apps/mobile/src/static/THIRD-PARTY-NOTICES.txt')
mkdirSync(dirname(output), { recursive: true })
writeFileSync(
  output,
  'AI 大狗 — Third-party notices\nIncludes packages present in the bundled uni-app JavaScript module graph and native Android libraries.\n\n' +
    sections.join('\n\n' + '='.repeat(70) + '\n\n'),
)
console.log(JSON.stringify({ packages: seen.size, missingLicenseFiles: missing }))
