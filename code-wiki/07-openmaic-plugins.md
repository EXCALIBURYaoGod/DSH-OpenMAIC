# 07 · OpenMAIC 集成插件

`server/src/plugins/` 下五个插件把 OpenMAIC 生态的能力以 Cordis 插件形式接入，
统一遵循「**对齐契约子集 + 可降级 + 不阻断闭环**」的哲学。

| 插件 | 文件名 | 提供服务 |
| --- | --- | --- |
| openmaic-slide | [plugin.ts](file:///workspace/edu-loop-mvp/server/src/plugins/openmaic-slide/plugin.ts) | `openmaic.slide` |
| openmaic-layout | [plugin.ts](file:///workspace/edu-loop-mvp/server/src/plugins/openmaic-layout/plugin.ts) | `openmaic.layout` |
| openmaic-storage | [plugin.ts](file:///workspace/edu-loop-mvp/server/src/plugins/openmaic-storage/plugin.ts) | `kv.store`、`docs.store` |
| openmaic-generation | [plugin.ts](file:///workspace/edu-loop-mvp/server/src/plugins/openmaic-generation/plugin.ts) | `openmaic.generation` |
| openmaic-tts-asr | [plugin.ts](file:///workspace/edu-loop-mvp/server/src/plugins/openmaic-tts-asr/plugin.ts) | `openmaic.tts`、`openmaic.asr` |

> 装配顺序（`index.ts`）：storage → generation → layout → slide → audio。
> slide 依赖 layout（优先消费），storage 依赖 db，generation 依赖 llm。

## 1. openmaic-storage — 统一持久化出口

把 `@openmaic/storage` 的 **KVStore + DocumentStore** 契约用 `node:sqlite` 落地。

- `inject: ['db']`；复用 **db 插件的同一个连接**，在同一库上建两张表：

```sql
CREATE TABLE IF NOT EXISTS storage_kv   ( scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (scope, key) );
CREATE TABLE IF NOT EXISTS storage_docs ( id TEXT PRIMARY KEY, name TEXT NOT NULL, scenes TEXT NOT NULL DEFAULT '[]',
                                          meta TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL );
```

- **`SqliteKVStore`**（`KVStoreContract`）：`get / set / remove / keys`，按 `scope` 分
  `device` / `account`（默认 `account`），值以 JSON 序列化；`assertScope` 校验合法 scope。
- **`SqliteDocumentStore`**（`DocumentStoreContract`）：`saveDocument / loadDocument /
  listDocuments / putScene / deleteDocument`。文档把 stage 元数据归一化到单行、scenes 存 JSON 列；
  `listDocuments` 只返回轻量摘要（不加载正文）；`putScene` 增量 upsert 单个 scene
  （已存在则替换并保持位置，否则追加）。
- 表由 db 插件统一管理生命周期，本插件 disposer 无需清理连接。

## 2. openmaic-layout — 完整 PPT 布局生成器

用 `@openmaic/dsl` 的 PPTElement 契约生成「**四点式布局**」（封面 / 内容卡片 / 进度 / 页码）。
**纯确定性、零 LLM、零外部依赖树**。

### 服务接口

```ts
export interface OpenmaicLayoutService {
  available: boolean
  layoutSlide(input: LayoutPageInput): LayoutPage
}
```

`layoutSlide` 按 `isCover`（或 `index === 0`）分派：

- **封面版式** `coverElements`：上下主题色条 + 居中大标题 + 可选副标题。
  标题/副标题按**实际折行数**计算盒高并在画布内垂直居中（固定盒高会让长标题溢出叠字）；
- **内容版式** `contentElements`：顶部标题栏 + 主题色下划线 + 要点卡片列表 + 底部页码 + 进度条。
  下划线/正文依次排在**标题实际高度之后**，进度宽度按页码比例计算。

### 关键实现细节

- **元素契约**：`text.content` 为 **HTML 字符串**（渲染端用 `dangerouslySetInnerHTML` 渲染）；
  `shape` 用 `viewBox + path` 绘制主题色条；每页 Slide 带 `viewportSize/viewportRatio/theme/background`。
- **字号必须内联进 content**：`PPTTextElement` 契约中并无元素级 `fontSize`，写了也不生效
  （渲染端只应用 content 的内联样式），因此 `textBox` 把 `font-size/line-height/color` 拼进 HTML。
- **折行估算**：`estimateLines(text, boxWidth, fontSize)` 按 CJK 全宽、ASCII 半宽估算折行数，
  `textBlockHeight` 再乘以行高并加内边距——因为**渲染端不自动撑高**，高度不足会向下溢出叠字。
- HTML 转义：要点/标题经 `escapeHtml` 转义，避免 `<` `&` 破坏 content 结构。
- `VIEWPORT_W/H = 960/540`，`RATIO = 0.5625`；主题色为重点蓝 `#5b9bd5` 系列。

## 3. openmaic-slide — 要点 → SlideDeck

`inject: ['llm', 'repo']`；`provide: 'openmaic.slide'`；`apply` 为 **async**。

### 三级降级策略（生成器选择）

```
layout 服务存在  → buildDeckWithLayout(layout, input)   // 消费 openmaic.layout，完整 PPT 版式
否则 dsl 可用    → buildDeckDsl(dsl)(input)             // 真机 @openmaic/dsl 包装
否则             → buildDeckBuiltin(input)              // 内置最小生成器（线性 text 布局）
```

- **真机 dsl 探测**：`tryLoadOpenmaic()` 用**动态拼装的 specifier**（`['@openmaic','dsl'].join('/')`）
  `await import`，以规避 tsc 静态解析；解析失败返回 `null`。
- **`SlideDeck`** 对外为扁平结构（`slides[]` 每项即完整契约 Slide），兼容 PPTist 风格；
  接入 dsl 时另带 `scenes[]`（type=slide，`content.canvas` 为契约 Slide）与 `__dslVersion`。
- **校验** `validate(deck)`：接入 dsl 时用 `dsl.validateStage`，降级用内置宽松断言
  （slides 为数组且每页有 elements）。
- 服务暴露 `available`（dsl 是否可用）、`source`（`openmaic` | `builtin-fallback`）、`dslVersion`。

## 4. openmaic-generation — 两阶段生成管线

`inject: ['llm']`；把 OpenMAIC `@openmaic/generation` 的「outline → complete scene」
插件化，**注入本项目自建的 `llm` 服务作为模型出口**。

```ts
export interface OpenmaicGenerationService {
  available: boolean
  source: 'llm' | 'mock'
  generateSceneOutlinesFromRequirements(input): Promise<GenerationResult<GeneratedOutline>>
  buildCompleteScene(outline, content): CompleteScene
}
```

- **`source` 判定**：`forceMock` 或 `loaded.degradedProviders.has(loaded.defaultProvider)` 为
  `mock`，否则 `llm`（即「默认路由是否被 mock 顶替」作为真实模型信号）；
- **`makeAiCall`**：把 generation 的 `(systemPrompt, userPrompt)` 约定映射为
  `loaded.runtime.stream(...)` 一次调用，再用 `assembleStream` 装配为完整文本，失败即抛错；
- **`generateSceneOutlinesFromRequirements`**：
  - `source === 'mock'` → 直接返回 `builtinOutline`，**不发起无效调用**；
  - 否则用 LLM 生成，`extractJson` 宽松解析（首尾大括号）；模型可能返回统一契约
    （有 `outlines`）或 mock 风格（有 `lessons`），两者都归一化；
  - 严格解析失败也回退 `builtinOutline`，保证闭环可跑；
- **`buildCompleteScene`**：把 outline + 讲解内容装配为 `{ id, title, order, desc, content: { type:'slide' } }`
  的场景形状，兼容 storage 的 `docs.store`。

## 5. openmaic-tts-asr — 语音 Provider 层

复刻 llm 插件的「config + key 注入 + 可降级」范式，暴露 `openmaic.tts` 与 `openmaic.asr`
两个服务：**静态 provider 元数据注册表 + 路由式调用**。

### provider 注册表

| 类型 | 内置 provider | 需要 Key |
| --- | --- | --- |
| TTS | `openai-tts`（默认 `https://api.openai.com/v1`） | 是 |
| TTS | `browser-native-tts`（服务端桩，抛错引导浏览器侧调用） | 否 |
| ASR | `openai-whisper` | 是 |
| ASR | `browser-native`（服务端桩） | 否 |

### 接口

```ts
export interface OpenmaicTtsService {
  listProviders(): TTSProviderMeta[]
  availableProviderIds(): string[]                       // requiresApiKey=false 恒可用；需 key 看是否解析到
  generate(config: TTSModelConfig, text: string): Promise<TTSGenerationResult>
}
export interface OpenmaicAsrService { /* 同构：listProviders / availableProviderIds / transcribe */ }
```

- **凭据**：`config.apiKey ?? resolveCredential('OPENAI_API_KEY')`；缺 key 抛错；
- **`generateOpenAITTS`**：`POST {baseUrl}/audio/speech`（model/input/voice/speed/format），
  返回 `Uint8Array` 音频；
- **`transcribeOpenAIWhisper`**：`POST {baseUrl}/audio/transcriptions`（`FormData` + Blob），
  返回文本；
- **可用性**：`availableProviderIds()` 过滤掉需要 key 但未配置的 provider；
- 未配置 `OPENAI_API_KEY` 时打印告警，仅开放 browser-native 桩。

## 6. 降级矩阵

| 插件 | 外部依赖 | 缺失时行为 | 对外标记 |
| --- | --- | --- | --- |
| storage | 无（仅 db） | 无降级，始终可用 | - |
| layout | 无 | 无降级，始终可用 | `available: true` |
| slide | `@openmaic/dsl` / `layout` | 逐级回退：layout → dsl → 内置生成器 | `source` / `available` / `dslVersion` |
| generation | 真实 LLM 凭据 | 回退内置 outline 生成器 | `source: 'mock'` |
| tts-asr | `OPENAI_API_KEY` | 仅开放 browser-native 桩 | `availableProviderIds()` |

> 所有降级都只影响该能力的**质量**，不影响主流程可用性——这是本项目「无 Key 也能跑通」
> 要求在各插件上的延续。

下一篇：[08-eval-judge.md](./08-eval-judge.md)。