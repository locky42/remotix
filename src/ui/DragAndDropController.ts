import * as vscode from 'vscode';
import { Container } from '../services/Container';
import { ConnectionManager } from '../services/ConnectionManager';
import { RemoteServiceProvider } from '../services/RemoteServiceProvider';

export class DragAndDropController implements vscode.TreeDragAndDropController<vscode.TreeItem> {
  readonly dragMimeTypes: string[] = ['application/vnd.code.tree.remotixView'];
  readonly dropMimeTypes: string[] = ['application/vnd.code.tree.remotixView'];
  private dragOverTarget: string | null = null;

  constructor(private connectionManager: ConnectionManager, private fireChange: () => void, private treeDataProvider: any) {}

  handleDrag(source: vscode.TreeItem[], dataTransfer: vscode.DataTransfer): void {
    const isConnectionDrag = source.some(item => ['connection', 'connection-active'].includes(String((item as any).contextValue || '')));
    // Don't set reorder mode here - only set it when needed during drop
    // This prevents flag getting stuck if drag is canceled
    this.dragOverTarget = null; // Reset on new drag

    const payload = DragAndDropController.serializeDragItems(source);
    if (payload && payload !== '[]') {
      dataTransfer.set('application/vnd.code.tree.remotixView', new vscode.DataTransferItem(payload));
    }
  }

  onDragOver(target: vscode.TreeItem | undefined, dataTransfer: vscode.DataTransfer): any {
    const transfer = dataTransfer.get('application/vnd.code.tree.remotixView');
    const draggedItems = DragAndDropController.parseDragTransfer(transfer);
    if (!draggedItems.length) return;

    if (target && ['connection', 'connection-active'].includes(String((target as any).contextValue || ''))) {
      const targetLabel = String((target as any).connectionLabel || target.label || '');
      const draggedLabels = draggedItems
        .map(i => String(i.connectionLabel || i.label || ''))
        .filter(Boolean);
      
      // Just track target, don't update tree yet to avoid reconnects
      if (draggedLabels.length && targetLabel) {
        this.dragOverTarget = targetLabel;
      }
      return;
    } else if (!target && this.dragOverTarget !== null) {
      // Drag left the tree
      this.dragOverTarget = null;
    }
  }

  async handleDrop(target: vscode.TreeItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const transfer = dataTransfer.get('application/vnd.code.tree.remotixView');
    const draggedItems = DragAndDropController.parseDragTransfer(transfer);
    if (!draggedItems.length) return;

    if (draggedItems.length && ['connection', 'connection-active'].includes(String(draggedItems[0].contextValue || ''))) {
      if (!target || !['connection', 'connection-active'].includes(String((target as any).contextValue || ''))) return;
      const targetLabel = String((target as any).connectionLabel || target.label || '');
      const draggedLabels = draggedItems
        .map(i => String(i.connectionLabel || i.label || ''))
        .filter(Boolean);
      if (!targetLabel || !draggedLabels.length) return;
      // Self-drop guard
      if (draggedLabels.length === 1 && draggedLabels[0] === targetLabel) return;
      
      // Ensure suppress flags are set so children fetch is blocked during tree update
      if (this.treeDataProvider) {
        const tdp = this.treeDataProvider as any;
        tdp.suppressConnectionExpand = true;
        tdp.isReordering = true;
        tdp.suppressOnChangeCallback = true;
      }
      
      // Do reorder (saves to config)
      this.connectionManager.reorder(draggedLabels, targetLabel);
      
      // Clear drag tracking FIRST (before fireChange, so preview is gone when tree re-renders)
      this.dragOverTarget = null;
      this.treeDataProvider?.setPreviewConnectionOrder?.(null);
      
      // Fire tree update NOW while suppress is still true - VS Code will redraw root list
      // but getChildren() for connections will return [] (blocked by suppressConnectionExpand)
      if (typeof this.fireChange === 'function') {
        this.fireChange();
      }
      
      // After a short delay, clear all suppress flags and re-render connections
      setTimeout(() => {
        if (this.treeDataProvider) {
          const tdp = this.treeDataProvider as any;
          tdp.isReordering = false;
          tdp.suppressConnectionExpand = false;
          tdp.suppressOnChangeCallback = false;
          if (tdp.suppressConnectionExpandTimeout) {
            clearTimeout(tdp.suppressConnectionExpandTimeout);
            tdp.suppressConnectionExpandTimeout = undefined;
          }
          // Re-render so getTreeItem() restores collapsibleState and command on connections
          if (typeof this.fireChange === 'function') {
            this.fireChange();
          }
        }
      }, 200);
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
    
    // Use onDone callback to refresh after moveItems completes
    await remoteService.moveItems(validDraggedItems, targetFolder, () => {
      // onDone callback
    });
    // Always refresh tree after moveItems completes
    if (typeof this.fireChange === 'function') this.fireChange();
  }

  private static serializeDragItems(source: vscode.TreeItem[]): string {
    const items = source.filter(item => ['connection', 'connection-active', 'ssh-file', 'ssh-folder', 'ftp-file', 'ftp-folder'].includes((item as any).contextValue));
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
