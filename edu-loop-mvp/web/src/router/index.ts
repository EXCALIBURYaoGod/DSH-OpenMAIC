import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

export const STEPS: Array<{ path: string; name: string; title: string; description: string }> = [
  { path: '/course', name: 'course', title: '1. 生成课程', description: '输入主题或资料，生成结构化课程大纲' },
  { path: '/explain', name: 'explain', title: '2. 结构化讲解', description: '逐课生成讲解，形成学习材料' },
  { path: '/quiz', name: 'quiz', title: '3. 测验', description: '按课次出题、作答并获得判分反馈' },
  { path: '/review', name: 'review', title: '4. 间隔重复', description: '按 SM-2 调度复习，巩固长期记忆' },
  { path: '/rubric', name: 'rubric', title: '5. 评估量规', description: '依据学习证据给出量规评估与建议' },
  { path: '/eval', name: 'eval', title: '评测中心', description: 'LLM Judge 对教学产物打分，驱动迭代优化' },
]

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/course' },
  { path: '/course', name: 'course', component: () => import('@/views/CourseView.vue') },
  { path: '/explain', name: 'explain', component: () => import('@/views/ExplainView.vue') },
  { path: '/quiz', name: 'quiz', component: () => import('@/views/QuizView.vue') },
  { path: '/review', name: 'review', component: () => import('@/views/ReviewView.vue') },
  { path: '/rubric', name: 'rubric', component: () => import('@/views/RubricView.vue') },
  { path: '/eval', name: 'eval', component: () => import('@/views/EvalView.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/course' },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})