/**
 * 主动互动增强 — 后台监听前台应用变化,触发桌宠主动搭话。
 *
 * 责任:
 *   1. 每 N 秒拉一次 active window(get-windows 包),拿当前前台应用名 / 标题
 *   2. 与上次比较,识别"切换"事件 / "长时间停留"事件
 *   3. 满足触发条件 → 通过 webContents.send 推 'pet:proactive-app-event' 给渲染端
 *   4. 渲染端在 use-proactive-greetings 里接到事件后调 AI 生成一句话主动搭话
 *
 * 触发限制:
 *   - 桌宠窗口隐藏 / 模型隐藏 → 不触发(由渲染端自己判断,主进程只负责发事件)
 *   - 应用切换冷却 5 分钟(避免频繁切窗导致刷屏)
 *   - 长停留触发后,该应用本次会话不再触发(切走再切回才重新计时)
 *   - 桌宠自身窗口不触发(把"electron / Desktop Pet" 排除掉)
 */
import type { BrowserWindow } from 'electron';
import { loadConfig, getProactiveConfig } from './config-store.js';

/** 轮询间隔(毫秒)。8 秒在体验和性能之间折中:用户切窗后大致 8s 内能感知。 */
const POLL_MS = 8_000;
/** 应用切换互动的最小冷却:5 分钟。同一应用在该窗口内不会重复触发"切换"事件。 */
const SWITCH_COOLDOWN_MS = 5 * 60 * 1000;
/** 启动后 8 秒内不触发任何互动,避开冷启动应用列表抖动 */
const STARTUP_GRACE_MS = 8_000;

interface AppInfo {
  /** 标准化后的应用名(小写、去后缀),如 'code' / 'msedge' / 'devenv' */
  app: string;
  /** 用户视角的友好名,如 'VS Code' / 'Microsoft Edge' */
  friendly: string;
  /** 当前窗口标题(可作为额外 context;隐私敏感,渲染端只用来分类) */
  title: string;
}

/** 把 get-windows 的 owner.name(如 'Code.exe')→ 友好名映射。
 *  缺失项原样显示。 */
const FRIENDLY_NAMES: Record<string, string> = {
  'code': 'VS Code',
  'cursor': 'Cursor',
  'windsurf': 'Windsurf',
  'msedge': 'Microsoft Edge',
  'chrome': 'Google Chrome',
  'firefox': 'Firefox',
  'devenv': 'Visual Studio',
  'idea64': 'IntelliJ IDEA',
  'pycharm64': 'PyCharm',
  'webstorm64': 'WebStorm',
  'goland64': 'GoLand',
  'rider64': 'Rider',
  'explorer': '资源管理器',
  'wechat': '微信',
  'qq': 'QQ',
  'tim': 'TIM',
  'feishu': '飞书',
  'dingtalk': '钉钉',
  'notion': 'Notion',
  'obsidian': 'Obsidian',
  'wpsoffice': 'WPS Office',
  'winword': 'Word',
  'excel': 'Excel',
  'powerpnt': 'PowerPoint',
  'photoshop': 'Photoshop',
  'figma': 'Figma',
  'spotify': 'Spotify',
  'qqmusic': 'QQ 音乐',
  'cloudmusic': '网易云音乐',
  'powershell': 'PowerShell',
  'cmd': '命令提示符',
  'windowsterminal': 'Windows Terminal',
  'wt': 'Windows Terminal',
};

/** 桌宠自己的窗口名 — 不能把切到桌宠当作"应用切换"触发自己 */
const SELF_NAMES = new Set(['electron', 'desktoppet', 'desktop pet']);

function normalizeAppName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\.exe$/i, '')
    .replace(/\s+/g, '')
    .trim();
}
function friendlyOf(app: string): string {
  return FRIENDLY_NAMES[app] ?? app;
}

class ProactiveAware {
  private timer: NodeJS.Timeout | null = null;
  private lastApp: string | null = null;
  /** 当前停留应用进入前台的时刻(毫秒)。切换时重置 */
  private appEnteredAt = 0;
  /** 上次"切换"互动触发时间。冷却用 */
  private lastSwitchFireAt = 0;
  /** ProactiveAware 启动时刻 — 启动后 STARTUP_GRACE_MS 内不触发,避免冷启动刷屏 */
  private startedAt = 0;
  /** 已经在当前应用上触发过"长停留"互动 → 切走后才能重新触发 */
  private longStayFired = false;
  /** 推事件用的渲染窗口 */
  private win: BrowserWindow | null = null;

