import * as vscode from 'vscode';
import { ConnectionItem, RemoteClipboard } from '../types';
import { Container } from '../services/Container';
import { LangService } from '../services/LangService';
import { RemoteService } from '../services/Remote/RemoteService';
import { ConnectionManager } from '../services/ConnectionManager';
import { RemoteServiceProvider } from '../services/RemoteServiceProvider';
import { RemotePathHelper } from '../helpers/RemotePathHelper';
import { RemoteClipboardHelper } from '../helpers/RemoteClipboardHelper';

let remoteClipboard: RemoteClipboard | undefined;

function getItemPath(item: any): string | undefined {
  return item?.sshPath || item?.ftpPath;
}

function getItemName(item: any, sourcePath: string): string {
  const label = typeof item?.label === 'string'
    ? item.label
    : (typeof item?.label?.label === 'string' ? item.label.label : '');
  if (label) {
    return label;
  }
  const parts = sourcePath.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : sourcePath;
}

function isDirectoryItem(item: any): boolean {
  const contextValue = String(item?.contextValue || '');
  return contextValue === 'ssh-folder' || contextValue === 'ftp-folder';
}

function buildIndexedCopyName(originalName: string, index: number, isDirectory: boolean): string {
  if (isDirectory) {
    return `${originalName}_${index}`;
  }
  const dotIndex = originalName.lastIndexOf('.');
  if (dotIndex > 0) {
    const base = originalName.slice(0, dotIndex);
    const ext = originalName.slice(dotIndex);
    return `${base}_${index}${ext}`;
  }
  return `${originalName}_${index}`;
}

function resolveConnectionItem(item: any): ConnectionItem | undefined {
  const label = item?.connectionLabel || item?.label;
  if (!label) {
    return undefined;
  }
  const connectionManager = Container.get('connectionManager') as ConnectionManager;
  if (!connectionManager) {
    return undefined;
  }

  return connectionManager.getByLabel(String(label));
}

