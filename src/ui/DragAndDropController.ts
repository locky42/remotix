import * as vscode from 'vscode';
import { Container } from '../services/Container';
import { ConnectionManager } from '../services/ConnectionManager';
import { RemoteServiceProvider } from '../services/RemoteServiceProvider';

export class DragAndDropController implements vscode.TreeDragAndDropController<vscode.TreeItem> {
  readonly dragMimeTypes: string[] = ['application/vnd.code.tree.remotixView'];
  readonly dropMimeTypes: string[] = ['application/vnd.code.tree.remotixView'];

  constructor(private connectionManager: ConnectionManager, private fireChange: () => void, private treeDataProvider: any) {}

  handleDrag(source: vscode.TreeItem[], dataTransfer: vscode.DataTransfer): void {
    const payload = DragAndDropController.serializeDragItems(source);
    if (payload && payload !== '[]') {
      dataTransfer.set('application/vnd.code.tree.remotixView', new vscode.DataTransferItem(payload));
    }
  }

  async handleDrop(target: vscode.TreeItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    // DEBUG LOG: handleDrop ENTRY
    // @ts-ignore
    if (typeof console !== 'undefined') console.log('[DragAndDropController][DEBUG] handleDrop ENTRY', { target, dataTransfer });
    const transfer = dataTransfer.get('application/vnd.code.tree.remotixView');
    const draggedItems = DragAndDropController.parseDragTransfer(transfer);
    if (!draggedItems.length) return;

    if (draggedItems.length && draggedItems[0].contextValue === 'connection') {
      if (!target || (target as any).contextValue !== 'connection') return;
      const targetLabel = (target as any).connectionLabel || target.label;
      const draggedLabels = draggedItems.map(i => i.label);
      this.connectionManager.reorder(draggedLabels, targetLabel);
      return;
    }

    if (!target || !['ssh-folder', 'ssh-file', 'ftp-folder', 'ftp-file'].includes((target as any).contextValue)) return;
    const targetFolder = (target as any).contextValue.endsWith('folder')
      ? (target as any).sshPath || (target as any).ftpPath
      : ((target as any).sshPath || (target as any).ftpPath || '').split('/').slice(0, -1).join('/') || '.';
    const remoteService = await (Container.get('remoteServiceProvider') as RemoteServiceProvider).getRemoteService((target as any).connectionLabel);
    if (!remoteService || !remoteService.moveItems) return;
    const validDraggedItems = draggedItems.filter((item: any) =>
      ((!!item.sshPath || !!item.ftpPath) && typeof item.connectionLabel === 'string' && !!item.connectionLabel)
    ).map((item: any) => ({
      sshPath: item.sshPath || item.ftpPath,
      connectionLabel: item.connectionLabel
    }));
    
    // @ts-ignore
    if (typeof console !== 'undefined') console.log('[DragAndDropController][DEBUG] Calling moveItems', { validDraggedItems, targetFolder });
    // Use onDone callback to refresh after moveItems completes
    await remoteService.moveItems(validDraggedItems, targetFolder, () => {
      // DEBUG LOG: moveItems finished
      // @ts-ignore
      if (typeof console !== 'undefined') console.log('[DragAndDropController][DEBUG] moveItems finished (onDone)');
    });
    // Always refresh tree after moveItems completes
    if (typeof this.fireChange === 'function') this.fireChange();
  }

  private static serializeDragItems(source: vscode.TreeItem[]): string {
    const items = source.filter(item => ['connection', 'ssh-file', 'ssh-folder', 'ftp-file', 'ftp-folder'].includes((item as any).contextValue));
    return JSON.stringify(items.map(i => ({
      contextValue: (i as any).contextValue,
      connectionLabel: (i as any).connectionLabel,
      sshPath: (i as any).sshPath,
      ftpPath: (i as any).ftpPath,
      label: i.label
    })));
  }

  private static parseDragTransfer(transfer: vscode.DataTransferItem | undefined): any[] {
    if (!transfer) return [];
    try {
      return JSON.parse(transfer.value);
    } catch {
      return Array.isArray(transfer.value) ? transfer.value : [transfer.value];
    }
  }
}
