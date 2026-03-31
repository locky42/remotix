import { RemoteService } from './RemoteService';
import { Client } from 'basic-ftp';
import * as vscode from 'vscode';
import { LangService } from '../LangService';
import { LoggerService } from '../LoggerService';
import { SessionProvider } from '../SessionProvider';

// Simple async mutex for serializing FTP operations
class AsyncMutex {
  private _lock: Promise<void> = Promise.resolve();
  private _isLocked = false;
  async acquire<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const willLock = new Promise<void>(resolve => (release = resolve));
    const prev = this._lock;
    this._lock = this._lock.then(() => willLock);
    await prev;
    this._isLocked = true;
    try {
      return await fn();
    } finally {
      this._isLocked = false;
      release!();
    }
  }
  get isLocked() { return this._isLocked; }
}

export class FtpRemoteService implements RemoteService {
  private conn: any;
  private _mutex = new AsyncMutex();

  constructor(conn: any) {
    this.conn = conn;
    LoggerService.show();
    LoggerService.log('[FTP] FtpRemoteService instance created.');
  }

  async connectIfNeeded(connectionLabel?: string) {
    if (!connectionLabel) throw new Error('No connectionLabel for FTP session');
    let client = SessionProvider.getSession<Client>(connectionLabel);
    if (client && (client as any).isConnected) return;
    if (client) {
      LoggerService.log('[FTP] Closing stale FTP session from SessionProvider');
      try { await client.close(); } catch {}
      SessionProvider.closeSession(connectionLabel);
    }
    client = new Client();
    await client.access({
      host: this.conn.host,
      port: this.conn.port ? Number(this.conn.port) : 21,
      user: this.conn.user,
      password: this.conn.password,
      secure: true,
      secureOptions: { rejectUnauthorized: false }
    });
    (client as any).isConnected = true;
    SessionProvider.setSession(connectionLabel, client);
  }

  async dispose(connectionLabel: string) {
    LoggerService.log(`[FTP] Disposing FTP session for ${connectionLabel}`);
    SessionProvider.closeSession(connectionLabel);
  }

