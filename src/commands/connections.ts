import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Container } from '../services/Container';
import { getAddConnectionHtml } from '../ui/webview';
import { LangService } from '../services/LangService';
import { ConfigService } from '../services/ConfigService';
import { TreeDataProvider } from '../ui/TreeDataProvider';
import { ConnectionManager } from '../services/ConnectionManager';
import { SessionProvider } from '../services/SessionProvider';
import { RemoteServiceProvider } from '../services/RemoteServiceProvider';

function normalizePortByType(rawPort: any, type: 'ftp' | 'ssh'): number {
  const parsed = Number.parseInt(String(rawPort ?? ''), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return type === 'ftp' ? 21 : 22;
}

function buildConnectionIdentity(connection: any): string {
  const type = String(connection?.type || '').trim().toLowerCase();
  const host = String(connection?.host || '').trim().toLowerCase();
  const user = String(connection?.user || '').trim().toLowerCase();
  const port = normalizePortByType(connection?.port, type === 'ftp' ? 'ftp' : 'ssh');
  return `${type}|${host}|${port}|${user}`;
}

export function registerConnectionCommands(saveConnection: Function) {
  const context = Container.get('extensionContext') as vscode.ExtensionContext;
  const treeDataProvider = Container.get('treeDataProvider') as TreeDataProvider;
  const connectionManager = Container.get('connectionManager') as ConnectionManager;

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

      const config = ConfigService.getGlobalConfig();
      const existingIdentityMap = new Map<string, number>(
        config.connections.map((c: any, index: number) => [buildConnectionIdentity(c), index])
      );

      const importCandidates = connections.map((connection, index) => {
        const normalizedConnection = {
          ...connection,
          type: connection.type as 'ftp' | 'ssh',
          port: normalizePortByType(connection.port, connection.type as 'ftp' | 'ssh')
        };
        const identity = buildConnectionIdentity(normalizedConnection);
        const exists = existingIdentityMap.has(identity);
        return {
          key: `${identity}|${index}`,
          connection,
          identity,
          exists
        };
      });

      const picks = await vscode.window.showQuickPick(
        importCandidates.map(candidate => ({
          label: candidate.connection.label,
          picked: !candidate.exists,
          detail: `${candidate.connection.user || ''}@${candidate.connection.host || ''}:${candidate.connection.port || ''}`,
          description: candidate.exists ? LangService.t('importRewriteHint') : undefined,
          key: candidate.key
        })),
        { canPickMany: true, placeHolder: LangService.t('chooseConnectionsToImport') }
      );
      if (!picks || picks.length === 0) return;
      const selectedKeys = new Set(picks.map((pick: any) => String((pick as any).key || '')));
      const selectedCandidates = importCandidates.filter(candidate => selectedKeys.has(candidate.key));

      let applied = 0;
      for (const candidate of selectedCandidates) {
        const connection = candidate.connection;
        const { password, ...connectionWithoutPassword } = connection;
        const normalizedConnection = {
          ...connectionWithoutPassword,
          type: connection.type as 'ftp' | 'ssh',
          port: normalizePortByType(connection.port, connection.type as 'ftp' | 'ssh')
        };

        const identity = buildConnectionIdentity(normalizedConnection);

        const existingIndex = existingIdentityMap.get(identity);
        if (existingIndex === undefined) {
          if (password) {
            await ConfigService.storePassword(connection.label, password);
          }
          config.connections.push(normalizedConnection);
          existingIdentityMap.set(identity, config.connections.length - 1);
          applied++;
          continue;
        }

        const existingConnection = config.connections[existingIndex] as any;
        const oldLabel = String(existingConnection?.label || '');
        const newLabel = String(normalizedConnection?.label || '');

        config.connections[existingIndex] = {
          ...existingConnection,
          ...normalizedConnection
        } as any;

        if (password) {
          await ConfigService.storePassword(newLabel, password);
          if (oldLabel && oldLabel !== newLabel) {
            await ConfigService.deletePassword(oldLabel);
          }
        } else if (oldLabel && newLabel && oldLabel !== newLabel) {
          await ConfigService.movePassword(oldLabel, newLabel);
        }

        applied++;
      }

      ConfigService.saveGlobalConfig(config);
      if (applied > 0) {
        connectionManager.load();
        treeDataProvider.refresh();
      }
      vscode.window.showInformationMessage(LangService.t('importedConnectionsFz', { count: applied }));
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

      const config = ConfigService.getGlobalConfig();
      const existingIdentityMap = new Map<string, number>(
        config.connections.map((c: any, index: number) => [buildConnectionIdentity(c), index])
      );

      const importCandidates = connections.map((connection, index) => {
        const normalizedConnection = {
          ...connection,
          type: 'ssh' as const,
          port: normalizePortByType(connection.port, 'ssh')
        };
        const identity = buildConnectionIdentity(normalizedConnection);
        const exists = existingIdentityMap.has(identity);
        return {
          key: `${identity}|${index}`,
          connection,
          identity,
          exists
        };
      });

      const picks = await vscode.window.showQuickPick(
        importCandidates.map(candidate => ({
          label: candidate.connection.label,
          picked: !candidate.exists,
          detail: `${candidate.connection.user || ''}@${candidate.connection.host || ''}:${candidate.connection.port || ''}`,
          description: candidate.exists ? LangService.t('importRewriteHint') : undefined,
          key: candidate.key
        })),
        { canPickMany: true, placeHolder: LangService.t('chooseConnectionsToImport') }
      );
      if (!picks || picks.length === 0) return;
      const selectedKeys = new Set(picks.map((pick: any) => String((pick as any).key || '')));
      const selectedCandidates = importCandidates.filter(candidate => selectedKeys.has(candidate.key));

      let applied = 0;
      for (const candidate of selectedCandidates) {
        const connection = candidate.connection;
        const normalizedConnection = {
          ...connection,
          type: 'ssh' as const,
          port: normalizePortByType(connection.port, 'ssh')
        };

        const identity = buildConnectionIdentity(normalizedConnection);
        const existingIndex = existingIdentityMap.get(identity);
        if (existingIndex === undefined) {
          config.connections.push(normalizedConnection);
          existingIdentityMap.set(identity, config.connections.length - 1);
          applied++;
          continue;
        }

        const existingConnection = config.connections[existingIndex] as any;
        const oldLabel = String(existingConnection?.label || '');
        const newLabel = String(normalizedConnection?.label || '');

        config.connections[existingIndex] = {
          ...existingConnection,
          ...normalizedConnection
        } as any;

        if (oldLabel && newLabel && oldLabel !== newLabel) {
          await ConfigService.movePassword(oldLabel, newLabel);
        }

        applied++;
      }
      ConfigService.saveGlobalConfig(config);
      if (applied > 0) {
        connectionManager.load();
        treeDataProvider.refresh();
      }
      vscode.window.showInformationMessage(LangService.t('importedConnections', { count: applied, source: sshConfigPath }));
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
          await saveConnection(connection, !!connection.global);
          treeDataProvider.addConnection(connection);
          panel.dispose();
        } else if (message.command === 'cancel') {
          panel.dispose();
        } else if (message.command === 'pickFile') {
          const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false });
          if (uris && uris.length > 0) {
            panel.webview.postMessage({ command: 'setFile', path: uris[0].fsPath });
          }
        } else if (message.command === 'copyPassword') {
          const value = String(message.value || '');
          if (value) {
            await vscode.env.clipboard.writeText(value);
            vscode.window.showInformationMessage(LangService.t('passwordCopied'));
          }
        } else if (message.command === 'passwordCopied') {
          vscode.window.showInformationMessage(LangService.t('passwordCopied'));
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
      async (message) => {
        if (message.command === 'add') {
          const oldLabel = connection.label;
          Object.assign(connection, message.data);
          const newLabel = `${connection.type.toUpperCase()}: ${connection.label}`;

          // Store password in SecretStorage if a new password is provided.
          if (connection.password) {
            await ConfigService.storePassword(newLabel, connection.password);
            delete connection.password;
            if (oldLabel !== newLabel) {
              await ConfigService.deletePassword(oldLabel);
            }
          } else if (oldLabel !== newLabel) {
            // Preserve existing secret when only label changed.
            await ConfigService.movePassword(oldLabel, newLabel);
          }

          connection.label = newLabel;
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
        } else if (message.command === 'copyPassword') {
          const value = String(message.value || '');
          if (value) {
            await vscode.env.clipboard.writeText(value);
            vscode.window.showInformationMessage(LangService.t('passwordCopied'));
          }
        } else if (message.command === 'passwordCopied') {
          vscode.window.showInformationMessage(LangService.t('passwordCopied'));
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
    await ConfigService.deletePassword(label);
    treeDataProvider.removeConnection(label);
    vscode.window.showInformationMessage(LangService.t('connectionDeleted', { label }));
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.closeConnection', async (item: vscode.TreeItem) => {
    const label = (item as any).connectionLabel || String(item.label);
    if (!label) {
      return;
    }

    SessionProvider.closeSession(label, true);
    const remoteServiceProvider = Container.get('remoteServiceProvider') as RemoteServiceProvider;
    remoteServiceProvider?.clearCache?.(label);
    treeDataProvider.refresh();
    vscode.window.showInformationMessage(LangService.t('connectionClosed', { label }));
  }));
}
