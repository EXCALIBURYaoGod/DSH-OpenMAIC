<script setup lang="ts">
import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useCourseStore } from '@/stores/course'
import { useLlmStore } from '@/stores/llm'

const course = useCourseStore()
const llm = useLlmStore()

const lessonId = ref('')
const count = ref(3)
const drafts = reactive<Record<string, string>>({})
const submitting = ref('')

async function generate(): Promise<void> {
  await course.generateQuiz(llm.route, {
    ...(lessonId.value.length > 0 ? { lessonId: lessonId.value } : {}),
    count: count.value,
  })
  if (course.error.length > 0) {
    ElMessage.error(course.error)
    return
  }
  ElMessage.success('题目已生成，并自动加入复习队列')
}

async function submit(questionId: string): Promise<void> {
  const answer = (drafts[questionId] ?? '').trim()
  if (answer.length === 0) {
    ElMessage.warning('请先作答')
    return
  }
  submitting.value = questionId
  const attempt = await course.submitAttempt(questionId, answer, llm.route)
  submitting.value = ''
  if (attempt === null) {
    ElMessage.error(course.error || '判分失败')
    return
  }
  ElMessage[attempt.correct ? 'success' : 'warning'](
    attempt.correct ? `回答正确（${attempt.score} 分）` : `回答有误（${attempt.score} 分），已自动安排复习`,
  )
}
</script>

<template>
  <div class="page">
    <el-empty v-if="course.course === null" description="请先完成步骤 1 生成课程" />

    <template v-else>
      <el-card shadow="never" class="card">
        <div class="toolbar">
          <el-select v-model="lessonId" placeholder="整门课程" clearable class="lesson-select">
            <el-option v-for="lesson in course.lessons" :key="lesson.id" :label="lesson.title" :value="lesson.id" />
          </el-select>
          <el-input-number v-model="count" :min="1" :max="8" />
          <el-button type="primary" :loading="course.loading" @click="generate">生成题目</el-button>
          <div class="stats">
            <el-tag size="small" type="info" effect="plain">
              已作答 {{ course.stats.attempted }} · 正确 {{ course.stats.correct }} · 正确率 {{ course.stats.accuracy }}%
            </el-tag>
          </div>
        </div>
      </el-card>

      <el-empty v-if="course.questions.length === 0" description="还没有题目，点击上方「生成题目」" :image-size="90" />

      <el-card v-for="question in course.questions" :key="question.id" shadow="never" class="card question-card">
        <div class="question-head">
          <span class="question-index">第 {{ question.idx + 1 }} 题</span>
          <el-tag size="small" effect="plain">{{ question.type === 'single_choice' ? '单选' : '简答' }}</el-tag>
          <el-tag size="small" type="info" effect="plain">{{ question.difficulty }}</el-tag>
        </div>

        <div class="stem">{{ question.stem }}</div>

        <el-radio-group v-if="question.type === 'single_choice' && question.options" v-model="drafts[question.id]" class="options">
          <el-radio v-for="option in question.options" :key="option" :value="option" class="option">{{ option }}</el-radio>
        </el-radio-group>

        <el-input
          v-else
          v-model="drafts[question.id]"
          type="textarea"
          :rows="3"
          placeholder="写下你的回答，判分会与参考答案的实质要求对照"
        />

        <div class="actions">
          <el-button type="primary" :loading="submitting === question.id" @click="submit(question.id)">提交作答</el-button>
        </div>

        <div v-if="course.latestAttemptByQuestion[question.id]" class="result">
          <el-alert
            :type="course.latestAttemptByQuestion[question.id]!.correct ? 'success' : 'error'"
            :closable="false"
            show-icon
          >
            <template #title>
              得分 {{ course.latestAttemptByQuestion[question.id]!.score }} ·
              {{ course.latestAttemptByQuestion[question.id]!.correct ? '正确' : '未通过' }}
              （判分来源：{{ course.latestAttemptByQuestion[question.id]!.gradedBy === 'llm' ? '模型' : '本地判据' }}）
            </template>
            <div>{{ course.latestAttemptByQuestion[question.id]!.feedback }}</div>
          </el-alert>

          <el-collapse class="answer-detail">
            <el-collapse-item title="查看参考答案与解析">
              <div class="answer-line"><strong>参考答案：</strong>{{ question.answer }}</div>
              <div v-if="question.explanation" class="answer-line"><strong>解析：</strong>{{ question.explanation }}</div>
            </el-collapse-item>
          </el-collapse>
        </div>
      </el-card>
    </template>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.lesson-select {
  width: 260px;
}

.stats {
  margin-left: auto;
}

.question-card {
  border: 1px solid #ebeef5;
}

.question-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.question-index {
  font-weight: 600;
}

.stem {
  margin-bottom: 12px;
  line-height: 1.6;
}

.options {
  display: flex;
  flex-direction: column;
  /* 覆盖 Element Plus .el-radio-group 默认的 align-items:center，让选项左对齐。 */
  align-items: flex-start;
  gap: 4px;
}

.option {
  height: auto;
  padding: 4px 0;
  white-space: normal;
}

.actions {
  margin-top: 12px;
}

.result {
  margin-top: 12px;
}

.answer-detail {
  margin-top: 8px;
}

.answer-line {
  font-size: 13px;
  color: #606266;
  line-height: 1.7;
}
</style>