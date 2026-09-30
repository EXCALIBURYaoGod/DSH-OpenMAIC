<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '@/utils/markdown'

const props = defineProps<{ source: string }>()

const html = computed(() => renderMarkdown(props.source))
</script>

<template>
  <!-- 内容已在 renderMarkdown 中做 HTML 转义，只放行白名单语法 -->
  <div class="markdown-body" v-html="html" />
</template>