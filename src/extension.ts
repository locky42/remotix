import * as vscode from 'vscode';
import { LangService } from './services/LangService';
import { ConnectionItem } from './types';
import { TreeDataProvider } from './ui/TreeDataProvider';
import { ConfigService } from './services/ConfigService';
import { registerFileFolderCommands } from './commands/files';
import { registerConnectionCommands } from './commands/connections';
import { registerUiCommands } from './commands/ui';

function saveConnection(conn: ConnectionItem, global: boolean, context: vscode.ExtensionContext) {
  if (global) {
    const config = ConfigService.getGlobalConfig(context);
    config.connections.push(conn);
    ConfigService.saveGlobalConfig(context, config);
  } else {
    const config = ConfigService.getProjectConfig();
    config.connections.push(conn);
    ConfigService.saveProjectConfig(config);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const treeDataProvider = new TreeDataProvider(context);
  const treeView = vscode.window.createTreeView('remotixView', {
    treeDataProvider,
    dragAndDropController: treeDataProvider
  });
  context.subscriptions.push(treeView);

  // Register file/folder operation commands in a separate module
  registerFileFolderCommands(context, treeDataProvider);

  // Register connection commands in a separate module
  registerConnectionCommands(context, treeDataProvider, saveConnection);

  // Register UI commands in a separate module
  registerUiCommands(context, treeDataProvider);

  context.subscriptions.push(vscode.commands.registerCommand('remotix.openSshTerminal', async (item: vscode.TreeItem) => {
    const conn = treeDataProvider.getConnectionByLabel(item.label as string);
    if (!conn || conn.type !== 'ssh') return;
    let sshCmd = `ssh${conn.port ? ' -p ' + conn.port : ''}`;
    if (conn.authMethod === 'privateKey' && conn.authFile) {
      sshCmd += ` -i "${conn.authFile}"`;
    }
    sshCmd += ` ${conn.user}@${conn.host}`;
    if (conn.authMethod === 'password' && conn.password) {
      const { execSync } = require('child_process');
      let sshpassExists = false;
      try {
        execSync('sshpass -V', { stdio: 'ignore' });
        sshpassExists = true;
      } catch {
        sshpassExists = false;
      }
      if (sshpassExists) {
        sshCmd = `sshpass -p '${conn.password.replace(/'/g, "'\\''")}' ` + sshCmd;
      } else {
        vscode.window.showInformationMessage(LangService.t('sshpassNotFound'));
      }
    }
    const terminal = vscode.window.createTerminal({ name: conn.label });
    terminal.sendText(sshCmd);
    terminal.show();
  }));
}

export function deactivate() {}
