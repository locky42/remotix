import { RemotePathHelper } from './RemotePathHelper';

export class RemoteRefreshHelper {
  public static refreshRemoteFolder(
    treeDataProvider: any,
    connectionLabel: string,
    remotePath: string,
    protocol: 'ssh' | 'ftp'
  ): void {
    treeDataProvider.refreshRemoteFolder(
      connectionLabel,
      RemotePathHelper.normalizeRemotePath(remotePath),
      protocol
    );
  }
}
