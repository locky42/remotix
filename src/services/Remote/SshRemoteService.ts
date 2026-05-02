import * as fs from 'fs';
import * as vscode from 'vscode';
import { Container } from '../Container';
import { Client as SshClient } from 'ssh2';
import { LangService } from '../LangService';
import { RemoteService } from './RemoteService';
import { ConfigService } from '../ConfigService';
import { LoggerService } from '../LoggerService';
import { SessionProvider } from '../SessionProvider';
import { TreeDataProvider } from '../../ui/TreeDataProvider';
import { RemoteFileEditService } from '../RemoteFileEditService';
import { PermissionHelper } from '../../helpers/PermissionHelper';
import { RemotePathHelper } from '../../helpers/RemotePathHelper';
import { RemoteTreeViewHelper } from '../../helpers/RemoteTreeViewHelper';
import { RemoteRefreshHelper } from '../../helpers/RemoteRefreshHelper';
import { PermissionIconHelper } from '../../helpers/PermissionIconHelper';
import { RemoteCrudDialogHelper } from '../../helpers/RemoteCrudDialogHelper';
import { PropertiesFormatHelper } from '../../helpers/PropertiesFormatHelper';
import { PropertiesDialogHelper } from '../../helpers/PropertiesDialogHelper';
import { ConnectionItem, PermissionApplyTarget, PermissionChangeOptions, RemoteBaseIcon } from '../../types';

export class SshRemoteService implements RemoteService {
  private connection: ConnectionItem;
  private sftpClient: any | null = null;
  private initialPath: string = '/';

  private getRemoteFileEditService(): RemoteFileEditService {
    return Container.get<RemoteFileEditService>('remoteFileEditService');
  }

  constructor(connection: ConnectionItem) {
    this.connection = connection;
    LoggerService.log(`[SshRemoteService] Created for ${this.connection.user}@${this.connection.host}:${this.connection.port}`);
  }

  private getPermissionStatusForSshEntry(fileEntry: any): 'no-read' | 'read-only' | undefined {
    const longname = String(fileEntry?.longname || '');
    const parts = longname.trim().split(/\s+/);
    const permBlock = parts[0] || '';
    const owner = parts[2] || '';

    if (permBlock.length >= 10) {
      const perms = permBlock.slice(1, 10);
      const ownerTriplet = perms.slice(0, 3);
      const worldTriplet = perms.slice(6, 9);
      const targetTriplet = owner && this.connection.user && owner === this.connection.user
        ? ownerTriplet
        : worldTriplet;

      const canRead = targetTriplet[0] === 'r';
      const canWrite = targetTriplet[1] === 'w';

      if (!canRead) {
        return 'no-read';
      }

      if (canRead && !canWrite) {
        return 'read-only';
      }

      return undefined;
    }

    // Fallback for servers that do not provide a parseable longname.
    const mode = Number(fileEntry?.attrs?.mode);
    if (!Number.isFinite(mode)) {
      return undefined;
    }

    const anyRead = (mode & 0o444) !== 0;
    const anyWrite = (mode & 0o222) !== 0;

    if (!anyRead) {
      return 'no-read';
    }

    if (anyRead && !anyWrite) {
      return 'read-only';
    }

    return undefined;
  }

  private getBaseIconForSshEntry(isDir: boolean, fileName: string): RemoteBaseIcon {
    if (isDir) {
      return 'folder';
    }

    const ext = fileName.split('.').pop()?.toLowerCase();
    if (['php', 'html', 'js', 'ts', 'css'].includes(ext || '')) return 'file-code';
    if (['jpg', 'png', 'gif', 'svg'].includes(ext || '')) return 'file-media';
    if (['zip', 'rar', 'tar', 'gz'].includes(ext || '')) return 'file-zip';
    if (['cert', 'key', 'pem', 'cer'].includes(ext || '')) return 'lock-file';
    return 'file';
  }

