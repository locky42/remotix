import * as vscode from 'vscode';
import { ConnectionItem } from './types';
import { t } from './lang';
// @ts-ignore
import { Client, ConnectConfig } from 'ssh2';
import { getGlobalConfig } from './config';

export class RemotixTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.TreeDragAndDropController<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData: vscode.Event<void> = this._onDidChangeTreeData.event;
  private connections: ConnectionItem[];

  private context: vscode.ExtensionContext;
  readonly dragMimeTypes: string[] = ['application/vnd.code.tree.remotixView'];
  readonly dropMimeTypes: string[] = ['application/vnd.code.tree.remotixView'];

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.connections = getGlobalConfig(context).connections;
  }
  
  handleDrag?(source: vscode.TreeItem[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): void | Thenable<void> {

    const items = source.filter(item => ['connection', 'ssh-file', 'ssh-folder'].includes((item as any).contextValue));
    if (items.length > 0) {
      const payload = items.map(i => ({
        contextValue: (i as any).contextValue,
        connectionLabel: (i as any).connectionLabel,
        sshPath: (i as any).sshPath,
        label: i.label
      }));
      dataTransfer.set('application/vnd.code.tree.remotixView', new vscode.DataTransferItem(JSON.stringify(payload)));
    }
  }

  async handleDrop?(target: vscode.TreeItem | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
    const transfer = dataTransfer.get('application/vnd.code.tree.remotixView');
    if (!transfer) return;
    let draggedItems: any[] = [];
    try {
      draggedItems = JSON.parse(transfer.value);
    } catch {
      draggedItems = Array.isArray(transfer.value) ? transfer.value : [transfer.value];
    }

    if (draggedItems.length && draggedItems[0].contextValue === 'connection') {
      if (!target || (target as any).contextValue !== 'connection') return;
      const targetLabel = (target as any).connectionLabel || target.label;
      const draggedLabels = draggedItems.map(i => i.label);
      const dragged = this.connections.filter(c => draggedLabels.includes(c.label));
      this.connections = this.connections.filter(c => !draggedLabels.includes(c.label));
      const idx = this.connections.findIndex(c => c.label === targetLabel);
      if (idx !== -1) {
        this.connections.splice(idx, 0, ...dragged);
        this._onDidChangeTreeData.fire();
      }
      return;
    }

    if (!target || !['ssh-folder', 'ssh-file'].includes((target as any).contextValue)) return;
    const targetFolder = (target as any).contextValue === 'ssh-folder'
      ? (target as any).sshPath
      : ((target as any).sshPath || '').split('/').slice(0, -1).join('/') || '.';
    const connectionLabel = (target as any).connectionLabel;
    const conn = this.getConnectionByLabel(connectionLabel);
    if (!conn) return;

    const Client = require('ssh2').Client;
    const ssh = new Client();
    const config: any = {
      host: conn.host || (conn.detail ? conn.detail.split('@')[1]?.split(':')[0] : ''),
      port: conn.port ? parseInt(conn.port) : 22,
      username: conn.user || (conn.detail ? conn.detail.split('@')[0] : ''),
    };
    if (conn.authMethod === 'privateKey' && conn.authFile) {
      try {
        config.privateKey = require('fs').readFileSync(conn.authFile);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(t('cannotReadKey', { error: errMsg }));
        return;
      }
    } else if (conn.password) {
      config.password = conn.password;
    }

    ssh.on('ready', () => {
      ssh.sftp((err: Error | undefined, sftp: any) => {
        if (err) {
          vscode.window.showErrorMessage(t('sftpError', { error: err.message }));
          ssh.end();
          return;
        }
        let moved = 0;
        let failed = 0;
        const total = draggedItems.length;
        draggedItems.forEach((item, idx) => {
          if (!item.sshPath) { failed++; if (moved + failed === total) ssh.end(); return; }
          const filename = item.sshPath.split('/').pop();
          const newPath = targetFolder === '.' ? filename : `${targetFolder}/${filename}`;
          if (item.sshPath === newPath) { moved++; if (moved + failed === total) ssh.end(); return; }
          sftp.rename(item.sshPath, newPath, (err: Error | null) => {
            if (err) {
              failed++;
              vscode.window.showErrorMessage(t('fileMoveError', { error: err.message }));
            } else {
              moved++;
            }
            if (moved + failed === total) {
              ssh.end();
              this._onDidChangeTreeData.fire();
            }
          });
        });
      });
    }).on('error', (err: Error) => {
      vscode.window.showErrorMessage(t('sshError', { error: err.message }));
    }).connect(config);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    // Add contextValue for delete button
    if ((element as any).contextValue === 'connection') {
      element.contextValue = 'connection';
    }
    return element;
  }
  removeConnection(label: string) {
    const idx = this.connections.findIndex(c => c.label === label);
    if (idx !== -1) {
      this.connections.splice(idx, 1);
      this._onDidChangeTreeData.fire();
    }
  }

  getConnectionByLabel(label: string): ConnectionItem | undefined {
    return this.connections.find(c => c.label === label);
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      const addItem = new vscode.TreeItem(t('addConnection'), vscode.TreeItemCollapsibleState.None);
      addItem.command = {
        command: 'remotix.addConnection',
        title: t('addConnection')
      };
      addItem.iconPath = new vscode.ThemeIcon('add');
      const connectionItems = this.connections.map(conn => {
        const item = new vscode.TreeItem(conn.label, vscode.TreeItemCollapsibleState.Collapsed);
        let desc = '';
        if (conn.type === 'ssh') {
          desc = `${conn.user || ''}@${conn.detail || ''}:${conn.port || ''}`;
          item.tooltip = `${t('editConnection')}: ${conn.user || ''}@${conn.detail || ''}:${conn.port || ''}\n${t('openSshTerminal')}`;
        } else {
          desc = `${conn.user || ''}@${conn.detail || ''}:${conn.port || ''}`;
          item.tooltip = `${t('editConnection')}: ${conn.user || ''}@${conn.detail || ''}:${conn.port || ''}`;
        }
        item.description = desc;
        item.iconPath = conn.type === 'ssh'
          ? new vscode.ThemeIcon('terminal')
          : new vscode.ThemeIcon('cloud');
        (item as any).contextValue = 'connection';
        (item as any).sshPath = '.';
        (item as any).connectionLabel = conn.label;
        return item;
      });
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
      return [new vscode.TreeItem(t('ftpNotImplemented'))];
    }
    return [];
  }

  async getSshFiles(conn: ConnectionItem, path: string = '.', connectionLabel?: string): Promise<vscode.TreeItem[]> {
    return new Promise((resolve, reject) => {
      const ssh = new Client();
      const config: ConnectConfig = {
        host: conn.host || (conn.detail ? conn.detail.split('@')[1]?.split(':')[0] : ''),
        port: conn.port ? parseInt(conn.port) : 22,
        username: conn.user || (conn.detail ? conn.detail.split('@')[0] : ''),
      };
      if (conn.authMethod === 'privateKey' && conn.authFile) {
        try {
          config.privateKey = require('fs').readFileSync(conn.authFile);
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(t('cannotReadKey', { error: errMsg }));
          resolve([]);
          return;
        }
      } else if (conn.password) {
        config.password = conn.password;
      }
      ssh.on('ready', () => {
        ssh.sftp((err: Error | undefined, sftp: any) => {
          if (err) {
            vscode.window.showErrorMessage(t('sftpError', { error: err.message }));
            ssh.end();
            resolve([]);
            return;
          }
          sftp.readdir(path, (err: Error | null, list: any[]) => {
            if (err) {
              vscode.window.showErrorMessage(t('fileDownloadError', { error: err.message }));
              ssh.end();
              resolve([]);
              return;
            }
            const items = list.map((f: any) => {
              const isDir = f.longname && f.longname[0] === 'd';
              const item = new vscode.TreeItem(f.filename, isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
              if (isDir) {
                (item as any).contextValue = 'ssh-folder';
                (item as any).sshPath = (path === '.' ? f.filename : path + '/' + f.filename);
                (item as any).connectionLabel = connectionLabel;
                item.iconPath = new vscode.ThemeIcon('folder');
              } else {
                (item as any).contextValue = 'ssh-file';
                (item as any).sshPath = (path === '.' ? f.filename : path + '/' + f.filename);
                (item as any).connectionLabel = connectionLabel;
                item.iconPath = new vscode.ThemeIcon('file');
                item.command = {
                  command: 'remotixView.itemClick',
                  title: 'Відкрити файл',
                  arguments: [{
                    label: f.filename,
                    sshPath: (path === '.' ? f.filename : path + '/' + f.filename),
                    connectionLabel: connectionLabel
                  }]
                };
              }
              return item;
            });
            items.sort((a, b) => {
              const getLabelString = (lbl: string | vscode.TreeItemLabel | undefined) => {
                if (!lbl) return '';
                if (typeof lbl === 'string') return lbl;
                return lbl.label || '';
              };
              const aLabel = getLabelString(a.label);
              const bLabel = getLabelString(b.label);
              return aLabel.localeCompare(bLabel, 'uk');
            });
            ssh.end();
            resolve(items);
          });
        });
      }).on('error', (err: Error) => {
        vscode.window.showErrorMessage(t('sshError', { error: err.message }));
        resolve([]);
      }).connect(config);
    });
  }

  addConnection(conn: ConnectionItem) {
    if (!this.connections.some(c => c.host === conn.host && c.port === conn.port && c.user === conn.user && c.type === conn.type)) {
      this.connections.push(conn);
      this._onDidChangeTreeData.fire();
    }
  }
}
