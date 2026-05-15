/**
 * AI 厂商模板 — 常见服务商的一键配置。
 *
 * 用于 AI 设置面板的"从模板新建"入口:选个模板 → 自动填 baseURL + 推荐 model 列表,
 * 用户只需要贴自己的 API key 就能用。
 *
 * 所有厂商都假定走 OpenAI-compatible 协议(`${baseURL}/chat/completions`),
 * 这是 99% 国产/云 LLM 的事实标准。不兼容的(如原生 Anthropic / Gemini)暂不收录。
 */

export interface ProviderTemplate {
  /** 模板 id — 稳定不变,用户保存的 profile 里会引用 */
  id: string;
  /** 显示名 */
  name: string;
  /** API base URL(不带尾 /) */
  baseURL: string;
  /** 推荐 model 名列表 — 用户切换下拉时看到的第一批。可自行 + 自定义 */
  models: string[];
  /** 申请 key 的入口页 — 空就不显示 */
  applyUrl?: string;
  /** 额外备注 — 例如"免费额度 / 是否支持视觉"等 */
  note?: string;
  /** 是否支持视觉(image_url 输入)— UI 里打个小标 */
  vision?: boolean;
}

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'o3-mini'],
    applyUrl: 'https://platform.openai.com/api-keys',
    vision: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek 官方',
    baseURL: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    applyUrl: 'https://platform.deepseek.com/api_keys',
    note: '官方 API,仅文本(无视觉)',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    // 官方最新(2025+)→ 旧款:glm-5.1 旗舰、glm-4.6/4.5 主力、glm-4-flash / glm-4v-flash 免费
    models: [
      'glm-4.5-flash',
      'glm-4-flash',
      'glm-4.6',
      'glm-4.5',
      'glm-5.1',
      'glm-4v-flash',
      'glm-4v-plus',
      'glm-4-plus',
    ],
    applyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    note: 'OpenAI 兼容。glm-4-flash / glm-4v-flash 免费;glm-4v 系列支持视觉',
    vision: true,
  },
  {
    id: 'qwen',
    name: '阿里通义 Qwen',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen-vl-plus', 'qwen-vl-max'],
    applyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    note: 'qwen-vl 系列支持视觉',
    vision: true,
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi',
    baseURL: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    applyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    baseURL: 'https://api.siliconflow.cn/v1',
    models: [
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-R1',
      'Qwen/Qwen2.5-72B-Instruct',
      'Qwen/Qwen2.5-VL-72B-Instruct',
    ],
    applyUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: '聚合多家开源模型,含 DeepSeek / Qwen-VL 等',
    vision: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    models: [
      'deepseek/deepseek-chat',
      'anthropic/claude-3.5-sonnet',
      'google/gemini-2.0-flash-exp:free',
      'meta-llama/llama-3.3-70b-instruct',
    ],
    applyUrl: 'https://openrouter.ai/keys',
    note: '全球模型聚合,可用各家前沿模型',
    vision: true,
  },
  {
    id: 'ollama',
    name: 'Ollama(本地)',
    baseURL: 'http://127.0.0.1:11434/v1',
    models: ['llama3.2', 'qwen2.5:7b', 'llama3.2-vision'],
    note: '本地模型,无需 API key(随便填一个即可)。先 `ollama pull <model>`',
    vision: true,
  },
];

/** 一个保存下来的厂商配置 — 用户自己的组合(基于模板或自定义) */
export interface ProviderProfile {
  /** 稳定 id */
  id: string;
  /** 显示名(用户可改) */
  name: string;
  /** 基于哪个模板(仅记录来源,不用于执行) */
  templateId?: string;
  baseURL: string;
  apiKey: string;
  /** 当前激活的 model — 切到该 profile 时自动填入 cfg.model */
  model: string;
  /** 用户常用 model 列表(沿用现有 modelPresets) */
  modelPresets: string[];
}
