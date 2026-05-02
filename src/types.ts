import { Client as SshClient } from 'ssh2';
import { Client as FtpClient } from "basic-ftp";

export type PermissionApplyTarget = 'all' | 'files' | 'directories';

export type PermissionChangeOptions = {
  mode: string;
  recursive: boolean;
  applyTo: PermissionApplyTarget;
};

export type PermissionStatus = 'no-read' | 'read-only' | undefined;
export type RemoteBaseIcon = 'folder' | 'file' | 'file-code' | 'file-media' | 'file-zip' | 'lock-file';
export type RemoteSession = SshClient | FtpClient;

export type RemoteClipboard = {
  connectionLabel: string;
  sourcePath: string;
  sourceName: string;
  isDirectory: boolean;
  sourceKind?: 'remote' | 'local';
};

export type RemoteFileEditOptions = {
  remotePath: string;
  host?: string;
  user?: string;
  tmpFolderPrefix: string;
  downloadToTemp: (tmpFile: string) => Promise<void>;
  uploadFromTemp: (tmpFile: string) => Promise<void>;
  logCleanupError?: (error: unknown) => void;
};

export interface ConnectionItem {
  label: string;
  type: 'ssh' | 'ftp';
  detail?: string;
  port?: number;
  user?: string;
  password?: string;
  authMethod?: string;
  authFile?: string;
  host?: string;
  client?: FtpClient | SshClient;
}

export interface RemotixConfig {
  connections: ConnectionItem[];
}
