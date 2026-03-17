import * as vscode from 'vscode';
import { codexDebug } from '../logging/codexLogger';

export type InlineTriggerMode = 'automatic' | 'hotkey';

export interface TriggerEvaluation {
  allowed: boolean;
  explicitHotkeyTrigger: boolean;
  triggerKindLabel: 'invoke' | 'automatic';
}

// Keep this aligned with the documented/manual hotkey default used elsewhere.
const MANUAL_TRIGGER_WINDOW_MS = 1200;

export class InlineTriggerGate {
  private manualTriggerUntil = 0;

  constructor(private readonly mode: InlineTriggerMode) {}

  evaluateRequest(
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): TriggerEvaluation {
    const triggerKindLabel: TriggerEvaluation['triggerKindLabel'] =
      context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke
        ? 'invoke'
        : 'automatic';

    codexDebug(
      `[codex] inline request received mode=${this.mode} trigger=${triggerKindLabel}`,
    );

    if (token.isCancellationRequested) {
      codexDebug('[codex] inline request skipped: vscode token already cancelled');
      return { allowed: false, explicitHotkeyTrigger: false, triggerKindLabel };
    }

    if (this.mode !== 'hotkey') {
      return { allowed: true, explicitHotkeyTrigger: false, triggerKindLabel };
    }

    if (triggerKindLabel === 'automatic' && this.consumeManualTriggerWindow()) {
      codexDebug(
        '[codex] inline request accepted in hotkey mode via automatic fallback trigger',
      );
      return { allowed: true, explicitHotkeyTrigger: true, triggerKindLabel };
    }

    if (triggerKindLabel === 'invoke' && this.consumeManualTriggerWindow()) {
      codexDebug(
        `[codex] inline request accepted in hotkey mode via manual trigger window (trigger=${triggerKindLabel})`,
      );
      return { allowed: true, explicitHotkeyTrigger: true, triggerKindLabel };
    }

    codexDebug(
      `[codex] inline request skipped: hotkey mode requires explicit hotkey command (got ${triggerKindLabel})`,
    );
    return { allowed: false, explicitHotkeyTrigger: false, triggerKindLabel };
  }

  markManualTriggerWindow(durationMs = MANUAL_TRIGGER_WINDOW_MS): void {
    this.manualTriggerUntil = Date.now() + durationMs;
  }

  private hasManualTriggerWindow(): boolean {
    return this.manualTriggerUntil >= Date.now();
  }

  private consumeManualTriggerWindow(): boolean {
    if (!this.hasManualTriggerWindow()) {
      return false;
    }
    this.manualTriggerUntil = 0;
    return true;
  }
}
