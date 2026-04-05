import { Container } from './Container';
import { LoggerService } from './LoggerService';
import { ConnectionManager } from './ConnectionManager';
import { createRemoteService } from '../factories/RemoteServiceFactory';

export class RemoteServiceProvider {
  private remoteServiceCache: Record<string, any> = {};

  async getRemoteService(label: string): Promise<any> {
    let remoteService = this.remoteServiceCache[label];
    if (!remoteService) {
      LoggerService.log(`[RemoteServiceProvider][DEBUG] Creating new remoteService for ${label}`);
      const connectionManager = Container.get('connectionManager') as ConnectionManager;
      const connection = connectionManager.getByLabel?.(label);
      if (!connection) {
        LoggerService.log(`[RemoteServiceProvider][DEBUG] Connection not found for label: ${label}`);
        return null;
      }
      remoteService = createRemoteService(connection);
      this.remoteServiceCache[label] = remoteService;
    } else {
      LoggerService.log(`[RemoteServiceProvider][DEBUG] Using cached remoteService for ${label}`);
    }
    return remoteService;
  }

  clearCache(label: string) {
    if (this.remoteServiceCache && label in this.remoteServiceCache) {
      // Try to close FTP session if possible
      try {
        const { SessionProvider } = require('./SessionProvider');
        SessionProvider.closeSession(label);
      } catch (e) {}
      delete this.remoteServiceCache[label];
    }
  }
}
