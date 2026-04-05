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

  createConnectionTreeItem(connection: ConnectionItem): vscode.TreeItem {
    const item = new vscode.TreeItem(connection.label, vscode.TreeItemCollapsibleState.Collapsed);
    let desc = '';
    if (connection.type === 'ssh') {
      desc = `${connection.user || ''}@${connection.detail || ''}:${connection.port || ''}`;
      item.tooltip = `${LangService.t('editConnection')}: ${connection.user || ''}@${connection.detail || ''}:${connection.port || ''}\n${LangService.t('openSshTerminal')}`;
    } else {
      desc = `${connection.user || ''}@${connection.detail || ''}:${connection.port || ''}`;
      item.tooltip = `${LangService.t('editConnection')}: ${connection.user || ''}@${connection.detail || ''}:${connection.port || ''}`;
    }
    item.description = desc;
    item.iconPath = connection.type === 'ssh'
      ? new vscode.ThemeIcon('terminal')
      : new vscode.ThemeIcon('cloud');
    (item as any).contextValue = 'connection';
    (item as any).sshPath = '.';
    (item as any).connectionLabel = connection.label;
    return item;
  }

  createFtpNotImplementedItem(): vscode.TreeItem {
    return new vscode.TreeItem(LangService.t('ftpNotImplemented'));
  }
}
