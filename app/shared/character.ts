// 主进程 + 渲染进程共享的类型定义。仅 type/interface,无运行时代码。

export interface Live2DExpressionRef {
  name: string;
  file: string;
}

export interface Live2DCharacter {
  id: string;
  name: string;
  category: string;      // live2d 下的一级分类目录,如 '通用' / '火影'
  type: 'live2d';
  root: string;          // 模型根目录绝对路径
  modelPath: string;     // model3.json 绝对路径
  expressions: string[]; // 显示用:model3 声明 + 文件夹内发现的 exp3
  motions: { group: string; count: number }[]; // 显示用:model3 声明 + 文件夹内发现的 motion3
  declaredExpressions?: string[]; // model3.json FileReferences.Expressions,运行时实际可直接触发
  discoveredExpressions?: Live2DExpressionRef[]; // 模型文件夹里实际存在的 *.exp3.json
  declaredMotions?: { group: string; count: number }[]; // model3.json FileReferences.Motions
  discoveredMotions?: { group: string; count: number }[]; // 模型文件夹里实际存在的 *.motion3.json
  hitAreas: { name: string; id: string }[];
}

/**
 * PNG 帧动画的循环规则。三种来源:
 * - simple:        `重复N-M` 或 `持续...重复NN`         → 直接循环 N..M
 * - enter-then-loop: `...是N-M然后重复`                   → 1..(N-1) 进入一次,N..M 循环
 * - hold:          单帧静止(目录里只有 1 张 png 的兜底)
 */
export type SpriteLoopRule =
  | { kind: 'simple'; loopStart: number; loopEnd: number }
  | { kind: 'enter-then-loop'; enterEnd: number; loopStart: number; loopEnd: number }
  | { kind: 'hold'; frame: number };

export interface SpriteState {
  name: string;        // 状态名,如 '说话' / '右转身'
  frames: string[];    // 帧绝对路径,按文件名数字排序
  loopRule: SpriteLoopRule;
  ruleSource: string;  // 规则来自的 .txt 文件名(用于调试)
}

export interface SpriteCompositeState {
  substates: Record<string, SpriteState>;
}

export type SpriteStateOrComposite = SpriteState | SpriteCompositeState;

export function isCompositeState(s: SpriteStateOrComposite): s is SpriteCompositeState {
  return 'substates' in s;
}

export interface SpriteCharacter {
  id: string;
  name: string;
  type: 'sprite';
  root: string;
  states: Record<string, SpriteStateOrComposite>;
}

/**
 * Hatch-Pet 格式 — OpenAI Codex 的 hatch-pet skill 输出的桌宠包。
 * 契约(详见 https://codexpets.org/install):
 *   - 每只桌宠一个文件夹,含 `pet.json` + `spritesheet.webp`
 *   - 1536×1872, 8 列 × 9 行 = 72 帧,单帧 192×208,未填格透明
 *   - 9 行固定语义:
 *       0 idle / 1 running-right / 2 running-left / 3 waving / 4 jumping
 *       5 failed / 6 waiting / 7 running / 8 review
 *   - 我们把 6=waiting 映射到 thinking,8=review 映射到 talking,0=idle 默认。
 *
 * 字段补齐 Live2DCharacter 形状(category / motions / expressions 等)只为
 * 让 PetMenu / DebugPanel 等老组件不报错,值都是空数组占位。
 */
export interface HatchPetCharacter {
  id: string;
  name: string;            // 用于 emotion-map / persona 查表
  category: string;        // 角色菜单分组,默认 'Hatch Pet'
  type: 'hatch-pet';
  /** 来源:builtin = 跟随程序打包的内置角色;user = 用户通过设置面板导入(可删) */
  source: 'builtin' | 'user';
  root: string;            // 角色文件夹绝对路径
  manifestPath: string;    // pet.json 绝对路径
  spritesheetPath: string; // spritesheet.webp 绝对路径
  description?: string;    // pet.json.description
  /** 本项目扩展字段:把 Codex 9 行 atlas 映射到桌宠行为 / 情绪 / 调试别名。未配置时会套用共享默认行为。 */
  behavior?: HatchPetBehaviorConfig;
  // 占位字段(让 PetMenu 等代码兼容 Live2DCharacter 形状)
  expressions: string[];
  motions: { group: string; count: number }[];
  hitAreas: { name: string; id: string }[];
}

export type HatchPetMotionAlias = number | number[];

export interface HatchPetBehaviorConfig {
  idleRows?: number[];
  walkRightRow?: number;
  walkLeftRow?: number;
  thinkingRow?: number;
  talkingRow?: number;
  draggingRow?: number;
  emotionRows?: Partial<Record<'happy' | 'sad' | 'angry' | 'surprised', number>>;
  aliases?: Record<string, HatchPetMotionAlias>;
  fps?: number;
  walkSpeed?: number;
  walkMs?: [number, number];
  restMs?: [number, number];
}

export type Character = Live2DCharacter | SpriteCharacter | HatchPetCharacter;

export interface CharacterIndex {
  live2d: Live2DCharacter[];
  sprite: SpriteCharacter[];
  hatchPet: HatchPetCharacter[];
  scannedAt: number; // 时间戳,便于诊断
  errors: string[];  // 扫描过程中记录的非致命错误
  // 资源根目录(绝对路径),用于把模型/帧绝对路径换算成 pet:// URL
  roots: {
    live2d: string;
    sprite: string;
    /** Hatch-Pet 内置根 — dev=app/hatch-pet,prod=resourcesPath/hatch-pet */
    hatchPet: string;
    /** Hatch-Pet 用户根 — userData/hatch-pet,通过设置面板导入的角色落到这里 */
    hatchPetUser: string;
  };
}
