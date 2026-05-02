import { RemotePathHelper } from './RemotePathHelper';

export class RemoteCrudDialogHelper {
  public static getRemotePath(item: any): string | undefined {
    const path = String(item?.sshPath || item?.ftpPath || '').trim();
    return path || undefined;
  }

  public static isDirectoryItem(item: any): boolean {
    return item?.contextValue === 'ssh-folder' || item?.contextValue === 'ftp-folder';
  }

  public static buildChildPath(basePath: string, item: any, childName: string): string {
    if (this.isDirectoryItem(item)) {
      return (basePath.endsWith('/') ? basePath : `${basePath}/`) + childName;
    }
    return `${RemotePathHelper.getParentRemotePath(basePath)}/${childName}`;
  }

  public static getRefreshPath(item: any, sourcePath: string): string {
    return this.isDirectoryItem(item)
      ? sourcePath
      : RemotePathHelper.getParentRemotePath(sourcePath);
  }

  public static getItemLabel(item: any): string {
    if (typeof item?.label === 'string') {
      return item.label;
    }
    if (item?.label && typeof item.label.label === 'string') {
      return item.label.label;
    }
    return String(item?.label || '');
  }

  public static buildRenamedPath(oldPath: string, newName: string): string {
    return oldPath.replace(/[^/]+$/, newName);
  }
}
