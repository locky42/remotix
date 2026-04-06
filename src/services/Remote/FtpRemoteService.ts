import * as vscode from 'vscode';
import { Container } from '../Container';
import { ConnectionItem } from '../../types';
import { LangService } from '../LangService';
import { RemoteService } from './RemoteService';
import { Client as FtpClient } from 'basic-ftp';
import { LoggerService } from '../LoggerService';
import { SessionProvider } from '../SessionProvider';
import { TreeDataProvider } from '../../ui/TreeDataProvider';
import { RemotePathHelper } from '../../helpers/RemotePathHelper';

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

  private getParentRemotePath(remotePath: string): string {
    const normalized = RemotePathHelper.normalizeRemotePath(remotePath).replace(/\/+$/g, '');
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

  private toAbsoluteRemotePath(remotePath: string): string {
    const normalizedInput = (remotePath || '.').replace(/\\/g, '/').trim();
    if (!normalizedInput || normalizedInput === '.') {
      return (this.initialPath || '/').replace(/\/+/g, '/');
    }
    if (normalizedInput.startsWith('/')) {
      return normalizedInput.replace(/\/+/g, '/');
    }
    const base = (this.initialPath || '/').replace(/\/$/, '');
    return `${base}/${normalizedInput}`.replace(/\/+/g, '/');
  }

  private normalizeRemoteLeafName(rawName: string): string {
    const normalized = String(rawName || '').replace(/\\/g, '/').trim();
    if (!normalized) {
      return '';
    }
    const parts = normalized.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : normalized;
  }

  private refreshFolder(treeDataProvider: TreeDataProvider, folderPath: string): void {
    treeDataProvider.refreshRemoteFolder(this.connection.label, RemotePathHelper.normalizeRemotePath(folderPath), 'ftp');
  }

  private getUploadConcurrencyLimit(): number {
    const configured = vscode.workspace.getConfiguration('remotix').get<number>('ftpUploadConcurrency', 3);
    const value = Number.isFinite(configured as number) ? Number(configured) : 3;
    return Math.max(1, Math.min(10, Math.floor(value)));
  }

  private getDownloadConcurrencyLimit(): number {
    const configured = vscode.workspace.getConfiguration('remotix').get<number>('ftpDownloadConcurrency', 3);
    const value = Number.isFinite(configured as number) ? Number(configured) : 3;
    return Math.max(1, Math.min(10, Math.floor(value)));
  }

  private getDeleteFileConcurrencyLimit(): number {
    const configured = vscode.workspace.getConfiguration('remotix').get<number>('ftpDeleteFileConcurrency', 4);
    const value = Number.isFinite(configured as number) ? Number(configured) : 4;
    return Math.max(1, Math.min(10, Math.floor(value)));
  }

  private async createWorkerClient(): Promise<FtpClient> {
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

        this.initialPath = RemotePathHelper.normalizeAbsolutePath(await ftpClient.pwd()); 
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
        requestPath = RemotePathHelper.normalizeAbsolutePath(requestPath);

        const list = await session.list(requestPath);

        LoggerService.log(`[FTP][DEBUG] Directory list received (${list.length} items).`);

        const items = list
          .map((item) => ({ ...item, __leafName: this.normalizeRemoteLeafName(item.name) }))
          .filter((item: any) => item.__leafName && item.__leafName !== '.' && item.__leafName !== '..')
          .map((item: any) => {
          const isFile = item.type === 1;
          const isDir = item.type === 2;
          const leafName = item.__leafName as string;
          
          const cleanPath = path.endsWith('/') ? path : (path === '.' ? '' : path + '/');
          const ftpPath = path === '.' ? leafName : cleanPath + leafName;
          const absoluteFtpPath = RemotePathHelper.normalizeAbsolutePath(ftpPath);

          const treeItem = new vscode.TreeItem(
            leafName,
            isDir
              ? (RemotePathHelper.shouldAutoExpandDirectory(this.initialPath, absoluteFtpPath)
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed)
              : vscode.TreeItemCollapsibleState.None
          );

          treeItem.contextValue = isDir ? 'ftp-folder' : (isFile ? 'ftp-file' : 'ftp-unknown');
          
          (treeItem as any).ftpPath = absoluteFtpPath;
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
                label: leafName,
                ftpPath: absoluteFtpPath,
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

        const CONCURRENCY_LIMIT = this.getDownloadConcurrencyLimit();
        const queue = [...filesToDownload];
        let downloadedCount = 0;

        const workers: FtpClient[] = await Promise.all(
          Array(Math.min(CONCURRENCY_LIMIT, queue.length))
            .fill(null)
            .map(() => this.createWorkerClient())
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
    LoggerService.log(`[FTP][UPLOAD] START dialog target=${targetPath || 'unknown'}`);
    const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
    if (!session) {
      vscode.window.showErrorMessage(LangService.t('connectionNotFound'));
      LoggerService.log('[FTP][UPLOAD] END fail: no active session');
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
      LoggerService.log('[FTP][UPLOAD] END canceled: no selection');
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
      LoggerService.log(`[FTP][UPLOAD] END success target=${targetPath}`);
    } else {
      LoggerService.log(`[FTP][UPLOAD] END fail target=${targetPath}`);
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

      LoggerService.log(`[FTP][UPLOAD FILE] START: ${localPath} -> ${remotePath}`);
      
      try {
        await session.uploadFrom(localPath, remotePath);
        LoggerService.log(`[FTP][UPLOAD FILE] END success: ${remotePath}`);
      } catch (err: any) {
        LoggerService.log(`[FTP][UPLOAD FILE] END fail: ${remotePath} error=${err.message}`);
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

      LoggerService.log(`[FTP][UPLOAD DIR] START: ${localDir} -> ${remoteDir}`);

      const fs = require('fs');
      const pathMod = require('path');
      const normalizedRoot = String(remoteDir).replace(/\\/g, '/');

      try {
        const dirsToEnsure: string[] = [];
        const fileJobs: Array<{ localPath: string; remotePath: string }> = [];
        const visitedRealDirs = new Set<string>();

        const collect = async (currentLocalDir: string, currentRemoteDir: string): Promise<void> => {
          const realDir = await fs.promises.realpath(currentLocalDir).catch(() => currentLocalDir);
          if (visitedRealDirs.has(realDir)) {
            LoggerService.log(`[FTP][UPLOAD DIR][SKIP] Already visited local dir (cycle guard): ${currentLocalDir}`);
            return;
          }
          visitedRealDirs.add(realDir);

          dirsToEnsure.push(currentRemoteDir);
          const entries = await fs.promises.readdir(currentLocalDir, { withFileTypes: true });
          for (const entry of entries) {
            const src = pathMod.join(currentLocalDir, entry.name);
            const dest = `${currentRemoteDir}/${entry.name}`.replace(/\\/g, '/');
            if (entry.isSymbolicLink && entry.isSymbolicLink()) {
              LoggerService.log(`[FTP][UPLOAD DIR][SKIP] Symbolic link: ${src}`);
              continue;
            }
            if (entry.isDirectory()) {
              await collect(src, dest);
            } else {
              fileJobs.push({ localPath: src, remotePath: dest });
            }
          }
        };

        await collect(localDir, normalizedRoot);
        LoggerService.log(`[FTP][UPLOAD DIR] QUEUE built: dirs=${dirsToEnsure.length}, files=${fileJobs.length}`);

        const previousDir = await session.pwd().catch(() => '/');
        LoggerService.log(`[FTP][UPLOAD DIR] BASE dir before ensure: ${previousDir}`);
        try {
          for (const dir of Array.from(new Set(dirsToEnsure))) {
            // ensureDir changes current directory; reset to base so relative paths stay stable
            await session.cd(previousDir);
            LoggerService.log(`[FTP][UPLOAD DIR][MKDIR] START base=${previousDir} ensure=${dir}`);
            try {
              await session.ensureDir(dir);
              LoggerService.log(`[FTP][UPLOAD DIR][MKDIR] END success ensure=${dir}`);
            } catch (mkdirErr: any) {
              LoggerService.log(`[FTP][UPLOAD DIR][MKDIR] END fail ensure=${dir} error=${mkdirErr?.message || String(mkdirErr)}`);
              throw mkdirErr;
            }
          }
        } finally {
          try {
            await session.cd(previousDir);
            LoggerService.log(`[FTP][UPLOAD DIR] Restored base dir: ${previousDir}`);
          } catch {
            await session.cd('/');
            LoggerService.log('[FTP][UPLOAD DIR] Failed to restore base dir, moved to /');
          }
        }

        const CONCURRENCY_LIMIT = this.getUploadConcurrencyLimit();
        const queue = [...fileJobs];
        let uploadedCount = 0;

        const workers: FtpClient[] = await Promise.all(
          Array(Math.min(CONCURRENCY_LIMIT, queue.length))
            .fill(null)
            .map(() => this.createWorkerClient())
        );

        try {
          const workerRun = async (worker: FtpClient): Promise<void> => {
            while (queue.length > 0) {
              const job = queue.shift();
              if (!job) {
                continue;
              }
              LoggerService.log(`[FTP][UPLOAD DIR][FILE] START: ${job.localPath} -> ${job.remotePath}`);
              try {
                await worker.uploadFrom(job.localPath, job.remotePath);
              } catch (uploadErr: any) {
                LoggerService.log(`[FTP][UPLOAD DIR][FILE] END fail: ${job.remotePath} error=${uploadErr?.message || String(uploadErr)}`);
                throw uploadErr;
              }
              uploadedCount++;
              LoggerService.log(`[FTP][UPLOAD DIR][FILE] END: ${job.remotePath}`);
              vscode.window.setStatusBarMessage(`Remotix: Uploaded ${uploadedCount}/${fileJobs.length} items`, 2000);
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

        LoggerService.log(`[FTP][UPLOAD DIR] END success: ${remoteDir}`);
      } catch (err: any) {
        LoggerService.log(`[FTP][UPLOAD DIR] END fail: ${remoteDir} error=${err.message}`);
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
    LoggerService.log(`[FTP][DELETE] START type=${isDir ? 'directory' : 'file'} path=${ftpPath}`);
    treeDataProvider?.treeLocker?.lock(LangService.t('deleteInProgress'), this.connection.label);
    try {
      if (isDir) {
        await this.deleteDir(ftpPath);
        vscode.window.showInformationMessage(LangService.t('folderDeleted', { path: ftpPath }));
      } else {
        await this.deleteFile(ftpPath);
        vscode.window.showInformationMessage(LangService.t('fileDeleted', { path: ftpPath }));
      }
      this.refreshFolder(treeDataProvider, this.getParentRemotePath(ftpPath));
      LoggerService.log(`[FTP][DELETE] END success type=${isDir ? 'directory' : 'file'} path=${ftpPath}`);
    } catch (e: any) {
      LoggerService.log(`[FTP][DELETE] END fail type=${isDir ? 'directory' : 'file'} path=${ftpPath} error=${e instanceof Error ? e.message : String(e)}`);
      vscode.window.showErrorMessage(LangService.t('deleteFailed', { error: (e instanceof Error ? e.message : String(e)) }));
    } finally {
      treeDataProvider?.treeLocker?.unlock();
    }
  }

  async deleteFile(remotePath: string): Promise<void> {
    return this._mutex.acquire(async () => {
      const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
      
      if (!session || (session as any).closed) {
        throw new Error(`FTP session not initialized or connection closed for ${this.connection.label}`);
      }

      const absolutePath = this.toAbsoluteRemotePath(remotePath);
      LoggerService.log(`[FTP][DELETE FILE] START: ${remotePath} (absolute=${absolutePath})`);

      try {
        await session.remove(absolutePath);
        LoggerService.log(`[FTP][DELETE FILE] END success: ${remotePath}`);
      } catch (err: any) {
        LoggerService.log(`[FTP][DELETE FILE] END fail: ${remotePath} error=${err.message}`);
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

      const absoluteRemoteDir = this.toAbsoluteRemotePath(remoteDir);
      LoggerService.log(`[FTP][DELETE DIR] START: ${remoteDir} (absolute=${absoluteRemoteDir})`);

      // Prefer server-side recursive delete first on a separate client with timeout.
      // This prevents the main session from appearing frozen if the server stalls.
      try {
        const nativeTimeoutMs = 12000;
        vscode.window.setStatusBarMessage('Remotix: Deleting directory (server-side)...', 1500);
        LoggerService.log(`[FTP][DELETE DIR] native-removeDir START: ${absoluteRemoteDir} timeout=${nativeTimeoutMs}ms`);

        const nativeClient = await this.createWorkerClient();
        try {
          await Promise.race([
            nativeClient.removeDir(absoluteRemoteDir),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error(`native-removeDir timeout after ${nativeTimeoutMs}ms`)), nativeTimeoutMs);
            })
          ]);

          LoggerService.log(`[FTP][DELETE DIR] END success: ${absoluteRemoteDir} strategy=native-removeDir`);
          return;
        } finally {
          try {
            nativeClient.close();
          } catch {
          }
        }
      } catch (nativeErr: any) {
        LoggerService.log(`[FTP][DELETE DIR] native-removeDir fail: ${absoluteRemoteDir} error=${nativeErr?.message || String(nativeErr)}; fallback=manual-recursive`);
      }

      const stats = { files: 0, dirs: 0 };
      let step = 0;
      const onProgress = (stage: string, path: string) => {
        step++;
        if (step % 10 === 0) {
          vscode.window.setStatusBarMessage(`Remotix: Deleting ${stats.files} files, ${stats.dirs} dirs`, 1500);
        }
        LoggerService.log(`[FTP][DELETE DIR][PROGRESS] step=${step} stage=${stage} path=${path} files=${stats.files} dirs=${stats.dirs}`);
      };

      try {
        const manualClient = await this.createWorkerClient();
        try {
          await this._recursiveDelete(manualClient, absoluteRemoteDir, stats, onProgress, new Set<string>(), 0, absoluteRemoteDir, new Set<string>());
        } finally {
          try {
            manualClient.close();
          } catch {
          }
        }
        LoggerService.log(`[FTP][DELETE DIR] END success: ${absoluteRemoteDir} summary(files=${stats.files}, dirs=${stats.dirs})`);
      } catch (err: any) {
        LoggerService.log(`[FTP][DELETE DIR] END fail: ${absoluteRemoteDir} error=${err.message} summary(files=${stats.files}, dirs=${stats.dirs})`);
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
          treeDataProvider.treeLocker.lock(LangService.t('downloadingFile'), this.connection.label);
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

  private async _recursiveDelete(
    session: FtpClient,
    targetPath: string,
    stats?: { files: number; dirs: number },
    onProgress?: (stage: string, path: string) => void,
    pathStack?: Set<string>,
    depth: number = 0,
    rootTargetPath?: string,
    pathIdStack?: Set<string>
  ): Promise<void> {
    const withOpTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
        })
      ]);
    };

    if (depth > 25) {
      throw new Error(`Delete depth limit exceeded at ${targetPath}. Possible cyclic/synthetic directory structure.`);
    }

    const normalizedTarget = String(targetPath || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
    const normalizedRoot = String(rootTargetPath || normalizedTarget).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
    const stack = pathStack || new Set<string>();
    const idStack = pathIdStack || new Set<string>();
    if (stack.has(normalizedTarget)) {
      throw new Error(`Cycle detected during delete at ${normalizedTarget}`);
    }
    stack.add(normalizedTarget);

    LoggerService.log(`[FTP][DELETE DIR][ENTER] ${targetPath}`);
    const list = await withOpTimeout(session.list(targetPath), 5000, `list(${targetPath})`);
    LoggerService.log(`[FTP][DELETE DIR][LIST] ${targetPath} -> ${list.length} items`);
    const normalizeLeafName = (rawName: string): string => {
      const normalized = String(rawName || '').replace(/\\/g, '/').trim();
      if (!normalized) {
        return '';
      }
      const parts = normalized.split('/').filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : normalized;
    };

    const filePathsToDelete: string[] = [];
    const directoryEntries: Array<{ item: any; fullPath: string; normalizedFull: string; rootOccurences: number; dirId: string }> = [];

    for (const item of list) {
      const leafName = normalizeLeafName(item.name);
      if (!leafName || leafName === '.' || leafName === '..') continue;
      const fullPath = targetPath.endsWith('/') 
        ? targetPath + leafName 
        : targetPath + '/' + leafName;
      const normalizedFull = String(fullPath).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
      const rootOccurences = normalizedRoot ? (normalizedFull.split(normalizedRoot).length - 1) : 0;
      const dirId = String((item as any).uniqueID || '').trim();

      if (item.type === 2) {
        directoryEntries.push({ item, fullPath, normalizedFull, rootOccurences, dirId });
      } else {
        filePathsToDelete.push(fullPath);
      }
    }

    if (filePathsToDelete.length > 0) {
      const queue = [...filePathsToDelete];
      const workerCount = Math.min(this.getDeleteFileConcurrencyLimit(), queue.length);
      LoggerService.log(`[FTP][DELETE DIR][FILE QUEUE] ${targetPath} -> ${queue.length} files, workers=${workerCount}`);

      const workers: FtpClient[] = await Promise.all(
        Array(workerCount)
          .fill(null)
          .map(() => this.createWorkerClient())
      );

      try {
        const workerRun = async (worker: FtpClient): Promise<void> => {
          while (queue.length > 0) {
            const fullPath = queue.shift();
            if (!fullPath) {
              continue;
            }

            LoggerService.log(`[FTP][DELETE DIR][FILE] remove: ${fullPath}`);
            await withOpTimeout(worker.remove(fullPath), 5000, `remove(${fullPath})`);
            if (stats) {
              stats.files++;
            }
            onProgress?.('file', fullPath);
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
    }

    for (const dirEntry of directoryEntries) {
      const { fullPath, normalizedFull, rootOccurences, dirId } = dirEntry;
      const safeRemoveLoopNode = async (): Promise<boolean> => {
        let removed = false;
        try {
          await withOpTimeout(session.remove(fullPath), 3000, `remove(loop:${fullPath})`);
          removed = true;
          if (stats) {
            stats.files++;
          }
          onProgress?.('link', fullPath);
          LoggerService.log(`[FTP][DELETE DIR][LOOP] removed as file/link: ${fullPath}`);
        } catch {
        }
        if (!removed) {
          try {
            await withOpTimeout(session.removeDir(fullPath), 3000, `removeDir(loop:${fullPath})`);
            removed = true;
            if (stats) {
              stats.dirs++;
            }
            onProgress?.('dir', fullPath);
            LoggerService.log(`[FTP][DELETE DIR][LOOP] removed as directory: ${fullPath}`);
          } catch {
          }
        }
        return removed;
      };

      const hasRepeatingTail = (() => {
        if (!normalizedRoot || !normalizedFull.startsWith(`${normalizedRoot}/`)) {
          return false;
        }
        const rel = normalizedFull.slice(normalizedRoot.length + 1);
        const parts = rel.split('/').filter(Boolean);
        const maxWindow = Math.min(8, Math.floor(parts.length / 2));
        for (let size = 2; size <= maxWindow; size++) {
          const a = parts.slice(parts.length - size);
          const b = parts.slice(parts.length - 2 * size, parts.length - size);
          if (a.length === size && b.length === size && a.join('/') === b.join('/')) {
            return true;
          }
        }
        return false;
      })();

      const isLoopByRoot = rootOccurences > 1;
      const isLoopById = Boolean(dirId) && idStack.has(dirId);
      const isLoopByTail = hasRepeatingTail;

      if (isLoopByRoot || isLoopById || isLoopByTail) {
        LoggerService.log(`[FTP][DELETE DIR][LOOP] detected at ${normalizedFull} reason=${isLoopByRoot ? 'root-repeat' : isLoopById ? `id-repeat:${dirId}` : 'tail-repeat'}`);
        const removed = await safeRemoveLoopNode();
        if (!removed) {
          throw new Error(`Loop-like path detected and cannot remove safely: ${fullPath}`);
        }
        continue;
      }

      if (dirId) {
        idStack.add(dirId);
      }
      try {
        await this._recursiveDelete(session, fullPath, stats, onProgress, stack, depth + 1, normalizedRoot, idStack);
      } finally {
        if (dirId) {
          idStack.delete(dirId);
        }
      }
    }

    LoggerService.log(`[FTP][DELETE DIR][RMDIR] remove: ${targetPath}`);
    await withOpTimeout(session.removeDir(targetPath), 5000, `removeDir(${targetPath})`);
    if (stats) {
      stats.dirs++;
    }
    onProgress?.('dir', targetPath);
    stack.delete(normalizedTarget);
  }
}