export function registerFileFolderCommands() {
  const context = Container.get('extensionContext') as vscode.ExtensionContext;

  context.subscriptions.push(vscode.commands.registerCommand('remotix.download', async (item: any) => {
    const connection = resolveConnectionItem(item);
    if (!connection) {
      vscode.window.showErrorMessage(LangService.t('connectionNotFound'));
      return;
    }
    const service = await (Container.get('remoteServiceProvider') as RemoteServiceProvider).getRemoteService(connection.label) as RemoteService;
    if (!service) {
      return;
    }
    
    await service.downloadWithDialogs?.(item);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.downloadFolderArchive', async (item: any) => {
    const connection = resolveConnectionItem(item);
    if (!connection) {
      vscode.window.showErrorMessage(LangService.t('connectionNotFound'));
      return;
    }
    const service = await (Container.get('remoteServiceProvider') as RemoteServiceProvider).getRemoteService(connection.label) as RemoteService;
    if (!service) {
      return;
    }

    if (!service.downloadFolderArchiveWithDialogs) {
      vscode.window.showErrorMessage(LangService.t('downloadArchiveNotSupported'));
      return;
    }

    await service.downloadFolderArchiveWithDialogs(item);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.upload', async (item: any) => {
    const connection = resolveConnectionItem(item);
    if (!connection) {
      vscode.window.showErrorMessage(LangService.t('connectionNotFound'));
      return;
    }
    const service = await (Container.get('remoteServiceProvider') as RemoteServiceProvider).getRemoteService(connection.label) as RemoteService;
    if (!service) {
      return;
    }
    await service.uploadWithDialogs?.(item);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.editFile', async (item: ConnectionItem) => {
    const connection = resolveConnectionItem(item);
    if (!connection) {
      vscode.window.showErrorMessage(LangService.t('connectionNotFound'));
      return;
    }
    const service = await (Container.get('remoteServiceProvider') as RemoteServiceProvider).getRemoteService(connection.label) as RemoteService;
    if (!service) {
      return;
    }
    await service.editFileWithDialogs?.(item);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.rename', async (item: ConnectionItem) => {
    const connection = resolveConnectionItem(item);
    if (!connection) {
      vscode.window.showErrorMessage(LangService.t('connectionNotFound'));
      return;
    }
    const service = await (Container.get('remoteServiceProvider') as RemoteServiceProvider).getRemoteService(connection.label) as RemoteService;
    if (!service) {
      return;
    }
    await service.renameWithDialogs?.(item);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.changePermissions', async (item: any) => {
    const connection = resolveConnectionItem(item);
    if (!connection) {
      vscode.window.showErrorMessage(LangService.t('connectionNotFound'));
      return;
    }
    const service = await (Container.get('remoteServiceProvider') as RemoteServiceProvider).getRemoteService(connection.label) as RemoteService;
    if (!service) {
      return;
    }

    if (!service.changePermissionsWithDialogs) {
      vscode.window.showErrorMessage(LangService.t('changePermissionsNotSupported'));
      return;
    }

    await service.changePermissionsWithDialogs(item);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.showProperties', async (item: any) => {
    const connection = resolveConnectionItem(item);
    if (!connection) {
      vscode.window.showErrorMessage(LangService.t('connectionNotFound'));
      return;
    }
    const service = await (Container.get('remoteServiceProvider') as RemoteServiceProvider).getRemoteService(connection.label) as RemoteService;
    if (!service) {
      return;
    }

    if (!service.showPropertiesWithDialogs) {
      vscode.window.showErrorMessage(LangService.t('showPropertiesNotSupported'));
      return;
    }

    await service.showPropertiesWithDialogs(item);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.createFolder', async (item: any) => {
    const connection = resolveConnectionItem(item);
    if (!connection) {
      vscode.window.showErrorMessage(LangService.t('connectionNotFound'));
      return;
    }
    const service = await (Container.get('remoteServiceProvider') as RemoteServiceProvider).getRemoteService(connection.label) as RemoteService;
    if (!service) {
      return;
    }
    await service.createFolderWithDialogs?.(item);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.createFile', async (item: any) => {
    const connection = resolveConnectionItem(item);
    if (!connection) {
      vscode.window.showErrorMessage(LangService.t('connectionNotFound'));
      return;
    }
    const service = await (Container.get('remoteServiceProvider') as RemoteServiceProvider).getRemoteService(connection.label) as RemoteService;
    if (!service) {
      return;
    }
    await service.createFileWithDialogs?.(item);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.deleteFile', async (item: any) => {
    const connection = resolveConnectionItem(item);
    if (!connection) {
      vscode.window.showErrorMessage(LangService.t('connectionNotFound'));
      return;
    }
    const service = await (Container.get('remoteServiceProvider') as RemoteServiceProvider).getRemoteService(connection.label) as RemoteService;
    if (!service) {
      return;
    }
    await service.deleteFileWithDialogs?.(item);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.copyItem', async (item: any) => {
    const connection = resolveConnectionItem(item);
    if (!connection) {
      vscode.window.showErrorMessage(LangService.t('connectionNotFound'));
      return;
    }

    const sourcePath = getItemPath(item);
    if (!sourcePath) {
      vscode.window.showErrorMessage(LangService.t('missingPathOrConnection'));
      return;
    }

    remoteClipboard = {
      connectionLabel: connection.label,
      sourcePath,
      sourceName: getItemName(item, sourcePath),
      isDirectory: isDirectoryItem(item),
      sourceKind: 'remote'
    };

    try {
      await vscode.env.clipboard.writeText(RemoteClipboardHelper.serializeRemoteClipboard(remoteClipboard));
    } catch {
    }

    vscode.window.showInformationMessage(
      LangService.t(
        remoteClipboard.isDirectory ? 'copiedFolderToClipboard' : 'copiedFileToClipboard',
        { path: sourcePath }
      )
    );
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.pasteItem', async (item: any) => {
    const connection = resolveConnectionItem(item);
    if (!connection) {
      vscode.window.showErrorMessage(LangService.t('connectionNotFound'));
      return;
    }

    try {
      const rawClipboard = await vscode.env.clipboard.readText();
      const systemClipboard = RemoteClipboardHelper.parseRemoteClipboard(rawClipboard);
      if (systemClipboard) {
        remoteClipboard = systemClipboard;
      } else {
        const plainPath = RemoteClipboardHelper.parsePlainClipboardPath(rawClipboard);
        if (plainPath) {
          const plainClipboard = await RemoteClipboardHelper.buildClipboardFromPlainPath(plainPath, connection.label);
          if (plainClipboard) {
            remoteClipboard = plainClipboard;
          }
        }
      }
    } catch {
    }

    if (!remoteClipboard) {
      vscode.window.showWarningMessage(LangService.t('clipboardEmpty'));
      return;
    }

    const sourceKind = remoteClipboard.sourceKind || 'remote';

    if (sourceKind === 'remote' && connection.label !== remoteClipboard.connectionLabel) {
      vscode.window.showWarningMessage(LangService.t('copyPasteConnectionMismatch'));
      return;
    }

    const service = await (Container.get('remoteServiceProvider') as RemoteServiceProvider).getRemoteService(connection.label) as RemoteService;
    if (!service?.copyItem) {
      vscode.window.showErrorMessage(LangService.t('copyNotSupported'));
      return;
    }

    const itemPath = getItemPath(item) || '.';
    const destinationFolder = isDirectoryItem(item) ? itemPath : RemotePathHelper.getParentRemotePath(itemPath);
    const sourceParentFolder = RemotePathHelper.getParentRemotePath(remoteClipboard.sourcePath);
    const sameFolder = RemotePathHelper.normalizePathForCompare(sourceParentFolder) === RemotePathHelper.normalizePathForCompare(destinationFolder);

    let targetName = remoteClipboard.sourceName;
    if (sameFolder) {
      const existingNames = new Set<string>();
      const existingItems = await service.listDirectory?.(destinationFolder);
      if (Array.isArray(existingItems)) {
        for (const existingItem of existingItems) {
          const label = typeof existingItem.label === 'string'
            ? existingItem.label
            : (typeof (existingItem as any)?.label?.label === 'string' ? (existingItem as any).label.label : '');
          if (label) {
            existingNames.add(label);
          }
        }
      }

      let index = 1;
      let candidate = buildIndexedCopyName(remoteClipboard.sourceName, index, remoteClipboard.isDirectory);
      while (existingNames.has(candidate)) {
        index += 1;
        candidate = buildIndexedCopyName(remoteClipboard.sourceName, index, remoteClipboard.isDirectory);
      }
      targetName = candidate;
    }

    const manualName = await vscode.window.showInputBox({
      prompt: LangService.t('enterCopyName'),
      value: targetName
    });

    if (!manualName) {
      return;
    }

    targetName = manualName.trim();
    if (!targetName) {
      return;
    }

    const targetPath = RemotePathHelper.joinRemotePath(destinationFolder, targetName);

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: LangService.t('copyInProgress'),
          cancellable: false
        },
        async (progress) => {
          const startedAt = Date.now();
          progress.report({
            message: LangService.t('copyInProgressDetails', {
              source: remoteClipboard!.sourcePath,
              target: targetPath
            })
          });

          const ticker = setInterval(() => {
            const seconds = Math.floor((Date.now() - startedAt) / 1000);
            progress.report({
              message: LangService.t('copyInProgressElapsed', { seconds: String(seconds) })
            });
          }, 1000);

          try {
            if ((remoteClipboard!.sourceKind || 'remote') === 'local') {
              if (remoteClipboard!.isDirectory) {
                await service.uploadDir(remoteClipboard!.sourcePath, targetPath);
              } else {
                await service.upload(remoteClipboard!.sourcePath, targetPath);
              }
            } else {
              await service.copyItem?.(remoteClipboard!.sourcePath, targetPath, remoteClipboard!.isDirectory);
            }
          } finally {
            clearInterval(ticker);
          }
        }
      );
      vscode.window.showInformationMessage(LangService.t('copySuccess', { path: targetPath }));
      const treeDataProvider = Container.get('treeDataProvider') as any;
      if (treeDataProvider?.refreshRemoteFolder) {
        treeDataProvider.refreshRemoteFolder(connection.label, destinationFolder, connection.type);
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(LangService.t('copyFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.copyPath', async (item: any) => {
    if (!item) {
      vscode.window.showErrorMessage(LangService.t('itemNotSelected'));
      return;
    }

    const remotePath = (item as any).sshPath || (item as any).ftpPath;
    if (!remotePath) {
      vscode.window.showErrorMessage(LangService.t('pathNotFound'));
      return;
    }

    try {
      await vscode.env.clipboard.writeText(remotePath);
      vscode.window.showInformationMessage(LangService.t('copiedPathToClipboard'));
    } catch (e: any) {
      vscode.window.showErrorMessage(LangService.t('copyFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }));
}
