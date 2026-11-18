<script setup>
import { computed, ref } from 'vue'
import AppIcon from './AppIcon.vue'
const props = defineProps({
  sessions: Array,
  selectedId: String,
  hostName: String,
  online: Boolean,
  busy: Boolean,
})
defineEmits(['open', 'new', 'settings', 'refresh', 'close'])
const query = ref(''),
  filter = ref('all')
function clearFilters() {
  query.value = ''
  filter.value = 'all'
}
const attentionCount = computed(() => props.sessions.filter((s) => s.attention).length)
const groups = computed(() => {
  const now = new Date(),
    today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const result = new Map()
  const matches = props.sessions.filter(
    (s) =>
      (filter.value !== 'attention' || s.attention) &&
      (filter.value !== 'file' || s.kind === 'file') &&
      `${s.title || ''} ${s.preview || ''}`
        .toLocaleLowerCase()
        .includes(query.value.trim().toLocaleLowerCase()),
  )
  for (const session of matches) {
    const stamp = Date.parse(session.updatedAt || session.createdAt || '')
    const label =
      stamp >= today
        ? '今天'
        : stamp >= today - 86400000
          ? '昨天'
          : stamp >= today - 86400000 * 7
            ? '最近 7 天'
            : '更早'
    if (!result.has(label)) result.set(label, [])
    result.get(label).push(session)
  }
  return ['今天', '昨天', '最近 7 天', '更早']
    .filter((label) => result.has(label))
    .map((label) => ({ label, sessions: result.get(label) }))
})
</script>

<template>
  <view class="drawer-content">
    <view class="drawer-brand">
      <image src="/static/dog-welcome.png" mode="aspectFit" class="drawer-dog" />
      <text class="drawer-name">AI 大狗</text>
      <button class="icon-button drawer-close" aria-label="关闭对话列表" @click="$emit('close')">
        <AppIcon name="close" />
      </button>
      <button class="primary new-chat" :disabled="busy" @click="$emit('new')">
        <AppIcon name="new" /><text>新对话</text>
      </button>
    </view>
    <view class="drawer-search"
      ><AppIcon name="search" /><input
        v-model="query"
        placeholder="搜索对话"
        aria-label="搜索对话标题与摘要"
        :maxlength="100"
      /><button v-if="query" class="clear-search" aria-label="清除搜索" @click="query = ''">
        ×
      </button></view
    >
    <view class="drawer-heading"
      ><AppIcon name="chat" /><text>全部对话</text
      ><button class="icon-button" aria-label="刷新对话" @click="$emit('refresh')">
        <AppIcon name="refresh" /></button
    ></view>
    <view class="drawer-filters" role="group" aria-label="筛选对话">
      <button :class="{ active: filter === 'all' }" @click="filter = 'all'">全部</button>
      <button :class="{ active: filter === 'attention' }" @click="filter = 'attention'">
        待确认 <text v-if="attentionCount">{{ attentionCount }}</text>
      </button>
      <button :class="{ active: filter === 'file' }" @click="filter = 'file'">文件对话</button>
    </view>
    <scroll-view scroll-y class="drawer-list">
      <view v-if="!groups.length" class="drawer-empty"
        ><text>{{ query || filter !== 'all' ? '没有匹配的对话' : '还没有对话，开始聊聊吧' }}</text
        ><button v-if="query || filter !== 'all'" class="quiet-button" @click="clearFilters">
          显示全部对话
        </button></view
      >
      <view v-for="group in groups" :key="group.label" class="session-group">
        <text class="group-label">{{ group.label }}</text>
        <button
          v-for="session in group.sessions"
          :key="session.id"
          class="session-row"
          :class="{ current: session.id === selectedId }"
          @click="$emit('open', session)"
        >
          <view class="session-row-copy"
            ><text class="session-title">{{ session.title || '新对话' }}</text
            ><text v-if="session.kind === 'file'" class="muted">文件对话 · 只读</text></view
          >
          <text v-if="session.attention" class="attention-label">待确认</text>
        </button>
      </view>
    </scroll-view>
    <view class="drawer-identity"
      ><button class="host-button" @click="$emit('settings')">
        <view class="host-icon"><AppIcon name="computer" /></view
        ><view class="session-copy"
          ><text class="session-title">{{ hostName }}</text
          ><text class="muted"
            ><text class="status-dot" :class="{ online }" />{{
              online ? '已连接' : '等待电脑上线'
            }}</text
          ></view
        ></button
      ><button class="icon-button glass" aria-label="设置" @click="$emit('settings')">
        <AppIcon name="settings" /></button
    ></view>
  </view>
</template>
