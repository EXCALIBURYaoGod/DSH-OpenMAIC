<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { STEPS } from '@/router'
import { useLlmStore } from '@/stores/llm'
import { useCourseStore } from '@/stores/course'
import { useSystemStore } from '@/stores/system'

const llm = useLlmStore()
const course = useCourseStore()
const system = useSystemStore()
const route = useRoute()
const router = useRouter()

/** 生产模式屏蔽评测中心：从步骤条中剔除该入口。 */
const visibleSteps = computed(() => (system.evalEnabled ? STEPS : STEPS.filter(step => step.name !== 'eval')))
const brandSub = computed(() =>
  system.evalEnabled ? '课程 · 讲解 · 测验 · 复习 · 量规 · 评测' : '课程 · 讲解 · 测验 · 复习 · 量规',
)

const activeIndex = computed(() => visibleSteps.value.findIndex(step => step.path === route.path))
const currentStep = computed(() => visibleSteps.value[Math.max(activeIndex.value, 0)]!)

onMounted(async () => {
  await llm.load()
  try {
    await course.loadCourses()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
})

function goto(path: string): void {
  void router.push(path)
}

async function onSelectCourse(id: string): Promise<void> {
  try {
    await course.selectCourse(id)
    ElMessage.success('已切换课程')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}
</script>

<template>
  <el-container class="layout">
    <el-aside width="248px" class="sidebar">
      <div class="brand">
        <div class="brand-title">教学闭环 MVP</div>
        <div class="brand-sub">{{ brandSub }}</div>
      </div>

      <el-steps direction="vertical" :active="activeIndex" class="steps">
        <el-step
          v-for="(step, index) in visibleSteps"
          :key="step.path"
          :title="step.title"
          :description="step.description"
          class="step-item"
          :class="{ 'is-active': index === activeIndex }"
          @click="goto(step.path)"
        />
      </el-steps>

      <div class="sidebar-footer">
        <el-tag v-if="course.course" size="small" type="info" effect="plain">
          题目 {{ course.questions.length }} · 到期 {{ course.dueCount }}
        </el-tag>
      </div>
    </el-aside>

    <el-container>
      <el-header class="header">
        <div class="header-left">
          <span class="page-title">{{ currentStep.title }}</span>
          <span class="page-desc">{{ currentStep.description }}</span>
        </div>

        <div class="header-right">
          <el-select
            v-if="course.courses.length > 0"
            :model-value="course.course?.id"
            placeholder="选择课程"
            size="default"
            class="course-select"
            @change="onSelectCourse"
          >
            <el-option v-for="item in course.courses" :key="item.id" :label="item.title" :value="item.id" />
          </el-select>

          <el-select
            :model-value="llm.provider"
            size="default"
            class="provider-select"
            @change="llm.setProvider"
          >
            <el-option v-for="item in llm.providers" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>

          <el-select v-model="llm.model" size="default" class="model-select" placeholder="模型">
            <el-option v-for="item in llm.currentModels" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>

          <el-tooltip
            :content="llm.isDegraded
              ? '该 provider 未解析到凭据，已降级为本地 mock 适配器：闭环可完整跑通，内容为确定性示例。配置 .env 后自动切换到真实模型。'
              : '已解析到凭据，将调用真实模型'"
            placement="bottom"
          >
            <el-tag :type="llm.isDegraded ? 'warning' : 'success'" size="small" effect="dark">
              {{ llm.isDegraded ? '本地降级' : '真实模型' }}
            </el-tag>
          </el-tooltip>
        </div>
      </el-header>

      <el-main class="main">
        <el-alert
          v-if="course.error"
          :title="course.error"
          type="error"
          show-icon
          closable
          class="page-alert"
          @close="course.error = ''"
        />
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.layout {
  height: 100vh;
}

.sidebar {
  display: flex;
  flex-direction: column;
  border-right: 1px solid #e4e7ed;
  background: var(--panel-bg);
  padding: 16px 0;
}

.brand {
  padding: 0 20px 16px;
}

.brand-title {
  font-size: 16px;
  font-weight: 600;
}

.brand-sub {
  margin-top: 4px;
  font-size: 12px;
  color: var(--muted);
}

.steps {
  flex: 1;
  padding: 4px 12px;
  overflow-y: auto;
}

.step-item {
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 6px;
}

.step-item.is-active {
  background: #ecf5ff;
}

.sidebar-footer {
  padding: 12px 20px 0;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 64px;
  background: var(--panel-bg);
  border-bottom: 1px solid #e4e7ed;
}

.header-left {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.page-title {
  font-size: 15px;
  font-weight: 600;
}

.page-desc {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.course-select {
  width: 200px;
}

.provider-select {
  width: 190px;
}

.model-select {
  width: 165px;
}

.main {
  padding: 18px;
  overflow-y: auto;
}

.page-alert {
  margin-bottom: 14px;
}
</style>