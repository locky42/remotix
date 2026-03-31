import * as vscode from 'vscode';
import { LoggerService } from '../services/LoggerService';
import { LangService } from '../services/LangService';
import { RemoteService } from '../services/Remote/RemoteService';
import { FtpRemoteService } from '../services/Remote/FtpRemoteService';
import { SshRemoteService } from '../services/Remote/SshRemoteService';

export function createRemoteService(item: any, treeDataProvider: any): RemoteService | undefined {
  const connectionLabel = item?.connectionLabel || item?.label;
  const treeDataProviderAny = treeDataProvider as any;
  const allConnections = treeDataProviderAny.connectionManager?.getAll?.() || [];
  const available = allConnections.map((c: any) => c.label) || [];
  LoggerService.log(`[createRemoteService] connectionLabel: ${connectionLabel}`);
  LoggerService.logObject('[createRemoteService] Item', item);
  LoggerService.log(`[createRemoteService] Available labels: [${available.join(', ')}]`);
  LoggerService.log(`[createRemoteService] All connections: ${JSON.stringify(allConnections, null, 2)}`);
  const conn = treeDataProviderAny.getConnectionByLabel(connectionLabel);
  LoggerService.log(`[createRemoteService] Found connection: ${JSON.stringify(conn, null, 2)}`);
  if (!conn) {
    if (typeof vscode !== 'undefined') {
      vscode.window.showErrorMessage(LangService.t('connectionNotFound'));
    }
    LoggerService.log(`[createRemoteService] Connection not found: ${connectionLabel}`);
    LoggerService.show();
    return undefined;
  }
  if (conn.type === 'ftp') {
    return new FtpRemoteService(conn);
  } else {
    return new SshRemoteService(conn);
  }
}
