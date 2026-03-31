import { LoggerService } from '../LoggerService';
import { SessionProvider } from '../SessionProvider';
import { RemoteService } from './RemoteService';
import * as fs from 'fs';
import { Client } from 'ssh2';
import * as vscode from 'vscode';
import { LangService } from '../LangService';

export class SshRemoteService implements RemoteService {
  private config: any;
  // Cache SFTP sessions per SSH connection
  private static sftpCache: Map<Client, any> = new Map();

  constructor(conn: any) {
    this.config = {
      host: conn.host || (conn.detail ? conn.detail.split('@')[1]?.split(':')[0] : ''),
      port: conn.port ? parseInt(conn.port) : 22,
      username: conn.user || (conn.detail ? conn.detail.split('@')[0] : ''),
    };
    if (conn.authMethod === 'privateKey' && conn.authFile) {
      this.config.privateKey = fs.readFileSync(conn.authFile);
    } else if (conn.password) {
      this.config.password = conn.password;
    }
    LoggerService.log(`[SshRemoteService] Created for ${this.config.username}@${this.config.host}:${this.config.port}`);
  }

  private connectIfNeeded(connectionLabel: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      let sshClient = SessionProvider.getSession<Client>(connectionLabel);
      if (sshClient && (sshClient as any).isConnected) {
        LoggerService.log('[SshRemoteService] Reusing existing SSH connection from SessionProvider');
        return resolve(sshClient);
      }
      if (sshClient) {
        LoggerService.log('[SshRemoteService] Closing stale SSH connection from SessionProvider');
        sshClient.end();
        SessionProvider.closeSession(connectionLabel);
      }
      sshClient = new Client();
      LoggerService.log('[SshRemoteService] Connecting to SSH...');
      sshClient.on('ready', () => {
        LoggerService.log('[SshRemoteService] SSH connection ready');
        (sshClient as any).isConnected = true;
        if (sshClient) {
          SessionProvider.setSession(connectionLabel, sshClient);
          resolve(sshClient);
        }
      });
      sshClient.on('error', (err: any) => {
        LoggerService.log(`[SshRemoteService] SSH error: ${err.message}`);
        (sshClient as any).isConnected = false;
        SessionProvider.closeSession(connectionLabel);
        if (sshClient) SshRemoteService.sftpCache.delete(sshClient);
        reject(err);
      });
      sshClient.on('end', () => {
        LoggerService.log('[SshRemoteService] SSH connection ended');
        (sshClient as any).isConnected = false;
        SessionProvider.closeSession(connectionLabel);
        if (sshClient) SshRemoteService.sftpCache.delete(sshClient);
      });
      sshClient.connect(this.config);
    });
  }

  // Get or create cached SFTP session for a given SSH connection
  private async getSftp(ssh: Client): Promise<any> {
    if (SshRemoteService.sftpCache.has(ssh)) {
      return SshRemoteService.sftpCache.get(ssh);
    }
    return new Promise((resolve, reject) => {
      ssh.sftp((err: any, sftp: any) => {
        if (err) return reject(err);
        SshRemoteService.sftpCache.set(ssh, sftp);
        resolve(sftp);
      });
    });
  }

  public disconnect(connectionLabel: string) {
    LoggerService.log(`[SshRemoteService] Disconnecting SSH for ${connectionLabel}`);
    SessionProvider.closeSession(connectionLabel);
  }

  private static getSshConfig(conn: any): any {
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
        vscode.window.showErrorMessage(LangService.t('cannotReadKey', { error: errMsg }));
        return null;
      }
    } else if (conn.password) {
      config.password = conn.password;
    }
    return config;
  }

  async moveItems(items: {sshPath: string, connectionLabel: string}[], targetFolder: string, onDone: () => void) {
    LoggerService.log(`[SshRemoteService][DEBUG] moveItems ENTRY: items=${JSON.stringify(items)}, targetFolder=${targetFolder}`);
    let moved = 0;
    let failed = 0;
    const total = items.length;
    for (const item of items) {
      try {
        if (!item.connectionLabel) throw new Error('connectionLabel is required');
        const connectionLabel: string = item.connectionLabel as string;
        const filename = item.sshPath.split('/').pop();
        if (!filename) {
          failed++;
          LoggerService.log('[SshRemoteService] moveItems: filename is undefined, skipping item');
          if (moved + failed === total) onDone();
          continue;
        }
        const newPath = targetFolder === '.' ? filename : `${targetFolder}/${filename}`;
        LoggerService.log(`[SshRemoteService][DEBUG] About to call rename: oldPath=${item.sshPath}, newPath=${newPath}, connectionLabel=${connectionLabel}`);
        if (item.sshPath === newPath) {
          moved++;
          if (moved + failed === total) onDone();
          continue;
        }
        await this.rename(item.sshPath, newPath, connectionLabel);
        moved++;
      } catch (err: any) {
        failed++;
        vscode.window.showErrorMessage(LangService.t('fileMoveError', { error: err.message }));
      }
      if (moved + failed === total) onDone();
    }
    if (items.length === 0) {
      LoggerService.log('[SshRemoteService] moveItems: No valid items with connectionLabel');
      onDone();
    }
  }

  async listDirectory(conn: any, path: string, connectionLabel: string): Promise<vscode.TreeItem[]> {
    LoggerService.log(`[SshRemoteService] listDirectory ENTRY: path=${path}, connectionLabel=${connectionLabel}`);
    try {
      const ssh = await this.connectIfNeeded(connectionLabel);
      const sftp = await this.getSftp(ssh);
      return await new Promise((resolve, reject) => {
        LoggerService.log(`[SshRemoteService] SFTP session started, reading dir: ${path}`);
        sftp.readdir(path, (err: any, list: any[]) => {
          if (err) {
            LoggerService.log(`[SshRemoteService] readdir error: ${err.message}`);
            vscode.window.showErrorMessage(LangService.t('fileDownloadError', { error: err.message }));
            return resolve([]);
          }
          LoggerService.log(`[SshRemoteService] Directory list received (${list.length} items)`);
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
                title: LangService.t('openFile'),
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
          LoggerService.log(`[SshRemoteService] Returning ${items.length} tree items`);
          resolve(items);
        });
      });
    } catch (err: any) {
      LoggerService.log(`[SshRemoteService] SSH error: ${err.message}`);
      vscode.window.showErrorMessage(LangService.t('sshError', { error: err.message }));
      return [];
    }
  }

  async deleteFileWithDialogs(item: any, treeDataProvider: any): Promise<void> {
    const sshPath = item?.sshPath || item?.ftpPath;
    const connectionLabel = item?.connectionLabel || item?.label;
    if (!sshPath || !connectionLabel) {
      vscode.window.showErrorMessage(LangService.t('missingPathOrConnection'));
      return;
    }
    const isDir = item.contextValue === 'ftp-folder' || item.contextValue === 'ssh-folder';
    const confirm = await vscode.window.showWarningMessage(
      LangService.t(isDir ? 'confirmDeleteFolder' : 'confirmDeleteFile', { path: sshPath }),
      { modal: true },
      LangService.t('delete')
    );
    if (confirm !== LangService.t('delete')) return;
    try {
      if (isDir) {
        await this.deleteDir(sshPath, connectionLabel);
        vscode.window.showInformationMessage(LangService.t('folderDeleted', { path: sshPath }));
      } else {
        await this.deleteFile(sshPath, connectionLabel);
        vscode.window.showInformationMessage(LangService.t('fileDeleted', { path: sshPath }));
      }
      treeDataProvider.refresh();
    } catch (e: any) {
      vscode.window.showErrorMessage(LangService.t('deleteFailed', { error: (e instanceof Error ? e.message : String(e)) }));
    }
  }

  async createFileWithDialogs(item: any, treeDataProvider: any): Promise<void> {
    const sshPath = item?.sshPath || item?.ftpPath;
    const connectionLabel = item?.connectionLabel || item?.label;
    if (!connectionLabel) {
      vscode.window.showErrorMessage(LangService.t('missingPathOrConnection'));
      return;
    }
    if (!sshPath) {
      vscode.window.showErrorMessage(LangService.t('ftpNoFolderForFile'));
      return;
    }
    const newFileName = await vscode.window.showInputBox({
      prompt: LangService.t('enterNewFileName'),
      value: LangService.t('defaultNewFileName')
    });
    if (!newFileName) return;
    let newFilePath: string;
    if (item?.contextValue === 'ssh-folder' || item?.contextValue === 'ftp-folder') {
      newFilePath = (sshPath.endsWith('/') ? sshPath : sshPath + '/') + newFileName;
    } else {
      newFilePath = sshPath.replace(/\/[^/]*$/, '') + '/' + newFileName;
    }
    try {
      await this.createFile(newFilePath, connectionLabel);
      vscode.window.showInformationMessage(LangService.t('fileCreated', { path: newFilePath }));
      treeDataProvider.refresh();
    } catch (e: any) {
      vscode.window.showErrorMessage(LangService.t('createFileFailed', { error: (e instanceof Error ? e.message : String(e)) }));
    }
  }

  async createFolderWithDialogs(item: any, treeDataProvider: any): Promise<void> {
    const sshPath = item?.sshPath || item?.ftpPath;
    const connectionLabel = item?.connectionLabel || item?.label;
    if (!sshPath || !connectionLabel) {
      vscode.window.showErrorMessage(LangService.t('missingPathOrConnection'));
      return;
    }
    const newFolderName = await vscode.window.showInputBox({
      prompt: LangService.t('enterNewFolderName'),
      value: LangService.t('defaultNewFolderName')
    });
    if (!newFolderName) return;
    let newFolderPath: string;
    if (item?.contextValue === 'ssh-folder' || item?.contextValue === 'ftp-folder') {
      newFolderPath = (sshPath.endsWith('/') ? sshPath : sshPath + '/') + newFolderName;
    } else {
      newFolderPath = sshPath.replace(/\/[^/]*$/, '') + '/' + newFolderName;
    }
    try {
      await this.createFolder(newFolderPath, connectionLabel);
      vscode.window.showInformationMessage(LangService.t('folderCreated', { path: newFolderPath }));
      treeDataProvider.refresh();
    } catch (e: any) {
      vscode.window.showErrorMessage(LangService.t('createFolderFailed', { error: (e instanceof Error ? e.message : String(e)) }));
    }
  }

  async renameWithDialogs(item: any, treeDataProvider: any): Promise<void> {
    const labelStr = typeof item.label === 'string' ? item.label : (item.label && typeof item.label.label === 'string' ? item.label.label : String(item.label));
    const oldLabel = labelStr;
    const sshPath = item.sshPath || item.ftpPath;
    const connectionLabel = item.connectionLabel;
    if (!sshPath || !connectionLabel) {
      vscode.window.showErrorMessage(LangService.t('missingSshPathOrConnectionLabel'));
      return;
    }
    const newName = await vscode.window.showInputBox({
      prompt: LangService.t('rename'),
      value: oldLabel
    });
    if (!newName || newName === oldLabel) return;
    const conn = treeDataProvider.getConnectionByLabel ? treeDataProvider.getConnectionByLabel(connectionLabel) : undefined;
    if (!conn) {
      vscode.window.showErrorMessage(LangService.t('connectionNotFound'));
      return;
    }
    const oldPath = sshPath;
    const newPath = oldPath.replace(/[^/]+$/, newName);
    try {
      await this.rename(oldPath, newPath, connectionLabel);
      vscode.window.showInformationMessage(LangService.t('renamedTo', { name: newName }));
      treeDataProvider.refresh();
    } catch (e: any) {
      vscode.window.showErrorMessage(LangService.t('renameFailed', { error: (e instanceof Error ? e.message : String(e)) }));
    }
  }

  async editFileWithDialogs(item: any, treeDataProvider: any): Promise<void> {
    const filePath = item.ftpPath || item.sshPath;
    if (!filePath) {
      vscode.window.showErrorMessage(LangService.t('missingPathOrConnection'));
      return;
    }
    const connectionLabel = item?.connectionLabel || item?.label;
    const conn = treeDataProvider.getConnectionByLabel ? treeDataProvider.getConnectionByLabel(connectionLabel) : undefined;
    if (!conn) {
      vscode.window.showErrorMessage(LangService.t('noConnectionsFound'));
      return;
    }
    const os = require('os');
    const pathMod = require('path');
    const fs = require('fs');
    const tmp = os.tmpdir();
    const safeHost = (conn.host ?? 'unknown').replace(/[^\w]/g, '_');
    const relPathRaw = item.sshPath || item.ftpPath || '';
    const safeRelPath = relPathRaw.replace(/^\/\/+/, '').split('/').map((p: string) => p.replace(/[^\w.\-]/g, '_')).join(pathMod.sep);
    const tmpDir = pathMod.join(tmp, `remotix_${safeHost}`);
    fs.mkdirSync(pathMod.dirname(pathMod.join(tmpDir, safeRelPath)), { recursive: true });
    const tmpFile = pathMod.join(tmpDir, safeRelPath);
    try {
      const ssh = await this.connectIfNeeded(connectionLabel);
      const sftp = await this.getSftp(ssh);
      await new Promise<void>(async (resolve, reject) => {
        sftp.fastGet(item.sshPath || '', tmpFile, {}, async (err: Error | null) => {
          if (err) return reject(err);
          const doc = await vscode.workspace.openTextDocument(tmpFile);
          await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Active });
          vscode.window.setStatusBarMessage(LangService.t('remoteFile', {
            user: conn.user ?? '',
            host: conn.host ?? '',
            path: item.sshPath ?? ''
          }), 5000);
          const saveListener = vscode.workspace.onDidSaveTextDocument(async (savedDoc) => {
            if (savedDoc.fileName === tmpFile) {
              try {
                const ssh2 = await this.connectIfNeeded(connectionLabel);
                const sftp2 = await this.getSftp(ssh2);
                sftp2.fastPut(tmpFile, item.sshPath || '', {}, (err3: Error | null) => {
                  if (err3) {
                    vscode.window.showErrorMessage(LangService.t('fileUploadError', { error: err3.message }));
                  } else {
                    vscode.window.setStatusBarMessage(LangService.t('fileSavedToServer'), 2000);
                  }
                });
              } catch (e) {
                vscode.window.showErrorMessage(LangService.t('fileUploadError', { error: (e instanceof Error ? e.message : String(e)) }));
              }
            }
          });
          const closeListener = vscode.workspace.onDidCloseTextDocument((closedDoc) => {
            if (closedDoc.fileName === tmpFile) {
              saveListener.dispose();
              closeListener.dispose();
              try { fs.unlinkSync(tmpFile); } catch {}
            }
          });
          resolve();
        });
      });
    } catch (e) {
      vscode.window.showErrorMessage(LangService.t('fileDownloadError', { error: (e instanceof Error ? e.message : String(e)) }));
    }
  }

  async uploadWithDialogs(item: any, treeDataProvider: any): Promise<void> {
    const connectionLabel = item?.connectionLabel || item?.label;
    const targetPath = item?.sshPath || item?.ftpPath;
    if (!connectionLabel || !targetPath) {
      vscode.window.showErrorMessage(LangService.t('missingPathOrConnection'));
      return;
    }
    const treeDataProviderAny = treeDataProvider as any;
    const conn = treeDataProviderAny.getConnectionByLabel
      ? treeDataProviderAny.getConnectionByLabel(connectionLabel)
      : undefined;
    if (!conn) {
      vscode.window.showErrorMessage(LangService.t('connectionNotFound'));
      return;
    }
    
    const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
    const uploadType = await vscode.window.showQuickPick(
        [
            { label: '$(file) File', value: 'file' },
            { label: '$(folder) Folder', value: 'folder' }
        ], 
        { placeHolder: LangService.t('selectUploadType') }
    );

    if (!uploadType) return;

    const isFolder = uploadType.value === 'folder';

    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: !isFolder,
        canSelectFolders: isFolder,
        canSelectMany: true,
        openLabel: LangService.t('select'),
        defaultUri: vscode.Uri.file(homeDir)
    });

    if (!uris || uris.length === 0) return;
    const pathMod = require('path');
    const fs = require('fs');
    let anyError = false;
    for (const uri of uris) {
      const localPath = uri.fsPath;
      let uploadTarget = targetPath;
      try {
        const stat = fs.statSync(localPath);
        if (stat.isDirectory()) {
          uploadTarget = pathMod.join(targetPath, pathMod.basename(localPath));
          await this.uploadDir(localPath, uploadTarget, connectionLabel);
        } else {
          await this.upload(localPath, pathMod.join(uploadTarget, pathMod.basename(localPath)), connectionLabel);
        }
      } catch (e: any) {
        anyError = true;
        vscode.window.showErrorMessage(LangService.t('uploadError', { error: (e instanceof Error ? e.message : String(e)) }));
      }
    }
    if (!anyError) {
      vscode.window.showInformationMessage(LangService.t('uploadSuccess'));
    }
    treeDataProvider.refresh();
  }

  async downloadWithDialogs(item: any, treeDataProvider: any): Promise<void> {
    LoggerService.log(`[SshRemoteService][DEBUG] downloadWithDialogs ENTRY: item=${JSON.stringify(item)}, contextValue=${item?.contextValue}`);
    const connectionLabel = item?.connectionLabel;
    const isDirectory = item?.contextValue === 'ssh-folder' || item?.contextValue === 'ftp-folder';
    LoggerService.log(`[SshRemoteService][DEBUG] downloadWithDialogs isDirectory=${isDirectory}`);
    if (!connectionLabel) {
      vscode.window.showErrorMessage(LangService.t('missingPathOrConnection'));
      return;
    }
      const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
      const uri = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        openLabel: LangService.t('chooseDownloadTarget'),
        defaultUri: vscode.Uri.file(homeDir)
    });
      if (!uri || uri.length === 0) return;
      const localTarget = uri[0].fsPath;
      try {
        if (isDirectory) {
          await this.downloadDir(item, localTarget);
      } else {
        await this.download(item, localTarget);
      }
      vscode.window.showInformationMessage(LangService.t('downloadSuccess'));
    } catch (err: any) {
      vscode.window.showErrorMessage(LangService.t('downloadError', { error: err.message }));
    }
  }

  async download(item: any, localTarget: string): Promise<void> {
    const remotePath = item?.ftpPath || item?.sshPath;
    const pathMod = require('path');
    const localDest = pathMod.join(localTarget, pathMod.basename(remotePath));
    const connectionLabel = item?.connectionLabel || item?.label;
    if (!connectionLabel) throw new Error('connectionLabel is required');
    const ssh = await this.connectIfNeeded(connectionLabel);
    const sftp = await this.getSftp(ssh);
    await new Promise<void>((resolve, reject) => {
      const writeStream = fs.createWriteStream(localDest);
      const readStream = sftp.createReadStream(remotePath);
      writeStream.on('close', () => { resolve(); });
      writeStream.on('error', (e: Error) => { reject(e); });
      readStream.on('error', (e: Error) => { reject(e); });
      readStream.pipe(writeStream);
    });
  }

  async downloadDir(item: any, localTarget: string): Promise<void> {
    LoggerService.log(`[SshRemoteService] downloadDir ENTRY: item=${JSON.stringify(item)}, localTarget=${localTarget}`);
    const remoteDir = item?.ftpPath || item?.sshPath;
    const pathMod = require('path');
    const localDest = pathMod.join(localTarget, pathMod.basename(remoteDir));
    const connectionLabel = item?.connectionLabel || item?.label;
    if (!connectionLabel) {
      LoggerService.log('[SshRemoteService] downloadDir: connectionLabel is missing!');
      throw new Error('connectionLabel is required');
    }
    LoggerService.log(`[SshRemoteService] downloadDir: connecting to SSH for label=${connectionLabel}`);
    const ssh = await this.connectIfNeeded(connectionLabel);
    LoggerService.log(`[SshRemoteService] downloadDir: connected, preparing to SFTP for remoteDir=${remoteDir}`);
    const sftp = await this.getSftp(ssh);
    await new Promise<void>((resolve, reject) => {
      const fs = require('fs');
      let downloadedFiles = 0;
      const vscode_ = require('vscode');
      const downloadDir = (remoteDir: string, localDir: string, cb: (err?: Error | null) => void) => {
        LoggerService.log(`[SshRemoteService] downloadDir: readdir ${remoteDir} -> ${localDir}`);
        sftp.readdir(remoteDir, (err: any, list: any[]) => {
          if (err) {
            LoggerService.log(`[SshRemoteService] downloadDir: readdir error: ${err.message}`);
            return cb(err);
          }
          fs.mkdirSync(localDir, { recursive: true });
          LoggerService.log(`[SshRemoteService] downloadDir: found ${list.length} entries in ${remoteDir}`);
          let i = 0;
          const next = () => {
            if (i >= list.length) return cb();
            const entry = list[i++];
            if (!entry.filename || entry.filename === '.' || entry.filename === '..') {
              next();
              return;
            }
            const entryPath = remoteDir + '/' + entry.filename;
            const localEntryPath = pathMod.join(localDir, entry.filename);
            LoggerService.log(`[SshRemoteService] downloadDir: entry ${entryPath} (${entry.longname})`);
            if (entry.longname && entry.longname[0] === 'd') {
              LoggerService.log(`[SshRemoteService] downloadDir: entering directory ${entryPath}`);
              downloadDir(entryPath, localEntryPath, (err2?: Error | null) => {
                if (err2) return cb(err2);
                next();
              });
            } else {
              LoggerService.log(`[SshRemoteService] downloadDir: downloading file ${entryPath} -> ${localEntryPath}`);
              sftp.stat(entryPath, (statErr: any, stats: any) => {
                let fileSize = stats && stats.size ? stats.size : 0;
                let received = 0;
                const writeStream = fs.createWriteStream(localEntryPath);
                const readStream = sftp.createReadStream(entryPath);
                readStream.on('data', (chunk: Buffer) => {
                  received += chunk.length;
                  const percent = fileSize ? Math.min(100, Math.round(received / fileSize * 100)) : 0;
                  const mbReceived = (received / 1024 / 1024).toFixed(2);
                  const mbTotal = (fileSize / 1024 / 1024).toFixed(2);
                  vscode_.window.setStatusBarMessage(`Remotix: ${entry.filename} (${mbReceived} MB / ${mbTotal} MB, ${percent}%) [${entryPath}]`);
                });
                writeStream.on('close', () => {
                  LoggerService.log(`[SshRemoteService] downloadDir: finished file ${entryPath}`);
                  downloadedFiles++;
                  vscode_.window.setStatusBarMessage(`Remotix: Downloaded ${downloadedFiles} files`);
                  next();
                });
                writeStream.on('error', (e: Error) => {
                  LoggerService.log(`[SshRemoteService] downloadDir: writeStream error: ${e.message}`);
                  cb(e);
                });
                readStream.on('error', (e: Error) => {
                  LoggerService.log(`[SshRemoteService] downloadDir: readStream error: ${e.message}`);
                  cb(e);
                });
                readStream.pipe(writeStream);
              });
            }
          };
          next();
        });
      };
      LoggerService.log(`[SshRemoteService] downloadDir: starting recursive downloadDir for ${remoteDir} -> ${localDest}`);
      downloadDir(remoteDir, localDest, (err2?: Error | null) => {
        vscode_.window.setStatusBarMessage('Remotix: Download complete', 3000);
        if (err2) {
          LoggerService.log(`[SshRemoteService] downloadDir: error in recursive downloadDir: ${err2.message}`);
          return reject(err2);
        }
        LoggerService.log(`[SshRemoteService] downloadDir: finished successfully for ${remoteDir}`);
        resolve();
      });
    });
  }

  async upload(localPath: string, remotePath: string, connectionLabel?: string): Promise<void> {
    if (!connectionLabel) throw new Error('connectionLabel is required');
    const ssh = await this.connectIfNeeded(connectionLabel);
    const sftp = await this.getSftp(ssh);
    await new Promise<void>((resolve, reject) => {
      const readStream = fs.createReadStream(localPath);
      const writeStream = sftp.createWriteStream(remotePath);
      writeStream.on('close', () => { resolve(); });
      writeStream.on('error', (e: Error) => { reject(e); });
      readStream.pipe(writeStream);
    });
  }

  async createFile(remotePath: string, connectionLabel?: string): Promise<void> {
    if (!connectionLabel) throw new Error('connectionLabel is required');
    const ssh = await this.connectIfNeeded(connectionLabel);
    const sftp = await this.getSftp(ssh);
    await new Promise<void>((resolve, reject) => {
      const writeStream = sftp.createWriteStream(remotePath, { flags: 'w', encoding: 'utf8' });
      writeStream.on('close', () => { resolve(); });
      writeStream.on('error', (e: Error) => { reject(e); });
      writeStream.end('');
    });
  }

  async createFolder(remoteDir: string, connectionLabel?: string): Promise<void> {
    if (!connectionLabel) throw new Error('connectionLabel is required');
    const ssh = await this.connectIfNeeded(connectionLabel);
    const sftp = await this.getSftp(ssh);
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(remoteDir, (err2: any) => {
        if (err2) reject(err2); else resolve();
      });
    });
  }

  async uploadDir(localDir: string, remoteDir: string, connectionLabel?: string): Promise<void> {
    const fsPromises = fs.promises;
    if (!connectionLabel) throw new Error('connectionLabel is required');
    const ssh = await this.connectIfNeeded(connectionLabel);
    const sftp = await this.getSftp(ssh);
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(remoteDir, (err2: any) => {
        if (err2 && (err2 as any).code !== 4) return reject(err2);
        fsPromises.readdir(localDir, { withFileTypes: true }).then(entries => {
          let i = 0;
          let errorOccurred = false;
          const next = () => {
            if (errorOccurred) return;
            if (i >= entries.length) { resolve(); return; }
            const entry = entries[i++];
            const srcPath = require('path').join(localDir, entry.name);
            const destPath = require('path').join(remoteDir, entry.name);
            if (entry.isDirectory()) {
              this.uploadDir(srcPath, destPath, connectionLabel).then(next).catch(e => { errorOccurred = true; reject(e); });
            } else {
              this.upload(srcPath, destPath, connectionLabel).then(next).catch(e => { errorOccurred = true; reject(e); });
            }
          };
          next();
        }).catch(e => { reject(e); });
      });
    });
  }

  async rename(oldRemotePath: string, newRemotePath: string, connectionLabel?: string): Promise<void> {
    if (!connectionLabel) throw new Error('connectionLabel is required');
    const ssh = await this.connectIfNeeded(connectionLabel);
    const sftp = await this.getSftp(ssh);
    await new Promise<void>((resolve, reject) => {
      sftp.rename(oldRemotePath, newRemotePath, (err2: any) => {
        if (err2) reject(err2); else resolve();
      });
    });
  }

  async deleteFile(remotePath: string, connectionLabel?: string): Promise<void> {
    if (!connectionLabel) throw new Error('connectionLabel is required');
    const ssh = await this.connectIfNeeded(connectionLabel);
    const sftp = await this.getSftp(ssh);
    await new Promise<void>((resolve, reject) => {
      sftp.unlink(remotePath, (err2: any) => {
        if (err2) reject(err2); else resolve();
      });
    });
  }

  async deleteDir(remoteDir: string, connectionLabel?: string): Promise<void> {
    LoggerService.log(`[SshRemoteService][deleteDir] ENTRY: remoteDir=${remoteDir}, connectionLabel=${connectionLabel}`);
    if (!connectionLabel) throw new Error('connectionLabel is required');
    const ssh = await this.connectIfNeeded(connectionLabel);
    const sftp = await this.getSftp(ssh);
    await new Promise<void>((resolve, reject) => {
      const rmDir = (dirPath: string, done: (err?: Error | null) => void) => {
        sftp.readdir(dirPath, (err2: any, list: any[]) => {
          if (err2) {
            LoggerService.log(`[SshRemoteService][deleteDir] readdir error for ${dirPath}: ${err2.message}`);
            return done(err2);
          }
          let i = 0;
          const next = () => {
            if (i >= list.length) {
              sftp.rmdir(dirPath, (errRm: any) => {
                if (errRm) LoggerService.log(`[SshRemoteService][deleteDir] rmdir error for ${dirPath}: ${errRm.message}`);
                return done(errRm);
              });
              return;
            }
            const entry = list[i++];
            const entryPath = dirPath + '/' + entry.filename;
            if (entry.longname && entry.longname[0] === 'd') {
              rmDir(entryPath, (err3) => {
                if (err3) {
                  LoggerService.log(`[SshRemoteService][deleteDir] rmDir error for ${entryPath}: ${err3.message}`);
                  return done(err3);
                }
                next();
              });
            } else {
              sftp.unlink(entryPath, (err3: any) => {
                if (err3) {
                  LoggerService.log(`[SshRemoteService][deleteDir] unlink error for ${entryPath}: ${err3.message}`);
                  return done(err3);
                }
                next();
              });
            }
          };
          next();
        });
      };
      rmDir(remoteDir, (err2: any) => {
        if (err2) {
          LoggerService.log(`[SshRemoteService][deleteDir] FINAL error for ${remoteDir}: ${err2.message}`);
          reject(err2);
        } else {
          resolve();
        }
      });
    });
  }
}
