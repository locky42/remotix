import * as vscode from 'vscode';
import { SshService } from '../core/SshService';
import { DragAndDropUtils } from './DragAndDropUtils';
import { ConnectionManager } from '../core/ConnectionManager';

export class DragAndDropController implements vscode.TreeDragAndDropController<vscode.TreeItem> {
  readonly dragMimeTypes: string[] = ['application/vnd.code.tree.remotixView'];
  readonly dropMimeTypes: string[] = ['application/vnd.code.tree.remotixView'];

  constructor(private connectionManager: ConnectionManager, private fireChange: () => void) {}

  handleDrag(source: vscode.TreeItem[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): void {
    const payload = DragAndDropUtils.serializeDragItems(source);
    if (payload && payload !== '[]') {
      dataTransfer.set('application/vnd.code.tree.remotixView', new vscode.DataTransferItem(payload));
    }
  }

  async handleDrop(target: vscode.TreeItem | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
    const transfer = dataTransfer.get('application/vnd.code.tree.remotixView');
    const draggedItems = DragAndDropUtils.parseDragTransfer(transfer);
    if (!draggedItems.length) return;

    if (draggedItems.length && draggedItems[0].contextValue === 'connection') {
      if (!target || (target as any).contextValue !== 'connection') return;
      const targetLabel = (target as any).connectionLabel || target.label;
      const draggedLabels = draggedItems.map(i => i.label);
      this.connectionManager.reorder(draggedLabels, targetLabel);
      return;
    }

    if (!target || !['ssh-folder', 'ssh-file'].includes((target as any).contextValue)) return;
    const targetFolder = (target as any).contextValue === 'ssh-folder'
      ? (target as any).sshPath
      : ((target as any).sshPath || '').split('/').slice(0, -1).join('/') || '.';
    const connectionLabel = (target as any).connectionLabel;
    const conn = this.connectionManager.getByLabel(connectionLabel);
    if (!conn) return;
    SshService.moveSftpItems(conn, draggedItems, targetFolder, this.fireChange);
  }
}
