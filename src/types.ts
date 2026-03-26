export interface ConnectionItem {
  label: string;
  type: 'ssh' | 'ftp';
  detail?: string;
  port?: string;
  user?: string;
  password?: string;
  authMethod?: string;
  authFile?: string;
  host?: string;
}

export interface RemotixConfig {
  connections: ConnectionItem[];
}