  async listDirectory(conn: any, path: string, connectionLabel?: string): Promise<vscode.TreeItem[]> {
    return this._mutex.acquire(async () => {
      LoggerService.show();
      LoggerService.log('==============================');
      LoggerService.log(`[FTP][DEBUG] listDirectory ENTRY`);
      LoggerService.log(`[FTP][DEBUG] typeof conn: ${typeof conn}`);
      LoggerService.logObject('[FTP][DEBUG] conn', conn);
      LoggerService.log(`[FTP][DEBUG] path: ${path}`);
      LoggerService.log(`[FTP][DEBUG] connectionLabel: ${connectionLabel}`);
      LoggerService.log(`[FTP][DEBUG] arguments:`);
      try {
        if (!connectionLabel) throw new Error('No connectionLabel for FTP session');
        await this.connectIfNeeded(connectionLabel);
        LoggerService.log(`[FTP][DEBUG] Listing directory: ${path}`);
        const client = SessionProvider.getSession<Client>(connectionLabel);
        if (!client) throw new Error('FTP client not initialized');
        const list = await client.list(path);
        LoggerService.log(`[FTP][DEBUG] Directory list received (${list.length} items).`);
        list.forEach((item, idx) => {
          LoggerService.logObject(`[FTP][DEBUG] Item[${idx}]`, item);
        });
        const items = list.map(item => {
          const isFile = item.type === 1;
          const isDir = item.type === 2;
          const ftpPath = (path === '.' ? item.name : path + '/' + item.name);
          const treeItem = new vscode.TreeItem(item.name, isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
          treeItem.contextValue = isDir ? 'ftp-folder' : (isFile ? 'ftp-file' : 'ftp-unknown');
          (treeItem as any).ftpPath = ftpPath;
          // Always set connectionLabel for all FTP items (including nested)
          (treeItem as any).connectionLabel = conn.label;
          if (isDir) {
            treeItem.iconPath = new vscode.ThemeIcon('folder');
          } else if (isFile) {
            treeItem.iconPath = new vscode.ThemeIcon('file');
            treeItem.command = {
              command: 'remotix.editFile',
              title: LangService.t('openFile'),
              arguments: [{
                label: item.name,
                ftpPath,
                connectionLabel: conn.label
              }]
            };
          }
          LoggerService.logObject('[FTP][DEBUG] TreeItem', {name: item.name, isFile, isDir, ftpPath, connectionLabel: conn.label});
          return treeItem;
        });
        LoggerService.log(`[FTP][DEBUG] Returning ${items.length} tree items.`);
        LoggerService.log(`[FTP][DEBUG] listDirectory EXIT`);
        LoggerService.log('==============================');
        return items;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        LoggerService.log(`[FTP][ERROR] Exception in listDirectory: ${msg}`);
        LoggerService.log(`[FTP][ERROR] Stack: ${(e instanceof Error && e.stack) ? e.stack : ''}`);
        vscode.window.showErrorMessage('FTP: ' + msg);
        LoggerService.show();
        return [];
      }
    });
  }

  async deleteFileWithDialogs(item: any, treeDataProvider: any): Promise<void> {
    const ftpPath = item?.ftpPath || item?.sshPath;
    const connectionLabel = item?.connectionLabel || item?.label;
    if (!ftpPath || !connectionLabel) {
      vscode.window.showErrorMessage(LangService.t('missingPathOrConnection'));
      return;
    }
    const isDir = item.contextValue === 'ftp-folder' || item.contextValue === 'ssh-folder';
    const confirm = await vscode.window.showWarningMessage(
      LangService.t(isDir ? 'confirmDeleteFolder' : 'confirmDeleteFile', { path: ftpPath }),
      { modal: true },
      LangService.t('delete')
    );
    if (confirm !== LangService.t('delete')) return;
    try {
      if (isDir) {
        await this.deleteDir(ftpPath);
        vscode.window.showInformationMessage(LangService.t('folderDeleted', { path: ftpPath }));
      } else {
        await this.deleteFile(ftpPath);
        vscode.window.showInformationMessage(LangService.t('fileDeleted', { path: ftpPath }));
      }
      treeDataProvider.refresh();
    } catch (e: any) {
      vscode.window.showErrorMessage(LangService.t('deleteFailed', { error: (e instanceof Error ? e.message : String(e)) }));
    }
  }

  async createFileWithDialogs(item: any, treeDataProvider: any): Promise<void> {
    const ftpPath = item?.ftpPath || item?.sshPath;
    const connectionLabel = item?.connectionLabel || item?.label;
    if (!connectionLabel) {
      vscode.window.showErrorMessage(LangService.t('missingPathOrConnection'));
      return;
    }
    if (!ftpPath) {
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
      newFilePath = (ftpPath.endsWith('/') ? ftpPath : ftpPath + '/') + newFileName;
    } else {
      newFilePath = ftpPath.replace(/\/[^/]*$/, '') + '/' + newFileName;
    }
    try {
      await this.createFile(newFilePath);
      vscode.window.showInformationMessage(LangService.t('fileCreated', { path: newFilePath }));
      treeDataProvider.refresh();
    } catch (e: any) {
      vscode.window.showErrorMessage(LangService.t('createFileFailed', { error: (e instanceof Error ? e.message : String(e)) }));
    }
  }

  async createFolderWithDialogs(item: any, treeDataProvider: any): Promise<void> {
    LoggerService.log('[FTP][createFolderWithDialogs] ENTRY');
    LoggerService.logObject('[FTP][createFolderWithDialogs] item', item);
    const ftpPath = item?.ftpPath || item?.sshPath;
    const connectionLabel = item?.connectionLabel || item?.label;
    LoggerService.log(`[FTP][createFolderWithDialogs] ftpPath: ${ftpPath}`);
    LoggerService.log(`[FTP][createFolderWithDialogs] connectionLabel: ${connectionLabel}`);
    if (!ftpPath || !connectionLabel) {
      LoggerService.log('[FTP][createFolderWithDialogs] Missing path or connectionLabel');
      vscode.window.showErrorMessage(LangService.t('missingPathOrConnection'));
      return;
    }
    const newFolderName = await vscode.window.showInputBox({
      prompt: LangService.t('enterNewFolderName'),
      value: LangService.t('defaultNewFolderName')
    });
    LoggerService.log(`[FTP][createFolderWithDialogs] newFolderName: ${newFolderName}`);
    if (!newFolderName) {
      LoggerService.log('[FTP][createFolderWithDialogs] No folder name entered, aborting');
      return;
    }
    let newFolderPath: string;
    if (item?.contextValue === 'ftp-folder' || item?.contextValue === 'ssh-folder') {
      newFolderPath = (ftpPath.endsWith('/') ? ftpPath : ftpPath + '/') + newFolderName;
    } else {
      newFolderPath = ftpPath.replace(/\/[^/]*$/, '') + '/' + newFolderName;
    }
    LoggerService.log(`[FTP][createFolderWithDialogs] newFolderPath: ${newFolderPath}`);
    try {
      await this.createFolder(newFolderPath, connectionLabel);
      LoggerService.log('[FTP][createFolderWithDialogs] Folder created successfully');
      vscode.window.showInformationMessage(LangService.t('folderCreated', { path: newFolderPath }));
      if (treeDataProvider && typeof treeDataProvider.clearRemoteServiceCache === 'function' && connectionLabel) {
        LoggerService.log(`[FTP][createFolderWithDialogs] Clearing remoteServiceCache and closing session for ${connectionLabel}`);
        treeDataProvider.clearRemoteServiceCache(connectionLabel);
      }
      treeDataProvider.refresh();
      LoggerService.log('[FTP][createFolderWithDialogs] treeDataProvider.refresh() called');
    } catch (e: any) {
      LoggerService.log(`[FTP][createFolderWithDialogs] ERROR: ${e instanceof Error ? e.message : String(e)}`);
      vscode.window.showErrorMessage(LangService.t('createFolderFailed', { error: (e instanceof Error ? e.message : String(e)) }));
    }
    LoggerService.log('[FTP][createFolderWithDialogs] EXIT');
  }

  async renameWithDialogs(item: any, treeDataProvider: any): Promise<void> {
    const labelStr = typeof item.label === 'string' ? item.label : (item.label && typeof item.label.label === 'string' ? item.label.label : String(item.label));
    const oldLabel = labelStr;
    const ftpPath = item.ftpPath || item.sshPath;
    const connectionLabel = item.connectionLabel;
    if (!ftpPath || !connectionLabel) {
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
    const oldPath = ftpPath;
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
      if (treeDataProvider && treeDataProvider.treeLocker) treeDataProvider.treeLocker.lock(LangService.t('downloadingFile'));
      await this.connectIfNeeded(connectionLabel);
      const client = SessionProvider.getSession<Client>(connectionLabel);
      if (!client) throw new Error('FTP client not initialized');
      await client.downloadTo(tmpFile, item.ftpPath || item.sshPath);
      const doc = await vscode.workspace.openTextDocument(tmpFile);
      await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Active });
      vscode.window.setStatusBarMessage(LangService.t('remoteFile', {
        user: conn.user ?? '',
        host: conn.host ?? '',
        path: item.ftpPath ?? item.sshPath ?? ''
      }), 5000);
      const saveListener = vscode.workspace.onDidSaveTextDocument(async (savedDoc) => {
        if (savedDoc.fileName === tmpFile) {
          try {
            await this.connectIfNeeded(connectionLabel);
            const client2 = SessionProvider.getSession<Client>(connectionLabel);
            if (!client2) throw new Error('FTP client not initialized');
            await client2.uploadFrom(tmpFile, item.ftpPath || item.sshPath);
            vscode.window.setStatusBarMessage(LangService.t('fileSavedToServer'), 2000);
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
    } catch (e) {
      vscode.window.showErrorMessage(LangService.t('fileDownloadError', { error: (e instanceof Error ? e.message : String(e)) }));
    } finally {
      if (treeDataProvider && treeDataProvider.treeLocker) treeDataProvider.treeLocker.unlock();
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

    if (!uris || uris.length === 0) {
      LoggerService.log('[FTP][uploadWithDialogs] No files/folders selected');
      return;
    }
    LoggerService.log('[FTP][uploadWithDialogs] Selected URIs:');
    uris.forEach((uri: any) => LoggerService.logObject('[FTP][uploadWithDialogs] URI', uri));
    const pathMod = require('path');
    const fs = require('fs');
    let anyError = false;
    for (const uri of uris) {
      const localPath = uri.fsPath;
      LoggerService.log(`[FTP][uploadWithDialogs] Processing localPath: ${localPath}`);
      let uploadTarget = targetPath;
      try {
        const stat = fs.statSync(localPath);
        LoggerService.log(`[FTP][uploadWithDialogs] Stat: isDirectory=${stat.isDirectory()}, isFile=${stat.isFile()}`);
        if (stat.isDirectory()) {
          uploadTarget = pathMod.join(targetPath, pathMod.basename(localPath));
          await this.uploadDir(localPath, uploadTarget);
        } else {
          await this.upload(localPath, pathMod.join(uploadTarget, pathMod.basename(localPath)));
        }
      } catch (e: any) {
        anyError = true;
        LoggerService.log(`[FTP][uploadWithDialogs][ERROR] ${e instanceof Error ? e.message : String(e)}`);
        vscode.window.showErrorMessage(LangService.t('uploadError', { error: (e instanceof Error ? e.message : String(e)) }));
      }
    }
    if (!anyError) {
      vscode.window.showInformationMessage(LangService.t('uploadSuccess'));
    }
    treeDataProvider.refresh();
  }

  async downloadWithDialogs(item: any, treeDataProvider: any): Promise<void> {
    const connectionLabel = item?.connectionLabel;
    const isDirectory = item?.contextValue === 'ssh-folder' || item?.contextValue === 'ftp-folder';
    if (!connectionLabel) {
      vscode.window.showErrorMessage(LangService.t('missingPathOrConnection'));
      return;
    }
    const conn = treeDataProvider.getConnectionByLabel
      ? treeDataProvider.getConnectionByLabel(connectionLabel)
      : undefined;
    if (!conn) {
      vscode.window.showErrorMessage(LangService.t('connectionNotFound'));
      return;
    }
    this.conn = conn;
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
    const connectionLabel = item?.connectionLabel || item?.label;
    await this.connectIfNeeded(connectionLabel);
    const remotePath = item?.ftpPath || item?.sshPath;
    const pathMod = require('path');
    const localDest = pathMod.join(localTarget, pathMod.basename(remotePath));
    const client = SessionProvider.getSession<Client>(connectionLabel);
    if (!client) throw new Error('FTP client not initialized');
    await client.downloadTo(localDest, remotePath);
  }

  async downloadDir(item: any, localTarget: string): Promise<void> {
    const connectionLabel = item?.connectionLabel || item?.label;
    await this.connectIfNeeded(connectionLabel);
    const remoteDir = item?.ftpPath || item?.sshPath;
    const pathMod = require('path');
    const fs = require('fs');
    const localDest = pathMod.join(localTarget, pathMod.basename(remoteDir));
    const client = SessionProvider.getSession<Client>(connectionLabel);
    if (!client) throw new Error('FTP client not initialized');
    await fs.promises.mkdir(localDest, { recursive: true });
    const list = await client.list(remoteDir);
    let downloadedFiles = 0;
    for (const entry of list) {
      if (entry.name === '.' || entry.name === '..') continue;
      const remotePath = remoteDir.replace(/\/+$/, '') + '/' + entry.name;
      const localPath = pathMod.join(localDest, entry.name);
      if (entry.type === 2) { // directory
        await this.downloadDir({ ...item, ftpPath: remotePath, sshPath: remotePath }, localDest);
      } else if (entry.type === 1) { // file
        let fileSize = entry.size || 0;
        let received = 0;
        await new Promise<void>((resolve, reject) => {
          const writeStream = fs.createWriteStream(localPath);
          writeStream.on('error', (e: Error) => reject(e));
          writeStream.on('close', () => {
            downloadedFiles++;
            vscode.window.setStatusBarMessage(`Remotix: Downloaded ${downloadedFiles} files`);
            resolve();
          });
          const origWrite = writeStream.write;
          writeStream.write = function(chunk: any, ...args: any[]) {
            received += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
            const percent = fileSize ? Math.min(100, Math.round(received / fileSize * 100)) : 0;
            const mbReceived = (received / 1024 / 1024).toFixed(2);
            const mbTotal = (fileSize / 1024 / 1024).toFixed(2);
            vscode.window.setStatusBarMessage(`Remotix: ${entry.name} (${mbReceived} MB / ${mbTotal} MB, ${percent}%) [${remotePath}]`);
            return origWrite.call(this, chunk, ...args);
          };
          client.downloadTo(writeStream, remotePath).catch(reject);
        });
      }
    }
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    return this._mutex.acquire(async () => {
      const connectionLabel = this.conn.label;
      await this.connectIfNeeded(connectionLabel);
      const client = SessionProvider.getSession<Client>(connectionLabel);
      if (!client) throw new Error('FTP client not initialized');
      await client.uploadFrom(localPath, remotePath);
    });
  }

  async uploadDir(localDir: string, remoteDir: string): Promise<void> {
    return this._mutex.acquire(async () => {
      const connectionLabel = this.conn.label;
      await this.connectIfNeeded(connectionLabel);
      const client = SessionProvider.getSession<Client>(connectionLabel);
      if (!client) throw new Error('FTP client not initialized');
      await client.uploadFromDir(localDir, remoteDir);
    });
  }

  async createFile(remotePath: string): Promise<void> {
    return this._mutex.acquire(async () => {
      const connectionLabel = this.conn.label;
      await this.connectIfNeeded(connectionLabel);
      const client = SessionProvider.getSession<Client>(connectionLabel);
      if (!client) throw new Error('FTP client not initialized');
      const tmp = require('os').tmpdir();
      const tmpPath = require('path').join(tmp, `remotix_empty_${Date.now()}`);
      require('fs').writeFileSync(tmpPath, '');
      await client.uploadFrom(tmpPath, remotePath);
      require('fs').unlinkSync(tmpPath);
    });
  }

  async createFolder(remoteDir: string, connectionLabel?: string): Promise<void> {
    return this._mutex.acquire(async () => {
      const label = connectionLabel ?? this.conn.label;
      await this.connectIfNeeded(label);
      const client = SessionProvider.getSession<Client>(label);
      if (!client) throw new Error('FTP client not initialized');
      await client.ensureDir(remoteDir);
    });
  }
  async rename(oldRemotePath: string, newRemotePath: string, connectionLabel?: string): Promise<void> {
    const label: string = connectionLabel ?? this.conn.label;
    if (!label) throw new Error('connectionLabel is required');
    await this.connectIfNeeded(label);
    const client = SessionProvider.getSession<Client>(label);
    if (!client) throw new Error('FTP client not initialized');
    await client.rename(oldRemotePath, newRemotePath);
  }

  async deleteFile(remotePath: string): Promise<void> {
    const connectionLabel = this.conn.label;
    await this.connectIfNeeded(connectionLabel);
    const client = SessionProvider.getSession<Client>(connectionLabel);
    if (!client) throw new Error('FTP client not initialized');
    await client.remove(remotePath);
  }

  async deleteDir(remoteDir: string): Promise<void> {
    const connectionLabel = this.conn.label;
    await this.connectIfNeeded(connectionLabel);
    const client = SessionProvider.getSession<Client>(connectionLabel);
    if (!client) throw new Error('FTP client not initialized');
    await client.removeDir(remoteDir);
  }

  async moveItems(items: any[], targetFolder: string, treeDataProvider: any): Promise<void> {
    return this._mutex.acquire(async () => {
      const connectionLabel = items[0]?.connectionLabel || items[0]?.label;
      await this.connectIfNeeded(connectionLabel);
      const client = SessionProvider.getSession<Client>(connectionLabel);
      if (!client) throw new Error('FTP client not initialized');
      let hadError = false;
      for (const item of items) {
        // Prefer ftpPath, fallback to sshPath for compatibility
        const oldPath = item.ftpPath || item.sshPath;
        if (!oldPath) {
          LoggerService.log(`[FTP][moveItems] Skipping item with no path: ${JSON.stringify(item)}`);
          continue;
        }
        const newPath = targetFolder.replace(/\/?$/, '/') + oldPath.split('/').pop();
        LoggerService.log(`[FTP][moveItems] Renaming: ${oldPath} -> ${newPath}`);
        try {
          await client.rename(oldPath, newPath);
        } catch (err) {
          hadError = true;
          LoggerService.log(`[FTP][moveItems][ERROR] ${err instanceof Error ? err.message : String(err)}`);
          const msg = (err instanceof Error) ? err.message : String(err);
          vscode.window.showErrorMessage(LangService.t('moveError', { error: msg }));
        }
      }
      // Force-clear FTP cache and session for this connection to ensure fresh directory listing
      if (treeDataProvider && typeof treeDataProvider.clearRemoteServiceCache === 'function' && connectionLabel) {
        LoggerService.log(`[FTP][moveItems] Clearing remoteServiceCache and closing session for ${connectionLabel}`);
        treeDataProvider.clearRemoteServiceCache(connectionLabel);
      }
      if (!hadError) {
        vscode.window.showInformationMessage(LangService.t('moveSuccess'));
      }
      // Try to refresh parent folder, not just global
      let parentItem = null;
      if (items.length > 0) {
        const movedItem = items[0];
        // parent path for refresh: remove last segment
        let parentPath = (movedItem.ftpPath || movedItem.sshPath || '').split('/').slice(0, -1).join('/') || '.';
        parentItem = {
          label: connectionLabel,
          contextValue: 'ftp-folder',
          ftpPath: parentPath,
          connectionLabel: connectionLabel
        };
        LoggerService.log(`[FTP][moveItems] Refreshing parent folder: ${parentPath}`);
        if (typeof treeDataProvider.refresh === 'function') {
          treeDataProvider.refresh(parentItem);
        }
      } else {
        treeDataProvider.refresh();
      }
    });
  }
}
