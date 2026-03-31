import * as vscode from 'vscode';
import { createRemoteService } from '../factories/RemoteServiceFactory';
import { LangService } from '../services/LangService';

export function registerFileFolderCommands(context: vscode.ExtensionContext, treeDataProvider: any) {
  context.subscriptions.push(vscode.commands.registerCommand('remotix.download', async (item: any) => {
    const service = createRemoteService(item, treeDataProvider);
    if (!service) {
      return;
    }
    // @ts-ignore
    await service.downloadWithDialogs(item, treeDataProvider);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.upload', async (item: any) => {
    const service = createRemoteService(item, treeDataProvider);
    if (!service || typeof service.uploadWithDialogs !== 'function') {
      vscode.window.showErrorMessage(LangService.t('uploadWithDialogsNotImplemented'));
      return;
    }
    await service.uploadWithDialogs(item, treeDataProvider);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.editFile', async (item: { label: string, sshPath?: string, ftpPath?: string, connectionLabel: string }) => {
    const service = createRemoteService(item, treeDataProvider);
    if (!service || typeof service.editFileWithDialogs !== 'function') {
      vscode.window.showErrorMessage(LangService.t('editFileWithDialogsNotImplemented'));
      return;
    }
    await service.editFileWithDialogs(item, treeDataProvider);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.rename', async (item: vscode.TreeItem) => {
    const service = createRemoteService(item, treeDataProvider);
    if (!service || typeof service.renameWithDialogs !== 'function') {
      vscode.window.showErrorMessage(LangService.t('renameWithDialogsNotImplemented'));
      return;
    }
    await service.renameWithDialogs(item, treeDataProvider);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.createFolder', async (item: any) => {
    const service = createRemoteService(item, treeDataProvider);
    if (!service || typeof service.createFolderWithDialogs !== 'function') {
      vscode.window.showErrorMessage(LangService.t('createFolderWithDialogsNotImplemented'));
      return;
    }
    await service.createFolderWithDialogs(item, treeDataProvider);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.createFile', async (item: any) => {
    const service = createRemoteService(item, treeDataProvider);
    if (!service || typeof service.createFileWithDialogs !== 'function') {
      vscode.window.showErrorMessage(LangService.t('createFileWithDialogsNotImplemented'));
      return;
    }
    await service.createFileWithDialogs(item, treeDataProvider);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.deleteFile', async (item: any) => {
    const service = createRemoteService(item, treeDataProvider);
    if (!service || typeof service.deleteFileWithDialogs !== 'function') {
      vscode.window.showErrorMessage(LangService.t('deleteFileWithDialogsNotImplemented'));
      return;
    }
    await service.deleteFileWithDialogs(item, treeDataProvider);
  }));
}
