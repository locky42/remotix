import * as vscode from 'vscode';
import { FormatHelper } from '../helpers/FormatHelper';

export class LoggerService {
  private static outputChannel: vscode.OutputChannel | undefined;

  static getChannel(): vscode.OutputChannel {
    if (!LoggerService.outputChannel) {
      LoggerService.outputChannel = vscode.window.createOutputChannel('Remotix', 'log');
    }
    return LoggerService.outputChannel;
  }

  static log(data: string, key?: string, type?: 'info' | 'error' | 'warning') {
    const logLevel = vscode.workspace.getConfiguration('remotix').get<string>('logLevel', 'error');
    if (logLevel === 'error' && type !== 'error') {
      return;
    }
    data = FormatHelper.formatData(data);
    const logType = type ? type.toUpperCase() : 'INFO';
    
    const prefix = `${new Date().toISOString().replace('T', ' ').replace('Z', '')} [${logType}] [${key || 'Remotix'}] `;
    const message = `${prefix}${data}`;
    LoggerService.getChannel().appendLine(message);
  }
}
