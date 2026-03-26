import * as vscode from 'vscode';
import { Client, ConnectConfig } from 'ssh2';
import { t } from '../lang';
import { ConnectionItem } from '../types';

export class SshService {
  static getSshConfig(conn: ConnectionItem): ConnectConfig | null {
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
        return null;
      }
    } else if (conn.password) {
      config.password = conn.password;
    }
    return config;
  }

  static moveSftpItems(conn: ConnectionItem, items: {sshPath: string}[], targetFolder: string, onDone: () => void) {
    const config = SshService.getSshConfig(conn);
    if (!config) return;
    const ssh = new Client();
    ssh.on('ready', () => {
      ssh.sftp((err: Error | undefined, sftp: any) => {
        if (err) {
          vscode.window.showErrorMessage(t('sftpError', { error: err.message }));
          ssh.end();
          return;
        }
        let moved = 0;
        let failed = 0;
        const total = items.length;
        items.forEach((item) => {
          if (!item.sshPath) { failed++; if (moved + failed === total) { ssh.end(); onDone(); } return; }
          const filename = item.sshPath.split('/').pop();
          const newPath = targetFolder === '.' ? filename : `${targetFolder}/${filename}`;
          if (item.sshPath === newPath) { moved++; if (moved + failed === total) { ssh.end(); onDone(); } return; }
          sftp.rename(item.sshPath, newPath, (err: Error | null) => {
            if (err) {
              failed++;
              vscode.window.showErrorMessage(t('fileMoveError', { error: err.message }));
            } else {
              moved++;
            }
            if (moved + failed === total) {
              ssh.end();
              onDone();
            }
          });
        });
      });
    }).on('error', (err: Error) => {
      vscode.window.showErrorMessage(t('sshError', { error: err.message }));
    }).connect(config);
  }

  static listSftpDirectory(conn: ConnectionItem, path: string, connectionLabel: string): Promise<vscode.TreeItem[]> {
    return new Promise((resolve, reject) => {
      const config = SshService.getSshConfig(conn);
      if (!config) { resolve([]); return; }
      const ssh = new Client();
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
}
