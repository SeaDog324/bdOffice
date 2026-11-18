import { defineConfig } from 'vite'
import uni from '@dcloudio/vite-plugin-uni'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [
    uni(),
    {
      name: 'bigdog-runtime-notices',
      generateBundle(_options, bundle) {
        const modules = [
          ...new Set(
            Object.values(bundle)
              .filter((item) => item.type === 'chunk')
              .flatMap((item) => Object.keys(item.modules)),
          ),
        ]
        const output = resolve('../../.build/mobile-notice-modules.json')
        mkdirSync(resolve('../../.build'), { recursive: true })
        writeFileSync(output, JSON.stringify(modules))
      },
    },
  ],
  server: { host: '127.0.0.1', port: 5179 },
})
