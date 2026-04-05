import * as vscode from 'vscode';
import { ConnectionItem } from '../types';
import { Container } from '../services/Container';
import { LangService } from '../services/LangService';
import { TreeDataProvider } from '../ui/TreeDataProvider';
import { LoggerService } from '../services/LoggerService';
import { RemoteService } from '../services/Remote/RemoteService';
import { FtpRemoteService } from '../services/Remote/FtpRemoteService';
import { SshRemoteService } from '../services/Remote/SshRemoteService';

export function createRemoteService(connection: ConnectionItem): RemoteService {
  const treeDataProvider = Container.get('treeDataProvider') as TreeDataProvider;
  const treeDataProviderAny = treeDataProvider as any;
  const allConnections = treeDataProviderAny.connectionManager?.getAll?.() || [];
  LoggerService.log(`[createRemoteService] Request: label=${connection.label}, type=${connection.type}, host=${connection.host}, port=${connection.port}`);
  LoggerService.log(`[createRemoteService] Available connections count: ${allConnections.length}`);
  const client = treeDataProviderAny.getConnectionByLabel(connection.label);
  LoggerService.log(`[createRemoteService] Found by label: ${client ? 'yes' : 'no'}`);
  if (!client) {
    if (typeof vscode !== 'undefined') {
      vscode.window.showErrorMessage(LangService.t('connectionNotFound'));
    }
    LoggerService.log(`[createRemoteService] Connection not found: ${connection.label}`);
    LoggerService.show();
    throw new Error(LangService.t('connectionNotFound'));
  }
  if (connection.type === 'ftp') {
    return new FtpRemoteService(connection);
  } else {
    return new SshRemoteService(connection);
  }
}
