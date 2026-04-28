import * as vscode from 'vscode';
import { ConnectionItem } from '../types';
import { TreeViewLocker } from './TreeViewLocker';
import { Container } from '../services/Container';
import { TreeItemFactory } from '../factories/TreeItemFactory';
import { DragAndDropController } from './DragAndDropController';
import { ConnectionManager } from '../services/ConnectionManager';
import { RemoteServiceProvider } from '../services/RemoteServiceProvider';
import { SessionProvider } from '../services/SessionProvider';

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
    LoggerService.show();
    LoggerService.log('------------------------------');
    LoggerService.log('[TreeDataProvider][DEBUG] getChildren ENTRY');
    LoggerService.log(`[TreeDataProvider][DEBUG] element: ${element ? `label=${String(elementAny?.label || '')}, context=${String(elementAny?.contextValue || '')}, path=${String(elementPath)}` : 'undefined'}`);
    const elementLabel = element ? String((element as any).connectionLabel || (element as any).label || '') : undefined;
    if (this.treeLocker.isLockedFor(elementLabel)) {
      if (element) {
        this.treeLocker.notifyBlockedActivity();
        LoggerService.log(`[TreeDataProvider][DEBUG] Tree is locked for current connection (${elementLabel}), returning []`);
        return [];
      }
      LoggerService.log('[TreeDataProvider][DEBUG] Tree is locked, but root remains available for connection management');
    }
    if (!element) {
      LoggerService.log('[TreeDataProvider][DEBUG] No element, returning root items');
      const addItem = this.itemFactory.createAddConnectionItem();
      let connections = this.connectionManager.getAll();
      
      // Apply preview order if active
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
      LoggerService.log(`[TreeDataProvider][DEBUG] connectionItems: count=${labels.length}, preview=[${labels.slice(0, 5).join(', ')}${labels.length > 5 ? ', ...' : ''}]`);
      LoggerService.log('[TreeDataProvider][DEBUG] getChildren EXIT (root)');
      LoggerService.log('------------------------------');
      return [addItem, ...connectionItems];
    }
    if (element && ((element as any).contextValue === 'connection' || (element as any).contextValue === 'connection-active' || (element as any).contextValue === 'ssh-folder' || (element as any).contextValue === 'ftp-folder')) {
      if (this.suppressConnectionExpand && ((element as any).contextValue === 'connection' || (element as any).contextValue === 'connection-active')) {
        LoggerService.log('[TreeDataProvider][DEBUG] Connection expand suppressed during reorder drag');
        return [];
      }

      const label = (element as any).connectionLabel || element.label;
      LoggerService.log(`[TreeDataProvider][DEBUG] label: ${label}`);
      
      // Don't connect during reorder - applies to all elements
      if (this.isReordering) {
        LoggerService.log(`[TreeDataProvider][DEBUG] Skipping connection during reorder for ${label}`);
        return [];
      }
      
      if (SessionProvider.isManuallyClosed(String(label))) {
        LoggerService.log(`[TreeDataProvider][DEBUG] Connection ${label} was manually closed, returning [] without reconnect`);
        LoggerService.log('[TreeDataProvider][DEBUG] getChildren EXIT (manually closed)');
        LoggerService.log('------------------------------');
        return [];
      }
      const connection = this.getConnectionByLabel(label);
      LoggerService.log(`[TreeDataProvider][DEBUG] connection: ${connection ? `type=${connection.type}, host=${connection.host}, port=${connection.port}, user=${connection.user}` : 'undefined'}`);
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
        result.forEach((child: vscode.TreeItem) => {
          const childAny = child as any;
          if (childAny?.contextValue === 'ssh-folder' || childAny?.contextValue === 'ftp-folder') {
            const childLabel = childAny.connectionLabel || label;
            const childPath = childAny.sshPath || childAny.ftpPath || '.';
            this.elementIndex.set(this.buildElementKey(String(childLabel), String(childAny.contextValue), String(childPath)), child);
          }
        });
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