  public detectModeFromEntry(fileEntry: any): string | undefined {
    const mode = Number(fileEntry?.attrs?.mode);
    if (Number.isFinite(mode)) {
      return (mode & 0o777).toString(8).padStart(3, '0');
    }

    const longname = String(fileEntry?.longname || '');
    const parts = longname.trim().split(/\s+/);
    const permBlock = parts[0] || '';
    return PermissionHelper.parsePermissionBlockToMode(permBlock);
  }

  private detectOwnerGroupFromSshEntry(fileEntry: any): { ownerName?: string; groupName?: string } {
    const longname = String(fileEntry?.longname || '');
    const parts = longname.trim().split(/\s+/);
    if (parts.length >= 4) {
      return {
        ownerName: parts[2],
        groupName: parts[3],
      };
    }
    return {};
  }

  private async getSshExtendedProperties(remotePath: string): Promise<{ ownerName?: string; groupName?: string; createdAt?: string | number }> {
    const session = await SessionProvider.getSession<SshClient>(this.connection.label, this);
    if (!session) {
      return {};
    }

    const command = `stat -c '%U|%G|%W|%w' ${this.quoteForShell(remotePath)}`;

    return await new Promise((resolve) => {
      session.exec(command, (err: Error | undefined, stream: any) => {
        if (err) {
          resolve({});
          return;
        }

        let stdout = '';
        const timeoutHandle = setTimeout(() => {
          try {
            if (typeof stream?.close === 'function') {
              stream.close();
            }
          } catch {
          }
          resolve({});
        }, 4000);

        stream.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });

        const finalize = (): void => {
          clearTimeout(timeoutHandle);
          const line = stdout.split(/\r?\n/).map((it: string) => it.trim()).find(Boolean);
          if (!line) {
            resolve({});
            return;
          }

          const [ownerName, groupName, createdEpochRaw, createdRaw] = line.split('|');
          const createdEpoch = Number(createdEpochRaw);
          const createdAt = Number.isFinite(createdEpoch) && createdEpoch > 0
            ? createdEpoch
            : (createdRaw && createdRaw !== '-' ? createdRaw : undefined);

          resolve({
            ownerName: ownerName && ownerName !== 'UNKNOWN' ? ownerName : undefined,
            groupName: groupName && groupName !== 'UNKNOWN' ? groupName : undefined,
            createdAt,
          });
        };

        stream.on('close', finalize);
        stream.on('error', () => {
          clearTimeout(timeoutHandle);
          resolve({});
        });
      });
    });
  }

  async showPropertiesWithDialogs(item: any): Promise<void> {
    const remotePath = PropertiesDialogHelper.getRemotePathOrNotify(item);
    if (!remotePath) {
      return;
    }

    const isDirectory = item?.contextValue === 'ssh-folder' || item?.contextValue === 'ftp-folder';
    const leafName = PropertiesDialogHelper.getLeafName(remotePath);

    try {
      const sftp = await this.getSftp();
      const attrs = await new Promise<any>((resolve, reject) => {
        sftp.stat(remotePath, (err: any, stat: any) => {
          if (err) {
            return reject(err);
          }
          resolve(stat);
        });
      });

      const modeFromAttrs = Number.isFinite(Number(attrs?.mode))
        ? (Number(attrs.mode) & 0o777).toString(8).padStart(3, '0')
        : undefined;
      const extended = await this.getSshExtendedProperties(remotePath);
      const permissions = PermissionHelper.normalizePermissionMode(String(item?.permissionMode || ''))
        || modeFromAttrs
        || LangService.t('propertiesUnknown');

      const items: vscode.QuickPickItem[] = [
        { label: LangService.t('propertiesPath'), description: remotePath },
        { label: LangService.t('propertiesType'), description: isDirectory ? LangService.t('propertiesDirectory') : LangService.t('propertiesFile') },
        { label: LangService.t('propertiesPermissions'), description: permissions },
        { label: LangService.t('propertiesSize'), description: PropertiesFormatHelper.formatSize(attrs?.size, isDirectory, LangService.t('propertiesUnknown')) },
        { label: LangService.t('propertiesOwner'), description: String(item?.ownerName || extended.ownerName || LangService.t('propertiesUnknown')) },
        { label: LangService.t('propertiesGroup'), description: String(item?.groupName || extended.groupName || LangService.t('propertiesUnknown')) },
        { label: LangService.t('propertiesUid'), description: attrs?.uid !== undefined ? String(attrs.uid) : LangService.t('propertiesUnknown') },
        { label: LangService.t('propertiesGid'), description: attrs?.gid !== undefined ? String(attrs.gid) : LangService.t('propertiesUnknown') },
        { label: LangService.t('propertiesCreated'), description: PropertiesFormatHelper.formatDate(extended.createdAt, LangService.t('propertiesUnknown'), true) },
        { label: LangService.t('propertiesModified'), description: PropertiesFormatHelper.formatDate(attrs?.mtime, LangService.t('propertiesUnknown'), true) },
      ];

      await PropertiesDialogHelper.showPropertiesQuickPick(remotePath, leafName, items);
    } catch (error: any) {
      vscode.window.showErrorMessage(LangService.t('propertiesLoadFailed', {
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  public async connect(): Promise<SshClient> {
    if (this.connection.authMethod === 'password' && !this.connection.password) {
      this.connection.password = await ConfigService.getPassword(this.connection.label);
    }

    return new Promise((resolve, reject) => {
      const sshClient = new SshClient();
      LoggerService.log('[SshRemoteService] Establishing SSH connection with a fresh client instance...');
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
          this.initialPath = await RemotePathHelper.resolveSftpInitialPath(sftp, this.initialPath, (resolvedPath) => {
            LoggerService.log(`[SshRemoteService] Initial directory: ${resolvedPath}`);
          });

          if (path === '.') {
            return RemoteTreeViewHelper.buildVirtualPathTree(this.initialPath, this.connection.label, 'sshPath', 'ssh-folder');
          }
          
          return await new Promise<vscode.TreeItem[]>((resolve) => {
              LoggerService.log(`[SshRemoteService] Using persistent SFTP for: ${path}`);
              
              sftp.readdir(path, (err: Error | undefined, list: any[]) => {
                  if (err) {
                    LoggerService.log(`[SshRemoteService] readdir error: ${err.message}`);

                    if (this.initialPath.startsWith(path) && path !== this.initialPath) {
                        
                        vscode.window.showErrorMessage(LangService.t('fileDownloadError', { error: err.message }));

                        const virtualItems = RemoteTreeViewHelper.buildPermissionDeniedVirtualChild(
                          this.initialPath,
                          path,
                          this.connection.label,
                          'sshPath',
                          'ssh-folder'
                        );
                        if (virtualItems) {
                          return resolve(virtualItems);
                        }
                    }

                    vscode.window.showErrorMessage(`Помилка читання директорії ${path}: ${err.message}`);
                    return resolve([]);
                  }

                  const items = list
                      .filter(f => f.filename !== '.' && f.filename !== '..')
                      .map((f: any) => {
                          const isDir = (f.attrs && f.attrs.mode) 
                              ? (f.attrs.mode & 0o170000) === 0o040000 
                              : (f.longname && f.longname.startsWith('d'));

                          let fullPath = path.endsWith('/') ? `${path}${f.filename}` : `${path}/${f.filename}`;
                          if (path === '.') fullPath = f.filename;

                          const item = new vscode.TreeItem(
                              f.filename, 
                              isDir
                                ? (RemotePathHelper.shouldAutoExpandDirectory(this.initialPath, fullPath)
                                  ? vscode.TreeItemCollapsibleState.Expanded
                                  : vscode.TreeItemCollapsibleState.Collapsed)
                                : vscode.TreeItemCollapsibleState.None
                          );

                          const ownerGroup = this.detectOwnerGroupFromSshEntry(f);

                          (item as any).sshPath = fullPath;
                          (item as any).connectionLabel = this.connection.label;
                          (item as any).permissionMode = this.detectModeFromEntry(f);
                          (item as any).ownerName = ownerGroup.ownerName;
                          (item as any).groupName = ownerGroup.groupName;
                          item.contextValue = isDir ? 'ssh-folder' : 'ssh-file';

                                const permissionStatus = this.getPermissionStatusForSshEntry(f);
                                const baseIcon = this.getBaseIconForSshEntry(isDir, f.filename);
                                item.iconPath = PermissionIconHelper.createPermissionIcon(baseIcon, permissionStatus);

                            if (!isDir) {
                              // Set resourceUri for proper icon alignment
                              try {
                                item.resourceUri = vscode.Uri.file('/ssh/' + encodeURIComponent(this.connection.label) + fullPath);
                              } catch {}
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

                    RemoteTreeViewHelper.sortTreeItems(items, 'uk');

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

  async downloadFolderArchiveWithDialogs(item: any): Promise<void> {
    const remoteDirRaw = String(item?.sshPath || '').trim();
    if (!remoteDirRaw) {
      vscode.window.showErrorMessage(LangService.t('missingPathOrConnection'));
      return;
    }

    if (item?.contextValue !== 'ssh-folder') {
      vscode.window.showErrorMessage(LangService.t('downloadArchiveOnlyForSshFolder'));
      return;
    }

    const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
    const uri = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      openLabel: LangService.t('chooseDownloadTarget'),
      defaultUri: vscode.Uri.file(homeDir)
    });
    if (!uri || uri.length === 0) {
      return;
    }

    const remoteDir = RemotePathHelper.normalizeRemotePath(remoteDirRaw).replace(/\/+$/g, '') || '/';
    const folderName = remoteDir.split('/').filter(Boolean).pop();
    if (!folderName) {
      vscode.window.showErrorMessage(LangService.t('downloadArchiveRootNotSupported'));
      return;
    }

    const archiveNameInput = await vscode.window.showInputBox({
      prompt: LangService.t('enterArchiveFileName'),
      value: `${folderName}.tar.gz`,
      validateInput: (value) => {
        const trimmed = String(value || '').trim();
        if (!trimmed) {
          return LangService.t('archiveFileNameRequired');
        }
        if (/[\\/]/.test(trimmed)) {
          return LangService.t('archiveFileNameNoPathSeparators');
        }
        return undefined;
      }
    });
    if (!archiveNameInput) {
      return;
    }

    const pathMod = require('path');
    const fsMod = require('fs');
    const archiveName = archiveNameInput.trim();
    const localDest = pathMod.join(uri[0].fsPath, archiveName);

    const remoteTmpArchivePath = `/tmp/remotix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tar.gz`;
    const parentRemotePath = RemotePathHelper.getParentRemotePath(remoteDir);
    const createArchiveCommand = `tar -C ${this.quoteForShell(parentRemotePath)} -czf ${this.quoteForShell(remoteTmpArchivePath)} ${this.quoteForShell(folderName)}`;

    LoggerService.log(`[SSH][ARCHIVE DOWNLOAD] START dir=${remoteDir} local=${localDest}`);

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: LangService.t('archiveDownloadInProgress'),
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: LangService.t('archiveDownloadPreparing') });
          await this.runShellCommand(createArchiveCommand, 300000);

          progress.report({ message: LangService.t('archiveDownloadTransfer') });
          const session = await SessionProvider.getSession<SshClient>(this.connection.label, this);
          if (!session) {
            throw new Error('SSH session is not available');
          }

          await new Promise<void>((resolve, reject) => {
            session.sftp((err, sftp) => {
              if (err) {
                return reject(err);
              }

              const writeStream = fsMod.createWriteStream(localDest);
              const readStream = sftp.createReadStream(remoteTmpArchivePath);

              const finalizeError = (error: Error): void => {
                readStream.destroy();
                writeStream.destroy();
                sftp.end();
                reject(error);
              };

              readStream.on('error', (streamErr: Error) => finalizeError(streamErr));
              writeStream.on('error', (streamErr: Error) => finalizeError(streamErr));

              writeStream.on('close', () => {
                sftp.end();
                resolve();
              });

              readStream.pipe(writeStream);
            });
          });
        }
      );

      vscode.window.showInformationMessage(LangService.t('archiveDownloadSuccess', { path: localDest }));
      LoggerService.log(`[SSH][ARCHIVE DOWNLOAD] END success dir=${remoteDir} local=${localDest}`);
    } catch (error: any) {
      LoggerService.log(`[SSH][ARCHIVE DOWNLOAD] END fail dir=${remoteDir} error=${error instanceof Error ? error.message : String(error)}`);
      vscode.window.showErrorMessage(LangService.t('archiveDownloadError', {
        error: error instanceof Error ? error.message : String(error)
      }));
    } finally {
      try {
        await this.runShellCommand(`rm -f ${this.quoteForShell(remoteTmpArchivePath)}`, 30000);
      } catch (cleanupError: any) {
        LoggerService.log(`[SSH][ARCHIVE DOWNLOAD] cleanup warning path=${remoteTmpArchivePath} error=${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
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
        const CONCURRENCY_LIMIT = ConfigService.getConcurrencyLimit('sshDownloadConcurrency', 4);

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
        : RemotePathHelper.getParentRemotePath(targetPath);
      RemoteRefreshHelper.refreshRemoteFolder(treeDataProvider, this.connection.label, refreshPath, 'ssh');
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

          const CONCURRENCY_LIMIT = ConfigService.getConcurrencyLimit('sshUploadConcurrency', 3);
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
    const sshPath = RemoteCrudDialogHelper.getRemotePath(item);
    if (!sshPath) {
      vscode.window.showErrorMessage(LangService.t('ftpNoFolderForFile'));
      return;
    }
    const newFileName = await vscode.window.showInputBox({
      prompt: LangService.t('enterNewFileName'),
      value: LangService.t('defaultNewFileName')
    });
    if (!newFileName) return;
    const newFilePath = RemoteCrudDialogHelper.buildChildPath(sshPath, item, newFileName);
    try {
      await this.createFile(newFilePath);
      vscode.window.showInformationMessage(LangService.t('fileCreated', { path: newFilePath }));
      const refreshPath = RemoteCrudDialogHelper.getRefreshPath(item, sshPath);
      RemoteRefreshHelper.refreshRemoteFolder(treeDataProvider, this.connection.label, refreshPath, 'ssh');
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
    const sshPath = RemoteCrudDialogHelper.getRemotePath(item);
    if (!sshPath) {
      vscode.window.showErrorMessage(LangService.t('missingPathOrConnection'));
      return;
    }
    const newFolderName = await vscode.window.showInputBox({
      prompt: LangService.t('enterNewFolderName'),
      value: LangService.t('defaultNewFolderName')
    });
    if (!newFolderName) return;
    const newFolderPath = RemoteCrudDialogHelper.buildChildPath(sshPath, item, newFolderName);
    try {
      await this.createFolder(newFolderPath);
      vscode.window.showInformationMessage(LangService.t('folderCreated', { path: newFolderPath }));
      const refreshPath = RemoteCrudDialogHelper.getRefreshPath(item, sshPath);
      RemoteRefreshHelper.refreshRemoteFolder(treeDataProvider, this.connection.label, refreshPath, 'ssh');
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
    const sshPath = RemoteCrudDialogHelper.getRemotePath(item);
    if (!sshPath) {
      vscode.window.showErrorMessage(LangService.t('missingPathOrConnection'));
      return;
    }
    const isDir = RemoteCrudDialogHelper.isDirectoryItem(item);
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
      RemoteRefreshHelper.refreshRemoteFolder(treeDataProvider, this.connection.label, RemotePathHelper.getParentRemotePath(sshPath), 'ssh');
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
    const oldLabel = RemoteCrudDialogHelper.getItemLabel(item);
    const sshPath = RemoteCrudDialogHelper.getRemotePath(item);
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
    const newPath = RemoteCrudDialogHelper.buildRenamedPath(oldPath, newName);
    try {
      await this.rename(oldPath, newPath);
      vscode.window.showInformationMessage(LangService.t('renamedTo', { name: newName }));
      const oldParent = RemotePathHelper.getParentRemotePath(oldPath);
      const newParent = RemotePathHelper.getParentRemotePath(newPath);
      RemoteRefreshHelper.refreshRemoteFolder(treeDataProvider, this.connection.label, oldParent, 'ssh');
      if (newParent !== oldParent) {
        RemoteRefreshHelper.refreshRemoteFolder(treeDataProvider, this.connection.label, newParent, 'ssh');
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

  private quoteForShell(value: string): string {
    return `'${String(value || '').replace(/'/g, `'"'"'`)}'`;
  }

  private async runShellCommand(command: string, timeoutMs: number = 120000): Promise<void> {
    const session = await SessionProvider.getSession<SshClient>(this.connection.label, this);
    if (!session) {
      throw new Error('SSH session is not available');
    }

    await new Promise<void>((resolve, reject) => {
      session.exec(command, (err: Error | undefined, stream: any) => {
        if (err) {
          return reject(err);
        }

        let settled = false;
        let stderr = '';

        const finalize = (error?: Error): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeoutHandle);
          if (error) {
            reject(error);
            return;
          }
          resolve();
        };

        const timeoutHandle = setTimeout(() => {
          const timeoutError = new Error(`Command timeout after ${timeoutMs}ms`);
          try {
            if (typeof stream?.close === 'function') {
              stream.close();
            }
          } catch {
          }
          finalize(timeoutError);
        }, timeoutMs);

        if (stream?.stderr) {
          stream.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
          });
        }

        const handleExit = (code: number | null): void => {
          if (code === 0) {
            finalize();
            return;
          }
          const errText = stderr.trim() || `Command exited with code ${String(code)}`;
          finalize(new Error(errText));
        };

        stream.on('exit', (code: number | null) => handleExit(code));
        stream.on('close', (code: number | null) => handleExit(code));
        stream.on('error', (streamErr: Error) => finalize(streamErr));
      });
    });
  }

  async changePermissionsWithDialogs(item: any): Promise<void> {
    const treeDataProvider = Container.get('treeDataProvider') as TreeDataProvider;
    const remotePath = String(item?.sshPath || item?.ftpPath || '').trim();
    if (!remotePath) {
      vscode.window.showErrorMessage(LangService.t('missingPathOrConnection'));
      return;
    }

    const isDirectory = item?.contextValue === 'ssh-folder' || item?.contextValue === 'ftp-folder';
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
      RemoteRefreshHelper.refreshRemoteFolder(treeDataProvider, this.connection.label, refreshPath, 'ssh');
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

    const escapedPath = this.quoteForShell(remotePath);
    let command = `chmod ${mode} ${escapedPath}`;

    if (options.recursive) {
      if (options.applyTo === 'all') {
        command = `chmod -R ${mode} ${escapedPath}`;
      } else if (options.applyTo === 'files') {
        command = `find ${escapedPath} -type f -exec chmod ${mode} {} +`;
      } else {
        command = `find ${escapedPath} -type d -exec chmod ${mode} {} +`;
      }
    }

    LoggerService.log(`[SSH][CHMOD] START mode=${mode} recursive=${String(options.recursive)} target=${options.applyTo} path=${remotePath}`);
    await this.runShellCommand(command, 180000);
    LoggerService.log(`[SSH][CHMOD] END success path=${remotePath}`);
  }

  async copyItem(sourceRemotePath: string, targetRemotePath: string, isDirectory: boolean): Promise<void> {
    const session = await SessionProvider.getSession<SshClient>(this.connection.label, this);

    if (!session) {
      throw new Error('SSH session is not available');
    }

    const source = String(sourceRemotePath || '').trim();
    const target = String(targetRemotePath || '').trim();
    if (!source || !target) {
      throw new Error('Source or target path is missing');
    }

    const copyCmd = `cp -a ${this.quoteForShell(source)} ${this.quoteForShell(target)}`;
    LoggerService.log(`[SSH][COPY] START type=${isDirectory ? 'directory' : 'file'} ${source} -> ${target}`);

    await new Promise<void>((resolve, reject) => {
      const timeoutMs = 120000;
      session.exec(copyCmd, (err: Error | undefined, stream: any) => {
        if (err) {
          LoggerService.log(`[SSH][COPY] END fail: ${source} -> ${target} error=${err.message}`);
          return reject(err);
        }

        let settled = false;
        const finalize = (error?: Error): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeoutHandle);
          if (error) {
            reject(error);
            return;
          }
          resolve();
        };

        const timeoutHandle = setTimeout(() => {
          const timeoutError = new Error(`Copy timeout after ${timeoutMs}ms`);
          LoggerService.log(`[SSH][COPY] END fail: ${source} -> ${target} error=${timeoutError.message}`);
          try {
            if (typeof stream?.close === 'function') {
              stream.close();
            }
          } catch {
          }
          finalize(timeoutError);
        }, timeoutMs);

        let stderr = '';
        if (stream?.stderr) {
          stream.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
          });
        }

        const handleExit = (code: number | null): void => {
          if (code === 0) {
            LoggerService.log(`[SSH][COPY] END success: ${source} -> ${target}`);
            finalize();
            return;
          }

          const errorMessage = stderr.trim() || `cp exited with code ${String(code)}`;
          LoggerService.log(`[SSH][COPY] END fail: ${source} -> ${target} error=${errorMessage}`);
          finalize(new Error(errorMessage));
        };

        stream.on('exit', (code: number | null) => {
          handleExit(code);
        });

        stream.on('close', (code: number | null) => {
          handleExit(code);
        });

        stream.on('error', (streamErr: Error) => {
          LoggerService.log(`[SSH][COPY] STREAM fail: ${source} -> ${target} error=${streamErr.message}`);
          finalize(streamErr);
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

    try {
      await this.getRemoteFileEditService().openWithTempFile({
        remotePath: filePath,
        host: this.connection.host,
        user: this.connection.user,
        tmpFolderPrefix: 'remotix',
        downloadToTemp: async (tmpFile) => {
          const ssh = await SessionProvider.getSession<SshClient>(this.connection.label, this);
          if (!ssh) {
            throw new Error(LangService.t('noConnectionsFound'));
          }

          await new Promise<void>((resolve, reject) => {
            ssh.sftp((err, sftp) => {
              if (err) {
                return reject(err);
              }

              LoggerService.log(`[SshRemoteService] SFTP session opened for download: ${filePath}`);
              sftp.fastGet(filePath, tmpFile, {}, (downloadErr) => {
                sftp.end();
                if (downloadErr) {
                  return reject(downloadErr);
                }
                resolve();
              });
            });
          });
        },
        uploadFromTemp: async (tmpFile) => {
          const currentSession = await SessionProvider.getSession<SshClient>(this.connection.label, this);
          if (!currentSession) {
            throw new Error(LangService.t('noConnectionsFound'));
          }

          await new Promise<void>((resolve, reject) => {
            currentSession.sftp((err, sftp) => {
              if (err) {
                return reject(err);
              }

              LoggerService.log(`[SshRemoteService] SFTP session opened for upload: ${filePath}`);
              sftp.fastPut(tmpFile, filePath, {}, (uploadErr) => {
                sftp.end();
                if (uploadErr) {
                  return reject(uploadErr);
                }
                resolve();
              });
            });
          });
        },
        logCleanupError: (cleanupError) => {
          LoggerService.log(`[SshRemoteService] Cleanup error: ${String(cleanupError)}`);
        },
      });
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
