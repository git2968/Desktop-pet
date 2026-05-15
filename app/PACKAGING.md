# 打包模式

Live2D 资产按构建配置拆成三种模式:

```bash
npm run build:live2d:all      # 打包 app/live2d 下全部分类
npm run build:live2d:common   # 只打包 app/live2d/通用
npm run build:live2d:none     # 不打包任何 Live2D 模型
```

兼容旧脚本:

```bash
npm run build          # 等同 build:live2d:all
npm run build:personal # 等同 build:live2d:all
npm run build:public   # 等同 build:live2d:none
```

输出目录:

- `dist-app/live2d-all`
- `dist-app/live2d-common`
- `dist-app/live2d-none`

对应配置文件:

- `electron-builder.live2d-all.yml`
- `electron-builder.live2d-common.yml`
- `electron-builder.live2d-none.yml`
