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

  static getParentRemotePath(remotePath?: string): string {
    const normalized = RemotePathHelper.normalizeRemotePath(remotePath).replace(/\/+$/g, '');
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

  static toAbsoluteRemotePath(remotePath?: string, initialPath?: string): string {
    const normalizedInput = String(remotePath || '.').replace(/\\/g, '/').trim();
    if (!normalizedInput || normalizedInput === '.') {
      return String(initialPath || '/').replace(/\/+/g, '/');
    }
    if (normalizedInput.startsWith('/')) {
      return normalizedInput.replace(/\/+/g, '/');
    }
    const base = String(initialPath || '/').replace(/\/$/, '');
    return `${base}/${normalizedInput}`.replace(/\/+/g, '/');
  }

  static getRemoteLeafName(rawName?: string): string {
    const normalized = String(rawName || '').replace(/\\/g, '/').trim();
    if (!normalized) {
      return '';
    }
    const parts = normalized.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : normalized;
  }

  static joinRemotePath(parent: string, childName: string): string {
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

  static normalizePathForCompare(path: string): string {
    const normalized = String(path || '.').replace(/\\/g, '/').replace(/\/+$/g, '');
    if (!normalized || normalized === '.') {
      return '.';
    }
    return normalized;
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
