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
