import * as vscode from 'vscode';
import { ConnectionItem } from '../types';
import { LangService } from '../services/LangService';

export class TreeItemFactory {
  createAddConnectionItem(): vscode.TreeItem {
    const addItem = new vscode.TreeItem(LangService.t('addConnection'), vscode.TreeItemCollapsibleState.None);
    addItem.command = {
      command: 'remotix.addConnection',
      title: LangService.t('addConnection')
    };
    addItem.iconPath = new vscode.ThemeIcon('add');
    return addItem;
  }

  createConnectionTreeItem(conn: ConnectionItem): vscode.TreeItem {
    const item = new vscode.TreeItem(conn.label, vscode.TreeItemCollapsibleState.Collapsed);
    let desc = '';
    if (conn.type === 'ssh') {
      desc = `${conn.user || ''}@${conn.detail || ''}:${conn.port || ''}`;
      item.tooltip = `${LangService.t('editConnection')}: ${conn.user || ''}@${conn.detail || ''}:${conn.port || ''}\n${LangService.t('openSshTerminal')}`;
    } else {
      desc = `${conn.user || ''}@${conn.detail || ''}:${conn.port || ''}`;
      item.tooltip = `${LangService.t('editConnection')}: ${conn.user || ''}@${conn.detail || ''}:${conn.port || ''}`;
    }
    item.description = desc;
    item.iconPath = conn.type === 'ssh'
      ? new vscode.ThemeIcon('terminal')
      : new vscode.ThemeIcon('cloud');
    (item as any).contextValue = 'connection';
    (item as any).sshPath = '.';
    (item as any).connectionLabel = conn.label;
    return item;
  }

  createFtpNotImplementedItem(): vscode.TreeItem {
    return new vscode.TreeItem(LangService.t('ftpNotImplemented'));
  }
}
