<script setup>
import { computed } from 'vue'
const props = defineProps({ name: { type: String, default: 'chat' } })
// Small local line icons; no upstream logos or icon font is bundled.
const paths = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  back: '<path d="m12 5-7 7 7 7M5 12h15"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  new: '<path d="M12 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M15 3l6 6M10 14l-1 4 4-1L22 8l-5-5Z"/>',
  search: '<circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6"/>',
  chat: '<path d="M4 4h16v12H9l-5 4Z"/>',
  computer: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  settings:
    '<path d="m9 3-1 3-3 1-2 4 2 2v4l4 2 3-1 3 1 4-2v-4l2-2-2-4-3-1-1-3Z"/><circle cx="12" cy="11" r="3"/>',
  file: '<path d="M13 3H5v18h14V9ZM13 3v6h6M8 13h8M8 17h6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m5 9 7 7 7-7"/>',
  send: '<path d="M12 20V4m-7 7 7-7 7 7"/>',
  refresh: '<path d="M20 7a9 9 0 1 0 1 8M20 3v5h-5"/>',
  tasks: '<path d="m3 6 2 2 4-4m-6 9 2 2 4-4M12 6h9M12 13h9M4 20h17"/>',
  scan: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M7 7h3v3H7Zm7 0h3v3h-3ZM7 14h3v3H7Zm7 0h3v3h-3Z"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 5 5 3-3 4 4"/>',
  bell: '<path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5ZM9 21h6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
  inbox: '<path d="M4 5h16l2 14H2ZM3 13h6l1 3h4l1-3h6"/>',
}
const mask = computed(
  () =>
    `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[props.name] || paths.chat}</svg>`)}")`,
)
</script>

<template>
  <view class="app-icon" :style="{ maskImage: mask, WebkitMaskImage: mask }" aria-hidden="true" />
</template>

<style scoped>
.app-icon {
  width: 22px;
  height: 22px;
  display: inline-block;
  flex: 0 0 auto;
  background: currentColor;
  mask-size: contain;
  mask-repeat: no-repeat;
  -webkit-mask-size: contain;
  -webkit-mask-repeat: no-repeat;
}
</style>