  attach(win: BrowserWindow): void {
    this.win = win;
  }
  detach(): void {
    this.win = null;
    this.stop();
  }

  /** 启动轮询。如果 config.proactive.enabled=false 直接 noop。 */
  start(): void {
    if (this.timer) return;
    const cfg = getProactiveConfig(loadConfig());
    if (!cfg.enabled) return;
    if (!cfg.awareApps && !cfg.awareLongStay) return;
    this.startedAt = Date.now();
    // eslint-disable-next-line no-console
    console.log('[proactive] started; pollMs=', POLL_MS);
    void this.tick(); // 立刻跑一次,后续按 POLL_MS
    this.timer = setInterval(() => void this.tick(), POLL_MS);
  }
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.lastApp = null;
    this.appEnteredAt = 0;
    this.longStayFired = false;
  }
  /** 配置变更后调一下 — 内部根据新 config 决定继续轮询还是停 */
  refresh(): void {
    const cfg = getProactiveConfig(loadConfig());
    const wantRun = cfg.enabled && (cfg.awareApps || cfg.awareLongStay);
    if (wantRun && !this.timer) this.start();
    else if (!wantRun && this.timer) this.stop();
  }

  private async fetchActiveWindow(): Promise<AppInfo | null> {
    try {
      // 动态 import 避免主进程启动时就加载 native 模块
      const mod = (await import('get-windows')) as typeof import('get-windows');
      const w = await mod.activeWindow();
      if (!w || !w.owner) return null;
      const ownerRaw = (w.owner.name ?? '').trim();
      if (!ownerRaw) return null;
      const app = normalizeAppName(ownerRaw);
      return { app, friendly: friendlyOf(app), title: w.title ?? '' };
    } catch (e) {
      // get-windows 偶尔失败(权限 / API 异常),safely 跳过本轮
      // eslint-disable-next-line no-console
      console.warn('[proactive] activeWindow failed:', (e as Error).message);
      return null;
    }
  }

  private async tick(): Promise<void> {
    const cfg = getProactiveConfig(loadConfig());
    if (!cfg.enabled) return;
    const info = await this.fetchActiveWindow();
    if (!info) return;
    if (SELF_NAMES.has(info.app)) {
      // 用户切回桌宠了,不视作"应用切换"。继续观察。
      return;
    }
    const now = Date.now();

    // —— 应用切换检测 ——
    if (this.lastApp !== info.app) {
      this.lastApp = info.app;
      this.appEnteredAt = now;
      this.longStayFired = false;
      // 启动后 STARTUP_GRACE_MS 内不触发(避开冷启动应用列表抖动)
      const inGrace = now - this.startedAt < STARTUP_GRACE_MS;
      if (!inGrace && cfg.awareApps) {
        if (now - this.lastSwitchFireAt >= SWITCH_COOLDOWN_MS) {
          this.lastSwitchFireAt = now;
          // eslint-disable-next-line no-console
          console.log('[proactive] switch →', info.app, '|', info.friendly);
          this.send('switch', info);
        } else {
          // eslint-disable-next-line no-console
          console.log(
            '[proactive] switch skipped (cooldown)',
            info.app,
            'remaining',
            Math.round((SWITCH_COOLDOWN_MS - (now - this.lastSwitchFireAt)) / 1000),
            's',
          );
        }
      }
      return;
    }

    // —— 长停留检测 ——
    if (cfg.awareLongStay && !this.longStayFired) {
      const stayMin = (now - this.appEnteredAt) / 60_000;
      if (stayMin >= Math.max(5, cfg.idleStayMinutes)) {
        this.longStayFired = true;
        this.send('long-stay', info);
      }
    }
  }

  private send(reason: 'switch' | 'long-stay', info: AppInfo): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send('pet:proactive-app-event', {
      reason,
      app: info.app,
      friendly: info.friendly,
      title: info.title,
    });
  }
}

export const proactiveAware = new ProactiveAware();
