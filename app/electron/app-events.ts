import { EventEmitter } from 'node:events';

export type AppEventPayload = {
  reason: string;
  [key: string]: unknown;
};

class DesktopPetAppEvents extends EventEmitter {
  emitConfigChanged(reason: string, extra: Record<string, unknown> = {}): void {
    this.emit('configChanged', { reason, ...extra } satisfies AppEventPayload);
  }

  emitSkillsChanged(reason: string, extra: Record<string, unknown> = {}): void {
    this.emit('skillsChanged', { reason, ...extra } satisfies AppEventPayload);
  }
}

export const appEvents = new DesktopPetAppEvents();
