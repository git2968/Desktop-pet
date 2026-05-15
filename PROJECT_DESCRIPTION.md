# Desktop Pet 项目说明

Desktop Pet 是一个 Windows 桌面宠物应用。项目基于 Electron、Vite、React、TypeScript、PIXI 和 Live2D 实现，核心目标是把 Live2D 模型、AI 对话、语音唤醒、工具调用和桌面交互整合到一个可打包分发的桌宠软件里。

主项目代码位于 `app/` 目录。

## 主要功能

- Live2D 桌宠显示: 自动扫描 `app/live2d` 下的 `.model3.json` 模型，按分类展示角色。
- 模型分类管理: 当前模型按 `通用`等目录分类，角色选择面板支持折叠分类。
- 角色交互: 点击头部切换表情，点击身体触发动作；模型也会根据鼠标位置做视线跟随。
- AI 对话: 右键菜单或托盘菜单可打开对话气泡，支持 Markdown、代码块、数学公式和 Mermaid。
- 角色人设: 每个模型可以配置独立 persona，让 AI 按角色口吻回复。
- 情绪驱动表情/动作: AI 回复末尾可输出 `[emotion: happy/sad/angry/surprised]`，程序会映射到对应模型的 expression / motion。
- 语音功能: 使用 VOSK 离线语音识别，支持语音唤醒和语音输入，并在开启后预热模型。
- MCP 工具: 支持配置 MCP server，让 AI 使用文件、浏览器、搜索、读屏等工具。
- Agent Skills: 支持内置 skill、本地上传 skill，以及从在线 skill 源下载缓存。
- SoulBanner 内置 skill: 已将 SoulBanner 角色 prompt 作为内置 skill 集成到软件中。
- 桌面辅助: 支持剪贴板建议、读屏、OCR、打开应用、通知、长期记忆等能力。

## 技术栈

- Electron: 桌面窗口、托盘菜单、IPC、打包发布。
- React + TypeScript: 渲染层 UI。
- Vite: 前端和 Electron 主进程构建。
- PIXI + pixi-live2d-display-lipsyncpatch: Live2D 渲染。
- VOSK: 离线语音识别。
- MCP SDK: Model Context Protocol 工具接入。
- electron-builder: Windows 安装包构建。

## 目录结构

```text
Desktop pet/
├─ CLAUDE.md                     # AI 协作/编码约束说明
├─ PROJECT_DESCRIPTION.md        # 当前项目说明
└─ app/
   ├─ electron/                  # Electron 主进程、IPC、MCP、AI、技能、配置
   │  ├─ main.ts
   │  ├─ preload.ts
   │  ├─ asset-scanner.ts        # Live2D 模型扫描
   │  ├─ ai-client.ts            # AI 请求与工具调用
   │  ├─ mcp-client.ts           # MCP 管理
   │  ├─ skill-registry.ts       # 在线/本地/内置 skill 管理
   │  └─ builtin-skills/         # 内置 skill 文档
   ├─ src/                       # React 渲染进程
   │  ├─ App.tsx
   │  ├─ render/                 # Live2D 渲染、语音、拖拽等逻辑
   │  └─ ui/                     # 菜单、气泡、设置面板、调试面板
   ├─ shared/                    # 主进程和渲染进程共用类型/配置
   │  ├─ character.ts
   │  ├─ emotion-map.ts          # 角色人设与情绪表情/动作映射
   │  ├─ mcp-presets.ts
   │  └─ provider-templates.ts
   ├─ live2d/                    # Live2D 模型资源
   │  ├─ 通用/
   │  ├─ 火影/
   │  └─ 抽象勿点/
   ├─ VOSK/                      # 内置语音识别模型 zip
   ├─ notify/                    # 通知相关资源
   ├─ electron-builder.*.yml     # 不同 Live2D 资源策略的打包配置
   ├─ PACKAGING.md               # 打包模式说明
   └─ package.json
```

## 本地开发

进入应用目录:

```bash
cd app
```

安装依赖:

```bash
npm install
```

启动开发环境:

```bash
npm run dev
```

类型检查:

```bash
npm run typecheck
```

生产构建准备:

```bash
npm run build:prepare
```

## 打包方式

项目提供三种 Live2D 资源打包模式:

```bash
npm run build:live2d:all      # 打包全部 app/live2d 模型
npm run build:live2d:common   # 只打包 app/live2d/通用
npm run build:live2d:none     # 不打包任何 Live2D 模型
```

