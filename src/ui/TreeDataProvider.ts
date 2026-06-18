import * as vscode from 'vscode';
import { ConnectionItem } from '../types';
import { TreeViewLocker } from './TreeViewLocker';
import { Container } from '../services/Container';
import { SessionProvider } from '../services/SessionProvider';
import { TreeItemFactory } from '../factories/TreeItemFactory';
import { DragAndDropController } from './DragAndDropController';
import { ConnectionManager } from '../services/ConnectionManager';
import { RemoteServiceProvider } from '../services/RemoteServiceProvider';

export class TreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.TreeDragAndDropController<vscode.TreeItem> {
  private remoteServiceCache: Record<string, any> = {};
  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined> = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined> = this._onDidChangeTreeData.event;
  private connectionManager: ConnectionManager;
  private elementIndex: Map<string, vscode.TreeItem> = new Map();
  private suppressConnectionExpand = false;
  private suppressConnectionExpandTimeout?: ReturnType<typeof setTimeout>;
  private previewConnectionOrder: string[] | null = null;
  private isReordering = false;
  private suppressOnChangeCallback = false;

  readonly dragAndDropController: DragAndDropController;
  private itemFactory: TreeItemFactory;

  public treeLocker: TreeViewLocker;

  constructor() {
    this.connectionManager = Container.get('connectionManager') as ConnectionManager;
    this.connectionManager.setOnChange((type?: string) => {
      // Skip tree update if we're in reorder mode (prevents tree update when reorder() fires onChange)
      if (this.suppressOnChangeCallback) return;
      // Fire tree change (type is just metadata)
      this._onDidChangeTreeData.fire(undefined);
    });
    this.itemFactory = new TreeItemFactory();
    // Pass the TreeDataProvider itself to DragAndDropController
    this.dragAndDropController = new DragAndDropController(this.connectionManager, () => this._onDidChangeTreeData.fire(undefined), this);
    this.treeLocker = new TreeViewLocker();
  }

  get dragMimeTypes(): string[] {
    return this.dragAndDropController.dragMimeTypes;
  }

  get dropMimeTypes(): string[] {
    return this.dragAndDropController.dropMimeTypes;
  }

  isInReorderMode(): boolean {
    return this.isReordering;
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

    if (element.contextValue === 'connection' || element.contextValue === 'connection-active') {
      const label = (element as any).connectionLabel || String(element.label);
      treeItem.contextValue = SessionProvider.hasSession(label) ? 'connection-active' : 'connection';
      if (this.suppressConnectionExpand) {
        treeItem.collapsibleState = vscode.TreeItemCollapsibleState.None;
        // Disable command click during drag-reorder
        treeItem.command = undefined;
      }
    }

    return treeItem;
  }
  
  removeConnection(label: string) {
    this.connectionManager.remove(label);
  }

  getConnectionByLabel(label: string): ConnectionItem | undefined {
    return this.connectionManager.getByLabel(label);
  }

  private normalizeRemotePath(remotePath?: string): string {
    if (!remotePath) {
      return '.';
    }
    const normalized = remotePath.replace(/\\/g, '/').trim();
    if (!normalized || normalized === './') {
      return '.';
    }
    return normalized;
  }

  private buildElementKey(connectionLabel: string, contextValue: string, remotePath?: string): string {
    return `${connectionLabel}::${contextValue}::${this.normalizeRemotePath(remotePath)}`;
  }

