import { createSSRApp } from 'vue'
import App from './App.vue'
import { installNativeNetwork } from './lib/native-network.mjs'
installNativeNetwork()

export function createApp() {
  return { app: createSSRApp(App) }
}
