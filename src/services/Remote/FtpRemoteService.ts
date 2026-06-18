import * as vscode from 'vscode';
import { Container } from '../Container';
import { AsyncMutex } from '../AsyncMutex';
import { LangService } from '../LangService';
import { RemoteService } from './RemoteService';
import { Client as FtpClient } from 'basic-ftp';
import { LoggerService } from '../LoggerService';
import { ConfigService } from '../ConfigService';
import { SessionProvider } from '../SessionProvider';
import { TreeDataProvider } from '../../ui/TreeDataProvider';
import { RemoteFileEditService } from '../RemoteFileEditService';
import { PermissionHelper } from '../../helpers/PermissionHelper';
import { RemotePathHelper } from '../../helpers/RemotePathHelper';
import { RemoteRefreshHelper } from '../../helpers/RemoteRefreshHelper';
import { RemoteTreeViewHelper } from '../../helpers/RemoteTreeViewHelper';
import { RemoteCrudDialogHelper } from '../../helpers/RemoteCrudDialogHelper';
import { PropertiesFormatHelper } from '../../helpers/PropertiesFormatHelper';
import { PropertiesDialogHelper } from '../../helpers/PropertiesDialogHelper';
import { ConnectionItem, PermissionApplyTarget, PermissionChangeOptions } from '../../types';

export class FtpRemoteService implements RemoteService {
  private connection: ConnectionItem;
  private _mutex = new AsyncMutex();
  private initialPath: string = '/';

  private getRemoteFileEditService(): RemoteFileEditService {
    return Container.get<RemoteFileEditService>('remoteFileEditService');
  }

  constructor(connection: ConnectionItem) {
    this.connection = connection;
    LoggerService.log('FtpRemoteService instance created.', 'FtpRemoteService', 'info');
  }

  public detectModeFromEntry(fileEntry: any): string | undefined {
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
      return PermissionHelper.parsePermissionBlockToMode(perms);
    }

