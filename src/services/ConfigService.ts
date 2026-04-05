import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Container } from './Container';
import { RemotixConfig } from '../types';

export class ConfigService {
  static getGlobalConfig(): RemotixConfig {
    const configPath = ConfigService.getGlobalConfigPath();
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    return { connections: [] };
  }

  static saveGlobalConfig(config: RemotixConfig) {
    const configPath = ConfigService.getGlobalConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  }

  private static getGlobalConfigPath() {
    const context = Container.get('extensionContext') as vscode.ExtensionContext;

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
