<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useCourseStore } from '@/stores/course'
import { useLlmStore } from '@/stores/llm'

const course = useCourseStore()
const llm = useLlmStore()
const router = useRouter()

const topic = ref('光合作用')
const material = ref('面向初中生物，40 分钟一节课。')
const streamText = ref('')
const courseId = ref('')
const degraded = ref(false)

async function generate(): Promise<void> {
  if (topic.value.trim().length === 0) {
    ElMessage.warning('请先输入课程主题')
    return
  }
  streamText.value = ''
  courseId.value = ''
  const created = await course.createCourse({
    topic: topic.value.trim(),
    material: material.value.trim(),
    route: llm.route,
    onDelta: text => {
      streamText.value += text
    },
    onMeta: meta => {
      courseId.value = meta.courseId
      degraded.value = meta.degraded
    },
  })
  if (created === null) {
    ElMessage.error(course.error || '生成失败')
    return
  }
  ElMessage.success('课程已生成并落库')
  streamText.value = ''
}

function goExplain(): void {
  void router.push('/explain')
}
</script>

<template>
  <div class="page">
    <el-card shadow="never" class="card">
      <template #header>
        <div class="card-header">
          <span>输入主题 / 资料</span>
          <span class="hint">模型会先给出课程结构，再进入逐课讲解</span>
        </div>
      </template>

      <el-form label-width="86px">
        <el-form-item label="课程主题">
          <el-input v-model="topic" placeholder="例如：光合作用 / 递归 / 面试中的 STAR 法则" maxlength="60" show-word-limit />
        </el-form-item>
        <el-form-item label="参考资料">
          <el-input
            v-model="material"
            type="textarea"
            :rows="4"
            placeholder="可选。粘贴教材片段、大纲或需求说明，模型会据此设计课程。"
            maxlength="4000"
            show-word-limit
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="course.streaming" @click="generate">
            {{ course.streaming ? '生成中…' : '生成结构化课程' }}
          </el-button>
          <el-tag v-if="degraded" type="warning" effect="plain" class="ml">
            当前为本地降级适配器（未配置 API Key）
          </el-tag>
        </el-form-item>
      </el-form>

      <div v-if="course.streaming" class="stream-box">
        <div class="stream-title">流式输出（原始模型响应）</div>
        <pre class="stream-text">{{ streamText || '等待首个分片…' }}</pre>
      </div>
    </el-card>

    <el-card v-if="course.course" shadow="never" class="card">
      <template #header>
        <div class="card-header">
          <span>{{ course.course.title }}</span>
          <el-button type="primary" link @click="goExplain">进入步骤 2 结构化讲解 →</el-button>
        </div>
      </template>

      <p class="summary">{{ course.course.summary }}</p>

      <div class="objectives">
        <div class="section-label">学习目标</div>
        <ul>
          <li v-for="objective in course.course.objectives" :key="objective">{{ objective }}</li>
        </ul>
      </div>

      <div class="section-label">课次（{{ course.lessons.length }}）</div>
      <div class="lessons">
        <el-card v-for="lesson in course.lessons" :key="lesson.id" shadow="hover" class="lesson-card">
          <div class="lesson-title">{{ lesson.idx + 1 }}. {{ lesson.title }}</div>
          <div class="lesson-objective">{{ lesson.objective }}</div>
          <div class="key-points">
            <el-tag v-for="point in lesson.keyPoints" :key="point" size="small" effect="plain">{{ point }}</el-tag>
          </div>
        </el-card>
      </div>

      <div class="meta">
        <el-tag size="small" type="info" effect="plain">provider: {{ course.course.provider }}</el-tag>
        <el-tag size="small" type="info" effect="plain">model: {{ course.course.model }}</el-tag>
        <el-tag v-if="course.course.degraded" size="small" type="warning" effect="plain">本地降级</el-tag>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
}

.hint {
  font-size: 12px;
  font-weight: 400;
  color: var(--muted);
}

.ml {
  margin-left: 12px;
}

.stream-box {
  margin-top: 6px;
  border: 1px dashed #dcdfe6;
  border-radius: 6px;
  padding: 10px 12px;
  background: #fafafa;
}

.stream-title {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 6px;
}

.stream-text {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  font-family: 'Cascadia Mono', Consolas, Menlo, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.summary {
  margin: 0 0 14px;
  color: #606266;
}

.section-label {
  font-size: 13px;
  font-weight: 600;
  margin: 10px 0 8px;
}

.objectives ul {
  margin: 0;
  padding-left: 20px;
  color: #606266;
}

.lessons {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}

.lesson-card {
  border: 1px solid #ebeef5;
}

.lesson-title {
  font-weight: 600;
  margin-bottom: 6px;
}

.lesson-objective {
  font-size: 13px;
  color: #606266;
  margin-bottom: 8px;
}

.key-points {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.meta {
  margin-top: 14px;
  display: flex;
  gap: 8px;
}
</style>