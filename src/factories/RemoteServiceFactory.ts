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
  LoggerService.log(`Request: label=${connection.label}, type=${connection.type}, host=${connection.host}, port=${connection.port}`, 'CreateRemoteService', 'info');
  LoggerService.log(`Available connections count: ${allConnections.length}`, 'CreateRemoteService', 'info');
  const client = treeDataProviderAny.getConnectionByLabel(connection.label);
  LoggerService.log(`Found by label: ${client ? 'yes' : 'no'}`, 'CreateRemoteService', 'info');
  if (!client) {
    if (typeof vscode !== 'undefined') {
      vscode.window.showErrorMessage(LangService.t('connectionNotFound'));
    }
    LoggerService.log(`Connection not found: ${connection.label}`, 'CreateRemoteService', 'error');
    throw new Error(LangService.t('connectionNotFound'));
  }

  return connection.type === 'ftp' ? new FtpRemoteService(connection) : new SshRemoteService(connection);
}
