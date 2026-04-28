import * as vscode from 'vscode';
import { ConnectionItem } from '../types';
import { Container } from '../services/Container';
import { LangService } from '../services/LangService';
import { RemoteService } from '../services/Remote/RemoteService';
import { ConnectionManager } from '../services/ConnectionManager';
import { RemoteServiceProvider } from '../services/RemoteServiceProvider';

type RemoteClipboard = {
  connectionLabel: string;
  sourcePath: string;
  sourceName: string;
  isDirectory: boolean;
  sourceKind?: 'remote' | 'local';
};

let remoteClipboard: RemoteClipboard | undefined;
const REMOTIX_CLIPBOARD_PREFIX = 'remotix-clipboard:';

function serializeRemoteClipboard(payload: RemoteClipboard): string {
  return `${REMOTIX_CLIPBOARD_PREFIX}${encodeURIComponent(JSON.stringify(payload))}`;
}

function parseRemoteClipboard(raw: string): RemoteClipboard | undefined {
  const text = String(raw || '').trim();
  if (!text.startsWith(REMOTIX_CLIPBOARD_PREFIX)) {
    return undefined;
  }

  const encoded = text.slice(REMOTIX_CLIPBOARD_PREFIX.length);
  if (!encoded) {
    return undefined;
  }

  try {
    const decoded = decodeURIComponent(encoded);
    const data = JSON.parse(decoded) as Partial<RemoteClipboard>;
    if (
      typeof data?.connectionLabel !== 'string' ||
      typeof data?.sourcePath !== 'string' ||
      typeof data?.sourceName !== 'string' ||
      typeof data?.isDirectory !== 'boolean'
    ) {
      return undefined;
    }

    return {
      connectionLabel: data.connectionLabel,
      sourcePath: data.sourcePath,
      sourceName: data.sourceName,
      isDirectory: data.isDirectory,
      sourceKind: data.sourceKind === 'local' ? 'local' : 'remote'
    };
  } catch {
    return undefined;
  }
}

function parsePlainClipboardPath(raw: string): string | undefined {
  const text = String(raw || '').trim();
  if (!text || text.startsWith(REMOTIX_CLIPBOARD_PREFIX)) {
    return undefined;
  }

  // Accept first line only to avoid accidental multiline clipboard contents.
  const firstLine = text.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  if (!firstLine) {
    return undefined;
  }

  return firstLine;
}

async function buildClipboardFromPlainPath(pathText: string, connectionLabel: string): Promise<RemoteClipboard | undefined> {
  const fs = await import('fs');
  const sourcePath = pathText.trim();
  if (!sourcePath) {
    return undefined;
  }

  const parts = sourcePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const sourceName = parts.length > 0 ? parts[parts.length - 1] : sourcePath;

  let isDirectory = /\/$/.test(sourcePath);
  let sourceKind: 'remote' | 'local' = 'remote';

  try {
    const stat = fs.statSync(sourcePath);
    sourceKind = 'local';
    isDirectory = stat.isDirectory();
  } catch {
  }

  if (!isDirectory) {
    if (sourceKind === 'remote') {
      const picked = await vscode.window.showQuickPick(
        [
          { label: '$(file) File', value: 'file' },
          { label: '$(folder) Folder', value: 'folder' }
        ],
        { placeHolder: 'Clipboard path type' }
      );
      if (!picked) {
        return undefined;
      }
      isDirectory = picked.value === 'folder';
    }
  }

  return {
    connectionLabel,
    sourcePath,
    sourceName,
    isDirectory,
    sourceKind
  };
}

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

function getParentPath(path: string): string {
  const normalized = String(path || '.').replace(/\\/g, '/').replace(/\/+$/g, '');
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

function joinRemotePath(parent: string, childName: string): string {
  const safeChild = String(childName || '').replace(/^\/+/, '');
  if (!safeChild) {
    return parent || '.';
  }
  if (!parent || parent === '.') {
    return safeChild;
  }
  if (parent === '/') {
    return `/${safeChild}`;
  }
  return `${parent.replace(/\/+$/g, '')}/${safeChild}`;
}

function normalizePathForCompare(path: string): string {
  const normalized = String(path || '.').replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!normalized || normalized === '.') {
    return '.';
  }
  return normalized;
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
      await vscode.env.clipboard.writeText(serializeRemoteClipboard(remoteClipboard));
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
      const systemClipboard = parseRemoteClipboard(rawClipboard);
      if (systemClipboard) {
        remoteClipboard = systemClipboard;
      } else {
        const plainPath = parsePlainClipboardPath(rawClipboard);
        if (plainPath) {
          const plainClipboard = await buildClipboardFromPlainPath(plainPath, connection.label);
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
    const destinationFolder = isDirectoryItem(item) ? itemPath : getParentPath(itemPath);
    const sourceParentFolder = getParentPath(remoteClipboard.sourcePath);
    const sameFolder = normalizePathForCompare(sourceParentFolder) === normalizePathForCompare(destinationFolder);

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

    const targetPath = joinRemotePath(destinationFolder, targetName);

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
