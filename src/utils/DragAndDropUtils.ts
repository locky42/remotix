import * as vscode from 'vscode';

export class DragAndDropUtils {
  static serializeDragItems(source: vscode.TreeItem[]): string {
    const items = source.filter(item => ['connection', 'ssh-file', 'ssh-folder'].includes((item as any).contextValue));
    return JSON.stringify(items.map(i => ({
      contextValue: (i as any).contextValue,
      connectionLabel: (i as any).connectionLabel,
      sshPath: (i as any).sshPath,
      label: i.label
    })));
  }

  static parseDragTransfer(transfer: vscode.DataTransferItem | undefined): any[] {
    if (!transfer) return [];
    try {
      return JSON.parse(transfer.value);
    } catch {
      return Array.isArray(transfer.value) ? transfer.value : [transfer.value];
    }
  }
}
