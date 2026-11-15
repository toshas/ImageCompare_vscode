// When an open session tab reloads from its edited file (no vscode): debounce, byte compare, one open at a time (docs/session-files.md: session-edit-reloads).
import { AimTimers } from './sweepAimPolicy';

/** The trailing-edge wait after a watcher event or a tab activation, before the file is read. */
export const SESSION_RELOAD_DEBOUNCE_MS = 250;

/** What the host supplies: timer primitives, a read of the session file, and a reload of the tab from new text. */
export interface SessionReloadIo {
  timers: AimTimers;
  read(): Promise<string>;
  reload(text: string): Promise<void>;
}

/** One per resolved session tab, armed after the initial open with the text that open read (docs/session-files.md: session-edit-reloads). */
export class SessionReloadGate {
  private pending?: unknown;
  private running = false;
  private again = false;
  private disposed = false;

  constructor(private readonly io: SessionReloadIo, private loaded: string | undefined) {}

  /** A watcher event or the tab becoming active: the check runs on the trailing edge. */
  trigger(): void {
    if (this.disposed) return;
    if (this.pending !== undefined) this.io.timers.clearTimer(this.pending);
    this.pending = this.io.timers.setTimer(() => {
      this.pending = undefined;
      void this.check();
    }, SESSION_RELOAD_DEBOUNCE_MS);
  }

  private async check(): Promise<void> {
    if (this.disposed) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      let text: string;
      try {
        text = await this.io.read();
      } catch {
        return;
      }
      if (this.disposed || text === this.loaded) return;
      this.loaded = text;
      await this.io.reload(text);
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        void this.check();
      }
    }
  }

  /** Tab closed: the pending debounce is cleared, and no later read or reload runs. */
  dispose(): void {
    this.disposed = true;
    if (this.pending !== undefined) this.io.timers.clearTimer(this.pending);
    this.pending = undefined;
  }
}
