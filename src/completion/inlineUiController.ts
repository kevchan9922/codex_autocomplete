import * as vscode from 'vscode';
import { codexLog } from '../logging/codexLogger';

type HotkeyNotificationClearReason = 'candidate_returned' | 'timeout' | 'dispose' | 'superseded';
const HOTKEY_NOTICE_DEDUP_MS = 1500;
const HOTKEY_NOTIFICATION_TIMEOUT_MS = 5000;

export class InlineUiController {
  private static activeHotkeyNotification:
    | { clear: (reason: HotkeyNotificationClearReason) => void }
    | undefined;
  private readonly lastRetriggerByEditor = new Map<string, { hash: string; at: number }>();
  private lastEmptyResponseNoticeAt = 0;
  private lastFirstChunkTimeoutNoticeAt = 0;
  private lastPostChunkTimeoutNoticeAt = 0;
  private lastHotkeyTriggeredNoticeAt = 0;

  shouldRetriggerInline(editorKey: string, contextHash: string): boolean {
    const now = Date.now();
    const last = this.lastRetriggerByEditor.get(editorKey);
    if (last && last.hash === contextHash && now - last.at < HOTKEY_NOTICE_DEDUP_MS) {
      return false;
    }
    this.lastRetriggerByEditor.set(editorKey, { hash: contextHash, at: now });
    return true;
  }

  clearEditorState(editorKey: string): void {
    this.lastRetriggerByEditor.delete(editorKey);
  }

  dispose(): void {
    this.clearHotkeyTriggered('dispose');
  }

  notifyEmptyModelResponse(): void {
    const now = Date.now();
    if (now - this.lastEmptyResponseNoticeAt < HOTKEY_NOTICE_DEDUP_MS) {
      return;
    }
    this.lastEmptyResponseNoticeAt = now;
    const message = 'No autocomplete - empty response from model';
    codexLog(`[codex] ${message}`);
    void vscode.window.showInformationMessage(message);
  }

  notifyFirstChunkTimeout(timeoutMs: number): void {
    const now = Date.now();
    if (now - this.lastFirstChunkTimeoutNoticeAt < HOTKEY_NOTICE_DEDUP_MS) {
      return;
    }
    this.lastFirstChunkTimeoutNoticeAt = now;
    const message = `No autocomplete - timed out waiting for first token (${timeoutMs}ms)`;
    codexLog(`[codex] ${message}`);
    void vscode.window.showInformationMessage(message);
  }

  notifyPostChunkTimeout(): void {
    const now = Date.now();
    if (now - this.lastPostChunkTimeoutNoticeAt < HOTKEY_NOTICE_DEDUP_MS) {
      return;
    }
    this.lastPostChunkTimeoutNoticeAt = now;
    const message = 'No autocomplete - request timed out before a usable completion was produced';
    codexLog(`[codex] ${message}`);
    void vscode.window.showInformationMessage(message);
  }

  notifyHotkeyTriggered(): void {
    this.showHotkeyNotification('Generating suggestion…', 'generating suggestion');
  }

  notifyHotkeyRetrying(): void {
    this.showHotkeyNotification('Auto-retrying…', 'auto-retrying suggestion', true, {
      notifyEmptyOnTimeout: true,
    });
  }

  private showHotkeyNotification(
    message: string,
    logLabel: string,
    forceRefresh = false,
    options?: {
      notifyEmptyOnTimeout?: boolean;
    },
  ): void {
    const now = Date.now();
    if (!forceRefresh && now - this.lastHotkeyTriggeredNoticeAt < HOTKEY_NOTICE_DEDUP_MS) {
      return;
    }
    this.lastHotkeyTriggeredNoticeAt = now;
    this.clearHotkeyTriggered('superseded');

    const progressLocation = vscode as typeof vscode & {
      ProgressLocation?: { Notification?: unknown };
    };
    const windowWithProgress = vscode.window as typeof vscode.window & {
      withProgress?: <T>(
        options: { location: unknown; title?: string; cancellable?: boolean },
        task: () => Promise<T> | T,
      ) => Promise<T>;
    };
    if (
      typeof windowWithProgress.withProgress === 'function'
      && progressLocation.ProgressLocation?.Notification !== undefined
    ) {
      codexLog(`[codex] showing ${logLabel} notification mode=progress`);
      let resolveNotification: (() => void) | undefined;
      const completion = new Promise<void>((resolve) => {
        resolveNotification = resolve;
      });
      const timeoutHandle = setTimeout(() => {
        codexLog(
          `[codex] ${logLabel} notification timeout reached (${HOTKEY_NOTIFICATION_TIMEOUT_MS}ms)`,
        );
        this.clearHotkeyTriggered('timeout');
      }, HOTKEY_NOTIFICATION_TIMEOUT_MS);
      let cleared = false;
      const clear = (reason: HotkeyNotificationClearReason) => {
        if (cleared) {
          return;
        }
        cleared = true;
        clearTimeout(timeoutHandle);
        InlineUiController.activeHotkeyNotification = undefined;
        codexLog(`[codex] cleared generating suggestion notification reason=${reason}`);
        resolveNotification?.();
        if (reason === 'timeout' && options?.notifyEmptyOnTimeout) {
          this.notifyEmptyModelResponse();
        }
      };
      InlineUiController.activeHotkeyNotification = { clear };
      void windowWithProgress.withProgress(
        {
          location: progressLocation.ProgressLocation.Notification,
          title: message,
          cancellable: false,
        },
        async () => completion,
      );
      return;
    }

    const windowWithStatusBar = vscode.window as typeof vscode.window & {
      setStatusBarMessage?: (text: string) => vscode.Disposable;
    };
    if (typeof windowWithStatusBar.setStatusBarMessage === 'function') {
      codexLog(`[codex] showing ${logLabel} notification mode=status_bar`);
      const statusMessage = windowWithStatusBar.setStatusBarMessage(message);
      const timeoutHandle = setTimeout(() => {
        codexLog(
          `[codex] ${logLabel} notification timeout reached (${HOTKEY_NOTIFICATION_TIMEOUT_MS}ms)`,
        );
        this.clearHotkeyTriggered('timeout');
      }, HOTKEY_NOTIFICATION_TIMEOUT_MS);
      let cleared = false;
      const clear = (reason: HotkeyNotificationClearReason) => {
        if (cleared) {
          return;
        }
        cleared = true;
        clearTimeout(timeoutHandle);
        statusMessage.dispose();
        InlineUiController.activeHotkeyNotification = undefined;
        codexLog(`[codex] cleared generating suggestion notification reason=${reason}`);
        if (reason === 'timeout' && options?.notifyEmptyOnTimeout) {
          this.notifyEmptyModelResponse();
        }
      };
      InlineUiController.activeHotkeyNotification = { clear };
      return;
    }
    codexLog(`[codex] showing ${logLabel} notification mode=info_message`);
    void vscode.window.showInformationMessage(message);
  }

  clearHotkeyTriggered(reason: HotkeyNotificationClearReason = 'candidate_returned'): void {
    InlineUiController.activeHotkeyNotification?.clear(reason);
  }
}
