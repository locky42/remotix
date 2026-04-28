import * as vscode from 'vscode';
import { Container } from '../Container';
import { LangService } from '../LangService';
import { RemoteService } from './RemoteService';
import { Client as FtpClient } from 'basic-ftp';
import { LoggerService } from '../LoggerService';
import { ConfigService } from '../ConfigService';
import { SessionProvider } from '../SessionProvider';
import { TreeDataProvider } from '../../ui/TreeDataProvider';
import { RemotePathHelper } from '../../helpers/RemotePathHelper';
import { ConnectionItem, PermissionApplyTarget, PermissionChangeOptions } from '../../types';

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

  private normalizePermissionMode(rawMode: string): string | undefined {
    const value = String(rawMode || '').trim();
    if (!/^[0-7]{3,4}$/.test(value)) {
      return undefined;
    }
    return value;
  }

  private parsePermissionTripletToOctal(triplet: string): number {
    let value = 0;
    if (triplet[0] === 'r') value += 4;
    if (triplet[1] === 'w') value += 2;
    if (triplet[2] === 'x' || triplet[2] === 's' || triplet[2] === 't') value += 1;
    return value;
  }

  private detectModeFromFtpEntry(fileEntry: any): string | undefined {
    const perms = fileEntry?.permissions;
    if (perms && typeof perms === 'object') {
      const user = Number(perms.user);
      const group = Number(perms.group);
      const world = Number(perms.world);
      if (Number.isFinite(user) && Number.isFinite(group) && Number.isFinite(world)) {
        return `${user}${group}${world}`;
      }
    }

    if (typeof perms === 'string' && perms.length >= 9) {
      const block = perms.length >= 10 ? perms.slice(-9) : perms;
      const owner = this.parsePermissionTripletToOctal(block.slice(0, 3));
      const group = this.parsePermissionTripletToOctal(block.slice(3, 6));
      const world = this.parsePermissionTripletToOctal(block.slice(6, 9));
      return `${owner}${group}${world}`;
    }

    return undefined;
  }

  private async applyFtpChmod(client: FtpClient, remotePath: string, mode: string): Promise<void> {
    const absolutePath = this.toAbsoluteRemotePath(remotePath);
    let lastError: any;
    const primaryCommand = `SITE CHMOD ${mode} ${absolutePath}`;
    try {
      LoggerService.log(`[FTP][CHMOD] TRY command="${primaryCommand}"`);
      await client.send(primaryCommand);
      LoggerService.log(`[FTP][CHMOD] OK command="${primaryCommand}"`);
      return;
    } catch (err: any) {
      lastError = err;
      LoggerService.log(`[FTP][CHMOD] FAIL command="${primaryCommand}" error=${err?.message || String(err)}`);
    }

    // Fallback for servers that only allow chmod by leaf name in parent cwd.
    const parentPath = this.getParentRemotePath(absolutePath);
    const leafName = this.normalizeRemoteLeafName(absolutePath);
    if (leafName) {
      const previousDir = await client.pwd().catch(() => '/');
      try {
        LoggerService.log(`[FTP][CHMOD] TRY cd parent for leaf chmod parent=${parentPath} leaf=${leafName}`);
        await client.cd(parentPath);
        const fallbackCommand = `SITE CHMOD ${mode} ${leafName}`;
        LoggerService.log(`[FTP][CHMOD] TRY command="${fallbackCommand}" (cwd=${parentPath})`);
        await client.send(fallbackCommand);
        LoggerService.log(`[FTP][CHMOD] OK command="${fallbackCommand}" (cwd=${parentPath})`);
        return;
      } catch (err: any) {
        lastError = err;
        LoggerService.log(`[FTP][CHMOD] FAIL fallback parent=${parentPath} leaf=${leafName} error=${err?.message || String(err)}`);
      } finally {
        try {
          await client.cd(previousDir);
        } catch {
        }
      }
    }

    const lastMessage = String(lastError?.message || '');
    if (/could not change perms|\b550\b/i.test(lastMessage)) {
      throw new Error(LangService.t('ftpChmodDeniedByServer', { path: absolutePath }));
    }

    throw lastError;
  }

  private async chmodRecursiveFtp(
    client: FtpClient,
    remoteDir: string,
    mode: string,
    applyTo: PermissionApplyTarget,
    stats: { files: number; dirs: number }
  ): Promise<void> {
    const absoluteDir = this.toAbsoluteRemotePath(remoteDir);
    const list = await client.list(absoluteDir);

    for (const entry of list) {
      const leafName = this.normalizeRemoteLeafName((entry as any)?.name);
      if (!leafName || leafName === '.' || leafName === '..') {
        continue;
      }

      const fullPath = absoluteDir.endsWith('/') ? `${absoluteDir}${leafName}` : `${absoluteDir}/${leafName}`;
      const isDirectory = (entry as any)?.type === 2;
      const isFile = (entry as any)?.type === 1;

      if (isDirectory) {
        if (applyTo !== 'files') {
          await this.applyFtpChmod(client, fullPath, mode);
          stats.dirs += 1;
        }
        await this.chmodRecursiveFtp(client, fullPath, mode, applyTo, stats);
        continue;
      }

      if (isFile && applyTo !== 'directories') {
        await this.applyFtpChmod(client, fullPath, mode);
        stats.files += 1;
      }
    }
  }

  async changePermissionsWithDialogs(item: any): Promise<void> {
    const treeDataProvider = Container.get('treeDataProvider') as TreeDataProvider;
    const remotePath = String(item?.ftpPath || item?.sshPath || '').trim();
    if (!remotePath) {
      vscode.window.showErrorMessage(LangService.t('missingPathOrConnection'));
      return;
    }

    const isDirectory = item?.contextValue === 'ftp-folder' || item?.contextValue === 'ssh-folder';
    const currentMode = this.normalizePermissionMode(String(item?.permissionMode || ''));
    const modeInput = await vscode.window.showInputBox({
      prompt: LangService.t('enterPermissionMode'),
      placeHolder: LangService.t('permissionModePlaceholder'),
      value: currentMode || (isDirectory ? '755' : '644'),
      validateInput: (value) => this.normalizePermissionMode(value)
        ? undefined
        : LangService.t('invalidPermissionMode')
    });
    if (!modeInput) {
      return;
    }

    const mode = this.normalizePermissionMode(modeInput);
    if (!mode) {
      vscode.window.showErrorMessage(LangService.t('invalidPermissionMode'));
      return;
    }

    let recursive = false;
    let applyTo: PermissionApplyTarget = 'all';

    if (isDirectory) {
      const recursiveChoice = await vscode.window.showQuickPick(
        [
          { label: LangService.t('permissionsApplyCurrentOnly'), value: 'no' },
          { label: LangService.t('permissionsApplyRecursive'), value: 'yes' }
        ],
        { placeHolder: LangService.t('choosePermissionsApplyMode') }
      );
      if (!recursiveChoice) {
        return;
      }
      recursive = recursiveChoice.value === 'yes';
    }

    if (recursive) {
      const targetChoice = await vscode.window.showQuickPick(
        [
          { label: LangService.t('permissionsTargetAll'), value: 'all' },
          { label: LangService.t('permissionsTargetFilesOnly'), value: 'files' },
          { label: LangService.t('permissionsTargetDirectoriesOnly'), value: 'directories' }
        ],
        { placeHolder: LangService.t('choosePermissionsTarget') }
      );
      if (!targetChoice) {
        return;
      }
      applyTo = targetChoice.value as PermissionApplyTarget;
    }

    try {
      await this.changePermissions(remotePath, { mode, recursive, applyTo });
      const refreshPath = isDirectory ? remotePath : this.getParentRemotePath(remotePath);
      this.refreshFolder(treeDataProvider, refreshPath);
      vscode.window.showInformationMessage(LangService.t('permissionsChanged', { path: remotePath, mode }));
    } catch (error: any) {
      vscode.window.showErrorMessage(LangService.t('changePermissionsFailed', {
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  async changePermissions(remotePath: string, options: PermissionChangeOptions): Promise<void> {
    const mode = this.normalizePermissionMode(options.mode);
    if (!mode) {
      throw new Error(LangService.t('invalidPermissionMode'));
    }

    await this._mutex.acquire(async () => {
      const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
      if (!session || (session as any).closed) {
        throw new Error(`FTP session not initialized or connection closed for ${this.connection.label}`);
      }

      const absolutePath = this.toAbsoluteRemotePath(remotePath);
      LoggerService.log(`[FTP][CHMOD] START mode=${mode} recursive=${String(options.recursive)} target=${options.applyTo} path=${absolutePath}`);

      if (!options.recursive) {
        await this.applyFtpChmod(session, absolutePath, mode);
        LoggerService.log(`[FTP][CHMOD] END success path=${absolutePath}`);
        return;
      }

      const stats = { files: 0, dirs: 0 };
      if (options.applyTo !== 'files') {
        await this.applyFtpChmod(session, absolutePath, mode);
        stats.dirs += 1;
      }

      await this.chmodRecursiveFtp(session, absolutePath, mode, options.applyTo, stats);
      LoggerService.log(`[FTP][CHMOD] END success path=${absolutePath} stats(files=${stats.files}, dirs=${stats.dirs})`);
    });
  }

  private async ensurePasswordLoaded(): Promise<void> {
    if (!this.connection.password) {
      this.connection.password = await ConfigService.getPassword(this.connection.label);
    }
  }

  private async createWorkerClient(): Promise<FtpClient> {
    await this.ensurePasswordLoaded();
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
      await this.ensurePasswordLoaded();
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

        if (path === '.') {
          const parts = this.initialPath.split('/').filter(p => p);
          
          const rootItem = new vscode.TreeItem('/', vscode.TreeItemCollapsibleState.Expanded);
          (rootItem as any).ftpPath = '/';
          (rootItem as any).connectionLabel = this.connection.label;
          rootItem.contextValue = 'ftp-folder';
          rootItem.iconPath = new vscode.ThemeIcon('folder');

          let currentParent = rootItem;
          let currentPath = '';

          for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            currentPath += '/' + part;
            const isLast = i === parts.length - 1;

            const item = new vscode.TreeItem(part, vscode.TreeItemCollapsibleState.Expanded);
            
            (item as any).ftpPath = currentPath;
            (item as any).connectionLabel = this.connection.label;
            item.contextValue = 'ftp-folder';
            item.iconPath = new vscode.ThemeIcon('folder');

            (currentParent as any).children = [item];

            if (!isLast) {
              currentParent = item;
            } else {
              delete (item as any).children;
              LoggerService.log(`[FTP][DEBUG] Virtual path built to: ${currentPath}`);
            }
          }

          return [rootItem];
        }

        let requestPath = RemotePathHelper.normalizeAbsolutePath(path);
        let list: any[] = [];

        try {
          list = await session.list(requestPath);
        } catch (err: any) {
          if (this.initialPath.startsWith(requestPath) && requestPath !== this.initialPath) {
            LoggerService.log(`[FTP][DEBUG] Permission denied on path chain, restoring virtual child.`);
            
            vscode.window.showErrorMessage(LangService.t('fileDownloadError', { error: err.message }));

            const parts = this.initialPath.split('/').filter(p => p);
            const currentParts = requestPath === '/' ? [] : requestPath.split('/').filter(p => p);
            const nextPart = parts[currentParts.length];

            if (nextPart) {
              const nextPath = requestPath === '/' ? `/${nextPart}` : `${requestPath}/${nextPart}`;
              const virtualItem = new vscode.TreeItem(nextPart, vscode.TreeItemCollapsibleState.Expanded);
              (virtualItem as any).ftpPath = nextPath;
              (virtualItem as any).connectionLabel = this.connection.label;
              virtualItem.contextValue = 'ftp-folder';
              virtualItem.iconPath = new vscode.ThemeIcon('folder');
              return [virtualItem];
            }
          }
          throw err;
        }

        const items = list
          .map((item) => ({ ...item, __leafName: this.normalizeRemoteLeafName(item.name) }))
          .filter((item: any) => item.__leafName && item.__leafName !== '.' && item.__leafName !== '..')
          .map((item: any) => {
            const isFile = item.type === 1;
            const isDir = item.type === 2;
            const leafName = item.__leafName as string;
            
            const absoluteFtpPath = requestPath.endsWith('/') 
                ? requestPath + leafName 
                : requestPath + '/' + leafName;

            const treeItem = new vscode.TreeItem(
              leafName,
              isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
            );

            treeItem.contextValue = isDir ? 'ftp-folder' : (isFile ? 'ftp-file' : 'ftp-unknown');
            
            (treeItem as any).ftpPath = absoluteFtpPath;
            (treeItem as any).connectionLabel = this.connection.label;
            (treeItem as any).permissionMode = this.detectModeFromFtpEntry(item);

            if (isDir) {
              treeItem.iconPath = new vscode.ThemeIcon('folder');
            } else {
              const ext = leafName.split('.').pop()?.toLowerCase();
              let iconName = 'file';
              if (['php', 'js', 'ts', 'html', 'css', 'json'].includes(ext!)) iconName = 'file-code';
              if (['png', 'jpg', 'svg', 'gif'].includes(ext!)) iconName = 'file-media';
              if (['zip', 'rar', 'tar', 'gz'].includes(ext!)) iconName = 'file-zip';
              
              treeItem.iconPath = new vscode.ThemeIcon(iconName);
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

        items.sort((a, b) => {
          const isADir = a.collapsibleState !== vscode.TreeItemCollapsibleState.None;
          const isBDir = b.collapsibleState !== vscode.TreeItemCollapsibleState.None;
          if (isADir !== isBDir) return isADir ? -1 : 1;
          return (a.label as string).localeCompare(b.label as string, 'uk');
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

  async copyItem(sourceRemotePath: string, targetRemotePath: string, isDirectory: boolean): Promise<void> {
    return this._mutex.acquire(async () => {
      const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);

      if (!session || (session as any).closed) {
        throw new Error(`FTP session not initialized or connection closed for ${this.connection.label}`);
      }

      const fs = require('fs');
      const os = require('os');
      const pathMod = require('path');
      const source = this.toAbsoluteRemotePath(sourceRemotePath);
      const target = this.toAbsoluteRemotePath(targetRemotePath);
      const tmpRoot = pathMod.join(os.tmpdir(), `remotix_copy_${Date.now()}_${Math.random().toString(16).slice(2)}`);
      const recentCopiedFiles: string[] = [];
      const recentLimit = 4;
      let copiedFileCount = 0;
      let activeStatusMessage: vscode.Disposable | undefined;

      const setPersistentStatus = (text: string): void => {
        activeStatusMessage?.dispose();
        activeStatusMessage = vscode.window.setStatusBarMessage(text);
      };

      const updateCopyStatus = (targetFile: string): void => {
        copiedFileCount += 1;
        const displayName = this.normalizeRemoteLeafName(targetFile) || targetFile;
        recentCopiedFiles.unshift(displayName);
        if (recentCopiedFiles.length > recentLimit) {
          recentCopiedFiles.length = recentLimit;
        }
        setPersistentStatus(`Remotix: Copied ${copiedFileCount} file(s). Latest: ${recentCopiedFiles.join(', ')}`);
      };

      if (source === target) {
        throw new Error('Source and target paths are identical');
      }

      const ensureRemoteDir = async (dirPath: string): Promise<void> => {
        const previousDir = await session.pwd().catch(() => '/');
        try {
          await session.ensureDir(dirPath);
        } finally {
          try {
            await session.cd(previousDir);
          } catch {
            await session.cd('/').catch(() => {});
          }
        }
      };

      const copyFileInternal = async (sourceFile: string, targetFile: string): Promise<void> => {
        const tmpFile = pathMod.join(tmpRoot, `file_${Date.now()}_${Math.random().toString(16).slice(2)}`);
        await fs.promises.mkdir(pathMod.dirname(tmpFile), { recursive: true });
        await session.downloadTo(tmpFile, sourceFile);
        await ensureRemoteDir(pathMod.posix.dirname(targetFile));
        await session.uploadFrom(tmpFile, targetFile);
        updateCopyStatus(targetFile);
        await fs.promises.unlink(tmpFile).catch(() => {});
      };

      const copyDirectoryRecursive = async (sourceDir: string, targetDir: string): Promise<void> => {
        await ensureRemoteDir(targetDir);
        const list = await session.list(sourceDir);
        const entries = list.filter((entry: any) => {
          const leafName = this.normalizeRemoteLeafName(entry.name);
          return leafName !== '.' && leafName !== '..';
        });

        for (const entry of entries) {
          const leafName = this.normalizeRemoteLeafName(entry.name);
          const sourceEntryPath = sourceDir.endsWith('/') ? `${sourceDir}${leafName}` : `${sourceDir}/${leafName}`;
          const targetEntryPath = targetDir.endsWith('/') ? `${targetDir}${leafName}` : `${targetDir}/${leafName}`;
          if (entry.type === 2) {
            await copyDirectoryRecursive(sourceEntryPath, targetEntryPath);
          } else if (entry.type === 1) {
            await copyFileInternal(sourceEntryPath, targetEntryPath);
          }
        }
      };

      LoggerService.log(`[FTP][COPY] START type=${isDirectory ? 'directory' : 'file'} ${source} -> ${target}`);

      try {
        await fs.promises.mkdir(tmpRoot, { recursive: true });
        setPersistentStatus(`Remotix: Copy started... ${this.normalizeRemoteLeafName(source)} -> ${this.normalizeRemoteLeafName(target)}`);
        if (isDirectory) {
          await copyDirectoryRecursive(source, target);
        } else {
          await copyFileInternal(source, target);
        }
        LoggerService.log(`[FTP][COPY] END success: ${source} -> ${target}`);
        activeStatusMessage?.dispose();
        activeStatusMessage = undefined;
        vscode.window.setStatusBarMessage(
          `Remotix: Copy completed (${copiedFileCount} file(s)). Latest: ${recentCopiedFiles.join(', ')}`,
          5000
        );
      } catch (err: any) {
        LoggerService.log(`[FTP][COPY] END fail: ${source} -> ${target} error=${err.message || String(err)}`);
        activeStatusMessage?.dispose();
        activeStatusMessage = undefined;
        vscode.window.setStatusBarMessage(
          `Remotix: Copy failed after ${copiedFileCount} file(s)`,
          5000
        );
        throw err;
      } finally {
        activeStatusMessage?.dispose();
        await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
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
