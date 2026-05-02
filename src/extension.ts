import * as vscode from 'vscode';
import { ConnectionItem } from './types';
import { Container } from './services/Container';
import { registerUiCommands } from './commands/ui';
import { LangService } from './services/LangService';
import { TreeDataProvider } from './ui/TreeDataProvider';
import { ConfigService } from './services/ConfigService';
import { registerFileFolderCommands } from './commands/files';
import { ConnectionManager } from './services/ConnectionManager';
import { registerConnectionCommands } from './commands/connections';
import { RemoteServiceProvider } from './services/RemoteServiceProvider';
import { RemoteFileEditService } from './services/RemoteFileEditService';

function resolveLangFromSettings(): 'en' | 'uk' {
  const configured = vscode.workspace.getConfiguration('remotix').get<string>('language', 'auto');
  if (configured === 'en' || configured === 'uk') {
    return configured;
  }
  const uiLang = vscode.env.language.toLowerCase();
  return uiLang.startsWith('uk') ? 'uk' : 'en';
}

async function migrateLegacyLanguageSetting(): Promise<void> {
  const config = vscode.workspace.getConfiguration('remotix');
  const configured = config.get<string>('language', 'auto');
  const normalized = String(configured || '').trim().toLowerCase();

  let migrated: 'auto' | 'en' | 'uk' | undefined;
  if (normalized === 'ukrainian' || normalized === 'ua' || normalized === 'uk-ua') {
    migrated = 'uk';
  } else if (normalized === 'english' || normalized === 'en-us' || normalized === 'en-gb') {
    migrated = 'en';
  }

  if (migrated && migrated !== configured) {
    await config.update('language', migrated, vscode.ConfigurationTarget.Global);
  }
}

async function saveConnection(connection: ConnectionItem, global: boolean) {
  // Store password in SecretStorage if present
  if (connection.password) {
    await ConfigService.storePassword(connection.label, connection.password);
    // Remove password before saving config
    delete connection.password;
  }
  if (global) {
    const config = ConfigService.getGlobalConfig();
    config.connections.push(connection);
    ConfigService.saveGlobalConfig(config);
  } else {
    const config = ConfigService.getProjectConfig();
    config.connections.push(connection);
    ConfigService.saveProjectConfig(config);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  migrateLegacyLanguageSetting()
    .catch(() => {})
    .finally(() => {
      LangService.setLang(resolveLangFromSettings());
    });

  Container.set('extensionContext', context);

  await ConfigService.migrateLegacyPasswordsFromConfigFiles();

  const connectionManager = new ConnectionManager();
  Container.set('connectionManager', connectionManager);
  const remoteServiceProvider = new RemoteServiceProvider();
  Container.set('remoteServiceProvider', remoteServiceProvider);
  const remoteFileEditService = new RemoteFileEditService();
  Container.set('remoteFileEditService', remoteFileEditService);
  const treeDataProvider = new TreeDataProvider();
  // Patch: load passwords from SecretStorage for all connections
  const patchConnectionsWithPasswords = async () => {
    const all = connectionManager.getAll();
    for (const conn of all) {
      if (conn && !conn.password) {
        conn.password = await ConfigService.getPassword(conn.label);
      }
    }
  };
  patchConnectionsWithPasswords();
  Container.set('treeDataProvider', treeDataProvider);

  const treeView = vscode.window.createTreeView('remotixView', {
    treeDataProvider,
    dragAndDropController: treeDataProvider
  });
  context.subscriptions.push(treeView);

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('remotix.language')) {
      LangService.setLang(resolveLangFromSettings());
      treeDataProvider.refresh();
    }
  }));

  // Register file/folder operation commands in a separate module
  registerFileFolderCommands();

  // Register connection commands in a separate module
  registerConnectionCommands(saveConnection);

  // Register UI commands in a separate module
  registerUiCommands();

  context.subscriptions.push(vscode.commands.registerCommand('remotix.openSshTerminal', async (item: vscode.TreeItem) => {
    const connection = treeDataProvider.getConnectionByLabel(item.label as string);
    if (!connection || connection.type !== 'ssh') return;
    // Always fetch password from SecretStorage
    let password = connection.password;
    if (connection.authMethod === 'password') {
      password = await ConfigService.getPassword(connection.label);
    }
    let sshCmd = `ssh${connection.port ? ' -p ' + connection.port : ''}`;
    if (connection.authMethod === 'privateKey' && connection.authFile) {
      sshCmd += ` -i "${connection.authFile}"`;
    }
    sshCmd += ` ${connection.user}@${connection.host}`;
    if (connection.authMethod === 'password' && password) {
      const { execSync } = require('child_process');
      let sshpassExists = false;
      try {
        execSync('sshpass -V', { stdio: 'ignore' });
        sshpassExists = true;
      } catch {
        sshpassExists = false;
      }
      if (sshpassExists) {
        sshCmd = `sshpass -p '${password.replace(/'/g, "'\\''")}' ` + sshCmd;
      } else {
        vscode.window.showInformationMessage(LangService.t('sshpassNotFound'));
      }
    }
    const terminal = vscode.window.createTerminal({ name: connection.label });
    terminal.sendText(sshCmd);
    terminal.show();
  }));
}

export function deactivate() {}
