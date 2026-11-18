<script setup>
import AppIcon from './AppIcon.vue'
defineProps({ title: String })
defineEmits(['close'])
</script>
<template>
  <view class="sheet-overlay" @click.self="$emit('close')">
    <view class="sheet" role="dialog" aria-modal="true" :aria-label="title">
      <view class="sheet-handle" />
      <view class="sheet-header"
        ><text class="section-title">{{ title }}</text
        ><button class="icon-button glass" aria-label="关闭" @click="$emit('close')">
          <AppIcon name="close" /></button
      ></view>
      <scroll-view scroll-y class="sheet-scroll"><slot /></scroll-view>
    </view>
  </view>
</template>
