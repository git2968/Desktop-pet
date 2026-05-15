# Desktop Pet App

这是 Desktop Pet 的应用源码目录。项目基于 Electron、React、TypeScript、PIXI 和 Live2D，支持 Live2D 桌宠、Codex `hatch-pet` 桌宠、AI 对话、角色人设、MCP 工具和语音输入。

如果你是从仓库根目录阅读项目，完整说明见 [../README.md](../README.md)。

## 效果预览

| 桌宠展示 | 角色选择 |
| --- | --- |
| ![桌宠展示 1](picture/展示1.png) | ![选择角色](picture/选择角色.png) |

| 对话效果 | AI 设置 |
| --- | --- |
| ![对话 1](picture/对话01.png) | ![AI 设置](picture/ai设置.png) |

| 对话与工具 | 设置面板 |
| --- | --- |
| ![对话 2](picture/对话02.png) | ![设置](picture/设置.png) |

![桌宠展示 2](picture/展示2.png)

## 开发

```bash
npm install
npm run dev
```

## 类型检查

```bash
npm run typecheck
```

## 打包

```bash
npm run build:live2d:none
npm run build:live2d:common
npm run build:live2d:all
```

更细分的打包配置：

```bash
npx electron-builder --config electron-builder.models-all.yml
npx electron-builder --config electron-builder.models-no-abstract-naruto.yml
npx electron-builder --config electron-builder.models-common-maodie.yml
```

## 模型资源

Hatch-Pet 资源格式：

```text
hatch-pet/<角色名>/pet.json
hatch-pet/<角色名>/spritesheet.webp
```

Live2D 本地模型目录：

```text
live2d/<分类>/<模型名>/xxx.model3.json
```

开源仓库保留 `live2d/.gitkeep`，但不会上传 `live2d` 里的模型文件。`hatch-pet` 目录只上传 `耄耋` 和 `万津莫` 两个示例。

## 素材说明

源码可以按 MIT License 开源，但模型、图片、音频、字体和第三方角色素材不一定属于 MIT License。上传或分发前请确认素材授权。

