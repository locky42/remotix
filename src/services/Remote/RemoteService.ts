import * as vscode from 'vscode';

export interface RemoteService {
  connect(): Promise<any>;
  listDirectory?(path: string): Promise<vscode.TreeItem[]>;

  downloadWithDialogs?(item: any): Promise<void>;
  download(item: any, localTarget: string): Promise<void>;
  downloadDir(item: any, localTarget: string): Promise<void>;

  uploadWithDialogs?(item: any): Promise<void>;
  upload(localPath: string, remotePath: string): Promise<void>;
  uploadDir(localDir: string, remoteDir: string): Promise<void>;

  createFileWithDialogs?(item: any): Promise<void>;
  createFile(remotePath: string): Promise<void>;

  createFolderWithDialogs?(item: any): Promise<void>;
  createFolder(remoteDir: string): Promise<void>;

  deleteFileWithDialogs?(item: any): Promise<void>;
  deleteFile(remotePath: string): Promise<void>;
  deleteDir(remoteDir: string): Promise<void>;

  renameWithDialogs?(item: any): Promise<void>;
  rename(oldRemotePath: string, newRemotePath: string): Promise<void>;
  
  editFileWithDialogs?(item: any): Promise<void>;
  
  moveItems?(items: {sshPath: string}[], targetFolder: string, treeDataProvider: any): Promise<void>;
}
