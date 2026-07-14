import * as vscode from 'vscode';
import { FormatHelper } from '../helpers/FormatHelper';

export class LoggerService {
  private static outputChannel: vscode.OutputChannel | undefined;

  static getChannel(): vscode.OutputChannel {
    if (!LoggerService.outputChannel) {
      LoggerService.outputChannel = vscode.window.createOutputChannel('Tentacle', 'log');
    }
    return LoggerService.outputChannel;
  }

  static log(data: any, key?: string, type?: 'info' | 'error' | 'warning') {
    const logLevel = vscode.workspace.getConfiguration('tentacle').get<string>('logLevel', 'error');
    if (logLevel === 'error' && type !== 'error') {
      return;
    }
    data = FormatHelper.formatData(data);
    const logType = type ? type.toUpperCase() : 'INFO';
    
    const prefix = `${new Date().toISOString().replace('T', ' ').replace('Z', '')} [${logType}] [${key || 'Tentacle'}] `;
    const message = `${prefix}${data}`;
    LoggerService.getChannel().appendLine(message);
  }
}
