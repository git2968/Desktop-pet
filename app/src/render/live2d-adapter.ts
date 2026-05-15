import * as PIXI from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display-lipsyncpatch/cubism4';

// pixi-live2d-display 内部从 window.PIXI 读 Ticker 等;不挂会运行时报错。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).PIXI = PIXI;

export const LIVE2D_TARGET_FPS = 60;

// 把 PIXI Ticker 注册给 Live2DModel,自动驱动动画与物理。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
Live2DModel.registerTicker(PIXI.Ticker as any);
PIXI.Ticker.shared.maxFPS = LIVE2D_TARGET_FPS;

/** 仅加载并返回 Live2DModel,不 addChild。stage 操作由调用方负责,避免 race。 */
export async function loadLive2D(url: string, ticker: PIXI.Ticker = PIXI.Ticker.shared): Promise<Live2DModel> {
  return Live2DModel.from(url, {
    autoHitTest: false,
    autoFocus: false,
    ticker,
  });
}

/**
 * 基于 PIXI getBounds() 实际像素 bounds 把模型居中并缩放。
 * 与 Cubism 的 origin 是否在中心无关,getBounds() 会反映真实屏幕矩形。
 *
 * 步骤:
 * 1) 复位 scale=1 + position=(0,0)
 * 2) 拿 raw bounds(此时是模型在 1x scale 时的屏幕矩形)
 * 3) 按 contain 模式算 fit;给 0.9 边距
 * 4) 应用 scale,再次拿 bounds,平移 model 让 bounds 中心对齐 stage 中心
 */
export function fitAndCenterModel(
  app: PIXI.Application,
  /** 接受 Live2DModel / 任意 PIXI.Container(包括 sprite-adapter 的 view) */
  model: PIXI.Container,
  /** 用户额外缩放系数(滚轮等):默认 1。会乘到自动 fit 之上。 */
  userScale: number = 1,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: any = model;
  // 用 app.screen(CSS 像素 = stage 坐标系),不是 renderer.width/height(那是 backbuffer 物理像素)
  const stageW = app.screen.width;
  const stageH = app.screen.height;

  m.scale.set(1);
  m.position.set(0, 0);
  const raw = m.getBounds() as PIXI.Rectangle;
  if (!(raw.height > 0) || !(raw.width > 0)) {
    // eslint-disable-next-line no-console
    console.warn('[fit] raw bounds invalid', JSON.stringify(raw));
    return;
  }

  const fit = Math.min((stageW * 0.9) / raw.width, (stageH * 0.9) / raw.height) * userScale;
  m.scale.set(fit);

  const bs = m.getBounds() as PIXI.Rectangle;
  // 让 bs 中心 == stage 中心:m.position 偏移 = 期望中心 - 当前中心
  const cx = bs.x + bs.width / 2;
  const cy = bs.y + bs.height / 2;
  m.x += stageW / 2 - cx;
  // 视觉重心微调:整体上移 5% 高度。原因有二:
  //   ① 模型 bounds 中心通常偏高,这样人眼看起来才在容器中央
  //   ② Windows 任务栏 40~50px 高,`workArea` 理论上已扣除,但高 DPI / 自动隐藏 / 用户拖动后
  //      可能仍被遮到脚 — 上移留底部更多安全区
  m.y += stageH / 2 - cy - stageH * 0.05;

  // 调试日志已移除(高频 console 影响性能);需要时可在此再加 console.log
  void bs;
}
