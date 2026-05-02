import * as vscode from 'vscode';
import { LangService } from '../services/LangService';
import { RemotePathHelper } from './RemotePathHelper';

export class PropertiesDialogHelper {
  static getRemotePathOrNotify(item: any): string | undefined {
    const remotePath = String(item?.sshPath || item?.ftpPath || '').trim();
    if (!remotePath) {
      vscode.window.showErrorMessage(LangService.t('missingPathOrConnection'));
      return undefined;
    }
    return remotePath;
  }

  static getLeafName(remotePath: string): string {
    return RemotePathHelper.getRemoteLeafName(remotePath) || remotePath;
  }

  static async showPropertiesQuickPick(
    remotePath: string,
    leafName: string,
    items: vscode.QuickPickItem[]
  ): Promise<void> {
    await vscode.window.showQuickPick(items, {
      title: LangService.t('propertiesTitle', { name: leafName }),
      placeHolder: remotePath,
      ignoreFocusOut: true,
    });
  }
}
