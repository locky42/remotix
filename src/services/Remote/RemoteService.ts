import * as vscode from 'vscode';

export interface RemoteService {
  download(item: any, localTarget: string): Promise<void>;
  downloadDir(item: any, localTarget: string): Promise<void>;
  upload(localPath: string, remotePath: string): Promise<void>;
  uploadDir(localDir: string, remoteDir: string): Promise<void>;
  createFile(remotePath: string): Promise<void>;
  createFolder(remoteDir: string): Promise<void>;
  rename(oldRemotePath: string, newRemotePath: string): Promise<void>;
  deleteFile(remotePath: string): Promise<void>;
  deleteDir(remoteDir: string): Promise<void>;
  /**
   * Handles all UI, checks, and error handling for download command.
   * Accepts treeDataProvider for connection lookup.
   */
  downloadWithDialogs?(item: any, treeDataProvider: any): Promise<void>;
  uploadWithDialogs?(item: any, treeDataProvider: any): Promise<void>;
  editFileWithDialogs?(item: any, treeDataProvider: any): Promise<void>;
  renameWithDialogs?(item: any, treeDataProvider: any): Promise<void>;
  createFolderWithDialogs?(item: any, treeDataProvider: any): Promise<void>;
  createFileWithDialogs?(item: any, treeDataProvider: any): Promise<void>;
  deleteFileWithDialogs?(item: any, treeDataProvider: any): Promise<void>;
  moveItems?(items: {sshPath: string, connectionLabel: string}[], targetFolder: string, treeDataProvider: any): Promise<void>;
  listDirectory?(conn: any, path: string, connectionLabel: string): Promise<vscode.TreeItem[]>;
}
