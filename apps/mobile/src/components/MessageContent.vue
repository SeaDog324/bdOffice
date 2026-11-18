<script setup>
import { computed } from 'vue'
import { parseMessageMarkdown } from '../lib/message-markdown.mjs'
const props = defineProps({ text: { type: String, default: '' } })
const parsed = computed(() => {
  try {
    return parseMessageMarkdown(props.text)
  } catch {
    // Formatting must never hide the underlying reply on a device runtime.
    let end = Math.min(props.text.length, 100000)
    if (end < props.text.length && /[\uD800-\uDBFF]/.test(props.text[end - 1])) end--
    return {
      blocks: [
        {
          kind: 'paragraph',
          spans: [{ kind: 'text', bold: false, text: props.text.slice(0, end) }],
        },
      ],
      truncated: end < props.text.length,
    }
  }
})
</script>

<template>
  <view class="message-content">
    <template v-for="(block, index) in parsed.blocks" :key="index">
      <view v-if="block.kind === 'code'" class="md-code-block">
        <text v-if="block.language" class="md-code-language">{{ block.language }}</text>
        <scroll-view scroll-x class="md-code-scroll"
          ><text class="md-code-body" selectable>{{ block.text }}</text></scroll-view
        >
      </view>
      <scroll-view v-else-if="block.kind === 'table'" scroll-x class="md-table-scroll">
        <view class="md-table">
          <view class="md-table-row md-table-header">
            <view v-for="(cell, cellIndex) in block.headers" :key="cellIndex" class="md-table-cell">
              <text
                v-for="(span, spanIndex) in cell"
                :key="spanIndex"
                :class="{ 'md-strong': span.bold, 'md-inline-code': span.kind === 'code' }"
                selectable
                >{{ span.text }}</text
              >
            </view>
          </view>
          <view v-for="(row, rowIndex) in block.rows" :key="rowIndex" class="md-table-row">
            <view v-for="(cell, cellIndex) in row" :key="cellIndex" class="md-table-cell">
              <text
                v-for="(span, spanIndex) in cell"
                :key="spanIndex"
                :class="{ 'md-strong': span.bold, 'md-inline-code': span.kind === 'code' }"
                selectable
                >{{ span.text }}</text
              >
            </view>
          </view>
        </view>
      </scroll-view>
      <view v-else-if="block.kind === 'list'" class="md-list">
        <view v-for="(item, itemIndex) in block.items" :key="itemIndex" class="md-list-row">
          <text class="md-marker">{{ item.marker }}</text>
          <view class="md-list-copy"
            ><text
              v-for="(span, spanIndex) in item.spans"
              :key="spanIndex"
              :class="{ 'md-strong': span.bold, 'md-inline-code': span.kind === 'code' }"
              selectable
              >{{ span.text }}</text
            ></view
          >
        </view>
      </view>
      <view
        v-else
        class="md-paragraph"
        :class="block.kind === 'heading' ? 'md-heading md-level-' + block.level : ''"
      >
        <text
          v-for="(span, spanIndex) in block.spans"
          :key="spanIndex"
          :class="{ 'md-strong': span.bold, 'md-inline-code': span.kind === 'code' }"
          selectable
          >{{ span.text }}</text
        >
      </view>
    </template>
    <text v-if="parsed.truncated" class="md-truncated"
      >内容较长，当前显示部分内容。完整记录可在电脑查看。</text
    >
  </view>
</template>

<style scoped>
.message-content {
  min-width: 0;
  white-space: normal;
}
.md-paragraph,
.md-list {
  margin: 0 0 10px;
}
.md-paragraph:last-child,
.md-list:last-child {
  margin-bottom: 0;
}
.md-paragraph,
.md-list-copy {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.md-heading {
  font-weight: 700;
  margin-top: 12px;
  line-height: 1.5;
}
.md-heading:first-child {
  margin-top: 0;
}
.md-level-1 {
  font-size: 21px;
}
.md-level-2 {
  font-size: 19px;
}
.md-level-3 {
  font-size: 17px;
}
.md-strong {
  font-weight: 700;
}
.md-inline-code {
  font-family: monospace;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--hover);
  color: var(--text-muted);
}
.md-list-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 4px;
}
.md-marker {
  min-width: 13px;
  flex-shrink: 0;
  color: var(--text-faint);
}
.md-list-copy {
  flex: 1;
  min-width: 0;
}
.md-code-block {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  margin: 10px 0;
  overflow: hidden;
}
.md-code-language {
  display: block;
  padding: 6px 10px;
  font-size: 10px;
  color: var(--text-faint);
  border-bottom: 1px solid var(--border);
}
.md-code-scroll {
  width: 100%;
}
.md-code-body {
  display: block;
  width: max-content;
  min-width: 100%;
  padding: 10px;
  font-family: monospace;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre;
}
.md-truncated {
  display: block;
  font-size: 11px;
  color: var(--warning);
  line-height: 1.7;
  margin-top: 8px;
}
.md-table-scroll {
  width: 100%;
  margin: 10px 0;
}
.md-table {
  display: table;
  border-collapse: collapse;
  min-width: 100%;
  font-size: 13px;
}
.md-table-row {
  display: table-row;
}
.md-table-header {
  background: var(--accent-soft);
  font-weight: 650;
}
.md-table-cell {
  display: table-cell;
  border: 1px solid var(--border);
  padding: 8px 10px;
  min-width: 90px;
  max-width: 300px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
