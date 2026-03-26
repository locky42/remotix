import * as fs from 'fs';
import * as path from 'path';
import { RemotixConfig } from './types';
import * as vscode from 'vscode';

export function getGlobalConfig(context: vscode.ExtensionContext): RemotixConfig {
  const configPath = getGlobalConfigPath(context);
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  return { connections: [] };
}

export function saveGlobalConfig(context: vscode.ExtensionContext, config: RemotixConfig) {
  const configPath = getGlobalConfigPath(context);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function getGlobalConfigPath(context: vscode.ExtensionContext) {
  const dir = context.globalStorageUri.fsPath;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'remotix-connections.json');
}

export function getProjectConfig(): RemotixConfig {
  const configPath = getProjectConfigPath();
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  return { connections: [] };
}

export function saveProjectConfig(config: RemotixConfig) {
  const configPath = getProjectConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function getProjectConfigPath() {
  const wsFolders = vscode.workspace.workspaceFolders;
  if (!wsFolders || wsFolders.length === 0) return '.remotix-connections.json';
  return path.join(wsFolders[0].uri.fsPath, '.remotix-connections.json');
}