兼容脚本:

```bash
npm run build          # 等同于 build:live2d:all
npm run build:personal # 等同于 build:live2d:all
npm run build:public   # 等同于 build:live2d:none
```

输出目录:

- 全量版: `app/dist-app/live2d-all`
- 仅通用版: `app/dist-app/live2d-common`
- 无 Live2D 版: `app/dist-app/live2d-none`

## Live2D 模型规则

模型放在 `app/live2d/<分类>/<模型目录>/` 下，例如:

```text
app/live2d/通用/Doro/Doro.model3.json
app/live2d/火影/ban/ban.model3.json
```

扫描规则:

- 递归查找 `.model3.json`。
- 分类取 `live2d` 下的第一级目录名。
- 表情从 `model3.json` 的 `FileReferences.Expressions` 读取。
- 程序也会递归补扫模型目录里的 `.exp3.json`，避免模型文件没有声明但资源实际存在。
- 动作从 `Motions` 和 `.motion3.json` 补扫结果合并。
- 已知不完整模型可在 `electron/asset-scanner.ts` 的忽略名单中排除。

## 角色人设和情绪映射

角色相关配置集中在:

```text
app/shared/emotion-map.ts
```

主要包含两部分:

- `DEFAULT_CHARACTER_PERSONAS`: 每个模型默认人设、说话风格、自称。
- `CHARACTER_EMOTION_MAP`: AI 情绪到 Live2D 表情/动作的映射。

示例:

```ts
Doro: {
  happy: { expression: ['Exp8', 'TongueOut', 'Exp5', 'Exp6'] },
  sad: { expression: ['Exp1', 'Exp7', 'Highlight OFF'] },
  angry: { expression: 'Exp2' },
  surprised: { expression: ['Exp3', 'Exp4'] },
}
```

AI 回复时如果最后一行包含:

```text
[emotion: happy]
```

渲染层会识别这个情绪标签，并尝试为当前模型播放对应表情或动作。标签本身不会显示给用户。

## Skill 与 MCP

Skill 管理在:

```text
app/electron/skill-registry.ts
```

支持三种来源:

- 内置 skill: `app/electron/builtin-skills/*.md`
- 本地 skill: 用户上传后保存到 Electron `userData/skills/local`
- 在线 skill: AI 查询后缓存到 Electron `userData/skills/<source>`

MCP 配置在设置面板中管理，核心代码在:

```text
app/electron/mcp-client.ts
app/shared/mcp-presets.ts
```

内置工具包括搜索、打开 URL、打开本地路径、读剪贴板、写剪贴板、通知、读屏、OCR、长期记忆、保存文本、模型辅助等。

## 用户配置与数据

用户配置不写入项目目录，而是保存到 Electron 的 `userData` 目录中，主要包括:

- AI provider、baseURL、apiKey、model
- 角色 persona
- 长期记忆
- MCP server 配置
- Agent Skills 配置
- 语音唤醒配置
- 桌宠大小、位置锁定、主动交互等设置

配置读写入口:

```text
app/electron/config-store.ts
```

## 常见维护入口

- 改模型扫描: `app/electron/asset-scanner.ts`
- 改角色选择/设置面板: `app/src/ui/pet-menu.tsx`
- 改对话气泡: `app/src/ui/chat-bubble.tsx`
- 改 Live2D 渲染和交互: `app/src/render/live2d-adapter.ts`
- 改角色承载逻辑: `app/src/render/character-host.tsx`
- 改人设/情绪映射: `app/shared/emotion-map.ts`
- 改内置 skill: `app/electron/builtin-skills/`
- 改 MCP 预设: `app/shared/mcp-presets.ts`
- 改打包资源策略: `app/electron-builder.live2d-*.yml`

## 注意事项

- `app/live2d` 下的很多模型可能有作者授权限制，发布全量包前需要确认模型授权。
- `build:live2d:common` 只适合发布通用模型版本。
- `build:live2d:none` 适合不附带任何模型的轻量版。
- 语音识别使用内置 small 中文模型，精度和速度做了折中。
- MCP 写文件、打开应用、读屏等操作涉及权限和隐私，设置里保留了确认机制。
- 当前项目以 Windows 使用场景为主，部分能力如 UIA 读屏、Windows OCR 仅在 Windows 可用。
