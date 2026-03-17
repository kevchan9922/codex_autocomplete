import * as vscode from 'vscode';

export const DEBUG_OUTPUT_CHANNEL_NAME = 'Codex Autocomplete Debug';

let debugOutputChannel: vscode.OutputChannel | undefined;

export function getDebugOutputChannel(): vscode.OutputChannel {
  if (!debugOutputChannel) {
    debugOutputChannel = vscode.window.createOutputChannel(DEBUG_OUTPUT_CHANNEL_NAME);
  }
  return debugOutputChannel;
}

export function resetDebugOutputChannelForTests(): void {
  debugOutputChannel = undefined;
}
