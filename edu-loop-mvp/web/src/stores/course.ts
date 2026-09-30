/**
 * 教学闭环状态：课程 → 讲解 → 测验 → 复习 → 量规。
 *
 * @module stores/course
 */

import { defineStore } from 'pinia'
import { apiGet, apiPost, postSse } from '@/api/client'
import type {
  Attempt,
  AttemptStats,
  Course,
  CourseDetail,
  Evaluation,
  Lesson,
  Question,
  Review,
  Rubric,
  SlideDeck,
  SlideDeckResponse,
} from '@/api/types'

interface RoutePayload {
  provider: string
  model: string
}

export const useCourseStore = defineStore('course', {
  state: () => ({
    loading: false,
    streaming: false,
    error: '',
    courses: [] as Course[],
    course: null as Course | null,
    lessons: [] as Lesson[],
    questions: [] as Question[],
    attempts: [] as Attempt[],
    stats: { attempted: 0, correct: 0, accuracy: 0 } as AttemptStats,
    due: [] as Array<{ review: Review; question: Question | null }>,
    reviews: [] as Review[],
    rubric: null as Rubric | null,
    evaluation: null as Evaluation | null,
    slideDeck: null as SlideDeck | null,
    slideTask: 'idle' as 'idle' | 'loading' | 'done' | 'error',
  }),
  getters: {
    /** 每题最近一次作答，便于在测验页显示判分结果。 */
    latestAttemptByQuestion(state): Record<string, Attempt> {
      const map: Record<string, Attempt> = {}
      for (const attempt of [...state.attempts].reverse()) map[attempt.questionId] = attempt
      return map
    },
    wrongQuestions(state): Question[] {
      const latest: Record<string, Attempt> = {}
      for (const attempt of [...state.attempts].reverse()) latest[attempt.questionId] = attempt
      return state.questions.filter(question => latest[question.id] !== undefined && !latest[question.id]!.correct)
    },
    dueCount(state): number {
      return state.due.length
    },
  },
  actions: {
    async loadCourses(): Promise<void> {
      const data = await apiGet<{ courses: Course[] }>('/api/courses')
      this.courses = data.courses
    },

    async selectCourse(id: string): Promise<void> {
      this.loading = true
      this.error = ''
      try {
        const data = await apiGet<CourseDetail>(`/api/courses/${id}`)
        this.course = data.course
        this.lessons = data.lessons
        this.stats = data.stats
        await Promise.all([this.loadQuestions(), this.loadReviews(), this.loadRubric()])
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      } finally {
        this.loading = false
      }
    },

    /** 步骤 1：流式生成课程大纲。 */
    async createCourse(input: {
      topic: string
      material?: string
      route: RoutePayload
      onDelta: (text: string) => void
      onMeta?: (meta: { courseId: string; degraded: boolean }) => void
    }): Promise<Course | null> {
      this.streaming = true
      this.error = ''
      let created: Course | null = null
      try {
        await postSse('/api/courses', { topic: input.topic, material: input.material, ...input.route }, {
          on: (event, data) => {
            const payload = data as Record<string, unknown>
            if (event === 'meta') {
              input.onMeta?.({
                courseId: String(payload.courseId),
                degraded: payload.degraded === true,
              })
            } else if (event === 'delta') {
              input.onDelta(String(payload.text ?? ''))
            } else if (event === 'outline') {
              created = payload.course as Course
              this.course = created
              this.lessons = payload.lessons as Lesson[]
            } else if (event === 'error') {
              this.error = String(payload.message ?? '生成失败')
            }
          },
        })
        if (created !== null) await this.loadCourses()
        return created
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
        return null
      } finally {
        this.streaming = false
      }
    },

    /** 步骤 2：流式生成某课的结构化讲解并落库。 */
    async explainLesson(lessonId: string, route: RoutePayload, onDelta: (text: string) => void): Promise<void> {
      if (this.course === null) return
      this.streaming = true
      this.error = ''
      try {
        await postSse(`/api/courses/${this.course.id}/lessons/${lessonId}/explain`, { ...route }, {
          on: (event, data) => {
            const payload = data as Record<string, unknown>
            if (event === 'delta') {
              if (typeof payload.text === 'string') onDelta(payload.text)
            } else if (event === 'done') {
              const lesson = payload.lesson as Lesson
              this.lessons = this.lessons.map(item => (item.id === lesson.id ? lesson : item))
            } else if (event === 'error') {
              this.error = String(payload.message ?? '讲解生成失败')
            }
          },
        })
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      } finally {
        this.streaming = false
      }
    },

    /** 把某课次的要点实时排版为幻灯片（依赖 openmaic-slide 服务，失败不阻断讲解）。 */
    async generateSlides(lessonId: string): Promise<void> {
      if (this.course === null) return
      this.slideTask = 'loading'
      this.error = ''
      try {
        const data = await apiPost<SlideDeckResponse>(
          `/api/slides/courses/${this.course.id}/lessons/${lessonId}/slides`,
          {},
        )
        this.slideDeck = data.deck
        this.slideTask = 'done'
      } catch (error) {
        this.slideTask = 'error'
        this.error = error instanceof Error ? error.message : String(error)
      }
    },

    /** 步骤 3a：出题。 */
    async generateQuiz(route: RoutePayload, options: { lessonId?: string; count?: number } = {}): Promise<void> {
      if (this.course === null) return
      this.loading = true
      this.error = ''
      try {
        const data = await apiPost<{ questions: Question[] }>(
          `/api/quiz/courses/${this.course.id}/generate`,
          { ...route, ...options },
        )
        this.questions = [...this.questions, ...data.questions]
        await Promise.all([this.loadQuestions(), this.loadReviews()])
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      } finally {
        this.loading = false
      }
    },

    /** 步骤 3b：作答并获得判分（同时更新复习调度）。 */
    async submitAttempt(questionId: string, answer: string, route: RoutePayload): Promise<Attempt | null> {
      if (this.course === null) return null
      this.error = ''
      try {
        const data = await apiPost<{ attempt: Attempt; stats: AttemptStats }>(
          `/api/quiz/questions/${questionId}/attempt`,
          { answer, ...route },
        )
        this.attempts = [data.attempt, ...this.attempts]
        this.stats = data.stats
        return data.attempt
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
        return null
      }
    },

    async loadQuestions(): Promise<void> {
      if (this.course === null) return
      const data = await apiGet<{ questions: Question[]; attempts: Attempt[]; stats: AttemptStats }>(
        `/api/quiz/courses/${this.course.id}/questions`,
      )
      this.questions = data.questions
      this.attempts = data.attempts
      this.stats = data.stats
    },

    /** 步骤 4a：加载到期复习项。 */
    async loadDue(): Promise<void> {
      if (this.course === null) return
      const data = await apiGet<{ due: Array<{ review: Review; question: Question | null }> }>(
        `/api/review/courses/${this.course.id}/due`,
      )
      this.due = data.due
    },

    async loadReviews(): Promise<void> {
      if (this.course === null) return
      const data = await apiGet<{ reviews: Review[] }>(`/api/review/courses/${this.course.id}/all`)
      this.reviews = data.reviews
    },

    /** 步骤 4b：提交一次复习评分（0-5）。 */
    async submitReview(questionId: string, grade: number): Promise<void> {
      if (this.course === null) return
      this.error = ''
      try {
        await apiPost<{ review: Review }>(`/api/review/questions/${questionId}/review`, { grade })
        await this.loadDue()
        await this.loadReviews()
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      }
    },

    /** 步骤 5a：生成评估量规。 */
    async generateRubric(route: RoutePayload): Promise<void> {
      if (this.course === null) return
      this.loading = true
      this.error = ''
      try {
        const data = await apiPost<{ rubric: Rubric }>(`/api/rubric/courses/${this.course.id}/generate`, { ...route })
        this.rubric = data.rubric
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      } finally {
        this.loading = false
      }
    },

    async loadRubric(): Promise<void> {
      if (this.course === null) return
      const data = await apiGet<{ rubric: Rubric | null; evaluation: Evaluation | null }>(
        `/api/rubric/courses/${this.course.id}`,
      )
      this.rubric = data.rubric
      this.evaluation = data.evaluation
    },

    /** 步骤 5b：依据学习证据给出评估。 */
    async evaluate(route: RoutePayload): Promise<void> {
      if (this.course === null) return
      this.loading = true
      this.error = ''
      try {
        const data = await apiPost<{ evaluation: Evaluation; stats: AttemptStats }>(
          `/api/rubric/courses/${this.course.id}/evaluate`,
          { ...route },
        )
        this.evaluation = data.evaluation
        this.stats = data.stats
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      } finally {
        this.loading = false
      }
    },
  },
})