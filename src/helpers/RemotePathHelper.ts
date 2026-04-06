export class RemotePathHelper {
  static normalizeRemotePath(remotePath?: string): string {
    const normalized = String(remotePath || '.').replace(/\\/g, '/').trim();
    return normalized.length > 0 ? normalized : '.';
  }

  static normalizeAbsolutePath(remotePath?: string): string {
    const normalized = RemotePathHelper.normalizeRemotePath(remotePath).replace(/\/+/g, '/');
    if (!normalized || normalized === '.' || normalized === '/') {
      return '/';
    }
    const absolute = normalized.startsWith('/') ? normalized : `/${normalized}`;
    return absolute.replace(/\/+$/g, '') || '/';
  }

  static shouldAutoExpandDirectory(currentPath: string, folderPath: string): boolean {
    const normalizedCurrentPath = RemotePathHelper.normalizeAbsolutePath(currentPath);
    const normalizedFolderPath = RemotePathHelper.normalizeAbsolutePath(folderPath);
    return normalizedCurrentPath === normalizedFolderPath || normalizedCurrentPath.startsWith(`${normalizedFolderPath}/`);
  }

  static async resolveSftpInitialPath(
    sftp: any,
    currentInitialPath: string,
    onResolved?: (resolvedPath: string) => void
  ): Promise<string> {
    if (RemotePathHelper.normalizeAbsolutePath(currentInitialPath) !== '/') {
      return RemotePathHelper.normalizeAbsolutePath(currentInitialPath);
    }

    return await new Promise<string>((resolve) => {
      sftp.realpath('.', (_err: Error | undefined, absPath: string) => {
        const resolvedPath = absPath ? RemotePathHelper.normalizeAbsolutePath(absPath) : '/';
        if (onResolved) {
          onResolved(resolvedPath);
        }
        resolve(resolvedPath);
      });
    });
  }
}
