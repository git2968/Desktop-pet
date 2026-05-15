import type { Model, KaldiRecognizer } from 'vosk-browser';

/**
 * 共享 vosk 工具:
 *   - 单例模型加载(避免多处语音输入各加载一份,节省内存)
 *   - 物理麦克风选择(绕过 Windows default/communications endpoint 静音陷阱)
 */

/** 内置 small 中文模型 URL,通过 pet:// 协议从 app/VOSK/ 或 resourcesPath/VOSK/ 加载 */
export const VOSK_MODEL_URL = 'pet://vosk-builtin/vosk-model-small-cn-0.22.zip';

let modelPromise: Promise<Model> | null = null;
let cachedModel: Model | null = null;
let cachedModelUrl: string | null = null;
let voskModulePromise: Promise<typeof import('vosk-browser')> | null = null;
let modelVersion = 0;
let scheduledReleaseTimer: number | null = null;
const recognizerRefs = new Map<Model, number>();
const retiredModels = new Set<Model>();

function loadVoskRuntime(): Promise<typeof import('vosk-browser')> {
  if (!voskModulePromise) {
    voskModulePromise = import('vosk-browser');
  }
  return voskModulePromise;
}

/** 全局加载状态 — 任何地方都能 getVoskState() 拿当前状态,
 *  状态变化时通过 'pet:vosk-state' window event 广播,UI(设置面板 / 全局 toast)监听。 */
export type VoskState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };
let currentState: VoskState = { kind: 'idle' };
function setState(next: VoskState): void {
  currentState = next;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('pet:vosk-state', { detail: next }));
  }
}
export function getVoskState(): VoskState {
  return currentState;
}

function terminateModel(model: Model): void {
  retiredModels.delete(model);
  recognizerRefs.delete(model);
  try {
    model.terminate?.();
  } catch {
    // ignore
  }
  try {
    // vosk-browser keeps the WASM heap in a private Worker. terminate() only
    // posts a library message, so stop the Worker too to return memory promptly.
    (model as unknown as { worker?: { terminate?: () => void } }).worker?.terminate?.();
  } catch {
    // ignore
  }
  try {
    (model as unknown as { messagePort?: { close?: () => void } }).messagePort?.close?.();
  } catch {
    // ignore
  }
}

function releaseModelWhenUnused(model: Model): void {
  if ((recognizerRefs.get(model) ?? 0) > 0) {
    retiredModels.add(model);
    return;
  }
  terminateModel(model);
}

function cancelScheduledVoskRelease(): void {
  if (scheduledReleaseTimer == null) return;
  window.clearTimeout(scheduledReleaseTimer);
  scheduledReleaseTimer = null;
}

function retireCachedModel(): void {
  const model = cachedModel;
  cachedModel = null;
  if (model) releaseModelWhenUnused(model);
}

function trackRecognizer(model: Model, recognizer: KaldiRecognizer): void {
  recognizerRefs.set(model, (recognizerRefs.get(model) ?? 0) + 1);
  const originalRemove = recognizer.remove?.bind(recognizer);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const next = Math.max(0, (recognizerRefs.get(model) ?? 1) - 1);
    if (next > 0) {
      recognizerRefs.set(model, next);
      return;
    }
    recognizerRefs.delete(model);
    if (retiredModels.has(model)) terminateModel(model);
  };
  recognizer.remove = () => {
    try {
      originalRemove?.();
    } finally {
      release();
    }
  };
}

/** 监听 cfg.voskCustomModelFile 变化 — 用户从设置面板换 / 删模型时重置缓存,
 *  下一次 loadVoskModel 重建。listener 只挂一次(模块级幂等)。 */
let listenerInstalled = false;
function installCfgListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  if (typeof window !== 'undefined') {
    window.addEventListener('petAI:configChanged', () => {
      // 简单粗暴:配置变了就 invalidate,下一次 load 重新拉。
      // 真要精细可以先比对 URL,但 vosk 模型加载本来就是 5-10s 的事,
      // 设置面板里改 voskCustomModelFile 不频繁,惰性重建就够了。
      void resolveModelUrl().then((u) => {
        if (u !== cachedModelUrl) {
          invalidateVoskModel();
        }
      });
    });
  }
}

/** 显式失效缓存 — 设置面板换 / 删模型后调用,下次 loadVoskModel 会重建。
 *  也供 UI 在上传成功后主动 await loadVoskModel() 拿到加载完成时机。 */
export function invalidateVoskModel(): void {
  modelVersion += 1;
  modelPromise = null;
  cachedModelUrl = null;
  retireCachedModel();
  setState({ kind: 'idle' });
}

/** Release the preheated/shared model when no voice feature needs it anymore. */
export function releaseVoskModel(): void {
  cancelScheduledVoskRelease();
  invalidateVoskModel();
}

