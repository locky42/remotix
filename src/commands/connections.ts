import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Container } from '../services/Container';
import { getAddConnectionHtml } from '../ui/webview';
import { LangService } from '../services/LangService';
import { ConfigService } from '../services/ConfigService';
import { TreeDataProvider } from '../ui/TreeDataProvider';

export function registerConnectionCommands(saveConnection: Function) {
  const context = Container.get('extensionContext') as vscode.ExtensionContext;
  const treeDataProvider = Container.get('treeDataProvider') as TreeDataProvider;

  context.subscriptions.push(vscode.commands.registerCommand('remotix.importFileZilla', async () => {
    try {
      const defaultPaths = [
        path.join(process.env.HOME || process.env.USERPROFILE || '.', '.config', 'filezilla', 'sitemanager.xml'),
        path.join(process.env.HOME || process.env.USERPROFILE || '.', 'AppData', 'Roaming', 'FileZilla', 'sitemanager.xml')
      ];
      let filePath = defaultPaths.find(p => fs.existsSync(p));
      if (!filePath) {
        const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          openLabel: LangService.t('chooseSitemanager'),
          defaultUri: vscode.Uri.file(homeDir)
        });
        if (!uris || uris.length === 0) return;
        filePath = uris[0].fsPath;
      }
      if (!fs.existsSync(filePath)) {
        vscode.window.showErrorMessage(LangService.t('fileNotFound', { file: filePath }));
        return;
      }
      const xmlContent = fs.readFileSync(filePath, 'utf8');
      const getTag = (block: string, tag: string): string => {
        let cleanBlock = block.replace(/\r?\n|\r|\t/g, '').replace(/>\s+</g, '><').replace(/\s{2,}/g, ' ');
        let re = new RegExp(`<\s*${tag}\s*[^>]*>([\s\S]*?)<\s*\/\s*${tag}\s*>`, 'ig');
        let m = re.exec(cleanBlock);
        if (m) return m[1].trim();
        const lowerBlock = cleanBlock.toLowerCase();
        const lowerTag = tag.toLowerCase();
        re = new RegExp(`<\s*${lowerTag}\s*[^>]*>([\s\S]*?)<\s*\/\s*${lowerTag}\s*>`, 'ig');
        m = re.exec(lowerBlock);
        if (m) return m[1].trim();
        const open = `<${tag}>`;
        const close = `</${tag}>`;
        const i1 = cleanBlock.indexOf(open);
        const i2 = cleanBlock.indexOf(close);
        if (i1 !== -1 && i2 !== -1 && i2 > i1) {
          return cleanBlock.substring(i1 + open.length, i2).trim();
        }
        return '';
      };
      const serverBlocks: string[] = [];
      const findServers = (xml: string) => {
        const serverRe = /(<Server>[\s\S]*?<\/Server>)/g;
        let m: RegExpExecArray | null;
        while ((m = serverRe.exec(xml))) {
          serverBlocks.push(m[1]);
        }
        const folderRe = /<Folder[\s\S]*?>([\s\S]*?)<\/Folder>/g;
        let f: RegExpExecArray | null;
        while ((f = folderRe.exec(xml))) {
          findServers(f[1]);
        }
      };
      const serversBlock = (xmlContent.match(/<Servers>([\s\S]*?)<\/Servers>/) || [])[1] || '';
      findServers(serversBlock);
      const connections = [];
      for (const block of serverBlocks) {
        const host = (getTag(block, 'Host') || '').trim();
        const protocol = (getTag(block, 'Protocol') || '').trim();
        if (!host || !protocol) {
          continue;
        }
        const port = getTag(block, 'Port') || (protocol === '0' ? '21' : '22');
        const user = getTag(block, 'User');
        let pass = getTag(block, 'Pass');
        const passTagMatch = block.match(/<Pass([^>]*)>([\s\S]*?)<\/Pass>/i);
        if (passTagMatch) {
          const attrs = passTagMatch[1] || '';
          const value = passTagMatch[2] || '';
          if (/encoding\s*=\s*"base64"/i.test(attrs)) {
            try { pass = Buffer.from(value, 'base64').toString('utf8'); } catch { pass = value; }
          } else {
            pass = value;
          }
        }
        const name = getTag(block, 'Name') || host;
        let type: 'ftp' | 'ssh' = 'ftp';
        if (protocol.trim() === '1') type = 'ssh';
        if (type === 'ftp') {
          connections.push({
            label: `FTP: ${name}`,
            type: 'ftp',
            host,
            port,
            user,
            password: pass || ''
          });
        } else if (type === 'ssh') {
          const keyfile = getTag(block, 'Keyfile');
          connections.push({
            label: `SSH: ${name}`,
            type: 'ssh',
            host,
            port,
            user,
            password: pass || '',
            authMethod: keyfile ? 'privateKey' : (pass ? 'password' : undefined),
            authFile: keyfile || undefined
          });
        }
      }
      if (!connections.length) {
        vscode.window.showWarningMessage(LangService.t('noFtpConnections'));
        return;
      }
      const picks = await vscode.window.showQuickPick(
        connections.map(c => ({
          label: c.label,
          picked: true,
          detail: `${c.user || ''}@${c.host || ''}:${c.port || ''}`,
          type: c.type
        })),
        { canPickMany: true, placeHolder: LangService.t('chooseConnectionsToImport') }
      );
      if (!picks || picks.length === 0) return;
      const toImport = connections.filter(c => picks.find(p => p.label === c.label && p.type === c.type));
      const config = ConfigService.getGlobalConfig();
      let added = 0;
      for (const connection of toImport) {
        const exists = config.connections.some(
          (c: any) => c.host === connection.host && c.port === connection.port && c.user === connection.user && c.type === (connection.type as 'ftp' | 'ssh')
        );
        if (!exists) {
          config.connections.push({ ...connection, type: connection.type as 'ftp' | 'ssh', port: parseInt(connection.port, 10) });
          added++;
        }
      }
      ConfigService.saveGlobalConfig(config);
      if (added > 0) {
        if (Array.isArray((treeDataProvider as any).connections)) {
          (treeDataProvider as any).connections = config.connections.slice();
        }
        treeDataProvider.refresh();
      }
      vscode.window.showInformationMessage(LangService.t('importedConnectionsFz', { count: added }));
    } catch (e) {
      vscode.window.showErrorMessage(LangService.t('importErrorFz', { error: (e instanceof Error ? e.message : String(e)) }));
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.importSshConfig', async () => {
    try {
      const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: LangService.t('chooseSshConfig'),
        defaultUri: vscode.Uri.file(homeDir)
      });
      if (!uris || uris.length === 0) return;
      const sshConfigPath = uris[0].fsPath;
      if (!fs.existsSync(sshConfigPath)) {
        vscode.window.showErrorMessage(LangService.t('fileNotFound', { file: sshConfigPath }));
        return;
      }
      const content = fs.readFileSync(sshConfigPath, 'utf8');
      const connections = [];
      let current: any = null;
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('Host ')) {
          if (current) connections.push(current);
          current = { label: 'SSH: ' + trimmed.slice(5).trim(), type: 'ssh' };
        } else if (current && trimmed) {
          const [key, ...rest] = trimmed.split(/\s+/);
          const value = rest.join(' ');
          if (/^Host(Name)?$/i.test(key)) current.host = value;
          if (/^User$/i.test(key)) current.user = value;
          if (/^Port$/i.test(key)) current.port = value;
          if (/^IdentityFile$/i.test(key)) {
            current.authMethod = 'privateKey';
            current.authFile = value.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '.');
          }
        }
      }
      if (current) connections.push(current);
      if (!connections.length) {
        vscode.window.showWarningMessage(LangService.t('noConnectionsFound'));
        return;
      }
      const picks = await vscode.window.showQuickPick(
        connections.map(c => ({ label: c.label, picked: true, detail: `${c.user || ''}@${c.host || ''}:${c.port || ''}` })),
        { canPickMany: true, placeHolder: LangService.t('chooseConnectionsToImport') }
      );
      if (!picks || picks.length === 0) return;
      const toImport = connections.filter(c => picks.find(p => p.label === c.label));
      const config = ConfigService.getGlobalConfig();
      for (const connection of toImport) {
        config.connections.push(connection);
        treeDataProvider.addConnection(connection);
      }
      ConfigService.saveGlobalConfig(config);
      vscode.window.showInformationMessage(LangService.t('importedConnections', { count: toImport.length, source: sshConfigPath }));
    } catch (e) {
      vscode.window.showErrorMessage(LangService.t('importErrorSsh', { error: (e instanceof Error ? e.message : String(e)) }));
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.addConnection', async () => {
    const panel = vscode.window.createWebviewPanel(
      'remotixAddConnection',
      LangService.t('addConnection'),
      vscode.ViewColumn.One,
      { enableScripts: true }
    );
    panel.webview.html = getAddConnectionHtml();
    panel.webview.onDidReceiveMessage(
      async (message) => {
        if (message.command === 'add') {
          const connection = message.data;
          saveConnection(connection, !!connection.global);
          treeDataProvider.addConnection(connection);
          panel.dispose();
        } else if (message.command === 'cancel') {
          panel.dispose();
        } else if (message.command === 'pickFile') {
          const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false });
          if (uris && uris.length > 0) {
            panel.webview.postMessage({ command: 'setFile', path: uris[0].fsPath });
          }
        }
      },
      undefined,
      context.subscriptions
    );
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.editConnection', async (item: vscode.TreeItem) => {
    const connection = treeDataProvider.getConnectionByLabel(item.label as string);
    if (!connection) return;
    const panel = vscode.window.createWebviewPanel(
      'remotixEditConnection',
      LangService.t('editConnection'),
      vscode.ViewColumn.One,
      { enableScripts: true }
    );
    panel.webview.html = getAddConnectionHtml(connection);
    panel.webview.onDidReceiveMessage(
      (message) => {
        if (message.command === 'add') {
          Object.assign(connection, message.data);
          connection.label = `${connection.type.toUpperCase()}: ${connection.label}`;
          connection.detail = `${connection.user}@${connection.host}:${connection.port}`;
          treeDataProvider.refresh();
          panel.dispose();
        } else if (message.command === 'cancel') {
          panel.dispose();
        } else if (message.command === 'pickFile') {
          vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false }).then(uris => {
            if (uris && uris.length > 0) {
              panel.webview.postMessage({ command: 'setFile', path: uris[0].fsPath });
            }
          });
        }
      },
      undefined,
      context.subscriptions
    );
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.deleteConnection', async (item: vscode.TreeItem) => {
    const label = item.label as string;
    const connection = treeDataProvider.getConnectionByLabel(label);
    if (!connection) return;
    const confirm = await vscode.window.showWarningMessage(
      LangService.t('confirmDeleteConnection', { label }),
      { modal: true },
      LangService.t('delete')
    );
    if (confirm !== LangService.t('delete')) return;
    // Remove from global config
    const globalConfig = ConfigService.getGlobalConfig();
    const idx = globalConfig.connections.findIndex((c: any) => c.label === label);
    if (idx !== -1) {
      globalConfig.connections.splice(idx, 1);
      ConfigService.saveGlobalConfig(globalConfig);
    }
    // Remove from project config
    const projectConfig = ConfigService.getProjectConfig();
    const idx2 = projectConfig.connections.findIndex((c: any) => c.label === label);
    if (idx2 !== -1) {
      projectConfig.connections.splice(idx2, 1);
      ConfigService.saveProjectConfig(projectConfig);
    }
    treeDataProvider.removeConnection(label);
    vscode.window.showInformationMessage(LangService.t('connectionDeleted', { label }));
  }));
}
