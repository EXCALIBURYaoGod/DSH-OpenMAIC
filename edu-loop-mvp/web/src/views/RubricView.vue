<script setup lang="ts">
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { useCourseStore } from '@/stores/course'
import { useLlmStore } from '@/stores/llm'

const course = useCourseStore()
const llm = useLlmStore()

/** 把 1-4 分的维度得分折算成进度条比例。 */
const scorePercent = (score: number): number => Math.min(100, Math.max(0, (score / 4) * 100))

const levelType = computed(() => {
  switch (course.evaluation?.level) {
    case '优秀':
      return 'success'
    case '良好':
      return 'primary'
    case '合格':
      return 'warning'
    default:
      return 'danger'
  }
})

async function generate(): Promise<void> {
  await course.generateRubric(llm.route)
  if (course.error.length > 0) {
    ElMessage.error(course.error)
    return
  }
  ElMessage.success('评估量规已生成')
}

async function evaluate(): Promise<void> {
  await course.evaluate(llm.route)
  if (course.error.length > 0) {
    ElMessage.error(course.error)
    return
  }
  ElMessage.success('已依据学习证据完成评估')
}
</script>

<template>
  <div class="page">
    <el-empty v-if="course.course === null" description="请先完成步骤 1 生成课程" />

    <template v-else>
      <el-card shadow="never">
        <div class="toolbar">
          <el-button type="primary" :loading="course.loading" @click="generate">
            {{ course.rubric ? '重新生成量规' : '生成评估量规' }}
          </el-button>
          <el-button :disabled="course.rubric === null" :loading="course.loading" @click="evaluate">
            依据学习证据评估
          </el-button>
          <div class="evidence">
            <el-tag size="small" type="info" effect="plain">
              评估证据：已作答 {{ course.stats.attempted }} 题 / 正确 {{ course.stats.correct }} 题 / 正确率 {{ course.stats.accuracy }}%
            </el-tag>
          </div>
        </div>
        <div class="hint">
          量规由模型生成，评估会结合测验正确率与最近错题给出各维度得分和下一步建议。
        </div>
      </el-card>

      <el-card v-if="course.rubric" shadow="never">
        <template #header><span class="title">评分量规</span></template>
        <el-table :data="course.rubric.criteria" size="small">
          <el-table-column prop="name" label="维度" width="130" />
          <el-table-column prop="descriptor" label="描述" />
          <el-table-column label="权重" width="90">
            <template #default="{ row }">{{ (row.weight * 100).toFixed(0) }}%</template>
          </el-table-column>
          <el-table-column label="等级" width="320">
            <template #default="{ row }">
              <el-tag v-for="level in row.levels" :key="level.level" size="small" effect="plain" class="level-tag">
                {{ level.level }} {{ level.score }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card v-if="course.evaluation" shadow="never">
        <template #header>
          <div class="card-header">
            <span class="title">评估结果</span>
            <div class="score">
              <span class="score-value">{{ course.evaluation.totalScore }}</span>
              <span class="score-unit">分</span>
              <el-tag :type="levelType" effect="dark" size="small">{{ course.evaluation.level }}</el-tag>
            </div>
          </div>
        </template>

        <div v-for="item in course.evaluation.perCriterion" :key="item.id" class="criterion">
          <div class="criterion-head">
            <span class="criterion-name">
              {{ course.rubric?.criteria.find(c => c.id === item.id)?.name ?? item.id }}
            </span>
            <span class="criterion-score">{{ item.score }} / 4</span>
          </div>
          <el-progress :percentage="scorePercent(item.score)" :show-text="false" :stroke-width="8" />
          <div class="criterion-comment">{{ item.comment }}</div>
        </div>

        <div v-if="course.evaluation.suggestions.length > 0" class="suggestions">
          <div class="section-label">下一步建议</div>
          <ul>
            <li v-for="suggestion in course.evaluation.suggestions" :key="suggestion">{{ suggestion }}</li>
          </ul>
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

.evidence {
  margin-left: auto;
}

.hint {
  margin-top: 10px;
  font-size: 12px;
  color: var(--muted);
}

.title {
  font-weight: 600;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.score {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.score-value {
  font-size: 22px;
  font-weight: 700;
}

.score-unit {
  font-size: 12px;
  color: var(--muted);
  margin-right: 6px;
}

.level-tag {
  margin-right: 4px;
}

.criterion {
  margin-bottom: 16px;
}

.criterion-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.criterion-name {
  font-size: 13px;
  font-weight: 600;
}

.criterion-score {
  font-size: 12px;
  color: var(--muted);
}

.criterion-comment {
  margin-top: 6px;
  font-size: 13px;
  color: #606266;
}

.suggestions {
  margin-top: 6px;
}

.section-label {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}

.suggestions ul {
  margin: 0;
  padding-left: 20px;
  color: #606266;
}
</style>