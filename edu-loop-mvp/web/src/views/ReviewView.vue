<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useCourseStore } from '@/stores/course'

const course = useCourseStore()

const revealed = reactive<Record<string, boolean>>({})
const grading = ref('')

/** 复习评分档位：对应简化 SM-2 的回忆质量 0-5。 */
const GRADES = [
  { value: 5, label: '脱口而出', type: 'success' as const },
  { value: 4, label: '想了一下', type: 'success' as const },
  { value: 3, label: '勉强想起', type: 'warning' as const },
  { value: 2, label: '想不起来', type: 'danger' as const },
  { value: 1, label: '完全不会', type: 'danger' as const },
]

const upcoming = computed(() =>
  [...course.reviews].sort((a, b) => a.dueAt.localeCompare(b.dueAt)).slice(0, 12),
)

onMounted(() => {
  if (course.course !== null) void course.loadDue()
})

async function grade(questionId: string, value: number): Promise<void> {
  grading.value = questionId
  await course.submitReview(questionId, value)
  grading.value = ''
  if (course.error.length > 0) {
    ElMessage.error(course.error)
    return
  }
  ElMessage.success('已记录本次复习，复习间隔已重新计算')
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
</script>

<template>
  <div class="page">
    <el-empty v-if="course.course === null" description="请先完成步骤 1 生成课程" />

    <template v-else>
      <el-card shadow="never">
        <div class="toolbar">
          <span class="title">今日到期 {{ course.due.length }} 题</span>
          <span class="hint">答错的题会被压回 1 天间隔，答对的题逐步拉长到 6 天、更长</span>
          <el-button link type="primary" @click="course.loadDue()">刷新</el-button>
        </div>
      </el-card>

      <el-empty v-if="course.due.length === 0" description="当前没有到期复习项。先去步骤 3 生成并作答几道题。" :image-size="90" />

      <el-card v-for="item in course.due" :key="item.review.questionId" shadow="never" class="card">
        <div class="question-head">
          <el-tag size="small" type="warning" effect="dark">到期</el-tag>
          <el-tag size="small" effect="plain">ease {{ item.review.ease }}</el-tag>
          <el-tag size="small" effect="plain">间隔 {{ item.review.intervalDays }} 天</el-tag>
          <el-tag size="small" effect="plain">重复 {{ item.review.repetitions }} 次</el-tag>
        </div>

        <div class="stem">{{ item.question?.stem ?? '（题目已删除）' }}</div>

        <el-button link type="primary" @click="revealed[item.review.questionId] = !revealed[item.review.questionId]">
          {{ revealed[item.review.questionId] ? '隐藏参考答案' : '显示参考答案' }}
        </el-button>

        <div v-if="revealed[item.review.questionId]" class="answer">
          {{ item.question?.answer ?? '' }}
        </div>

        <div class="grades">
          <span class="grade-label">这次回忆得怎么样？</span>
          <el-button
            v-for="option in GRADES"
            :key="option.value"
            :type="option.type"
            size="small"
            plain
            :loading="grading === item.review.questionId"
            @click="grade(item.review.questionId, option.value)"
          >
            {{ option.value }} · {{ option.label }}
          </el-button>
        </div>
      </el-card>

      <el-card v-if="upcoming.length > 0" shadow="never">
        <template #header><span class="title">复习计划</span></template>
        <el-table :data="upcoming" size="small">
          <el-table-column prop="questionId" label="题目 ID" width="200" />
          <el-table-column label="下次到期" width="140">
            <template #default="{ row }">{{ formatDate(row.dueAt) }}</template>
          </el-table-column>
          <el-table-column prop="intervalDays" label="间隔（天）" width="110" />
          <el-table-column prop="repetitions" label="重复次数" width="100" />
          <el-table-column prop="ease" label="难度因子" width="100" />
        </el-table>
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

.title {
  font-weight: 600;
}

.hint {
  font-size: 12px;
  color: var(--muted);
}

.question-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.stem {
  line-height: 1.6;
  margin-bottom: 8px;
}

.answer {
  margin: 8px 0;
  padding: 8px 12px;
  background: #f5f7fa;
  border-radius: 6px;
  font-size: 13px;
  color: #606266;
}

.grades {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.grade-label {
  font-size: 13px;
  color: var(--muted);
}
</style>