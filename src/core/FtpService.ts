import * as vscode from 'vscode';
import { Client } from 'basic-ftp';
import { ConnectionItem } from '../types';

export class FtpService {
  static async listDirectory(conn: ConnectionItem, path: string): Promise<vscode.TreeItem[]> {
    const client = new Client();
    try {
      await client.access({
        host: conn.host,
        port: conn.port ? Number(conn.port) : 21,
        user: conn.user,
        password: conn.password,
        secure: true, // FTPS (TLS)
        secureOptions: { rejectUnauthorized: false }
      });
      const list = await client.list(path);
      return list.map(item => {
        const isFile = item.type === 1;
        const isDir = item.type === 2;
        const treeItem = new vscode.TreeItem(item.name, isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        treeItem.contextValue = isDir ? 'ftp-folder' : (isFile ? 'ftp-file' : 'ftp-unknown');
        (treeItem as any).ftpPath = (path === '.' ? item.name : path + '/' + item.name);
        (treeItem as any).connectionLabel = conn.label;
        if (isDir) {
          treeItem.iconPath = new vscode.ThemeIcon('folder');
        } else if (isFile) {
          treeItem.iconPath = new vscode.ThemeIcon('file');
          treeItem.command = {
            command: 'remotix.editFile',
            title: 'Відкрити файл',
            arguments: [{
              label: item.name,
              ftpPath: (path === '.' ? item.name : path + '/' + item.name),
              connectionLabel: conn.label
            }]
          };
        }
        return treeItem;
      });
    } catch (e) {
      vscode.window.showErrorMessage('FTP: ' + (e instanceof Error ? e.message : String(e)));
      return [];
    } finally {
      client.close();
    }
  }
}
