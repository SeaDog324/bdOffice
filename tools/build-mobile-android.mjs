import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const android = join(root, 'apps/mobile/android'),
  tools = join(root, '.build/android-tools')
const java = process.env.JAVA_HOME
if (!java) throw new Error('Set JAVA_HOME to a JDK 17 installation.')
const sdk = process.env.ANDROID_HOME || join(tools, 'sdk')
const gradle = process.env.BIGDOG_GRADLE_HOME || join(tools, 'gradle/gradle-8.11.1')
const npm = process.env.npm_execpath
if (!npm) throw new Error('Run this builder through npm run mobile:android.')
function run(file, args, env = process.env) {
  const result = spawnSync(file, args, { cwd: root, env, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('Build command failed (' + result.status + ').')
}
run(process.execPath, [npm, 'run', 'build:h5', '-w', '@bigdogoffice/mobile'])
run(process.execPath, [join(root, 'tools/generate-mobile-notices.mjs')])
const assets = resolve(android, 'app/src/main/assets/www')
if (!assets.startsWith(resolve(android) + sep) || !assets.endsWith(sep + 'assets' + sep + 'www'))
  throw new Error('Unsafe generated asset path')
rmSync(assets, { recursive: true, force: true })
mkdirSync(dirname(assets), { recursive: true })
cpSync(join(root, 'apps/mobile/dist/build/h5'), assets, { recursive: true })
cpSync(
  join(root, 'apps/mobile/src/static/THIRD-PARTY-NOTICES.txt'),
  join(assets, 'static/THIRD-PARTY-NOTICES.txt'),
)
const drawable = join(android, 'app/src/main/res/drawable')
mkdirSync(drawable, { recursive: true })
cpSync(join(root, 'apps/mobile/src/static/dog-welcome.png'), join(drawable, 'dog.png'))
writeFileSync(join(android, 'local.properties'), 'sdk.dir=' + sdk.replaceAll('\\', '/') + '\n')
const socketDir = join(root, '.build/java-sockets')
mkdirSync(socketDir, { recursive: true })
const signingDir =
  process.env.BIGDOG_ANDROID_SIGNING_DIR ||
  join(root, '.build', 'android-signing')
mkdirSync(signingDir, { recursive: true })
const signingFile = join(signingDir, 'signing.json')
let signing = existsSync(signingFile) ? JSON.parse(readFileSync(signingFile, 'utf8')) : undefined

if (!signing) {
  signing = {
    path: join(signingDir, 'bigdog-release.jks'),
    alias: 'bigdog-mobile',
    password: randomBytes(32).toString('hex'),
  }
  writeFileSync(signingFile, JSON.stringify(signing), { mode: 0o600 })
}
const env = {
  ...process.env,
  JAVA_HOME: java,
  ANDROID_HOME: sdk,
  JAVA_TOOL_OPTIONS: `-Djdk.net.unixdomain.tmpdir=${socketDir}`,
  BIGDOG_ANDROID_KEYSTORE: signing.path,
  BIGDOG_ANDROID_KEY_ALIAS: signing.alias,
  BIGDOG_ANDROID_STORE_PASSWORD: signing.password,
  BIGDOG_ANDROID_KEY_PASSWORD: signing.password,
  BIGDOG_KEYSTORE_PASSWORD: signing.password,
}
if (!existsSync(signing.path))
  run(
    join(java, 'bin/keytool.exe'),
    [
      '-genkeypair',
      '-keystore',
      signing.path,
      '-storepass:env',
      'BIGDOG_KEYSTORE_PASSWORD',
      '-keypass:env',
      'BIGDOG_KEYSTORE_PASSWORD',
      '-alias',
      signing.alias,
      '-keyalg',
      'RSA',
      '-keysize',
      '3072',
      '-validity',
      '10000',
      '-dname',
      'CN=AI BigDog Mobile,O=BigDogOffice,C=CN',
    ],
    env,
  )
const launcher = readdirSync(join(gradle, 'lib')).find((name) =>
  /^gradle-(?:launcher|gradle-cli-main)-[0-9].*\.jar$/.test(name),
)
if (!launcher) throw new Error('Gradle launcher jar not found')
run(
  join(java, 'bin/java.exe'),
  [
    '-cp',
    join(gradle, 'lib', launcher),
    'org.gradle.launcher.GradleMain',
    '-p',
    android,
    ':app:assembleRelease',
    ':app:assembleDebug',
    '--no-daemon',
    '--console=plain',
  ],
  env,
)
const apk = join(android, 'app/build/outputs/apk/release/app-release.apk')
const output = join(root, '.build/mobile-release')
mkdirSync(output, { recursive: true })
const version = JSON.parse(readFileSync(join(root, 'apps/mobile/package.json'), 'utf8')).version
const target = join(output, `AI-BigDog-${version}-android.apk`)
cpSync(apk, target)
const receipt = {
  apk: target,
  sha256: createHash('sha256').update(readFileSync(target)).digest('hex'),
  signed: true,
  buildType: 'release',
  package: 'office.bigdog.mobile',
  version,
}
writeFileSync(join(output, 'build.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify(receipt))
