import * as vscode from 'vscode';

export class RemoteTreeViewHelper {
  static buildVirtualPathTree(
    initialPath: string,
    connectionLabel: string,
    remotePathField: 'sshPath' | 'ftpPath',
    folderContextValue: string
  ): vscode.TreeItem[] {
    const parts = String(initialPath || '/').split('/').filter((p) => p);

    const rootItem = new vscode.TreeItem('/', vscode.TreeItemCollapsibleState.Expanded);
    (rootItem as any)[remotePathField] = '/';
    (rootItem as any).connectionLabel = connectionLabel;
    rootItem.contextValue = folderContextValue;
    rootItem.iconPath = new vscode.ThemeIcon('folder');

    let currentParent = rootItem;
    let currentPath = '';

    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      currentPath += `/${part}`;

      const item = new vscode.TreeItem(part, vscode.TreeItemCollapsibleState.Expanded);
      (item as any)[remotePathField] = currentPath;
      (item as any).connectionLabel = connectionLabel;
      item.contextValue = folderContextValue;
      item.iconPath = new vscode.ThemeIcon('folder');

      (currentParent as any).children = [item];

      if (!isLast) {
        currentParent = item;
      } else {
        delete (item as any).children;
      }
    }

    return [rootItem];
  }

  static buildPermissionDeniedVirtualChild(
    initialPath: string,
    requestPath: string,
    connectionLabel: string,
    remotePathField: 'sshPath' | 'ftpPath',
    folderContextValue: string
  ): vscode.TreeItem[] | undefined {
    const parts = String(initialPath || '/').split('/').filter((p) => p);
    const currentParts = requestPath === '/' ? [] : String(requestPath || '').split('/').filter((p) => p);
    const nextPart = parts[currentParts.length];

    if (!nextPart) {
      return undefined;
    }

    const nextPath = requestPath === '/' ? `/${nextPart}` : `${requestPath}/${nextPart}`;
    const virtualItem = new vscode.TreeItem(nextPart, vscode.TreeItemCollapsibleState.Expanded);
    (virtualItem as any)[remotePathField] = nextPath;
    (virtualItem as any).connectionLabel = connectionLabel;
    virtualItem.contextValue = folderContextValue;
    virtualItem.iconPath = new vscode.ThemeIcon('folder');
    return [virtualItem];
  }

  static sortTreeItems(items: vscode.TreeItem[], locale: string = 'uk'): void {
    items.sort((a, b) => {
      const isADir = a.collapsibleState !== vscode.TreeItemCollapsibleState.None;
      const isBDir = b.collapsibleState !== vscode.TreeItemCollapsibleState.None;
      if (isADir !== isBDir) {
        return isADir ? -1 : 1;
      }
      return String(a.label || '').localeCompare(String(b.label || ''), locale, { sensitivity: 'base' });
    });
  }
}
