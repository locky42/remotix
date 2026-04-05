import * as fs from 'fs';
import * as vscode from 'vscode';
import { Container } from '../Container';
import { Client as SshClient } from 'ssh2';
import { LangService } from '../LangService';
import { ConnectionItem } from '../../types';
import { RemoteService } from './RemoteService';
import { LoggerService } from '../LoggerService';
import { SessionProvider } from '../SessionProvider';
import { TreeDataProvider } from '../../ui/TreeDataProvider';

export class SshRemoteService implements RemoteService {
  private connection: ConnectionItem;
  private sftpClient: any | null = null;

  constructor(connection: ConnectionItem) {
    this.connection = connection;
    LoggerService.log(`[SshRemoteService] Created for ${this.connection.user}@${this.connection.host}:${this.connection.port}`);
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
    treeDataProvider.refreshRemoteFolder(this.connection.label, this.normalizeRemotePath(folderPath), 'ssh');
  }

  private getUploadConcurrencyLimit(): number {
    const configured = vscode.workspace.getConfiguration('remotix').get<number>('sshUploadConcurrency', 3);
    const value = Number.isFinite(configured as number) ? Number(configured) : 3;
    return Math.max(1, Math.min(10, Math.floor(value)));
  }

  private getDownloadConcurrencyLimit(): number {
    const configured = vscode.workspace.getConfiguration('remotix').get<number>('sshDownloadConcurrency', 4);
    const value = Number.isFinite(configured as number) ? Number(configured) : 4;
    return Math.max(1, Math.min(10, Math.floor(value)));
  }

  public connect(): Promise<SshClient> {
    return new Promise((resolve, reject) => {
      const sshClient = new SshClient();
      LoggerService.log('[SshRemoteService] Connecting to SSH (always new connection)...');
      sshClient.on('ready', () => {
        LoggerService.log('[SshRemoteService] SSH connection ready');
        (sshClient as any).isConnected = true;
        SessionProvider.setSession(this.connection.label, sshClient);
        resolve(sshClient);
      });
      sshClient.on('error', (err: any) => {
        LoggerService.log(`[SshRemoteService] SSH error: ${err.message}`);
        (sshClient as any).isConnected = false;
        SessionProvider.closeSession(this.connection.label);
        reject(err);
      });
      sshClient.on('end', () => {
        LoggerService.log('[SshRemoteService] SSH connection ended');
        (sshClient as any).isConnected = false;
        SessionProvider.closeSession(this.connection.label);
      });
      try {
        sshClient.connect({
          host: this.connection.host,
          port: this.connection.port,
          username: this.connection.user,
          password: this.connection.password,
          privateKey: this.connection.authMethod === 'privateKey' && this.connection.authFile ? fs.readFileSync(this.connection.authFile) : undefined,
        });
      } catch (e: any) {
        reject(new Error(`Failed to initiate connection: ${e.message}`));
      }
    });
  }

  async listDirectory(path: string): Promise<vscode.TreeItem[]> {
      LoggerService.log(`[SshRemoteService] listDirectory ENTRY: path=${path}`);
      try {
          const sftp = await this.getSftp();
          
          return await new Promise<vscode.TreeItem[]>((resolve) => {
              LoggerService.log(`[SshRemoteService] Using persistent SFTP for: ${path}`);
              
              sftp.readdir(path, (err: Error | undefined, list: any[]) => {
                  if (err) {
                      LoggerService.log(`[SshRemoteService] readdir error: ${err.message}`);
                      this.sftpClient = null;
                      vscode.window.showErrorMessage(LangService.t('fileDownloadError', { error: err.message }));
                      return resolve([]);
                  }

                  const items = list
                      .filter(f => f.filename !== '.' && f.filename !== '..')
                      .map((f: any) => {
                          const isDir = (f.attrs && f.attrs.mode) 
                              ? (f.attrs.mode & 0o170000) === 0o040000 
                              : (f.longname && f.longname.startsWith('d'));

                          const item = new vscode.TreeItem(
                              f.filename, 
                              isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                          );

                          let fullPath = path.endsWith('/') ? `${path}${f.filename}` : `${path}/${f.filename}`;
                          if (path === '.') fullPath = f.filename;

                          (item as any).sshPath = fullPath;
                          (item as any).connectionLabel = this.connection.label;
                          item.contextValue = isDir ? 'ssh-folder' : 'ssh-file';

                          if (!isDir) {
                              const ext = f.filename.split('.').pop()?.toLowerCase();
                              if (isDir) {
                                  item.iconPath = new vscode.ThemeIcon('folder');
                              } else {
                                  let iconName = 'file';
                                  if (['php', 'html', 'js', 'ts', 'css'].includes(ext)) iconName = 'file-code';
                                  if (['jpg', 'png', 'gif', 'svg'].includes(ext)) iconName = 'file-media';
                                  if (['zip', 'rar', 'tar', 'gz'].includes(ext)) iconName = 'file-zip';
                                  if (['cert', 'key', 'pem', 'cer'].includes(ext)) iconName = 'lock';

                                  item.iconPath = new vscode.ThemeIcon(iconName);
                              }
                              item.command = {
                                  command: 'remotixView.itemClick',
                                  title: LangService.t('openFile'),
                                  arguments: [{
                                      label: f.filename,
                                      sshPath: fullPath,
                                      connectionLabel: this.connection.label
                                  }]
                              };
                          }
                          return item;
                      });

                  items.sort((a, b) => {
                      const isADir = a.collapsibleState !== vscode.TreeItemCollapsibleState.None;
                      const isBDir = b.collapsibleState !== vscode.TreeItemCollapsibleState.None;
                      if (isADir !== isBDir) return isADir ? -1 : 1;
                      return (a.label as string).localeCompare(b.label as string, 'uk', { sensitivity: 'base' });
                  });

                  resolve(items);
              });
          });
      } catch (err: any) {
          LoggerService.log(`[SshRemoteService] SSH error: ${err.message}`);
          this.sftpClient = null;
          return [];
      }
  }

