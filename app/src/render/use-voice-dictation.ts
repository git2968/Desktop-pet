import { useEffect, useRef } from 'react';
import { type KaldiRecognizer } from 'vosk-browser';
import {
  createRecognizer,
  pickPhysicalMicDeviceId,
  buildMicConstraints,
  createSpeechAudioContext,
  scheduleVoskModelRelease,
  voiceDebugLog,
} from './vosk-shared';

/**
 * 语音听写 hook —— 用 vosk small 中文模型把麦克风音频实时转文字,推给调用方。
 *
 * vosk-shared 负责单例模型缓存;本 hook 每次听写创建自己的 KaldiRecognizer 和 mic stream。
 *
 * 调用方典型用法(对话框 🎤 按钮):
 *   useVoiceDictation({
 *     enabled: dictating,
 *     onPartial: (txt) => setInput(txt),       // 实时文本流入输入框
 *     onFinal: (txt) => { setInput(txt); send(); },  // vosk 检测到一段语音结束 → 自动发送
 *   });
 *
 * enabled 由 false→true:加载 model(若已缓存即时)→ 拿 mic → 起 audio pipeline
 * enabled 由 true→false:停 audio pipeline + 释放 mic(model 留缓存)
 */

interface Args {
  enabled: boolean;
  /** 实时(流式)识别结果 — vosk partial,每帧可能更新。空字符串表示重置(一句话刚结束)。 */
  onPartial?: (text: string) => void;
  /** vosk 标记一段语音结束时的最终文本。 */
  onFinal?: (text: string) => void;
  /** mic 拒绝 / model 加载失败 */
  onError?: (msg: string) => void;
}

export function useVoiceDictation({ enabled, onPartial, onFinal, onError }: Args): void {
  // 用 ref 持最新 callback,避免 callback 引用变化触发整个 pipeline 重建。
  const onPartialRef = useRef(onPartial);
  const onFinalRef = useRef(onFinal);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onPartialRef.current = onPartial;
    onFinalRef.current = onFinal;
    onErrorRef.current = onError;
  });

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;
    let processorNode: ScriptProcessorNode | null = null;
    let recognizer: KaldiRecognizer | null = null;

    const log = (...args: unknown[]) => {
      voiceDebugLog('[voice-dictation]', ...args);
    };

    (async () => {
      const deviceId = await pickPhysicalMicDeviceId();
      try {
        stream = await navigator.mediaDevices.getUserMedia(buildMicConstraints(deviceId));
      } catch (e) {
        log('mic denied:', e);
        onErrorRef.current?.(`麦克风获取失败: ${(e as Error)?.message ?? e}`);
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      audioCtx = createSpeechAudioContext();
      sourceNode = audioCtx.createMediaStreamSource(stream);

      try {
        const r = await createRecognizer(audioCtx.sampleRate);
        recognizer = r.recognizer;
      } catch (e) {
        log('createRecognizer failed:', e);
        onErrorRef.current?.(`模型加载失败: ${(e as Error)?.message ?? e}`);
        try {
          sourceNode?.disconnect();
        } catch {
          // ignore
        }
        try {
          void audioCtx?.close();
        } catch {
          // ignore
        }
        stream?.getTracks().forEach((t) => t.stop());
        sourceNode = null;
        audioCtx = null;
        stream = null;
        return;
      }
      if (cancelled) {
        try {
          recognizer.remove?.();
        } catch {
          // ignore
        }
        recognizer = null;
        return;
      }
      recognizer.setWords?.(false);

      recognizer.on('result', (msg) => {
        const r = (msg as { result?: { text?: string } }).result;
        // vosk 中文 result text 形如 "你 好 魔 女" 带空格,去掉
        const text = (r?.text ?? '').replace(/\s+/g, '');
        if (text) {
          log('final:', text);
          onFinalRef.current?.(text);
        }
      });
      recognizer.on('partialresult', (msg) => {
        const r = (msg as { result?: { partial?: string } }).result;
        const text = (r?.partial ?? '').replace(/\s+/g, '');
        onPartialRef.current?.(text);
      });

      processorNode = audioCtx.createScriptProcessor(4096, 1, 1);
      processorNode.onaudioprocess = (event) => {
        if (!recognizer) return;
        try {
          recognizer.acceptWaveform(event.inputBuffer);
        } catch (err) {
          log('acceptWaveform err:', err);
        }
      };
      sourceNode.connect(processorNode);
      // 连到一个 zero-gain 后再到 destination,驱动 onaudioprocess 但不会回放声音
      const mute = audioCtx.createGain();
      mute.gain.value = 0;
      processorNode.connect(mute);
      mute.connect(audioCtx.destination);

      log('started');
    })();

    return () => {
      cancelled = true;
      try {
        processorNode?.disconnect();
        if (processorNode) processorNode.onaudioprocess = null;
      } catch {
        // ignore
      }
      try {
        sourceNode?.disconnect();
      } catch {
        // ignore
      }
      try {
        void audioCtx?.close();
      } catch {
        // ignore
      }
      stream?.getTracks().forEach((t) => t.stop());
      try {
        recognizer?.remove?.();
      } catch {
        // ignore
      }
      scheduleVoskModelRelease();
    };
    // 故意只依赖 enabled — onPartial/onFinal/onError 用最新闭包(从 ref 读不到必要),
    // 但用户给的是稳定 callback 的话也 OK;不稳定会重建 pipeline,影响小。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}