    return undefined;
  }

  async showPropertiesWithDialogs(item: any): Promise<void> {
    const remotePath = PropertiesDialogHelper.getRemotePathOrNotify(item);
    if (!remotePath) {
      return;
    }

    const absolutePath = RemotePathHelper.toAbsoluteRemotePath(remotePath, this.initialPath);
    const isDirectoryFromItem = item?.contextValue === 'ftp-folder' || item?.contextValue === 'ssh-folder';
    const leafName = PropertiesDialogHelper.getLeafName(absolutePath);

    try {
      const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
      if (!session || (session as any).closed) {
        throw new Error(LangService.t('ftpSessionNotInitializedForConnection', { label: this.connection.label }));
      }

      let entry: any | undefined;
      if (absolutePath !== '/') {
        const parentPath = RemotePathHelper.getParentRemotePath(absolutePath);
        const list = await session.list(parentPath);
        entry = list.find((candidate: any) => RemotePathHelper.getRemoteLeafName(candidate?.name) === leafName);
      }

      const isDirectory = entry
        ? entry.type === 2
        : isDirectoryFromItem;
      const permissions = PermissionHelper.normalizePermissionMode(String(item?.permissionMode || ''))
        || this.detectModeFromEntry(entry)
        || LangService.t('propertiesUnknown');

      const items: vscode.QuickPickItem[] = [
        { label: LangService.t('propertiesPath'), description: absolutePath },
        { label: LangService.t('propertiesType'), description: isDirectory ? LangService.t('propertiesDirectory') : LangService.t('propertiesFile') },
        { label: LangService.t('propertiesPermissions'), description: permissions },
        { label: LangService.t('propertiesSize'), description: PropertiesFormatHelper.formatSize(entry?.size, isDirectory, LangService.t('propertiesUnknown')) },
        { label: LangService.t('propertiesOwner'), description: entry?.user ? String(entry.user) : LangService.t('propertiesUnknown') },
        { label: LangService.t('propertiesGroup'), description: entry?.group ? String(entry.group) : LangService.t('propertiesUnknown') },
        { label: LangService.t('propertiesCreated'), description: PropertiesFormatHelper.formatDate(entry?.createdAt || entry?.rawCreatedAt || entry?.created, LangService.t('propertiesUnknown')) },
        { label: LangService.t('propertiesModified'), description: PropertiesFormatHelper.formatDate(entry?.modifiedAt || entry?.rawModifiedAt, LangService.t('propertiesUnknown')) },
      ];

      await PropertiesDialogHelper.showPropertiesQuickPick(absolutePath, leafName, items);
    } catch (error: any) {
      vscode.window.showErrorMessage(LangService.t('propertiesLoadFailed', {
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  private async applyFtpChmod(client: FtpClient, remotePath: string, mode: string): Promise<void> {
    const absolutePath = RemotePathHelper.toAbsoluteRemotePath(remotePath, this.initialPath);
    let lastError: any;
    const primaryCommand = `SITE CHMOD ${mode} ${absolutePath}`;
    try {
      LoggerService.log(`TRY command="${primaryCommand}"`, 'FtpRemoteService', 'info');
      await client.send(primaryCommand);
      LoggerService.log(`OK command="${primaryCommand}"`, 'FtpRemoteService', 'info');
      return;
    } catch (err: any) {
      lastError = err;
      LoggerService.log(`FAIL command="${primaryCommand}" error=${err?.message || String(err)}`, 'FtpRemoteService', 'error');
    }

    // Fallback for servers that only allow chmod by leaf name in parent cwd.
    const parentPath = RemotePathHelper.getParentRemotePath(absolutePath);
    const leafName = RemotePathHelper.getRemoteLeafName(absolutePath);
    if (leafName) {
      const previousDir = await client.pwd().catch(() => '/');
      try {
        LoggerService.log(`TRY cd parent for leaf chmod parent=${parentPath} leaf=${leafName}`, 'FtpRemoteService', 'info');
        await client.cd(parentPath);
        const fallbackCommand = `SITE CHMOD ${mode} ${leafName}`;
        LoggerService.log(`TRY command="${fallbackCommand}" (cwd=${parentPath})`, 'FtpRemoteService', 'info');
        await client.send(fallbackCommand);
        LoggerService.log(`OK command="${fallbackCommand}" (cwd=${parentPath})`, 'FtpRemoteService', 'info');
        return;
      } catch (err: any) {
        lastError = err;
        LoggerService.log(`FAIL fallback parent=${parentPath} leaf=${leafName} error=${err?.message || String(err)}`, 'FtpRemoteService', 'error');
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
    const absoluteDir = RemotePathHelper.toAbsoluteRemotePath(remoteDir, this.initialPath);
    const list = await client.list(absoluteDir);

    for (const entry of list) {
      const leafName = RemotePathHelper.getRemoteLeafName((entry as any)?.name);
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
    const currentMode = PermissionHelper.normalizePermissionMode(String(item?.permissionMode || ''));
    const modeInput = await vscode.window.showInputBox({
      prompt: LangService.t('enterPermissionMode'),
      placeHolder: LangService.t('permissionModePlaceholder'),
      value: currentMode || (isDirectory ? '755' : '644'),
      validateInput: (value) => PermissionHelper.normalizePermissionMode(value)
        ? undefined
        : LangService.t('invalidPermissionMode')
    });
    if (!modeInput) {
      return;
    }

    const mode = PermissionHelper.normalizePermissionMode(modeInput);
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
      const refreshPath = isDirectory ? remotePath : RemotePathHelper.getParentRemotePath(remotePath);
      RemoteRefreshHelper.refreshRemoteFolder(treeDataProvider, this.connection.label, refreshPath, 'ftp');
      vscode.window.showInformationMessage(LangService.t('permissionsChanged', { path: remotePath, mode }));
    } catch (error: any) {
      vscode.window.showErrorMessage(LangService.t('changePermissionsFailed', {
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  async changePermissions(remotePath: string, options: PermissionChangeOptions): Promise<void> {
    const mode = PermissionHelper.normalizePermissionMode(options.mode);
    if (!mode) {
      throw new Error(LangService.t('invalidPermissionMode'));
    }

    await this._mutex.acquire(async () => {
      const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
      if (!session || (session as any).closed) {
        throw new Error(LangService.t('ftpSessionNotInitializedForConnection', { label: this.connection.label }));
      }

      const absolutePath = RemotePathHelper.toAbsoluteRemotePath(remotePath, this.initialPath);
      LoggerService.log(`START mode=${mode} recursive=${String(options.recursive)} target=${options.applyTo} path=${absolutePath}`, 'FtpRemoteService', 'info');

      if (!options.recursive) {
        await this.applyFtpChmod(session, absolutePath, mode);
        LoggerService.log(`END success path=${absolutePath}`, 'FtpRemoteService', 'info');
        return;
      }

      const stats = { files: 0, dirs: 0 };
      if (options.applyTo !== 'files') {
        await this.applyFtpChmod(session, absolutePath, mode);
        stats.dirs += 1;
      }

      await this.chmodRecursiveFtp(session, absolutePath, mode, options.applyTo, stats);
      LoggerService.log(`END success path=${absolutePath} stats(files=${stats.files}, dirs=${stats.dirs})`, 'FtpRemoteService', 'info');
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
      LoggerService.log(`Connecting to FTP (always new connection, label: ${this.connection.label})...`, 'FtpRemoteService', 'info');

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
        LoggerService.log(`Initial directory: ${this.initialPath}`, 'FtpRemoteService', 'info');

        LoggerService.log('FTP connection ready', 'FtpRemoteService', 'info');
        
        (ftpClient as any).isConnected = true;
        SessionProvider.setSession(this.connection.label, ftpClient);
        ftpClient.ftp.socket.on('close', () => {
          LoggerService.log('FTP connection ended', 'FtpRemoteService', 'info');
          (ftpClient as any).isConnected = false;
          SessionProvider.closeSession(this.connection.label);
        });

        ftpClient.ftp.socket.on('error', (err: any) => {
          LoggerService.log(`FTP socket error: ${err.message}`, 'FtpRemoteService', 'error');
          (ftpClient as any).isConnected = false;
          SessionProvider.closeSession(this.connection.label);
        });

        resolve(ftpClient);

      } catch (err: any) {
        LoggerService.log(`FTP connection error: ${err.message}`, 'FtpRemoteService', 'error');
        (ftpClient as any).isConnected = false;
        SessionProvider.closeSession(this.connection.label);
        
        ftpClient.close(); 
        reject(err);
      }
    });
  }

  async listDirectory(path: string): Promise<vscode.TreeItem[]> {
    return this._mutex.acquire(async () => {
      LoggerService.log(`listDirectory ENTRY: path=${path}, label=${this.connection.label}`, 'FtpRemoteService', 'info');

      try {
        const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);

        if (!session || (session as any).closed) {
          throw new Error(LangService.t('ftpClientNotInitializedOrClosed'));
        }

        if (path === '.') {
          return RemoteTreeViewHelper.buildVirtualPathTree(this.initialPath, this.connection.label, 'ftpPath', 'ftp-folder');
        }

        let requestPath = RemotePathHelper.normalizeAbsolutePath(path);
        let list: any[] = [];

        try {
          list = await session.list(requestPath);
        } catch (err: any) {
          if (this.initialPath.startsWith(requestPath) && requestPath !== this.initialPath) {
            LoggerService.log(`Permission denied on path chain, restoring virtual child.`, 'FtpRemoteService', 'info');
            
            vscode.window.showErrorMessage(LangService.t('fileDownloadError', { error: err.message }));

            const virtualItems = RemoteTreeViewHelper.buildPermissionDeniedVirtualChild(
              this.initialPath,
              requestPath,
              this.connection.label,
              'ftpPath',
              'ftp-folder'
            );
            if (virtualItems) {
              return virtualItems;
            }
          }
          throw err;
        }

        const items = list
          .map((item) => ({ ...item, __leafName: RemotePathHelper.getRemoteLeafName(item.name) }))
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
            (treeItem as any).permissionMode = this.detectModeFromEntry(item);

            const unknownLabel = LangService.t('propertiesUnknown');
            const modifiedValue = item?.modifiedAt || item?.rawModifiedAt;
            const sizeText = PropertiesFormatHelper.formatSize(item?.size, isDir, unknownLabel);
            const modifiedText = PropertiesFormatHelper.formatDate(modifiedValue, unknownLabel);
            treeItem.description = isDir ? modifiedText : `${sizeText} • ${modifiedText}`;
            treeItem.tooltip = isDir
              ? `${leafName}\n${LangService.t('propertiesModified')}: ${modifiedText}`
              : `${leafName}\n${LangService.t('propertiesSize')}: ${sizeText}\n${LangService.t('propertiesModified')}: ${modifiedText}`;

            if (isDir) {
              treeItem.iconPath = new vscode.ThemeIcon('folder');
            } else {
              // Set resourceUri for proper icon alignment
              try {
                treeItem.resourceUri = vscode.Uri.file('/ftp/' + encodeURIComponent(this.connection.label) + absoluteFtpPath);
              } catch {}
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

        RemoteTreeViewHelper.sortTreeItems(items, 'uk');

        LoggerService.log(`Returning ${items.length} tree items. EXIT`, 'FtpRemoteService', 'info');
        return items;

      } catch (e: any) {
        const msg = e.message || String(e);
        LoggerService.log(`Exception in listDirectory: ${msg}`, 'FtpRemoteService', 'error');
        vscode.window.showErrorMessage(LangService.t('ftpErrorMessage', { error: msg }));
        return [];
      }
    });
  }

  async downloadWithDialogs(item: any): Promise<void> {
    const isDirectory = item?.contextValue === 'ssh-folder' || item?.contextValue === 'ftp-folder';
    const selectedPath = item?.ftpPath || item?.sshPath || item?.item?.name || 'unknown';
    LoggerService.log(`START dialog type=${isDirectory ? 'directory' : 'file'} path=${selectedPath}`, 'FtpRemoteService', 'info');
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
      LoggerService.log(`END success type=${isDirectory ? 'directory' : 'file'} path=${selectedPath}`, 'FtpRemoteService', 'info');
    } catch (err: any) {
      LoggerService.log(`END fail type=${isDirectory ? 'directory' : 'file'} path=${selectedPath} error=${err?.message || String(err)}`, 'FtpRemoteService', 'error');
      vscode.window.showErrorMessage(LangService.t('downloadError', { error: err.message }));
    }
  }

  async download(item: any, localTarget: string): Promise<void> {
    const remotePath = item?.ftpPath;
    if (!remotePath) {
      throw new Error(LangService.t('remotePathMissing'));
    }

    const pathMod = require('path');
    const localDest = pathMod.join(localTarget, pathMod.basename(remotePath));

    const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
    
    if (!session || (session as any).closed) {
      throw new Error(LangService.t('ftpSessionNotInitializedOrClosed'));
    }

    LoggerService.log(`START: ${remotePath} -> ${localDest}`, 'FtpRemoteService', 'info');

    try {
      await session.downloadTo(localDest, remotePath);
      LoggerService.log(`END success: ${localDest}`, 'FtpRemoteService', 'info');
    } catch (err: any) {
      LoggerService.log(`END fail: ${remotePath} error=${err.message}`, 'FtpRemoteService', 'error');
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
      if (!session || (session as any).closed) throw new Error(LangService.t('ftpSessionNotInitialized'));

      LoggerService.log(`START: ${remoteDir} -> ${localDest}`, 'FtpRemoteService', 'info');
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
        LoggerService.log(`QUEUE built: ${filesToDownload.length} files`);

        const CONCURRENCY_LIMIT = ConfigService.getConcurrencyLimit('ftpDownloadConcurrency', 3);
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
              LoggerService.log(`START: ${job.remotePath}`, 'FtpRemoteService', 'info');
              await worker.downloadTo(job.localPath, job.remotePath);
              downloadedCount++;
              LoggerService.log(`END: ${job.remotePath}`, 'FtpRemoteService', 'info');
              vscode.window.setStatusBarMessage(
                LangService.t('downloadProgressStatus', { downloaded: downloadedCount, total: filesToDownload.length }),
                2000
              );
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

        LoggerService.log(`END success: ${remoteDir}`, 'FtpRemoteService', 'info');
      } catch (err: any) {
        LoggerService.log(`END fail: ${remoteDir} error=${err?.message || String(err)}`, 'FtpRemoteService', 'error');
        throw err;
      }
    });
  }

  async uploadWithDialogs(item: any): Promise<void> {
    const treeDataProvider = Container.get('treeDataProvider') as TreeDataProvider;
    const targetPath = item?.sshPath || item?.ftpPath;
    LoggerService.log(`START dialog target=${targetPath || 'unknown'}`, 'FtpRemoteService', 'info');
    if (!targetPath) {
      vscode.window.showErrorMessage(LangService.t('missingPathOrConnection'));
      LoggerService.log('END fail: missing target path', 'FtpRemoteService', 'error');
      return;
    }

    const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
    if (!session) {
      vscode.window.showErrorMessage(LangService.t('connectionNotFound'));
      LoggerService.log('END fail: no active session', 'FtpRemoteService', 'error');
      return;
    }
    
    const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
    const uploadType = await vscode.window.showQuickPick(
        [
        { label: `$(file) ${LangService.t('file')}`, value: 'file' },
        { label: `$(folder) ${LangService.t('folder')}`, value: 'folder' }
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
      LoggerService.log(`No files/folders selected`, 'FtpRemoteService', 'info');
      LoggerService.log(`END canceled: no selection`, 'FtpRemoteService', 'info');
      return;
    }
    LoggerService.log(`Selected URIs:`, 'FtpRemoteService', 'info');
    uris.forEach((uri: any) => LoggerService.log(`URI: ${uri.fsPath}`, 'FtpRemoteService', 'info'));
    const pathMod = require('path');
    const fs = require('fs');
    let anyError = false;
    for (const uri of uris) {
      const localPath = uri.fsPath;
      LoggerService.log(`Processing localPath: ${localPath}`, 'FtpRemoteService', 'info');
      let uploadTarget = targetPath;
      try {
        const stat = fs.statSync(localPath);
        LoggerService.log(`Stat: isDirectory=${stat.isDirectory()}, isFile=${stat.isFile()}`, 'FtpRemoteService', 'info');
        if (stat.isDirectory()) {
          uploadTarget = pathMod.join(targetPath, pathMod.basename(localPath));
          await this.uploadDir(localPath, uploadTarget);
        } else {
          await this.upload(localPath, pathMod.join(uploadTarget, pathMod.basename(localPath)));
        }
      } catch (e: any) {
        anyError = true;
        LoggerService.log(`${e instanceof Error ? e.message : String(e)}`, 'FtpRemoteService', 'error');
        vscode.window.showErrorMessage(LangService.t('uploadError', { error: (e instanceof Error ? e.message : String(e)) }));
      }
    }
    if (!anyError) {
      vscode.window.showInformationMessage(LangService.t('uploadSuccess'));
      LoggerService.log(`END success target=${targetPath}`, 'FtpRemoteService', 'info');
    } else {
      LoggerService.log(`END fail target=${targetPath}`, 'FtpRemoteService', 'error');
    }
    const refreshPath = item?.contextValue === 'ftp-folder' || item?.contextValue === 'ssh-folder'
      ? targetPath
      : RemotePathHelper.getParentRemotePath(targetPath);
    RemoteRefreshHelper.refreshRemoteFolder(treeDataProvider, this.connection.label, refreshPath, 'ftp');
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    return this._mutex.acquire(async () => {
      
      const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
      
      if (!session || (session as any).closed) {
        throw new Error(LangService.t('ftpSessionNotInitializedForConnection', { label: this.connection.label }));
      }

      LoggerService.log(`START: ${localPath} -> ${remotePath}`, 'FtpRemoteService', 'info');
      
      try {
        await session.uploadFrom(localPath, remotePath);
        LoggerService.log(`END success: ${remotePath}`, 'FtpRemoteService', 'info');
      } catch (err: any) {
        LoggerService.log(`END fail: ${remotePath} error=${err.message}`, 'FtpRemoteService', 'error');
        throw err;
      }
    });
  }

  async uploadDir(localDir: string, remoteDir: string): Promise<void> {
    return this._mutex.acquire(async () => {
      const session = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
      
      if (!session || (session as any).closed) {
        throw new Error(LangService.t('ftpSessionNotInitializedForConnection', { label: this.connection.label }));
      }

      LoggerService.log(`START: ${localDir} -> ${remoteDir}`, 'FtpRemoteService', 'info');

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
            LoggerService.log(`SKIP: Already visited local dir (cycle guard): ${currentLocalDir}`, 'FtpRemoteService', 'info');
            return;
          }
          visitedRealDirs.add(realDir);

          dirsToEnsure.push(currentRemoteDir);
          const entries = await fs.promises.readdir(currentLocalDir, { withFileTypes: true });
          for (const entry of entries) {
            const src = pathMod.join(currentLocalDir, entry.name);
            const dest = `${currentRemoteDir}/${entry.name}`.replace(/\\/g, '/');
            if (entry.isSymbolicLink && entry.isSymbolicLink()) {
              LoggerService.log(`SKIP: Symbolic link: ${src}`, 'FtpRemoteService', 'info');
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
        LoggerService.log(`QUEUE built: dirs=${dirsToEnsure.length}, files=${fileJobs.length}`, 'FtpRemoteService', 'info');

        const previousDir = await session.pwd().catch(() => '/');
        LoggerService.log(`BASE dir before ensure: ${previousDir}`, 'FtpRemoteService', 'info');
        try {
          for (const dir of Array.from(new Set(dirsToEnsure))) {
            // ensureDir changes current directory; reset to base so relative paths stay stable
            await session.cd(previousDir);
            LoggerService.log(`START base=${previousDir} ensure=${dir}`, 'FtpRemoteService', 'info');
            try {
              await session.ensureDir(dir);
              LoggerService.log(`END success ensure=${dir}`, 'FtpRemoteService', 'info');
            } catch (mkdirErr: any) {
              LoggerService.log(`END fail ensure=${dir} error=${mkdirErr?.message || String(mkdirErr)}`, 'FtpRemoteService', 'error');
              throw mkdirErr;
            }
          }
        } finally {
          try {
            await session.cd(previousDir);
            LoggerService.log(`Restored base dir: ${previousDir}`, 'FtpRemoteService', 'info');
          } catch {
            await session.cd('/');
            LoggerService.log('Failed to restore base dir, moved to /', 'FtpRemoteService', 'error');
          }
        }

        const CONCURRENCY_LIMIT = ConfigService.getConcurrencyLimit('ftpUploadConcurrency', 3);
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
              LoggerService.log(`START: ${job.localPath} -> ${job.remotePath}`, 'FtpRemoteService', 'info');
              try {
                await worker.uploadFrom(job.localPath, job.remotePath);
              } catch (uploadErr: any) {
                LoggerService.log(`END fail: ${job.remotePath} error=${uploadErr?.message || String(uploadErr)}`, 'FtpRemoteService', 'error');
                throw uploadErr;
              }
              uploadedCount++;
              LoggerService.log(`END: ${job.remotePath}`, 'FtpRemoteService', 'info');
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

        LoggerService.log(`END success: ${remoteDir}`, 'FtpRemoteService', 'info');
      } catch (err: any) {
        LoggerService.log(`END fail: ${remoteDir} error=${err.message}`, 'FtpRemoteService', 'error');
        throw err;
      }
    });
  }


  async createFileWithDialogs(item: any): Promise<void> {
    const treeDataProvider = Container.get('treeDataProvider') as TreeDataProvider;

    const ftpPath = RemoteCrudDialogHelper.getRemotePath(item);
    if (!ftpPath) {
      vscode.window.showErrorMessage(LangService.t('ftpNoFolderForFile'));
      return;
    }
    const newFileName = await vscode.window.showInputBox({
      prompt: LangService.t('enterNewFileName'),
      value: LangService.t('defaultNewFileName')
    });
    if (!newFileName) return;
    const newFilePath = RemoteCrudDialogHelper.buildChildPath(ftpPath, item, newFileName);
    try {
      await this.createFile(newFilePath);
      vscode.window.showInformationMessage(LangService.t('fileCreated', { path: newFilePath }));
      const refreshPath = RemoteCrudDialogHelper.getRefreshPath(item, ftpPath);
      RemoteRefreshHelper.refreshRemoteFolder(treeDataProvider, this.connection.label, refreshPath, 'ftp');
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
        LoggerService.log(`Creating empty file: ${remotePath}`, 'FtpRemoteService', 'info');
        fs.writeFileSync(tmpPath, '');
        await session.uploadFrom(tmpPath, remotePath);
        
        LoggerService.log(`File created successfully`, 'FtpRemoteService', 'info');
      } catch (err: any) {
        LoggerService.log(`createFile failed: ${err.message}`, 'FtpRemoteService', 'error');
        throw err;
      } finally {
        try {
          if (fs.existsSync(tmpPath)) {
            fs.unlinkSync(tmpPath);
          }
        } catch (cleanupErr) {
          LoggerService.log(`Temp file cleanup error: ${cleanupErr}`, 'FtpRemoteService', 'error');
        }
      }
    });
  }


  async createFolderWithDialogs(item: any): Promise<void> {
    const treeDataProvider = Container.get('treeDataProvider') as TreeDataProvider;
    LoggerService.log('ENTRY', 'FtpRemoteService', 'info');
    LoggerService.log(item, 'FtpRemoteService', 'info');
    const ftpPath = RemoteCrudDialogHelper.getRemotePath(item);
    if (!ftpPath) {
      vscode.window.showErrorMessage(LangService.t('missingPathOrConnection'));
      return;
    }
    LoggerService.log(`ftpPath: ${ftpPath}`, 'FtpRemoteService', 'info');
    const newFolderName = await vscode.window.showInputBox({
      prompt: LangService.t('enterNewFolderName'),
      value: LangService.t('defaultNewFolderName')
    });
    LoggerService.log(`newFolderName: ${newFolderName}`, 'FtpRemoteService', 'info');
    if (!newFolderName) {
      LoggerService.log('No folder name entered, aborting', 'FtpRemoteService', 'info');
      return;
    }
    const newFolderPath = RemoteCrudDialogHelper.buildChildPath(ftpPath, item, newFolderName);
    LoggerService.log(`newFolderPath: ${newFolderPath}`, 'FtpRemoteService', 'info');
    try {
      await this.createFolder(newFolderPath);
      LoggerService.log('Folder created successfully', 'FtpRemoteService', 'info');
      vscode.window.showInformationMessage(LangService.t('folderCreated', { path: newFolderPath }));
      if (treeDataProvider && typeof treeDataProvider.clearRemoteServiceCache === 'function') {
        LoggerService.log('Clearing remoteServiceCache', 'FtpRemoteService', 'info');
        treeDataProvider.clearRemoteServiceCache(this.connection.label);
      }
      const refreshPath = RemoteCrudDialogHelper.getRefreshPath(item, ftpPath);
      RemoteRefreshHelper.refreshRemoteFolder(treeDataProvider, this.connection.label, refreshPath, 'ftp');
      LoggerService.log('folder-level refresh called', 'FtpRemoteService', 'info');
    } catch (e: any) {
      LoggerService.log(`ERROR: ${e instanceof Error ? e.message : String(e)}`, 'FtpRemoteService', 'error');
      vscode.window.showErrorMessage(LangService.t('createFolderFailed', { error: (e instanceof Error ? e.message : String(e)) }));
    }
    LoggerService.log('EXIT', 'FtpRemoteService', 'info');
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
        LoggerService.log(`Current directory before create: ${previousDir}`, 'FtpRemoteService', 'info');
      } catch (pwdErr) {
        LoggerService.log(`Could not get current directory: ${pwdErr}`, 'FtpRemoteService', 'warning');
      }

      LoggerService.log(`Creating directory (ensureDir): ${remoteDir}`, 'FtpRemoteService', 'info');

      try {
        await session.ensureDir(remoteDir);
        LoggerService.log(`Directory created or already exists`, 'FtpRemoteService', 'info');

      } catch (err: any) {
        LoggerService.log(`createFolder failed: ${err.message}`, 'FtpRemoteService', 'error');
        throw err;
      } finally {
        try {
          await session.cd(previousDir);
          LoggerService.log(`Returned to directory: ${previousDir}`, 'FtpRemoteService', 'info');
        } catch (cdErr: any) {
          LoggerService.log(`Failed to return to ${previousDir}: ${cdErr.message}`, 'FtpRemoteService', 'error');
          await session.cd('/'); 
        }
      }
    });
  }


  async deleteFileWithDialogs(item: any): Promise<void> {
    const treeDataProvider = Container.get('treeDataProvider') as TreeDataProvider;
    const ftpPath = RemoteCrudDialogHelper.getRemotePath(item);
    if (!ftpPath) {
      vscode.window.showErrorMessage(LangService.t('missingPathOrConnection'));
      return;
    }
    const isDir = RemoteCrudDialogHelper.isDirectoryItem(item);
    const confirm = await vscode.window.showWarningMessage(
      LangService.t(isDir ? 'confirmDeleteFolder' : 'confirmDeleteFile', { path: ftpPath }),
      { modal: true },
      LangService.t('delete')
    );
    if (confirm !== LangService.t('delete')) return;
    LoggerService.log(`START type=${isDir ? 'directory' : 'file'} path=${ftpPath}`, 'FtpRemoteService', 'info');
    treeDataProvider?.treeLocker?.lock(LangService.t('deleteInProgress'), this.connection.label);
    try {
      if (isDir) {
        await this.deleteDir(ftpPath);
        vscode.window.showInformationMessage(LangService.t('folderDeleted', { path: ftpPath }));
      } else {
        await this.deleteFile(ftpPath);
        vscode.window.showInformationMessage(LangService.t('fileDeleted', { path: ftpPath }));
      }
      RemoteRefreshHelper.refreshRemoteFolder(treeDataProvider, this.connection.label, RemotePathHelper.getParentRemotePath(ftpPath), 'ftp');
      LoggerService.log(`END success type=${isDir ? 'directory' : 'file'} path=${ftpPath}`, 'FtpRemoteService', 'info');
    } catch (e: any) {
      LoggerService.log(`END fail type=${isDir ? 'directory' : 'file'} path=${ftpPath} error=${e instanceof Error ? e.message : String(e)}`, 'FtpRemoteService', 'error');
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

      const absolutePath = RemotePathHelper.toAbsoluteRemotePath(remotePath, this.initialPath);
      LoggerService.log(`START: ${remotePath} (absolute=${absolutePath})`, 'FtpRemoteService', 'info');

      try {
        await session.remove(absolutePath);
        LoggerService.log(`END success: ${remotePath}`, 'FtpRemoteService', 'info');
      } catch (err: any) {
        LoggerService.log(`END fail: ${remotePath} error=${err.message}`, 'FtpRemoteService', 'error');
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

      const absoluteRemoteDir = RemotePathHelper.toAbsoluteRemotePath(remoteDir, this.initialPath);
      LoggerService.log(`START: ${remoteDir} (absolute=${absoluteRemoteDir})`, 'FtpRemoteService', 'info');

      // Prefer server-side recursive delete first on a separate client with timeout.
      // This prevents the main session from appearing frozen if the server stalls.
      try {
        const nativeTimeoutMs = 12000;
        vscode.window.setStatusBarMessage('Remotix: Deleting directory (server-side)...', 1500);
        LoggerService.log(`native-removeDir START: ${absoluteRemoteDir} timeout=${nativeTimeoutMs}ms`, 'FtpRemoteService', 'info');

        const nativeClient = await this.createWorkerClient();
        try {
          await Promise.race([
            nativeClient.removeDir(absoluteRemoteDir),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error(`native-removeDir timeout after ${nativeTimeoutMs}ms`)), nativeTimeoutMs);
            })
          ]);

          LoggerService.log(`END success: ${absoluteRemoteDir} strategy=native-removeDir`, 'FtpRemoteService', 'info');
          return;
        } finally {
          try {
            nativeClient.close();
          } catch {
          }
        }
      } catch (nativeErr: any) {
        LoggerService.log(`native-removeDir fail: ${absoluteRemoteDir} error=${nativeErr?.message || String(nativeErr)}; fallback=manual-recursive`, 'FtpRemoteService', 'error');
      }

      const stats = { files: 0, dirs: 0 };
      let step = 0;
      const onProgress = (stage: string, path: string) => {
        step++;
        if (step % 10 === 0) {
          vscode.window.setStatusBarMessage(`Remotix: Deleting ${stats.files} files, ${stats.dirs} dirs`, 1500);
        }
        LoggerService.log(`step=${step} stage=${stage} path=${path} files=${stats.files} dirs=${stats.dirs}`, 'FtpRemoteService', 'info');
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
        LoggerService.log(`END success: ${absoluteRemoteDir} summary(files=${stats.files}, dirs=${stats.dirs})`, 'FtpRemoteService', 'info');
      } catch (err: any) {
        LoggerService.log(`END fail: ${absoluteRemoteDir} error=${err.message} summary(files=${stats.files}, dirs=${stats.dirs})`, 'FtpRemoteService', 'error');
        throw err;
      }
    });
  }


  async renameWithDialogs(item: any): Promise<void> {
    const treeDataProvider = Container.get('treeDataProvider') as TreeDataProvider;
    const oldLabel = RemoteCrudDialogHelper.getItemLabel(item);
    const ftpPath = RemoteCrudDialogHelper.getRemotePath(item);
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
    const newPath = RemoteCrudDialogHelper.buildRenamedPath(oldPath, newName);
    try {
      await this.rename(oldPath, newPath);
      vscode.window.showInformationMessage(LangService.t('renamedTo', { name: newName }));
      const oldParent = RemotePathHelper.getParentRemotePath(oldPath);
      const newParent = RemotePathHelper.getParentRemotePath(newPath);
      RemoteRefreshHelper.refreshRemoteFolder(treeDataProvider, this.connection.label, oldParent, 'ftp');
      if (newParent !== oldParent) {
        RemoteRefreshHelper.refreshRemoteFolder(treeDataProvider, this.connection.label, newParent, 'ftp');
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

      LoggerService.log(`Renaming: ${oldRemotePath} -> ${newRemotePath}`, 'FtpRemoteService', 'info');

      try {
        await session.rename(oldRemotePath, newRemotePath);
        
        LoggerService.log(`Rename successful`, 'FtpRemoteService', 'info');
      } catch (err: any) {
        LoggerService.log(`rename failed: ${err.message}`, 'FtpRemoteService', 'error');
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
      const source = RemotePathHelper.toAbsoluteRemotePath(sourceRemotePath, this.initialPath);
      const target = RemotePathHelper.toAbsoluteRemotePath(targetRemotePath, this.initialPath);
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
        const displayName = RemotePathHelper.getRemoteLeafName(targetFile) || targetFile;
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
          const leafName = RemotePathHelper.getRemoteLeafName(entry.name);
          return leafName !== '.' && leafName !== '..';
        });

        for (const entry of entries) {
          const leafName = RemotePathHelper.getRemoteLeafName(entry.name);
          const sourceEntryPath = sourceDir.endsWith('/') ? `${sourceDir}${leafName}` : `${sourceDir}/${leafName}`;
          const targetEntryPath = targetDir.endsWith('/') ? `${targetDir}${leafName}` : `${targetDir}/${leafName}`;
          if (entry.type === 2) {
            await copyDirectoryRecursive(sourceEntryPath, targetEntryPath);
          } else if (entry.type === 1) {
            await copyFileInternal(sourceEntryPath, targetEntryPath);
          }
        }
      };

      LoggerService.log(`START type=${isDirectory ? 'directory' : 'file'} ${source} -> ${target}`, 'FtpRemoteService', 'info');

      try {
        await fs.promises.mkdir(tmpRoot, { recursive: true });
        setPersistentStatus(`Remotix: Copy started... ${RemotePathHelper.getRemoteLeafName(source)} -> ${RemotePathHelper.getRemoteLeafName(target)}`);
        if (isDirectory) {
          await copyDirectoryRecursive(source, target);
        } else {
          await copyFileInternal(source, target);
        }
        LoggerService.log(`END success: ${source} -> ${target}`, 'FtpRemoteService', 'info');
        activeStatusMessage?.dispose();
        activeStatusMessage = undefined;
        vscode.window.setStatusBarMessage(
          `Remotix: Copy completed (${copiedFileCount} file(s)). Latest: ${recentCopiedFiles.join(', ')}`,
          5000
        );
      } catch (err: any) {
        LoggerService.log(`END fail: ${source} -> ${target} error=${err.message || String(err)}`, 'FtpRemoteService', 'error');
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

      try {
        if (treeDataProvider?.treeLocker) {
          treeDataProvider.treeLocker.lock(LangService.t('downloadingFile'), this.connection.label);
        }

        await this.getRemoteFileEditService().openWithTempFile({
          remotePath: ftpPath,
          host: this.connection.host,
          user: this.connection.user,
          tmpFolderPrefix: 'remotix_ftp',
          downloadToTemp: async (tmpFile) => {
            const activeSession = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
            if (!activeSession || (activeSession as any).closed) {
              throw new Error('FTP session not initialized or connection closed');
            }

            LoggerService.log(`Downloading for edit: ${ftpPath} -> ${tmpFile}`);
            await activeSession.downloadTo(tmpFile, ftpPath);
          },
          uploadFromTemp: async (tmpFile) => {
            const session2 = await SessionProvider.getSession<FtpClient>(this.connection.label, this);
            if (!session2 || (session2 as any).closed) {
              throw new Error('Connection lost');
            }

            LoggerService.log(`Uploading changes: ${tmpFile} -> ${ftpPath}`);
            await session2.uploadFrom(tmpFile, ftpPath);
          },
          logCleanupError: (cleanupError) => {
            LoggerService.log(`Temp file cleanup error: ${String(cleanupError)}`);
          },
        });

      } catch (e: any) {
        const msg = e.message || String(e);
        LoggerService.log(`editFile: ${msg}`, 'FtpRemoteService', 'error');
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
          LoggerService.log(`Skipping item (invalid path): ${item.label || 'unknown'}`, 'FtpRemoteService', 'warning');
          continue;
        }

        const itemName = oldPath.split('/').filter(Boolean).pop();
        const newPath = targetDirClean + itemName;

        if (oldPath === newPath) continue;

        LoggerService.log(`Moving: ${oldPath} -> ${newPath}`, 'FtpRemoteService', 'info');

        try {
          await session.rename(oldPath, newPath);
        } catch (err: any) {
          hadError = true;
          LoggerService.log(`${err.message}`, 'FtpRemoteService', 'error');
          vscode.window.showErrorMessage(LangService.t('moveFailed', { error: err.message }));
        }
      }

      if (treeDataProvider?.refresh) {
        RemoteRefreshHelper.refreshRemoteFolder(treeDataProvider, this.connection.label, targetFolder, 'ftp');
      }
      
      if (!hadError) {
        vscode.window.showInformationMessage(LangService.t('itemsMovedSuccessfully'));
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

    LoggerService.log(`${targetPath}`, 'FtpRemoteService', 'info');
    const list = await withOpTimeout(session.list(targetPath), 5000, `list(${targetPath})`);
    LoggerService.log(`${targetPath} -> ${list.length} items`, 'FtpRemoteService', 'info');
    const filePathsToDelete: string[] = [];
    const directoryEntries: Array<{ item: any; fullPath: string; normalizedFull: string; rootOccurences: number; dirId: string }> = [];

    for (const item of list) {
      const leafName = RemotePathHelper.getRemoteLeafName(item.name);
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
      const workerCount = Math.min(ConfigService.getConcurrencyLimit('ftpDeleteFileConcurrency', 4), queue.length);
      LoggerService.log(`${targetPath} -> ${queue.length} files, workers=${workerCount}`, 'FtpRemoteService', 'info');

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

            LoggerService.log(`remove: ${fullPath}`, 'FtpRemoteService', 'info');
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
          LoggerService.log(`removed as file/link: ${fullPath}`, 'FtpRemoteService', 'info');
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
            LoggerService.log(`removed as directory: ${fullPath}`, 'FtpRemoteService', 'info');
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
        LoggerService.log(`detected loop at ${normalizedFull} reason=${isLoopByRoot ? 'root-repeat' : isLoopById ? `id-repeat:${dirId}` : 'tail-repeat'}`, 'FtpRemoteService', 'warning');
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

    LoggerService.log(`remove: ${targetPath}`, 'FtpRemoteService', 'info');
    await withOpTimeout(session.removeDir(targetPath), 5000, `removeDir(${targetPath})`);
    if (stats) {
      stats.dirs++;
    }
    onProgress?.('dir', targetPath);
    stack.delete(normalizedTarget);
  }
}
