import * as vscode from 'vscode';
import { ConnectionItem } from '../types';
import { Container } from '../services/Container';
import { LangService } from '../services/LangService';
import { RemoteService } from '../services/Remote/RemoteService';
import { ConnectionManager } from '../services/ConnectionManager';
import { RemoteServiceProvider } from '../services/RemoteServiceProvider';

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
}