  public refreshRemoteFolder(connectionLabel: string, remotePath: string, protocol: 'ssh' | 'ftp' = 'ssh'): void {
    const contextValue = protocol === 'ssh' ? 'ssh-folder' : 'ftp-folder';
    const key = this.buildElementKey(connectionLabel, contextValue, remotePath);
    const element = this.elementIndex.get(key);
    if (element) {
      this._onDidChangeTreeData.fire(element);
      return;
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  public setConnectionReorderMode(active: boolean): void {
    this.suppressConnectionExpand = active;
    this.isReordering = active;
    this.suppressOnChangeCallback = active; // Suppress onChange callback during reorder
    
    if (this.suppressConnectionExpandTimeout) {
      clearTimeout(this.suppressConnectionExpandTimeout);
      this.suppressConnectionExpandTimeout = undefined;
    }

    if (active) {
      // Safety net for canceled drags where drop callback is not fired.
      this.suppressConnectionExpandTimeout = setTimeout(() => {
        this.suppressConnectionExpand = false;
        this.isReordering = false;
        this.suppressOnChangeCallback = false;
        this.previewConnectionOrder = null;
        this._onDidChangeTreeData.fire(undefined);
      }, 10000);
      // Don't fire tree update when entering reorder mode - prevents unnecessary reconnects during drag
      return;
    }

    // Fire tree update only when exiting reorder mode
    this._onDidChangeTreeData.fire(undefined);
  }

  public setPreviewConnectionOrder(order: string[] | null): void {
    this.previewConnectionOrder = order;
    // Only fire update if setting new preview, not when clearing
    if (order !== null) {
      this._onDidChangeTreeData.fire(undefined);
    }
  }

    refresh(element?: vscode.TreeItem) {
      if (element) {
        const elementAny = element as any;
        if (elementAny.children) {
          delete elementAny.children;
        }
      }
      
      this._onDidChangeTreeData.fire(element);
    }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if ((element as any)?.children) {
        return (element as any).children;
    }
    const { LoggerService } = await import('../services/LoggerService');
    const elementAny = element as any;
    const elementPath = elementAny?.sshPath || elementAny?.ftpPath || '.';
    LoggerService.log('getChildren ENTRY', 'TreeDataProvider', 'info');
    LoggerService.log(`element: ${element ? `label=${String(elementAny?.label || '')}, context=${String(elementAny?.contextValue || '')}, path=${String(elementPath)}` : 'undefined'}`, 'TreeDataProvider', 'info');
    const elementLabel = element ? String((element as any).connectionLabel || (element as any).label || '') : undefined;
    if (this.treeLocker.isLockedFor(elementLabel)) {
      if (element) {
        this.treeLocker.notifyBlockedActivity();
        LoggerService.log(`Tree is locked for current connection (${elementLabel}), returning []`, 'TreeDataProvider', 'info');
        return [];
      }
      LoggerService.log('Tree is locked, but root remains available for connection management', 'TreeDataProvider', 'info');
    }
    if (!element) {
      LoggerService.log('No element, returning root items', 'TreeDataProvider', 'info');
      const addItem = this.itemFactory.createAddConnectionItem();
      let connections = this.connectionManager.getAll();
      
      if (this.previewConnectionOrder) {
        const connMap = new Map(connections.map(c => [c.label, c]));
        const previewConns: ConnectionItem[] = [];
        for (const label of this.previewConnectionOrder) {
          const conn = connMap.get(label);
          if (conn) {
            previewConns.push(conn);
          }
        }
        connections = previewConns;
      }
      
      const connectionItems = connections.map(conn => {
        const item = this.itemFactory.createConnectionTreeItem(conn);
        (item as any).connectionLabel = conn.label;
        this.elementIndex.set(this.buildElementKey(conn.label, 'connection', '.'), item);
        return item;
      });
      const labels = connectionItems.map(i => String(i.label));
      LoggerService.log(`connectionItems: count=${labels.length}, preview=[${labels.slice(0, 5).join(', ')}${labels.length > 5 ? ', ...' : ''}]`, 'TreeDataProvider', 'info');
      LoggerService.log('getChildren EXIT (root)', 'TreeDataProvider', 'info');
      return [addItem, ...connectionItems];
    }
    if (element && ((element as any).contextValue === 'connection' || (element as any).contextValue === 'connection-active' || (element as any).contextValue === 'ssh-folder' || (element as any).contextValue === 'ftp-folder')) {
      const label = (element as any).connectionLabel || element.label;
      const hasSession = SessionProvider.hasSession(String(label));
      const isExpandingNow = (this as any).allowExpandOnce === label;

      if (!hasSession && !isExpandingNow && ((element as any).contextValue === 'connection' || (element as any).contextValue === 'connection-active')) {
        LoggerService.log('Single click connection expand suppressed', 'TreeDataProvider', 'info');
        return [];
      }

      if (this.suppressConnectionExpand && ((element as any).contextValue === 'connection' || (element as any).contextValue === 'connection-active')) {
        LoggerService.log('Connection expand suppressed during reorder drag', 'TreeDataProvider', 'info');
        return [];
      }

      LoggerService.log(`label: ${label}`, 'TreeDataProvider', 'info');
      
      if (this.isReordering) {
        LoggerService.log(`Skipping connection during reorder for ${label}`, 'TreeDataProvider', 'info');
        return [];
      }
      
      if (SessionProvider.isManuallyClosed(String(label))) {
        LoggerService.log(`Connection ${label} was manually closed, returning [] without reconnect`, 'TreeDataProvider', 'info');
        LoggerService.log('getChildren EXIT (manually closed)', 'TreeDataProvider', 'info');
        return [];
      }
      const connection = this.getConnectionByLabel(label);
      LoggerService.log(`connection: ${connection ? `type=${connection.type}, host=${connection.host}, port=${connection.port}, user=${connection.user}` : 'undefined'}`, 'TreeDataProvider', 'info');
      if (!connection) {
        LoggerService.log('No connection found, returning []', 'TreeDataProvider', 'info');
        LoggerService.log('getChildren EXIT (no conn)', 'TreeDataProvider', 'info');
        return [];
      }
    
      const provider = Container.get('remoteServiceProvider') as RemoteServiceProvider;
      const remoteService = await provider.getRemoteService(label);
      if (!remoteService) {
        return [];
      } else {
        LoggerService.log(`Using cached remoteService for ${label}`, 'TreeDataProvider', 'info');
      }
      LoggerService.log(`remoteService: ${remoteService ? remoteService.constructor.name : 'undefined'}`, 'TreeDataProvider', 'info');
      if (!remoteService) {
        LoggerService.log('No remoteService, returning []', 'TreeDataProvider', 'info');
        LoggerService.log('getChildren EXIT (no remoteService)', 'TreeDataProvider', 'info');
        return [];
      }
      const path = (element as any).sshPath || (element as any).ftpPath || '.';
      LoggerService.log(`path: ${path}`, 'TreeDataProvider', 'info');
      if (typeof remoteService.listDirectory === 'function') {
        LoggerService.log('Calling remoteService.listDirectory...', 'TreeDataProvider', 'info');
        const result = await remoteService.listDirectory(path, label);
        result.forEach((child: vscode.TreeItem) => {
          const childAny = child as any;
          if (childAny?.contextValue === 'ssh-folder' || childAny?.contextValue === 'ftp-folder') {
            const childLabel = childAny.connectionLabel || label;
            const childPath = childAny.sshPath || childAny.ftpPath || '.';
            this.elementIndex.set(this.buildElementKey(String(childLabel), String(childAny.contextValue), String(childPath)), child);
          }
        });
        LoggerService.log(`listDirectory returned ${Array.isArray(result) ? result.length : 'non-array'} items`, 'TreeDataProvider', 'info');
        LoggerService.log('getChildren EXIT (listDirectory)', 'TreeDataProvider', 'info');
        return result;
      }
      LoggerService.log('remoteService.listDirectory is not a function, returning []', 'TreeDataProvider', 'info');
      LoggerService.log('getChildren EXIT (no listDirectory)', 'TreeDataProvider', 'info');
      return [];
    }
    LoggerService.log('[TreeDataProvider][DEBUG] element did not match any known contextValue, returning []', 'TreeDataProvider', 'info');
    LoggerService.log('[TreeDataProvider][DEBUG] getChildren EXIT (default)', 'TreeDataProvider', 'info');
    return [];
  }

  getParent(element: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem> {
    if (element.contextValue === 'connection' || element.contextValue === 'connection-active') {
      return undefined;
    }

    const elementAny = element as any;
    const connectionLabel = elementAny.connectionLabel;
    const currentPath = elementAny.sshPath || elementAny.ftpPath;
    
    if (!connectionLabel || !currentPath || currentPath === '.') {
      return undefined;
    }

    const pathParts = currentPath.split('/');
    pathParts.pop();
    
    let parentPath = pathParts.join('/') || '.';
    
    const isSsh = elementAny.contextValue?.startsWith('ssh-');
    const parentContext = isSsh ? 'ssh-folder' : 'ftp-folder';

    if (parentPath === '.') {
      const serverKey = this.buildElementKey(connectionLabel, 'connection', '.');
      return this.elementIndex.get(serverKey);
    }

    const parentKey = this.buildElementKey(connectionLabel, parentContext, parentPath);
    return this.elementIndex.get(parentKey);
  }

  addConnection(conn: ConnectionItem) {
    this.connectionManager.add(conn);
  }
}
