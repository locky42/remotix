import * as fs from 'fs';
import * as path from 'path';
import { RemotixConfig } from '../types';
import * as vscode from 'vscode';

export class ConfigService {
  static getGlobalConfig(context: vscode.ExtensionContext): RemotixConfig {
    const configPath = ConfigService.getGlobalConfigPath(context);
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    return { connections: [] };
  }

  static saveGlobalConfig(context: vscode.ExtensionContext, config: RemotixConfig) {
    const configPath = ConfigService.getGlobalConfigPath(context);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  }

  private static getGlobalConfigPath(context: vscode.ExtensionContext) {
    const dir = context.globalStorageUri.fsPath;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'remotix-connections.json');
  }

  static getProjectConfig(): RemotixConfig {
    const configPath = ConfigService.getProjectConfigPath();
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    return { connections: [] };
  }

  static saveProjectConfig(config: RemotixConfig) {
    const configPath = ConfigService.getProjectConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  }

  private static getProjectConfigPath() {
    const wsFolders = vscode.workspace.workspaceFolders;
    if (!wsFolders || wsFolders.length === 0) return '.remotix-connections.json';
    return path.join(wsFolders[0].uri.fsPath, '.remotix-connections.json');
  }
}
