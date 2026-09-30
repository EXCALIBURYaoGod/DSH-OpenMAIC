<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { apiGet, apiPost } from '@/api/client'
import type { EvalOverview, EvalTarget } from '@/api/types'
import { useCourseStore } from '@/stores/course'
import { useLlmStore } from '@/stores/llm'

const course = useCourseStore()
const llm = useLlmStore()

const overview = ref<EvalOverview | null>(null)
const loading = ref(false)
const runningTarget = ref<{ target: EvalTarget; all: boolean } | null>(null)

async function loadOverview(): Promise<void> {
  if (course.course === null) return
  loading.value = true
  try {
    overview.value = await apiGet<EvalOverview>(`/api/eval/courses/${course.course.id}`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    loading.value = false
  }
}

async function run(target: EvalTarget, all: boolean): Promise<void> {
  if (course.course === null) return
  runningTarget.value = { target, all }
  try {
    await apiPost<{ runs: unknown[] }>(`/api/eval/courses/${course.course.id}/run`, {
      target,
      all,
      ...llm.route,
    })
    ElMessage.success(all ? `已评测全部「${label(target)}」` : `已评测最新「${label(target)}」`)
    await loadOverview()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    runningTarget.value = null
  }
}

function label(target: EvalTarget): string {
  return overview.value?.targets.find(item => item.target === target)?.label ?? target
}

const scorePercent = (score: number): number => Math.min(100, Math.max(0, score))

function levelType(level: string): 'success' | 'primary' | 'warning' | 'danger' {
  switch (level) {
    case '优秀': return 'success'
    case '良好': return 'primary'
    case '合格': return 'warning'
    default: return 'danger'
  }
}

/** 各类型的分均值（把全部评测运行按 targetType 分组取平均），用于看整体健康度。 */
const averages = computed<Array<{ target: EvalTarget; label: string; avg: number; count: number }>>(() => {
  if (overview.value === null) return []
  return overview.value.targets.map(t => {
    const runs = overview.value!.runs.filter(run => run.targetType === t.target)
    const avg = runs.length === 0 ? 0 : Math.round(runs.reduce((sum, run) => sum + run.totalScore, 0) / runs.length)
    return { target: t.target, label: t.label, avg, count: runs.length }
  })
})

/** 平均分是否非零：决定是否显示整体得分条与聚合环比（此处为基线首测）。 */
const hasAnyRun = computed(() => averages.value.some(item => item.count > 0))

/** 每类产物的历史运行趋势（按时间正序），带与上一次的环比，用于度量迭代效果。 */
const trends = computed<Array<{
  target: EvalTarget
  label: string
  runs: Array<{ id: string; totalScore: number; level: string; delta: number | null; createdAt: string }>
}>>(() => {
  if (overview.value === null) return []
  return overview.value.targets.map(t => {
    const list = overview.value!.runs
      .filter(run => run.targetType === t.target)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((run, index, arr) => {
        const previous = index > 0 ? arr[index - 1] : undefined
        const delta = previous === undefined ? null : run.totalScore - previous.totalScore
        return { id: run.id, totalScore: run.totalScore, level: run.level, delta, createdAt: run.createdAt }
      })
    return { target: t.target, label: t.label, runs: list }
  })
})

function formatTime(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div class="page">
    <el-empty v-if="course.course === null" description="请先完成步骤 1 生成课程" />

    <template v-else>
      <el-card shadow="never">
        <div class="intro">
          <span>LLM Judge 对课程产生的教学产物打分：覆盖课程大纲、结构化讲解、测验题目、判分反馈四类。</span>
          <span class="muted">逐个跑评测可得到可迭代的指标，供优化提示词后复测对比。</span>
        </div>
        <el-button type="primary" :loading="loading" size="small" @click="loadOverview">刷新</el-button>
      </el-card>

      <el-card v-if="hasAnyRun" shadow="never">
        <template #header><span class="title">整体指标（均值）</span></template>
        <el-row :gutter="16">
          <el-col v-for="item in averages" :key="item.target" :span="6">
            <div class="avg-cell">
              <div class="avg-label">{{ item.label }}<span v-if="item.count > 0" class="muted">（{{ item.count }} 次）</span></div>
              <div class="avg-value">{{ item.avg }}</div>
              <el-progress :percentage="scorePercent(item.avg)" :show-text="false" :stroke-width="8" />
            </div>
          </el-col>
        </el-row>
      </el-card>

      <el-card v-if="hasAnyRun" shadow="never">
        <template #header><span class="title">历史运行趋势（环比）</span></template>
        <div v-for="t in trends" :key="t.target" v-show="t.runs.length > 0" class="trend-block">
          <div class="trend-label">{{ t.label }}</div>
          <div class="trend-row">
            <div v-for="(run, i) in t.runs" :key="run.id" class="trend-point">
              <span class="trend-score">{{ run.totalScore }}</span>
              <el-tag :type="levelType(run.level)" size="small" effect="plain">{{ run.level }}</el-tag>
              <span
                v-if="run.delta !== null"
                class="trend-delta"
                :class="run.delta > 0 ? 'delta-up' : run.delta < 0 ? 'delta-down' : ''"
              >
                {{ run.delta > 0 ? '+' : '' }}{{ run.delta > 0 || run.delta < 0 ? run.delta : '±0' }}
              </span>
              <span class="trend-time">{{ i === 0 ? `基线 ${formatTime(run.createdAt)}` : formatTime(run.createdAt) }}</span>
            </div>
          </div>
        </div>
        <div class="hint-muted">提示：对同一产物做提示词/参数调整后再次评测，环比即可直观反映指标升降。</div>
      </el-card>

      <el-card v-for="t in overview?.targets ?? []" :key="t.target" shadow="never">
        <template #header>
          <div class="card-header">
            <span class="title">{{ t.label }}</span>
            <div class="actions">
              <el-button
                size="small"
                :loading="runningTarget?.target === t.target && runningTarget.all"
                :disabled="runningTarget !== null"
                @click="run(t.target, true)"
              >评测全部</el-button>
              <el-button
                size="small"
                type="primary"
                :loading="runningTarget?.target === t.target && !runningTarget.all"
                :disabled="runningTarget !== null"
                @click="run(t.target, false)"
              >评测最新</el-button>
            </div>
          </div>
        </template>

        <template v-if="overview?.latest[t.target]">
          <el-descriptions :column="1" size="small" border>
            <el-descriptions-item label="总分">
              <span class="score-value">{{ overview!.latest[t.target]!.detail.totalScore }}</span>
              <el-tag :type="levelType(overview!.latest[t.target]!.level)" effect="dark" size="small" class="tag">
                {{ overview!.latest[t.target]!.level }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="评语">{{ overview!.latest[t.target]!.detail.review }}</el-descriptions-item>
          </el-descriptions>

          <div v-for="item in overview!.latest[t.target]!.detail.perCriterion" :key="item.id" class="criterion">
            <div class="criterion-head">
              <span class="criterion-name">{{ item.name }} <span class="muted">（{{ item.score }}/5）</span></span>
              <span class="muted">{{ (t.criteria.find(c => c.id === item.id)?.weight ?? 0) * 100 }}%</span>
            </div>
            <el-progress :percentage="scorePercent((item.score / 5) * 100)" :show-text="false" :stroke-width="8" />
            <div v-if="item.comment" class="comment">{{ item.comment }}</div>
          </div>

          <div v-if="overview!.latest[t.target]!.detail.suggestions.length > 0" class="suggestions">
            <div class="section-label">改进建议</div>
            <ul>
              <li v-for="s in overview!.latest[t.target]!.detail.suggestions" :key="s">{{ s }}</li>
            </ul>
          </div>
        </template>
        <el-empty v-else description="尚未评测该类型，点击上方按钮开始" :image-size="60" />
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

.intro {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
  font-size: 13px;
}

.muted {
  color: var(--muted);
  font-weight: 400;
}

.title {
  font-weight: 600;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.actions {
  display: flex;
  gap: 8px;
}

.avg-cell {
  padding: 4px 0;
}

.avg-label {
  font-size: 13px;
  margin-bottom: 4px;
}

.avg-value {
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 6px;
}

.trend-block {
  margin-bottom: 14px;
}

.trend-label {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}

.trend-row {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
}

.trend-point {
  display: flex;
  align-items: center;
  gap: 6px;
}

.trend-score {
  font-size: 16px;
  font-weight: 700;
}

.trend-delta {
  font-size: 12px;
  font-weight: 600;
}

.delta-up {
  color: #67c23a;
}

.delta-down {
  color: #f56c6c;
}

.trend-time {
  font-size: 12px;
  color: var(--muted);
}

.hint-muted {
  margin-top: 6px;
  font-size: 12px;
  color: var(--muted);
}

.score-value {
  font-size: 18px;
  font-weight: 700;
  margin-right: 8px;
}

.tag {
  margin-left: 4px;
}

.criterion {
  margin-top: 14px;
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

.comment {
  margin-top: 6px;
  font-size: 13px;
  color: #606266;
}

.suggestions {
  margin-top: 12px;
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