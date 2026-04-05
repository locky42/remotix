import * as vscode from 'vscode';
import { ConnectionItem } from '../types';
import { TreeViewLocker } from './TreeViewLocker';
import { Container } from '../services/Container';
import { TreeItemFactory } from '../factories/TreeItemFactory';
import { DragAndDropController } from './DragAndDropController';
import { ConnectionManager } from '../services/ConnectionManager';
import { RemoteServiceProvider } from '../services/RemoteServiceProvider';

export class TreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.TreeDragAndDropController<vscode.TreeItem> {
  private remoteServiceCache: Record<string, any> = {};
  private _onDidChangeTreeData: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData: vscode.Event<void> = this._onDidChangeTreeData.event;
  private connectionManager: ConnectionManager;

  readonly dragAndDropController: DragAndDropController;
  private itemFactory: TreeItemFactory;

  public treeLocker: TreeViewLocker;

  constructor() {
    this.connectionManager = Container.get('connectionManager') as ConnectionManager;
    this.connectionManager.setOnChange(() => this._onDidChangeTreeData.fire());
    this.itemFactory = new TreeItemFactory();
    // Pass the TreeDataProvider itself to DragAndDropController
    this.dragAndDropController = new DragAndDropController(this.connectionManager, () => this._onDidChangeTreeData.fire(), this);
    this.treeLocker = new TreeViewLocker();
  }

  get dragMimeTypes(): string[] {
    return this.dragAndDropController.dragMimeTypes;
  }

  get dropMimeTypes(): string[] {
    return this.dragAndDropController.dropMimeTypes;
  }

  clearRemoteServiceCache(label: string) {
    if (this.remoteServiceCache && label in this.remoteServiceCache) {
      // Try to close FTP session if possible
      try {
        const { SessionProvider } = require('../services/SessionProvider');
        SessionProvider.closeSession(label);
      } catch (e) {}
      delete this.remoteServiceCache[label];
    }
  }
  
  handleDrag?(source: vscode.TreeItem[], dataTransfer: vscode.DataTransfer): void | Thenable<void> {
    return this.dragAndDropController.handleDrag(source, dataTransfer);
  }

  handleDrop?(target: vscode.TreeItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    return this.dragAndDropController.handleDrop(target, dataTransfer);
  }

  getTreeItem(element: any): vscode.TreeItem {
    const treeItem = element instanceof vscode.TreeItem ? element : new vscode.TreeItem(element.label);

    if (element.ftpPath) {
      (treeItem as any).ftpPath = element.ftpPath;
    }
    if (element.sshPath) {
      (treeItem as any).sshPath = element.sshPath;
    }
    
    if (element.connectionLabel) {
      (treeItem as any).connectionLabel = element.connectionLabel;
    }

    if (element.contextValue === 'connection') {
      treeItem.contextValue = 'connection';
    }

    return treeItem;
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
    const { LoggerService } = await import('../services/LoggerService');
    if (this.treeLocker.isLocked()) {
        LoggerService.log('[TreeDataProvider][DEBUG] Tree is LOCKED. Skipping getChildren to prevent session collision.');
        return [];
    }
    LoggerService.show();
    LoggerService.log('------------------------------');
    LoggerService.log('[TreeDataProvider][DEBUG] getChildren ENTRY');
    LoggerService.log(`[TreeDataProvider][DEBUG] element: ${element ? JSON.stringify(element, null, 2) : 'undefined'}`);
    if (this.treeLocker.isLocked()) {
      const { LoggerService } = await import('../services/LoggerService');
      LoggerService.log('[TreeDataProvider][DEBUG] Tree is locked, returning []');
      return [];
    }
    if (!element) {
      LoggerService.log('[TreeDataProvider][DEBUG] No element, returning root items');
      const addItem = this.itemFactory.createAddConnectionItem();
      const connectionItems = this.connectionManager.getAll().map(conn => this.itemFactory.createConnectionTreeItem(conn));
      LoggerService.log(`[TreeDataProvider][DEBUG] connectionItems: ${JSON.stringify(connectionItems.map(i => i.label))}`);
      LoggerService.log('[TreeDataProvider][DEBUG] getChildren EXIT (root)');
      LoggerService.log('------------------------------');
      return [addItem, ...connectionItems];
    }
    if (element && ((element as any).contextValue === 'connection' || (element as any).contextValue === 'ssh-folder' || (element as any).contextValue === 'ftp-folder')) {
      const label = (element as any).connectionLabel || element.label;
      LoggerService.log(`[TreeDataProvider][DEBUG] label: ${label}`);
      const connection = this.getConnectionByLabel(label);
      LoggerService.log(`[TreeDataProvider][DEBUG] connection: ${JSON.stringify(connection, null, 2)}`);
      if (!connection) {
        LoggerService.log('[TreeDataProvider][DEBUG] No connection found, returning []');
        LoggerService.log('[TreeDataProvider][DEBUG] getChildren EXIT (no conn)');
        LoggerService.log('------------------------------');
        return [];
      }
    
      const provider = Container.get('remoteServiceProvider') as RemoteServiceProvider;
      const remoteService = await provider.getRemoteService(label);
      if (!remoteService) {
        return [];
      } else {
        LoggerService.log(`[TreeDataProvider][DEBUG] Using cached remoteService for ${label}`);
      }
      LoggerService.log(`[TreeDataProvider][DEBUG] remoteService: ${remoteService ? remoteService.constructor.name : 'undefined'}`);
      if (!remoteService) {
        LoggerService.log('[TreeDataProvider][DEBUG] No remoteService, returning []');
        LoggerService.log('[TreeDataProvider][DEBUG] getChildren EXIT (no remoteService)');
        LoggerService.log('------------------------------');
        return [];
      }
      const path = (element as any).sshPath || (element as any).ftpPath || '.';
      LoggerService.log(`[TreeDataProvider][DEBUG] path: ${path}`);
      if (typeof remoteService.listDirectory === 'function') {
        LoggerService.log('[TreeDataProvider][DEBUG] Calling remoteService.listDirectory...');
        const result = await remoteService.listDirectory(path, label);
        LoggerService.log(`[TreeDataProvider][DEBUG] listDirectory returned ${Array.isArray(result) ? result.length : 'non-array'} items`);
        LoggerService.log('[TreeDataProvider][DEBUG] getChildren EXIT (listDirectory)');
        LoggerService.log('------------------------------');
        return result;
      }
      LoggerService.log('[TreeDataProvider][DEBUG] remoteService.listDirectory is not a function, returning []');
      LoggerService.log('[TreeDataProvider][DEBUG] getChildren EXIT (no listDirectory)');
      LoggerService.log('------------------------------');
      return [];
    }
    LoggerService.log('[TreeDataProvider][DEBUG] element did not match any known contextValue, returning []');
    LoggerService.log('[TreeDataProvider][DEBUG] getChildren EXIT (default)');
    LoggerService.log('------------------------------');
    return [];
  }

  addConnection(conn: ConnectionItem) {
    this.connectionManager.add(conn);
  }
}