  async downloadWithDialogs(item: any): Promise<void> {
    LoggerService.log(`[SshRemoteService][DEBUG] downloadWithDialogs ENTRY: item=${JSON.stringify(item)}, contextValue=${item?.contextValue}`);
    const isDirectory = item?.contextValue === 'ssh-folder' || item?.contextValue === 'ftp-folder';
    const selectedPath = item?.sshPath || item?.ftpPath || 'unknown';
    LoggerService.log(`[SSH][DOWNLOAD] START dialog type=${isDirectory ? 'directory' : 'file'} path=${selectedPath}`);
    LoggerService.log(`[SshRemoteService][DEBUG] downloadWithDialogs isDirectory=${isDirectory}`);
  
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
        LoggerService.log(`[SSH][DOWNLOAD] END success type=${isDirectory ? 'directory' : 'file'} path=${selectedPath}`);
    } catch (err: any) {
        LoggerService.log(`[SSH][DOWNLOAD] END fail type=${isDirectory ? 'directory' : 'file'} path=${selectedPath} error=${err?.message || String(err)}`);
      vscode.window.showErrorMessage(LangService.t('downloadError', { error: err.message }));
    }
  }

  async download(item: any, localTarget: string): Promise<void> {
    const remotePath = item?.ftpPath || item?.sshPath;
    if (!remotePath) throw new Error('Remote path is missing');

    const pathMod = require('path');
    const localDest = pathMod.join(localTarget, pathMod.basename(remotePath));

    const session = await SessionProvider.getSession<SshClient>(this.connection.label, this);

    return await new Promise<void>((resolve, reject) => {
      session.sftp((err, sftp) => {
        if (err) {
          LoggerService.log(`[SshRemoteService] SFTP Error: ${err.message}`);
          return reject(err);
        }

        LoggerService.log(`[SSH][DOWNLOAD FILE] START: ${remotePath} -> ${localDest}`);

        const writeStream = fs.createWriteStream(localDest);
        const readStream = sftp.createReadStream(remotePath);

        writeStream.on('error', (e: Error) => {
          LoggerService.log(`[SshRemoteService] WriteStream Error: ${e.message}`);
          sftp.end();
          reject(e);
        });

        readStream.on('error', (e: Error) => {
          LoggerService.log(`[SshRemoteService] ReadStream Error: ${e.message}`);
          sftp.end();
          reject(e);
        });

        writeStream.on('close', () => {
          LoggerService.log(`[SSH][DOWNLOAD FILE] END success: ${localDest}`);
          sftp.end();
          resolve();
        });

        readStream.pipe(writeStream);
      });
    });
  }

  async downloadDir(item: any, localTarget: string): Promise<void> {
    LoggerService.log(`[SSH][DOWNLOAD DIR] START: path=${item?.sshPath || item?.ftpPath}, localTarget=${localTarget}`);

    const remoteDir = item?.ftpPath || item?.sshPath;
    if (!remoteDir) throw new Error('Remote path is missing');
    const pathMod = require('path');
    const fs = require('fs');
    const vscode_ = require('vscode');
    const localDest = pathMod.join(localTarget, pathMod.basename(remoteDir));

    const session = await SessionProvider.getSession<SshClient>(this.connection.label, this);

    return new Promise<void>((resolve, reject) => {
      session.sftp((err, sftp) => {
        if (err) return reject(err);

        let downloadedFiles = 0;
        const CONCURRENCY_LIMIT = this.getDownloadConcurrencyLimit();

        const readdirAsync = (dir: string): Promise<any[]> =>
          new Promise((res, rej) => sftp.readdir(dir, (e, list) => (e ? rej(e) : res(list || []))));

        const downloadFile = (entryRemotePath: string, entryLocalPath: string, entryName: string, fileSize: number): Promise<void> => {
          return new Promise<void>((res, rej) => {
            LoggerService.log(`[SSH][DOWNLOAD DIR][FILE] START: ${entryRemotePath}`);
            let received = 0;
            const readStream = sftp.createReadStream(entryRemotePath);
            const writeStream = fs.createWriteStream(entryLocalPath);

            readStream.on('data', (chunk: Buffer) => {
              received += chunk.length;
              if (fileSize > 0) {
                const percent = Math.round((received / fileSize) * 100);
                vscode_.window.setStatusBarMessage(`Remotix: ${entryName} [${percent}%]`, 1000);
              }
            });

            const handleError = (e: Error) => {
              readStream.destroy();
              writeStream.destroy();
              LoggerService.log(`[SSH][DOWNLOAD DIR][FILE] END fail: ${entryRemotePath} error=${e.message}`);
              rej(e);
            };

            readStream.on('error', handleError);
            writeStream.on('error', handleError);

            writeStream.on('finish', () => {
              downloadedFiles++;
              LoggerService.log(`[SSH][DOWNLOAD DIR][FILE] END: ${entryRemotePath}`);
              vscode_.window.setStatusBarMessage(`Remotix: Завантажено ${downloadedFiles} файлів`, 2000);
              res();
            });

            readStream.pipe(writeStream);
          });
        };

        const recursiveDownload = async (rDir: string, lDir: string): Promise<void> => {
          if (!fs.existsSync(lDir)) {
            fs.mkdirSync(lDir, { recursive: true });
          }

          const list = await readdirAsync(rDir);
          const entries = list.filter((entry: any) => entry.filename !== '.' && entry.filename !== '..');
          const dirs = entries.filter((entry: any) => entry.attrs?.isDirectory?.());
          const files = entries.filter((entry: any) => !entry.attrs?.isDirectory?.());
          LoggerService.log(`[SSH][DOWNLOAD DIR] BATCH: dir=${rDir} dirs=${dirs.length} files=${files.length}`);

          // Build folders first to keep structure predictable.
          for (const entry of dirs) {
            const entryRemotePath = rDir.endsWith('/') ? rDir + entry.filename : rDir + '/' + entry.filename;
            const entryLocalPath = pathMod.join(lDir, entry.filename);
            await recursiveDownload(entryRemotePath, entryLocalPath);
          }

          const queue = [...files];
          const worker = async (): Promise<void> => {
            while (queue.length > 0) {
              const entry = queue.shift();
              if (!entry) continue;
              const entryRemotePath = rDir.endsWith('/') ? rDir + entry.filename : rDir + '/' + entry.filename;
              const entryLocalPath = pathMod.join(lDir, entry.filename);
              const fileSize = entry.attrs?.size || 0;
              await downloadFile(entryRemotePath, entryLocalPath, entry.filename, fileSize);
            }
          };

          const workerCount = Math.min(CONCURRENCY_LIMIT, queue.length);
          if (workerCount > 0) {
            await Promise.all(Array(workerCount).fill(null).map(() => worker()));
          }
        };

        recursiveDownload(remoteDir, localDest)
          .then(() => {
            sftp.end();
            vscode_.window.setStatusBarMessage('Remotix: Завантаження папки завершено', 5000);
            LoggerService.log(`[SSH][DOWNLOAD DIR] END success: ${remoteDir}`);
            resolve();
          })
          .catch((finalErr: Error) => {
            sftp.end();
            LoggerService.log(`[SSH][DOWNLOAD DIR] END fail: ${remoteDir} error=${finalErr.message}`);
            reject(finalErr);
          });
      });
    });
  }


  async uploadWithDialogs(item: any): Promise<void> {
    const treeDataProvider = Container.get('treeDataProvider') as TreeDataProvider;
    const targetPath = item?.sshPath || item?.ftpPath;
    LoggerService.log(`[SSH][UPLOAD] START dialog target=${targetPath || 'unknown'}`);
    if (!targetPath) {
      vscode.window.showErrorMessage(LangService.t('missingPathOrConnection'));
      LoggerService.log('[SSH][UPLOAD] END fail: missing target path');
      return;
    }
    const treeDataProviderAny = treeDataProvider as any;
    const conn = treeDataProviderAny.getConnectionByLabel
      ? treeDataProviderAny.getConnectionByLabel(this.connection.label)
      : undefined;
    if (!conn) {
      vscode.window.showErrorMessage(LangService.t('connectionNotFound'));
      LoggerService.log('[SSH][UPLOAD] END fail: connection not found');
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
      LoggerService.log('[SSH][UPLOAD] END canceled: no selection');
      return;
    }
    const pathMod = require('path');
    const fs = require('fs');
    let anyError = false;

    try {
      treeDataProvider.treeLocker.lock(LangService.t('uploadInProgress'), this.connection.label);
      LoggerService.log('[DEBUG] Tree locked for upload sequence');

      for (const uri of uris) {
        const localPath = uri.fsPath;
        let uploadTarget = targetPath;
        try {
          const stat = fs.statSync(localPath);
          if (stat.isDirectory()) {
            uploadTarget = pathMod.join(targetPath, pathMod.basename(localPath));
            await this.uploadDir(localPath, uploadTarget);
          } else {
            await this.upload(localPath, pathMod.join(uploadTarget, pathMod.basename(localPath)));
          }
        } catch (e: any) {
          anyError = true;
          vscode.window.showErrorMessage(LangService.t('uploadError', { error: (e instanceof Error ? e.message : String(e)) }));
        }
      }
      if (!anyError) {
        vscode.window.showInformationMessage(LangService.t('uploadSuccess'));
        LoggerService.log(`[SSH][UPLOAD] END success target=${targetPath}`);
      } else {
        LoggerService.log(`[SSH][UPLOAD] END fail target=${targetPath}`);
      }
    } finally {
      treeDataProvider.treeLocker.unlock();
      LoggerService.log('[DEBUG] Tree unlocked after upload sequence');
      const refreshPath = item?.contextValue === 'ssh-folder' || item?.contextValue === 'ftp-folder'
        ? targetPath
        : this.getParentRemotePath(targetPath);
      this.refreshFolder(treeDataProvider, refreshPath);
    }
  }

  async upload(localPath: string, remotePath: string, sftp?: any): Promise<void> {
      const session = await SessionProvider.getSession<any>(this.connection.label, this);

      return new Promise<void>((resolve, reject) => {
          const executeUpload = (sftpClient: any) => {
          LoggerService.log(`[SSH][UPLOAD FILE] START: ${localPath} -> ${remotePath}`);
              sftpClient.fastPut(localPath, remotePath, (err: Error | undefined) => {
                  if (err) {
              LoggerService.log(`[SSH][UPLOAD FILE] END fail: ${remotePath} error=${err.message}`);
                      return reject(err);
                  }
            LoggerService.log(`[SSH][UPLOAD FILE] END success: ${remotePath}`);
                  resolve();
              });
          };

          if (sftp) {
              executeUpload(sftp);
          } else {
              session.sftp((err: Error | undefined, client: any) => {
                  if (err) return reject(err);
                  executeUpload(client);
              });
          }
      });
  }

  async uploadDir(localDir: string, remoteDir: string, existingSftp?: any): Promise<void> {
      const pathMod = require('path');
      const fsPromises = require('fs').promises;
      const normalizedRemote = remoteDir.replace(/\\/g, '/');
      const visitedRealDirs = new Set<string>();

      LoggerService.log(`[SSH][UPLOAD DIR] START: ${localDir} -> ${normalizedRemote}`);

      try {
          const session = await SessionProvider.getSession<any>(this.connection.label, this);
          const sftp: any = existingSftp || await new Promise((res, rej) => {
              LoggerService.log(`[DEBUG 3] Запит SFTP потоку...`);
              session.sftp((err: Error | undefined, client: any) => {
                  if (err) return rej(err);
                  LoggerService.log(`[DEBUG 3.SUCCESS] SFTP потік готовий`);
                  res(client);
              });
          });

          await this.createFolder(normalizedRemote);
          LoggerService.log(`[DEBUG 4.SUCCESS] Етап створення папки пройдено`);

          const collectableEntries = await fsPromises.readdir(localDir, { withFileTypes: true });
          const entries = [] as any[];
          for (const entry of collectableEntries) {
            const src = pathMod.join(localDir, entry.name);
            if (entry.isSymbolicLink && entry.isSymbolicLink()) {
              LoggerService.log(`[SSH][UPLOAD DIR][SKIP] Symbolic link: ${src}`);
              continue;
            }
            entries.push(entry);
          }

          const realDir = await fsPromises.realpath(localDir).catch(() => localDir);
          if (visitedRealDirs.has(realDir)) {
            LoggerService.log(`[SSH][UPLOAD DIR][SKIP] Already visited local dir (cycle guard): ${localDir}`);
            return;
          }
          visitedRealDirs.add(realDir);

          LoggerService.log(`[SSH][UPLOAD DIR] BATCH entries=${entries.length} dir=${normalizedRemote}`);

          const dirs = entries.filter((entry: any) => entry.isDirectory());
          const files = entries.filter((entry: any) => !entry.isDirectory());

          for (const entry of dirs) {
              const src = pathMod.join(localDir, entry.name);
              const dest = `${normalizedRemote}/${entry.name}`;
              
              await this.uploadDir(src, dest, sftp);
          }

          const CONCURRENCY_LIMIT = this.getUploadConcurrencyLimit();
          const queue = [...files];
          const worker = async (): Promise<void> => {
            while (queue.length > 0) {
              const entry = queue.shift();
              if (!entry) {
                continue;
              }
              const src = pathMod.join(localDir, entry.name);
              const dest = `${normalizedRemote}/${entry.name}`;
              LoggerService.log(`[SSH][UPLOAD DIR][FILE] START: ${src} -> ${dest}`);
              await this.upload(src, dest, sftp);
              LoggerService.log(`[SSH][UPLOAD DIR][FILE] END: ${dest}`);
            }
          };

          const workerCount = Math.min(CONCURRENCY_LIMIT, queue.length);
          if (workerCount > 0) {
            await Promise.all(Array(workerCount).fill(null).map(() => worker()));
          }

                LoggerService.log(`[SSH][UPLOAD DIR] END success: ${normalizedRemote}`);

      } catch (err: any) {
                LoggerService.log(`[SSH][UPLOAD DIR] END fail: ${normalizedRemote} error=${err.message}`);
          throw err;
      } finally {
          if (!existingSftp) {
                  LoggerService.log('[SSH][UPLOAD DIR] root operation finished');
          }
      }
  }

  async createFileWithDialogs(item: any): Promise<void> {
    const treeDataProvider = Container.get('treeDataProvider') as TreeDataProvider;
    const sshPath = item?.sshPath || item?.ftpPath;
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
      await this.createFile(newFilePath);
      vscode.window.showInformationMessage(LangService.t('fileCreated', { path: newFilePath }));
      const refreshPath = item?.contextValue === 'ssh-folder' || item?.contextValue === 'ftp-folder'
        ? sshPath
        : this.getParentRemotePath(sshPath);
      this.refreshFolder(treeDataProvider, refreshPath);
    } catch (e: any) {
      vscode.window.showErrorMessage(LangService.t('createFileFailed', { error: (e instanceof Error ? e.message : String(e)) }));
    }
  }

  async createFile(remotePath: string): Promise<void> {
    const session = await SessionProvider.getSession<SshClient>(this.connection.label, this);

    return await new Promise<void>((resolve, reject) => {
      session.sftp((err, sftp) => {
        if (err) {
          LoggerService.log(`[SshRemoteService] createFile SFTP Error: ${err.message}`);
          return reject(err);
        }

        LoggerService.log(`[SshRemoteService] Creating empty file: ${remotePath}`);

        const writeStream = sftp.createWriteStream(remotePath, { 
          flags: 'w', 
          encoding: 'utf8' 
        });

        writeStream.on('close', () => {
          LoggerService.log(`[SshRemoteService] File created successfully: ${remotePath}`);
          sftp.end();
          resolve();
        });

        writeStream.on('error', (e: Error) => {
          LoggerService.log(`[SshRemoteService] createFile WriteStream Error: ${e.message}`);
          sftp.end();
          reject(e);
        });

        writeStream.end('');
      });
    });
  }


  async createFolderWithDialogs(item: any): Promise<void> {
    const treeDataProvider = Container.get('treeDataProvider') as TreeDataProvider;
    const sshPath = item?.sshPath || item?.ftpPath;
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
      await this.createFolder(newFolderPath);
      vscode.window.showInformationMessage(LangService.t('folderCreated', { path: newFolderPath }));
      const refreshPath = item?.contextValue === 'ssh-folder' || item?.contextValue === 'ftp-folder'
        ? sshPath
        : this.getParentRemotePath(sshPath);
      this.refreshFolder(treeDataProvider, refreshPath);
    } catch (e: any) {
      vscode.window.showErrorMessage(LangService.t('createFolderFailed', { error: (e instanceof Error ? e.message : String(e)) }));
    }
  }

  async createFolder(remoteDir: string): Promise<void> {
      const session = await SessionProvider.getSession<any>(this.connection.label, this);
      
      return new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
              LoggerService.log(`[MKDIR TIMEOUT] Force resolve для: ${remoteDir}`);
              resolve();
          }, 5000);

          session.exec(`mkdir -p "${remoteDir}"`, (err: Error | undefined, stream: any) => {
              if (err) {
                  LoggerService.log(`[MKDIR ERROR] ${err.message}`);
                  clearTimeout(timeout);
                  return resolve();
              }

              stream.on('data', (data: Buffer) => LoggerService.log(`[MKDIR STDOUT] ${data.toString()}`));
              stream.stderr.on('data', (data: Buffer) => LoggerService.log(`[MKDIR STDERR] ${data.toString()}`));

              stream.on('close', (code: number | null) => {
                  clearTimeout(timeout);
                  LoggerService.log(`[MKDIR CLOSE] Код: ${code}`);
                  resolve();
              });
              
              stream.end();
          });
      });
  }

  async deleteFileWithDialogs(item: any): Promise<void> {
    const treeDataProvider = Container.get('treeDataProvider') as TreeDataProvider;
    const sshPath = item?.sshPath || item?.ftpPath;
    if (!sshPath) {
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
    LoggerService.log(`[SSH][DELETE] START type=${isDir ? 'directory' : 'file'} path=${sshPath}`);
    treeDataProvider?.treeLocker?.lock(LangService.t('deleteInProgress'), this.connection.label);
    try {
      if (isDir) {
        await this.deleteDir(sshPath);
        vscode.window.showInformationMessage(LangService.t('folderDeleted', { path: sshPath }));
      } else {
        await this.deleteFile(sshPath);
        vscode.window.showInformationMessage(LangService.t('fileDeleted', { path: sshPath }));
      }
      this.refreshFolder(treeDataProvider, this.getParentRemotePath(sshPath));
      LoggerService.log(`[SSH][DELETE] END success type=${isDir ? 'directory' : 'file'} path=${sshPath}`);
    } catch (e: any) {
      LoggerService.log(`[SSH][DELETE] END fail type=${isDir ? 'directory' : 'file'} path=${sshPath} error=${e instanceof Error ? e.message : String(e)}`);
      vscode.window.showErrorMessage(LangService.t('deleteFailed', { error: (e instanceof Error ? e.message : String(e)) }));
    } finally {
      treeDataProvider?.treeLocker?.unlock();
    }
  }

  async deleteFile(remotePath: string): Promise<void> {
    const session = await SessionProvider.getSession<SshClient>(this.connection.label, this);

    return await new Promise<void>((resolve, reject) => {
      session.sftp((err, sftp) => {
        if (err) {
          LoggerService.log(`[SshRemoteService] deleteFile SFTP Error: ${err.message}`);
          return reject(err);
        }

        LoggerService.log(`[SSH][DELETE FILE] START: ${remotePath}`);

        sftp.unlink(remotePath, (err2: any) => {
          if (err2) {
            LoggerService.log(`[SSH][DELETE FILE] END fail: ${remotePath} error=${err2.message}`);
            sftp.end();
            return reject(err2);
          }
          
          LoggerService.log(`[SSH][DELETE FILE] END success: ${remotePath}`);
          sftp.end();
          resolve();
        });
      });
    });
  }

  async deleteDir(remoteDir: string): Promise<void> {
    LoggerService.log(`[SSH][DELETE DIR] START: ${remoteDir}`);
    
    const session = await SessionProvider.getSession<SshClient>(this.connection.label, this);
    
    if (!session || (session as any).closed) {
      throw new Error('SSH session is closed or not available');
    }

    return new Promise<void>((resolve, reject) => {
      session.sftp((err, sftp) => {
        if (err) {
          LoggerService.log(`[SSH][DELETE DIR] SFTP error: ${err.message}`);
          return reject(err);
        }

        const rmRecursive = (dirPath: string, done: (err?: Error | null) => void) => {
          sftp.readdir(dirPath, (err2, list) => {
            if (err2) {
              LoggerService.log(`[SSH][DELETE DIR] readdir fail: ${dirPath} error=${err2.message}`);
              return done(err2);
            }

            let i = 0;
            const next = (): void => {
              if (i >= list.length) {
                sftp.rmdir(dirPath, (errRm) => {
                  if (errRm) {
                    LoggerService.log(`[SSH][DELETE DIR] rmdir fail: ${dirPath} error=${errRm.message}`);
                  }
                  return done(errRm);
                });
                return;
              }

              const entry = list[i++];
              
              if (entry.filename === '.' || entry.filename === '..') {
                return next();
              }

              const entryPath = dirPath.endsWith('/') ? dirPath + entry.filename : dirPath + '/' + entry.filename;
              
              const isDirectory = entry.attrs.isDirectory();

              if (isDirectory) {
                rmRecursive(entryPath, (err3) => {
                  if (err3) return done(err3);
                  next();
                });
              } else {
                sftp.unlink(entryPath, (err3) => {
                  if (err3) {
                    LoggerService.log(`[SSH][DELETE DIR] unlink fail: ${entryPath} error=${err3.message}`);
                    return done(err3);
                  }
                  next();
                });
              }
            };

            next();
          });
        };

        rmRecursive(remoteDir, (finalErr) => {
          sftp.end();
          if (finalErr) {
            LoggerService.log(`[SSH][DELETE DIR] END fail: ${remoteDir} error=${finalErr.message}`);
            reject(finalErr);
          } else {
            LoggerService.log(`[SSH][DELETE DIR] END success: ${remoteDir}`);
            resolve();
          }
        });
      });
    });
  }


  async renameWithDialogs(item: any): Promise<void> {
    const treeDataProvider = Container.get('treeDataProvider') as TreeDataProvider;
    const labelStr = typeof item.label === 'string' ? item.label : (item.label && typeof item.label.label === 'string' ? item.label.label : String(item.label));
    const oldLabel = labelStr;
    const sshPath = item.sshPath || item.ftpPath;
    if (!sshPath) {
      vscode.window.showErrorMessage(LangService.t('missingSshPathOrConnectionLabel'));
      return;
    }
    const newName = await vscode.window.showInputBox({
      prompt: LangService.t('rename'),
      value: oldLabel
    });
    if (!newName || newName === oldLabel) return;
    const session = await SessionProvider.getSession<SshClient>(this.connection.label, this);
    if (!session) {
      vscode.window.showErrorMessage(LangService.t('connectionNotFound'));
      return;
    }
    const oldPath = sshPath;
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
    const session = await SessionProvider.getSession<SshClient>(this.connection.label, this);

    return await new Promise<void>((resolve, reject) => {
      session.sftp((err, sftp) => {
        if (err) {
          LoggerService.log(`[SshRemoteService] rename SFTP Error: ${err.message}`);
          return reject(err);
        }

        LoggerService.log(`[SshRemoteService] Renaming: ${oldRemotePath} -> ${newRemotePath}`);

        sftp.rename(oldRemotePath, newRemotePath, (err2: any) => {
          if (err2) {
            LoggerService.log(`[SshRemoteService] rename error: ${err2.message}`);
            sftp.end();
            return reject(err2);
          }
          
          LoggerService.log(`[SshRemoteService] Rename/Move successful`);
          sftp.end();
          resolve();
        });
      });
    });
  }


  async editFileWithDialogs(item: any): Promise<void> {
    const filePath = item.ftpPath || item.sshPath;
    if (!filePath) {
      vscode.window.showErrorMessage(LangService.t('missingPathOrConnection'));
      return;
    }
    const session = await SessionProvider.getSession<SshClient>(this.connection.label, this);
    if (!session) {
      vscode.window.showErrorMessage(LangService.t('noConnectionsFound'));
      return;
    }
    const os = require('os');
    const pathMod = require('path');
    const fs = require('fs');
    const tmp = os.tmpdir();
    const safeHost = (this.connection.host ?? 'unknown_host').replace(/[^\w]/g, '_');
    const relPathRaw = item.sshPath || item.ftpPath || '';
    const safeRelPath = relPathRaw.replace(/^\/\/+/, '').split('/').map((p: string) => p.replace(/[^\w.\-]/g, '_')).join(pathMod.sep);
    const tmpDir = pathMod.join(tmp, `remotix_${safeHost}`);
    fs.mkdirSync(pathMod.dirname(pathMod.join(tmpDir, safeRelPath)), { recursive: true });
    const tmpFile = pathMod.join(tmpDir, safeRelPath);
    try {
      const ssh = await SessionProvider.getSession<SshClient>(this.connection.label, this);
      const remotePath = item.sshPath || '';

      await new Promise<void>((resolve, reject) => {
        ssh.sftp((err, sftp) => {
          if (err) return reject(err);

          LoggerService.log(`[SshRemoteService] SFTP session opened for download: ${remotePath}`);
          sftp.fastGet(remotePath, tmpFile, {}, (downloadErr) => {
            sftp.end();
            if (downloadErr) return reject(downloadErr);
            resolve();
          });
        });
      });
      
      const doc = await vscode.workspace.openTextDocument(tmpFile);
      await vscode.window.showTextDocument(doc, { preview: false });

      vscode.window.setStatusBarMessage(LangService.t('remoteFile', {
        user: (session as any).user ?? '',
        host: (session as any).host ?? '',
        path: remotePath
      }), 5000);

      const subscriptions: vscode.Disposable[] = [];
      const saveSub = vscode.workspace.onDidSaveTextDocument(async (savedDoc) => {
        if (savedDoc.fileName === tmpFile) {
          try {
            const currentSession = await SessionProvider.getSession<SshClient>(this.connection.label, this);
            if (!currentSession) {
              vscode.window.showErrorMessage(LangService.t('noConnectionsFound'));
              return;
            }
            
            await new Promise<void>((resolve, reject) => {
              currentSession.sftp((err, sftp) => {
                if (err) return reject(err);

                LoggerService.log(`[SshRemoteService] SFTP session opened for upload: ${remotePath}`);
                sftp.fastPut(tmpFile, remotePath, {}, (uploadErr) => {
                  sftp.end();
                  if (uploadErr) {
                    return reject(uploadErr);
                  }
                  vscode.window.setStatusBarMessage(LangService.t('fileSavedToServer'), 2000);
                  resolve();
                });
              });
            });
          } catch (uploadErr: any) {
            vscode.window.showErrorMessage(LangService.t('fileUploadError', { error: uploadErr.message }));
          }
        }
      });
      subscriptions.push(saveSub);

      const closeSub = vscode.workspace.onDidCloseTextDocument((closedDoc) => {
        if (closedDoc.fileName === tmpFile) {
          subscriptions.forEach(s => s.dispose());
          try {
            if (require('fs').existsSync(tmpFile)) {
              require('fs').unlinkSync(tmpFile);
              LoggerService.log(`[SshRemoteService] Temporary file deleted: ${tmpFile}`);
            }
          } catch (err) {
            LoggerService.log(`[SshRemoteService] Cleanup error: ${err}`);
          }
        }
      });
      subscriptions.push(closeSub);

    } catch (e: any) {
      LoggerService.log(`[SshRemoteService] Error: ${e.message}`);
      vscode.window.showErrorMessage(LangService.t('fileDownloadError', { error: e.message }));
    }
  }


  async moveItems(items: {sshPath: string}[], targetFolder: string, onDone: () => void): Promise<void> {
    LoggerService.log(`[SshRemoteService][DEBUG] moveItems ENTRY: items=${JSON.stringify(items)}, targetFolder=${targetFolder}`);
    let moved = 0;
    let failed = 0;
    const total = items.length;
    for (const item of items) {
      try {
        const filename = item.sshPath.split('/').pop();
        if (!filename) {
          failed++;
          LoggerService.log('[SshRemoteService] moveItems: filename is undefined, skipping item');
          if (moved + failed === total) onDone();
          continue;
        }
        const newPath = targetFolder === '.' ? filename : `${targetFolder}/${filename}`;
        if (item.sshPath === newPath) {
          moved++;
          if (moved + failed === total) onDone();
          continue;
        }
        await this.rename(item.sshPath, newPath);
        moved++;
      } catch (err: any) {
        failed++;
        vscode.window.showErrorMessage(LangService.t('fileMoveError', { error: err.message }));
      }
      if (moved + failed === total) onDone();
    }
    if (items.length === 0) {
      LoggerService.log('[SshRemoteService] moveItems: No valid items to move');
      onDone();
    }
  }  

  private async getSftp(): Promise<any> {
    const session = await SessionProvider.getSession<any>(this.connection.label, this);

    if (this.sftpClient && this.sftpClient._client !== session) {
        LoggerService.log(`[SFTP] Session mismatch (old session died). Resetting SFTP client.`);
        this.sftpClient = null;
    }

    if (this.sftpClient) {
        return this.sftpClient;
    }

    return new Promise((resolve, reject) => {
        LoggerService.log(`[SFTP] Creating new SFTP stream for session...`);
        session.sftp((err: Error | undefined, sftp: any) => {
            if (err) return reject(err);
            
            this.sftpClient = sftp;
            this.sftpClient._client = session; 
            this.sftpClient.on('close', () => {
                LoggerService.log(`[SFTP] Stream closed for ${this.connection.label}`);
                this.sftpClient = null;
            });
            this.sftpClient.on('error', (err: any) => {
                LoggerService.log(`[SFTP ERROR] ${err.message}`);
                this.sftpClient = null;
            });

            resolve(sftp);
        });
    });
}
}
