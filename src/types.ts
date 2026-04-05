import { Client as SshClient } from 'ssh2';
import { Client as FtpClient } from "basic-ftp";

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
