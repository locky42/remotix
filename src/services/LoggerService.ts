import * as vscode from 'vscode';

export class LoggerService {
  private static outputChannel: vscode.OutputChannel | undefined;

  static getChannel(): vscode.OutputChannel {
    if (!LoggerService.outputChannel) {
      LoggerService.outputChannel = vscode.window.createOutputChannel('Remotix');
    }
    return LoggerService.outputChannel;
  }

  static log(msg: string) {
    LoggerService.getChannel().appendLine(msg);
  }

  static logObject(label: string, obj: any) {
    LoggerService.getChannel().appendLine(`${label}: ${JSON.stringify(obj, null, 2)}`);
  }

  static show() {
    LoggerService.getChannel().show(true);
  }
}
