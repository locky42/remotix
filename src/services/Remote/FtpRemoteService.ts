import * as vscode from 'vscode';
import { Container } from '../Container';
import { ConnectionItem } from '../../types';
import { LangService } from '../LangService';
import { RemoteService } from './RemoteService';
import { Client as FtpClient } from 'basic-ftp';
import { LoggerService } from '../LoggerService';
import { SessionProvider } from '../SessionProvider';
import { TreeDataProvider } from '../../ui/TreeDataProvider';

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
  private connection: ConnectionItem;
  private _mutex = new AsyncMutex();
  private initialPath: string = '/';

  constructor(connection: ConnectionItem) {
    this.connection = connection;
    LoggerService.show();
    LoggerService.log('[FTP] FtpRemoteService instance created.');
  }

  private normalizeRemotePath(remotePath: string): string {
    const normalized = (remotePath || '.').replace(/\\/g, '/').trim();
    return normalized.length > 0 ? normalized : '.';
  }

  private getParentRemotePath(remotePath: string): string {
    const normalized = this.normalizeRemotePath(remotePath).replace(/\/+$|\/+$/g, '');
    if (!normalized || normalized === '.') {
      return '.';
    }
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash < 0) {
      return '.';
    }
    if (lastSlash === 0) {
      return '/';
    }
    return normalized.slice(0, lastSlash);
  }

  private refreshFolder(treeDataProvider: TreeDataProvider, folderPath: string): void {
    treeDataProvider.refreshRemoteFolder(this.connection.label, this.normalizeRemotePath(folderPath), 'ftp');
  }

  private async createDownloadWorkerClient(): Promise<FtpClient> {
    const client = new FtpClient();
    await client.access({
      host: this.connection.host,
      port: this.connection.port ? Number(this.connection.port) : 21,
      user: this.connection.user,
      password: this.connection.password,
      secure: true,
      secureOptions: { rejectUnauthorized: false }
    });

    if (this.initialPath && this.initialPath !== '.') {
      try {
        await client.cd(this.initialPath);
      } catch {
      }
    }

    return client;
  }

  public connect(): Promise<FtpClient> {
    return new Promise(async (resolve, reject) => {
      const ftpClient = new FtpClient();
      LoggerService.log(`[FtpRemoteService] Connecting to FTP (always new connection, label: ${this.connection.label})...`);

      try {
        await ftpClient.access({
          host: this.connection.host,
          port: this.connection.port ? Number(this.connection.port) : 21,
          user: this.connection.user,
          password: this.connection.password,
          secure: true,
          secureOptions: { rejectUnauthorized: false }
        });

        this.initialPath = await ftpClient.pwd(); 
        LoggerService.log(`[FTP] Initial directory: ${this.initialPath}`);

        LoggerService.log('[FtpRemoteService] FTP connection ready');
        
        (ftpClient as any).isConnected = true;
        SessionProvider.setSession(this.connection.label, ftpClient);
        ftpClient.ftp.socket.on('close', () => {
          LoggerService.log('[FtpRemoteService] FTP connection ended');
          (ftpClient as any).isConnected = false;
          SessionProvider.closeSession(this.connection.label);
        });

        ftpClient.ftp.socket.on('error', (err: any) => {
          LoggerService.log(`[FtpRemoteService] FTP socket error: ${err.message}`);
          (ftpClient as any).isConnected = false;
          SessionProvider.closeSession(this.connection.label);
        });

        resolve(ftpClient);

      } catch (err: any) {
        LoggerService.log(`[FtpRemoteService] FTP connection error: ${err.message}`);
        (ftpClient as any).isConnected = false;
        SessionProvider.closeSession(this.connection.label);
        
        ftpClient.close(); 
        reject(err);
      }
    });
  }

  async listDirectory(path: string): Promise<vscode.TreeItem[]> {
    return this._mutex.acquire(async () => {
      LoggerService.log('==============================');
      LoggerService.log(`[FTP][DEBUG] listDirectory ENTRY: path=${path}, label=${this.connection.label}`);

      try {
        const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);

        if (!session || (session as any).closed) {
          throw new Error('FTP client not initialized or connection closed');
        }

        let requestPath = path;
        if (path === '.') {
          requestPath = this.initialPath;
        }

        const list = await session.list(requestPath);

        LoggerService.log(`[FTP][DEBUG] Directory list received (${list.length} items).`);

        const items = list.map((item) => {
          const isFile = item.type === 1;
          const isDir = item.type === 2;
          
          const cleanPath = path.endsWith('/') ? path : (path === '.' ? '' : path + '/');
          const ftpPath = path === '.' ? item.name : cleanPath + item.name;

          const treeItem = new vscode.TreeItem(
            item.name, 
            isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
          );

          treeItem.contextValue = isDir ? 'ftp-folder' : (isFile ? 'ftp-file' : 'ftp-unknown');
          
          (treeItem as any).ftpPath = ftpPath;
          (treeItem as any).connectionLabel = this.connection.label;
          (treeItem as any).item = item;

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
                connectionLabel: this.connection.label
              }]
            };
          }

          return treeItem;
        });

        LoggerService.log(`[FTP][DEBUG] Returning ${items.length} tree items. EXIT`);
        LoggerService.log('==============================');
        return items;

      } catch (e: any) {
        const msg = e.message || String(e);
        LoggerService.log(`[FTP][ERROR] Exception in listDirectory: ${msg}`);
        vscode.window.showErrorMessage('FTP Error: ' + msg);
        return [];
      }
    });
  }

  async downloadWithDialogs(item: any): Promise<void> {
    const isDirectory = item?.contextValue === 'ssh-folder' || item?.contextValue === 'ftp-folder';
    const selectedPath = item?.ftpPath || item?.sshPath || item?.item?.name || 'unknown';
    LoggerService.log(`[FTP][DOWNLOAD] START dialog type=${isDirectory ? 'directory' : 'file'} path=${selectedPath}`);
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
      LoggerService.log(`[FTP][DOWNLOAD] END success type=${isDirectory ? 'directory' : 'file'} path=${selectedPath}`);
    } catch (err: any) {
      LoggerService.log(`[FTP][DOWNLOAD] END fail type=${isDirectory ? 'directory' : 'file'} path=${selectedPath} error=${err?.message || String(err)}`);
      vscode.window.showErrorMessage(LangService.t('downloadError', { error: err.message }));
    }
  }

  async download(item: any, localTarget: string): Promise<void> {
    const remotePath = item?.ftpPath;
    if (!remotePath) {
      throw new Error('Remote path is missing');
    }

    const pathMod = require('path');
    const localDest = pathMod.join(localTarget, pathMod.basename(remotePath));

    const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
    
    if (!session || (session as any).closed) {
      throw new Error('FTP session not initialized or connection closed');
    }

    LoggerService.log(`[FTP][DOWNLOAD FILE] START: ${remotePath} -> ${localDest}`);

    try {
      await session.downloadTo(localDest, remotePath);
      LoggerService.log(`[FTP][DOWNLOAD FILE] END success: ${localDest}`);
    } catch (err: any) {
      LoggerService.log(`[FTP][DOWNLOAD FILE] END fail: ${remotePath} error=${err.message}`);
      throw err;
    }
  }

  async downloadDir(item: any, localTarget: string): Promise<void> {
    return this._mutex.acquire(async () => {
      const remoteDir = item?.ftpPath || item.item?.name;
      const pathMod = require('path');
      const fs = require('fs');
      
      const localDest = pathMod.join(localTarget, pathMod.basename(remoteDir));
      await fs.promises.mkdir(localDest, { recursive: true });

      const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
      if (!session || (session as any).closed) throw new Error('FTP session not initialized');

      LoggerService.log(`[FTP][DOWNLOAD DIR] START: ${remoteDir} -> ${localDest}`);
      try {
        const filesToDownload: Array<{ remotePath: string; localPath: string }> = [];
        const collectFiles = async (rDir: string, lDir: string): Promise<void> => {
          await fs.promises.mkdir(lDir, { recursive: true });
          const list = await session.list(rDir);
          const entries = list.filter((entry: any) => entry.name !== '.' && entry.name !== '..');

          for (const entry of entries) {
            const remotePath = rDir.endsWith('/') ? rDir + entry.name : rDir + '/' + entry.name;
            const localPath = pathMod.join(lDir, entry.name);
            if (entry.type === 2) {
              await collectFiles(remotePath, localPath);
            } else if (entry.type === 1) {
              filesToDownload.push({ remotePath, localPath });
            }
          }
        };

        await collectFiles(remoteDir, localDest);
        LoggerService.log(`[FTP][DOWNLOAD DIR] QUEUE built: ${filesToDownload.length} files`);

        const CONCURRENCY_LIMIT = 3;
        const queue = [...filesToDownload];
        let downloadedCount = 0;

        const workers: FtpClient[] = await Promise.all(
          Array(Math.min(CONCURRENCY_LIMIT, queue.length))
            .fill(null)
            .map(() => this.createDownloadWorkerClient())
        );

        try {
          const workerRun = async (worker: FtpClient): Promise<void> => {
            while (queue.length > 0) {
              const job = queue.shift();
              if (!job) {
                continue;
              }
              LoggerService.log(`[FTP][DOWNLOAD DIR][FILE] START: ${job.remotePath}`);
              await worker.downloadTo(job.localPath, job.remotePath);
              downloadedCount++;
              LoggerService.log(`[FTP][DOWNLOAD DIR][FILE] END: ${job.remotePath}`);
              vscode.window.setStatusBarMessage(`Remotix: Downloaded ${downloadedCount}/${filesToDownload.length} items`, 2000);
            }
          };

          await Promise.all(workers.map((worker) => workerRun(worker)));
        } finally {
          for (const worker of workers) {
            try {
              worker.close();
            } catch {
            }
          }
        }

        LoggerService.log(`[FTP][DOWNLOAD DIR] END success: ${remoteDir}`);
      } catch (err: any) {
        LoggerService.log(`[FTP][DOWNLOAD DIR] END fail: ${remoteDir} error=${err?.message || String(err)}`);
        throw err;
      }
    });
  }

  async uploadWithDialogs(item: any): Promise<void> {
    const treeDataProvider = Container.get('treeDataProvider') as TreeDataProvider;
    const targetPath = item?.sshPath || item?.ftpPath;
    const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
    if (!session) {
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
    const refreshPath = item?.contextValue === 'ftp-folder' || item?.contextValue === 'ssh-folder'
      ? targetPath
      : this.getParentRemotePath(targetPath);
    this.refreshFolder(treeDataProvider, refreshPath);
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    return this._mutex.acquire(async () => {
      
      const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
      
      if (!session || (session as any).closed) {
        throw new Error(`FTP session not initialized or connection closed for ${this.connection.label}`);
      }

      LoggerService.log(`[FTP] Uploading: ${localPath} -> ${remotePath}`);
      
      try {
        await session.uploadFrom(localPath, remotePath);
        LoggerService.log(`[FTP] Upload successful`);
      } catch (err: any) {
        LoggerService.log(`[FTP][ERROR] Upload failed: ${err.message}`);
        throw err;
      }
    });
  }

  async uploadDir(localDir: string, remoteDir: string): Promise<void> {
    return this._mutex.acquire(async () => {
      const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
      
      if (!session || (session as any).closed) {
        throw new Error(`FTP session not initialized or connection closed for ${this.connection.label}`);
      }

      LoggerService.log(`[FTP] uploadDir START: ${localDir} -> ${remoteDir}`);

      try {
        await session.uploadFromDir(localDir, remoteDir);
        LoggerService.log(`[FTP] uploadDir SUCCESS`);
      } catch (err: any) {
        LoggerService.log(`[FTP][ERROR] uploadDir failed: ${err.message}`);
        throw err;
      }
    });
  }


  async createFileWithDialogs(item: any): Promise<void> {
    const treeDataProvider = Container.get('treeDataProvider') as TreeDataProvider;

    const ftpPath = item?.ftpPath || item?.sshPath;
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
      const refreshPath = item?.contextValue === 'ftp-folder' || item?.contextValue === 'ssh-folder'
        ? ftpPath
        : this.getParentRemotePath(ftpPath);
      this.refreshFolder(treeDataProvider, refreshPath);
    } catch (e: any) {
      vscode.window.showErrorMessage(LangService.t('createFileFailed', { error: (e instanceof Error ? e.message : String(e)) }));
    }
  }

  async createFile(remotePath: string): Promise<void> {
    return this._mutex.acquire(async () => {
      const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
      
      if (!session || (session as any).closed) {
        throw new Error(`FTP session not initialized or connection closed for ${this.connection.label}`);
      }

      const fs = require('fs');
      const pathMod = require('path');
      const os = require('os');

      const tmpDir = os.tmpdir();
      const tmpPath = pathMod.join(tmpDir, `remotix_empty_${Date.now()}.txt`);

      try {
        LoggerService.log(`[FTP] Creating empty file: ${remotePath}`);
        fs.writeFileSync(tmpPath, '');
        await session.uploadFrom(tmpPath, remotePath);
        
        LoggerService.log(`[FTP] File created successfully`);
      } catch (err: any) {
        LoggerService.log(`[FTP][ERROR] createFile failed: ${err.message}`);
        throw err;
      } finally {
        try {
          if (fs.existsSync(tmpPath)) {
            fs.unlinkSync(tmpPath);
          }
        } catch (cleanupErr) {
          LoggerService.log(`[FTP] Temp file cleanup error: ${cleanupErr}`);
        }
      }
    });
  }


  async createFolderWithDialogs(item: any): Promise<void> {
    const treeDataProvider = Container.get('treeDataProvider') as TreeDataProvider;
    LoggerService.log('[FTP][createFolderWithDialogs] ENTRY');
    LoggerService.logObject('[FTP][createFolderWithDialogs] item', item);
    const ftpPath = item?.ftpPath || item?.sshPath;
    LoggerService.log(`[FTP][createFolderWithDialogs] ftpPath: ${ftpPath}`);
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
      await this.createFolder(newFolderPath);
      LoggerService.log('[FTP][createFolderWithDialogs] Folder created successfully');
      vscode.window.showInformationMessage(LangService.t('folderCreated', { path: newFolderPath }));
      if (treeDataProvider && typeof treeDataProvider.clearRemoteServiceCache === 'function') {
        LoggerService.log('[FTP][createFolderWithDialogs] Clearing remoteServiceCache');
        treeDataProvider.clearRemoteServiceCache(this.connection.label);
      }
      const refreshPath = item?.contextValue === 'ftp-folder' || item?.contextValue === 'ssh-folder'
        ? ftpPath
        : this.getParentRemotePath(ftpPath);
      this.refreshFolder(treeDataProvider, refreshPath);
      LoggerService.log('[FTP][createFolderWithDialogs] folder-level refresh called');
    } catch (e: any) {
      LoggerService.log(`[FTP][createFolderWithDialogs] ERROR: ${e instanceof Error ? e.message : String(e)}`);
      vscode.window.showErrorMessage(LangService.t('createFolderFailed', { error: (e instanceof Error ? e.message : String(e)) }));
    }
    LoggerService.log('[FTP][createFolderWithDialogs] EXIT');
  }

  async createFolder(remoteDir: string): Promise<void> {
    return this._mutex.acquire(async () => {
      const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
      
      if (!session || (session as any).closed) {
        throw new Error(`FTP session not initialized or connection closed for ${this.connection.label}`);
      }

      let previousDir = '/';
      try {
        previousDir = await session.pwd();
        LoggerService.log(`[FTP] Current directory before create: ${previousDir}`);
      } catch (pwdErr) {
        LoggerService.log(`[FTP][WARNING] Could not get current directory: ${pwdErr}`);
      }

      LoggerService.log(`[FTP] Creating directory (ensureDir): ${remoteDir}`);

      try {
        await session.ensureDir(remoteDir);
        LoggerService.log(`[FTP] Directory created or already exists`);

      } catch (err: any) {
        LoggerService.log(`[FTP][ERROR] createFolder failed: ${err.message}`);
        throw err;
      } finally {
        try {
          await session.cd(previousDir);
          LoggerService.log(`[FTP] Returned to directory: ${previousDir}`);
        } catch (cdErr: any) {
          LoggerService.log(`[FTP][ERROR] Failed to return to ${previousDir}: ${cdErr.message}`);
          await session.cd('/'); 
        }
      }
    });
  }


  async deleteFileWithDialogs(item: any): Promise<void> {
    const treeDataProvider = Container.get('treeDataProvider') as TreeDataProvider;
    const ftpPath = item?.ftpPath || item?.sshPath;
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
      this.refreshFolder(treeDataProvider, this.getParentRemotePath(ftpPath));
    } catch (e: any) {
      vscode.window.showErrorMessage(LangService.t('deleteFailed', { error: (e instanceof Error ? e.message : String(e)) }));
    }
  }

  async deleteFile(remotePath: string): Promise<void> {
    return this._mutex.acquire(async () => {
      const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
      
      if (!session || (session as any).closed) {
        throw new Error(`FTP session not initialized or connection closed for ${this.connection.label}`);
      }

      LoggerService.log(`[FTP] Deleting file: ${remotePath}`);

      try {
        await session.remove(remotePath);
        LoggerService.log(`[FTP] File deleted successfully`);
      } catch (err: any) {
        LoggerService.log(`[FTP][ERROR] deleteFile failed: ${err.message}`);
        throw err;
      }
    });
  }

  async deleteDir(remoteDir: string): Promise<void> {
    return this._mutex.acquire(async () => {
      const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
      
      if (!session || (session as any).closed) {
        throw new Error(`FTP session not initialized or connection closed for ${this.connection.label}`);
      }

      LoggerService.log(`[FTP] Starting recursive deletion of: ${remoteDir}`);

      try {
        await this._recursiveDelete(session, remoteDir);
        LoggerService.log(`[FTP] Recursive delete SUCCESS: ${remoteDir}`);
      } catch (err: any) {
        LoggerService.log(`[FTP][ERROR] Recursive delete FAILED: ${err.message}`);
        throw err;
      }
    });
  }


  async renameWithDialogs(item: any): Promise<void> {
    const treeDataProvider = Container.get('treeDataProvider') as TreeDataProvider;
    const labelStr = typeof item.label === 'string' ? item.label : (item.label && typeof item.label.label === 'string' ? item.label.label : String(item.label));
    const oldLabel = labelStr;
    const ftpPath = item.ftpPath || item.sshPath;
    if (!ftpPath) {
      vscode.window.showErrorMessage(LangService.t('missingSshPathOrConnectionLabel'));
      return;
    }
    const newName = await vscode.window.showInputBox({
      prompt: LangService.t('rename'),
      value: oldLabel
    });
    if (!newName || newName === oldLabel) return;
    const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
    if (!session) {
      vscode.window.showErrorMessage(LangService.t('connectionNotFound'));
      return;
    }
    const oldPath = ftpPath;
    const newPath = oldPath.replace(/[^/]+$/, newName);
    try {
      await this.rename(oldPath, newPath);
      vscode.window.showInformationMessage(LangService.t('renamedTo', { name: newName }));
      const oldParent = this.getParentRemotePath(oldPath);
      const newParent = this.getParentRemotePath(newPath);
      this.refreshFolder(treeDataProvider, oldParent);
      if (newParent !== oldParent) {
        this.refreshFolder(treeDataProvider, newParent);
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(LangService.t('renameFailed', { error: (e instanceof Error ? e.message : String(e)) }));
    }
  }

  async rename(oldRemotePath: string, newRemotePath: string): Promise<void> {
    return this._mutex.acquire(async () => {
      const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
      
      if (!session || (session as any).closed) {
        throw new Error(`FTP session not initialized or connection closed for ${this.connection.label}`);
      }

      LoggerService.log(`[FTP] Renaming: ${oldRemotePath} -> ${newRemotePath}`);

      try {
        await session.rename(oldRemotePath, newRemotePath);
        
        LoggerService.log(`[FTP] Rename successful`);
      } catch (err: any) {
        LoggerService.log(`[FTP][ERROR] rename failed: ${err.message}`);
        throw err;
      }
    });
  }


  async editFileWithDialogs(item: any): Promise<void> {
    return this._mutex.acquire(async () => {
      const treeDataProvider = Container.get('treeDataProvider') as TreeDataProvider;
      const ftpPath = item.ftpPath;

      if (!ftpPath) {
        vscode.window.showErrorMessage(LangService.t('missingPathOrConnection'));
        return;
      }

      const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
      if (!session) {
        vscode.window.showErrorMessage(LangService.t('noConnectionsFound'));
        return;
      }

      const os = require('os');
      const pathMod = require('path');
      const fs = require('fs');

      const tmp = os.tmpdir();
      const safeHost = (this.connection.host ?? 'unknown').replace(/[^\w]/g, '_');
      const safeRelPath = ftpPath.replace(/^\/+/, '').split('/').map((p: string) => p.replace(/[^\w.\-]/g, '_')).join(pathMod.sep);
      
      const tmpDir = pathMod.join(tmp, `remotix_ftp_${safeHost}`);
      const tmpFile = pathMod.join(tmpDir, safeRelPath);

      try {
        fs.mkdirSync(pathMod.dirname(tmpFile), { recursive: true });

        if (treeDataProvider?.treeLocker) {
          treeDataProvider.treeLocker.lock(LangService.t('downloadingFile'));
        }

        const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
        if (!session || (session as any).closed) {
          throw new Error('FTP session not initialized or connection closed');
        }

        LoggerService.log(`[FTP] Downloading for edit: ${ftpPath} -> ${tmpFile}`);
        await session.downloadTo(tmpFile, ftpPath);

        const doc = await vscode.workspace.openTextDocument(tmpFile);
        await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Active });

        vscode.window.setStatusBarMessage(LangService.t('remoteFile', {
          user: this.connection.user ?? '',
          host: this.connection.host ?? '',
          path: ftpPath
        }), 5000);

        const saveListener = vscode.workspace.onDidSaveTextDocument(async (savedDoc) => {
          if (savedDoc.fileName === tmpFile) {
            try {
              const session2 = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
              if (!session2 || (session2 as any).closed) throw new Error('Connection lost');
              
              LoggerService.log(`[FTP] Uploading changes: ${tmpFile} -> ${ftpPath}`);
              await session2.uploadFrom(tmpFile, ftpPath);
              vscode.window.setStatusBarMessage(LangService.t('fileSavedToServer'), 2000);
            } catch (e: any) {
              vscode.window.showErrorMessage(LangService.t('fileUploadError', { error: e.message }));
            }
          }
        });

        const closeListener = vscode.workspace.onDidCloseTextDocument((closedDoc) => {
          if (closedDoc.fileName === tmpFile) {
            saveListener.dispose();
            closeListener.dispose();
            try {
              if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
            } catch (err) {
              LoggerService.log(`[FTP] Temp file cleanup error: ${err}`);
            }
          }
        });

      } catch (e: any) {
        const msg = e.message || String(e);
        LoggerService.log(`[FTP][ERROR] editFile: ${msg}`);
        vscode.window.showErrorMessage(LangService.t('fileDownloadError', { error: msg }));
      } finally {
        if (treeDataProvider?.treeLocker) {
          treeDataProvider.treeLocker.unlock();
        }
      }
    });
  }


  async moveItems(items: any[], targetFolder: string, treeDataProvider: any): Promise<void> {
    return this._mutex.acquire(async () => {
      if (items.length === 0) return;

      const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
      if (!session || (session as any).closed) {
        throw new Error(`FTP session not initialized for ${this.connection.label}`);
      }

      let hadError = false;
      const targetDirClean = targetFolder.endsWith('/') ? targetFolder : targetFolder + '/';

      for (const item of items) {
        const oldPath = item.ftpPath || item.sshPath || (item.resourceUri ? item.resourceUri.path : null);
        
        if (!oldPath || oldPath === '.') {
          LoggerService.log(`[FTP][moveItems] Skipping item (invalid path): ${item.label || 'unknown'}`);
          continue;
        }

        const itemName = oldPath.split('/').filter(Boolean).pop();
        const newPath = targetDirClean + itemName;

        if (oldPath === newPath) continue;

        LoggerService.log(`[FTP][moveItems] Moving: ${oldPath} -> ${newPath}`);

        try {
          await session.rename(oldPath, newPath);
        } catch (err: any) {
          hadError = true;
          LoggerService.log(`[FTP][moveItems][ERROR] ${err.message}`);
          vscode.window.showErrorMessage(`Move failed: ${err.message}`);
        }
      }

      if (treeDataProvider?.refresh) {
        this.refreshFolder(treeDataProvider, targetFolder);
      }
      
      if (!hadError) {
        vscode.window.showInformationMessage('Items moved successfully');
      }
    });
  }

  private async _recursiveDelete(session: FtpClient, targetPath: string): Promise<void> {
    const list = await session.list(targetPath);

    for (const item of list) {
      if (item.name === '.' || item.name === '..') continue;
      const fullPath = targetPath.endsWith('/') 
        ? targetPath + item.name 
        : targetPath + '/' + item.name;

      if (item.type === 2) { // Directory
        await this._recursiveDelete(session, fullPath);
      } else {
        LoggerService.log(`[FTP][DEBUG] Removing file: ${fullPath}`);
        await session.remove(fullPath);
      }
    }

    LoggerService.log(`[FTP][DEBUG] Removing empty directory: ${targetPath}`);
    await session.removeDir(targetPath);
  }
}
