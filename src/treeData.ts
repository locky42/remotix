import * as vscode from 'vscode';
import { ConnectionItem } from './types';
import { ConnectionManager } from './core/ConnectionManager';
import { TreeItemFactory } from './core/TreeItemFactory';
// @ts-ignore
import { SshService } from './core/SshService';
import { DragAndDropController } from './utils/DragAndDropController';
import { getGlobalConfig } from './config';

export class RemotixTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.TreeDragAndDropController<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData: vscode.Event<void> = this._onDidChangeTreeData.event;
  private connectionManager: ConnectionManager;

  readonly dragAndDropController: DragAndDropController;
    get dragMimeTypes(): string[] {
      return this.dragAndDropController.dragMimeTypes;
    }

    get dropMimeTypes(): string[] {
      return this.dragAndDropController.dropMimeTypes;
    }
  private itemFactory: TreeItemFactory;

  constructor(context: vscode.ExtensionContext) {
    const connections = getGlobalConfig(context).connections;
    this.connectionManager = new ConnectionManager(connections, () => this._onDidChangeTreeData.fire());
    this.itemFactory = new TreeItemFactory();
    this.dragAndDropController = new DragAndDropController(this.connectionManager, () => this._onDidChangeTreeData.fire());
  }
  

  // Delegate drag-and-drop to controller
  handleDrag?(source: vscode.TreeItem[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): void | Thenable<void> {
    return this.dragAndDropController.handleDrag(source, dataTransfer, token);
  }

  handleDrop?(target: vscode.TreeItem | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
    return this.dragAndDropController.handleDrop(target, dataTransfer, token);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    // Add contextValue for delete button
    if ((element as any).contextValue === 'connection') {
      element.contextValue = 'connection';
    }
    return element;
  }
  removeConnection(label: string) {
    this.connectionManager.remove(label);
  }

  getConnectionByLabel(label: string): ConnectionItem | undefined {
    return this.connectionManager.getByLabel(label);
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      const addItem = this.itemFactory.createAddConnectionItem();
      const connectionItems = this.connectionManager.getAll().map(conn => this.itemFactory.createConnectionTreeItem(conn));
      return [addItem, ...connectionItems];
    }
    
    if (element && ((element as any).contextValue === 'connection' || (element as any).contextValue === 'ssh-folder')) {
      const label = (element as any).connectionLabel || element.label;
      const conn = this.getConnectionByLabel(label);
      if (!conn) return [];
      if (conn.type === 'ssh') {
        const sshPath = (element as any).sshPath || '.';
        return await this.getSshFiles(conn, sshPath, label);
      }
      // FTP: TODO
      return [this.itemFactory.createFtpNotImplementedItem()];
    }
    return [];
  }

  async getSshFiles(conn: ConnectionItem, path: string = '.', connectionLabel?: string): Promise<vscode.TreeItem[]> {
    return SshService.listSftpDirectory(conn, path, connectionLabel || '');
  }

  addConnection(conn: ConnectionItem) {
    this.connectionManager.add(conn);
  }
}