/** Release the shared Vosk model after a short idle period.
 *  Manual dictation can reload it on demand. */
export function scheduleVoskModelRelease(delayMs: number = 60_000): void {
  cancelScheduledVoskRelease();
  scheduledReleaseTimer = window.setTimeout(() => {
    scheduledReleaseTimer = null;
    releaseVoskModel();
  }, delayMs);
}

/** 决定本次该加载哪个模型 URL — 优先用户上传的自定义,fallback 内置 small */
async function resolveModelUrl(): Promise<string> {
  try {
    const info = await window.petAPI?.voskGetCustomModelInfo?.();
    if (info?.hasCustom && info.fileName) {
      // pet:// 协议主进程从 userData/vosk/ 读
      return `pet://vosk-user/${encodeURIComponent(info.fileName)}`;
    }
  } catch {
    // ipc 没接入(单元测试等场景)→ 走内置
  }
  return VOSK_MODEL_URL;
}

/** 获取(并缓存)vosk 模型。第一次调约 5-10s,之后立即 resolve。
 *  vosk-browser 不允许并发 createModel,所以这里直接 promise 复用。 */
export function loadVoskModel(): Promise<Model> {
  cancelScheduledVoskRelease();
  installCfgListener();
  if (cachedModel?.ready) {
    return Promise.resolve(cachedModel);
  }
  if (!modelPromise) {
    setState({ kind: 'loading' });
    const version = modelVersion;
    const loadPromise = (async () => {
      const url = await resolveModelUrl();
      if (version !== modelVersion) {
        throw new Error('Vosk model load was superseded');
      }
      cachedModelUrl = url;
      const { createModel } = await loadVoskRuntime();
      const model = await createModel(url);
      if (version !== modelVersion) {
        terminateModel(model);
        throw new Error('Vosk model load was superseded');
      }
      cachedModel = model;
      cachedModelUrl = url;
      setState({ kind: 'ready' });
      return model;
    })();
    modelPromise = loadPromise.catch((e) => {
      // 失败时清空,允许下次重试;同时把错误状态广播出去
      if (version === modelVersion) {
        modelPromise = null;
        cachedModel = null;
        cachedModelUrl = null;
        setState({ kind: 'error', message: (e as Error).message || String(e) });
      }
      throw e;
    });
  }
  return modelPromise;
}

/** 创建一个 KaldiRecognizer。若 cached model 因为某种原因被 terminate(比如热更新残留),
 *  自动重置缓存并重 createModel 一次。返回 [model, recognizer],调用方负责 recognizer.remove(),
 *  绝对不要 model.terminate()(共享的)。 */
export async function createRecognizer(sampleRate: number): Promise<{ model: Model; recognizer: KaldiRecognizer }> {
  let model = await loadVoskModel();
  try {
    const recognizer = new model.KaldiRecognizer(sampleRate);
    trackRecognizer(model, recognizer);
    return { model, recognizer };
  } catch (e) {
    const msg = String(e);
    if (/terminated|not ready/i.test(msg)) {
      // model 是僵尸态 — 清掉缓存,重新加载一份
      // eslint-disable-next-line no-console
      console.warn('[vosk-shared] cached model is dead, reloading…', msg);
      invalidateVoskModel();
      model = await loadVoskModel();
      const recognizer = new model.KaldiRecognizer(sampleRate);
      trackRecognizer(model, recognizer);
      return { model, recognizer };
    }
    throw e;
  }
}

export function createSpeechAudioContext(): AudioContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ctx = (window.AudioContext ?? (window as any).webkitAudioContext) as typeof AudioContext;
  try {
    return new Ctx({ sampleRate: 16000 });
  } catch {
    return new Ctx();
  }
}

export function voiceDebugLog(scope: string, ...args: unknown[]): void {
  try {
    if (window.localStorage?.getItem('pet:voice-debug') !== '1') return;
  } catch {
    return;
  }
  // eslint-disable-next-line no-console
  console.log(scope, ...args);
}

/** 选第一个真实物理 mic 的 deviceId。
 *  Windows 上 enumerateDevices 通常列 3 个 audioinput:default / communications / 物理设备。
 *  default 在 VoIP 占用 communications 时会被静音(track.muted=true),用物理 deviceId 绕开。 */
export async function pickPhysicalMicDeviceId(): Promise<string | null> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');
    const physical = mics.find(
      (m) => m.deviceId !== 'default' && m.deviceId !== 'communications',
    );
    return physical?.deviceId ?? null;
  } catch {
    return null;
  }
}

/** 标准 mic 约束 — echoCancellation/noiseSuppression/autoGainControl 全关,
 *  避免某些 Realtek 驱动把信号削成绝对静音。 */
export function buildMicConstraints(deviceId: string | null): MediaStreamConstraints {
  return {
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
      sampleRate: 16000,
    },
  };
}
