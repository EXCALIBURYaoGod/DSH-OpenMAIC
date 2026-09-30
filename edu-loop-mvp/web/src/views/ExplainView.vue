<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import MarkdownView from '@/components/MarkdownView.vue'
import SlidePreview from '@/components/SlidePreview.vue'
import { useCourseStore } from '@/stores/course'
import { useLlmStore } from '@/stores/llm'

const course = useCourseStore()
const llm = useLlmStore()

const selectedId = ref('')
const streamText = ref('')

const selectedLesson = computed(() => course.lessons.find(lesson => lesson.id === selectedId.value) ?? null)
/** 已落库的讲解优先展示；正在流式生成时展示实时文本。 */
const displayText = computed(() => (streamText.value.length > 0 ? streamText.value : selectedLesson.value?.explanation ?? ''))

onMounted(() => {
  if (course.lessons.length > 0 && selectedId.value.length === 0) selectedId.value = course.lessons[0]!.id
})

function select(lessonId: string): void {
  selectedId.value = lessonId
  streamText.value = ''
  course.slideDeck = null
  course.slideTask = 'idle'
}

async function generateSlides(): Promise<void> {
  if (selectedLesson.value === null) return
  await course.generateSlides(selectedLesson.value.id)
  if (course.slideTask === 'error') {
    ElMessage.warning(`幻灯片预览不可用：${course.error || '服务未就绪'}`)
  }
}

async function explain(): Promise<void> {
  if (selectedLesson.value === null) {
    ElMessage.warning('请先选择课次')
    return
  }
  streamText.value = ''
  await course.explainLesson(selectedLesson.value.id, llm.route, text => {
    streamText.value += text
  })
  if (course.error.length > 0) {
    ElMessage.error(course.error)
    return
  }
  ElMessage.success('讲解已生成并持久化到该课次')
  streamText.value = ''
  // 讲解就绪后并行生成幻灯片预览（失败不阻断讲解）。
  await generateSlides()
}
</script>

<template>
  <div class="page">
    <el-empty v-if="course.lessons.length === 0" description="还没有课程，请先完成步骤 1 生成结构化课程" />

    <div v-else class="split">
      <el-card shadow="never" class="list-card">
        <template #header>
          <span class="card-title">课次</span>
        </template>
        <div
          v-for="lesson in course.lessons"
          :key="lesson.id"
          class="lesson-item"
          :class="{ 'is-active': lesson.id === selectedId }"
          @click="select(lesson.id)"
        >
          <div class="lesson-name">{{ lesson.idx + 1 }}. {{ lesson.title }}</div>
          <div class="lesson-state">
            <el-tag v-if="lesson.explanation" size="small" type="success" effect="plain">已生成</el-tag>
            <el-tag v-else size="small" type="info" effect="plain">待生成</el-tag>
          </div>
        </div>
      </el-card>

      <el-card shadow="never" class="detail-card">
        <template #header>
          <div class="card-header">
            <span class="card-title">{{ selectedLesson?.title ?? '请选择课次' }}</span>
            <div class="card-actions">
              <el-button
                :loading="course.slideTask === 'loading'"
                :disabled="selectedLesson === null || course.streaming"
                @click="generateSlides"
              >
                生成幻灯片
              </el-button>
              <el-button
                type="primary"
                :loading="course.streaming"
                :disabled="selectedLesson === null"
                @click="explain"
              >
                {{ selectedLesson?.explanation ? '重新生成讲解' : '生成讲解' }}
              </el-button>
            </div>
          </div>
        </template>

        <div v-if="selectedLesson" class="objective">
          学习目标：{{ selectedLesson.objective }}
          <el-tag v-for="point in selectedLesson.keyPoints" :key="point" size="small" effect="plain" class="point-tag">
            {{ point }}
          </el-tag>
        </div>

        <div v-if="displayText.length > 0" class="explain-body">
          <MarkdownView :source="displayText" />
        </div>
        <el-empty v-else description="点击右上角生成结构化讲解" :image-size="90" />

        <div v-if="selectedLesson" class="slide-panel">
          <el-collapse>
            <el-collapse-item title="幻灯片预览" name="slide">
              <SlidePreview :deck="course.slideDeck" />
            </el-collapse-item>
          </el-collapse>
        </div>

        <div v-if="course.streaming" class="streaming-tip">
          <el-icon class="is-loading"><i class="el-icon-loading" /></el-icon>
          正在流式生成…
        </div>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.split {
  display: grid;
  grid-template-columns: 300px 1fr;
  gap: 14px;
  align-items: start;
}

.card-title {
  font-weight: 600;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.card-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.lesson-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 10px;
  border-radius: 6px;
  cursor: pointer;
}

.lesson-item:hover {
  background: #f5f7fa;
}

.lesson-item.is-active {
  background: #ecf5ff;
}

.lesson-name {
  font-size: 13px;
  line-height: 1.4;
}

.objective {
  font-size: 13px;
  color: #606266;
  padding-bottom: 12px;
  border-bottom: 1px solid #ebeef5;
  margin-bottom: 12px;
}

.point-tag {
  margin-left: 6px;
}

.explain-body {
  max-height: calc(100vh - 300px);
  overflow-y: auto;
  padding-right: 6px;
}

.slide-panel {
  margin-top: 14px;
  border-top: 1px dashed #ebeef5;
  padding-top: 6px;
}

.streaming-tip {
  margin-top: 10px;
  font-size: 12px;
  color: var(--muted);
}
</style>