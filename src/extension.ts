console.log('[remotix] Extension activated');
import * as vscode from 'vscode';
import { t } from './lang';
import * as path from 'path';
import * as fs from 'fs';
import { ConnectionItem } from './types';
import { RemotixTreeDataProvider } from './treeData';
import { getGlobalConfig, saveGlobalConfig, getProjectConfig, saveProjectConfig } from './config';
import { getAddConnectionHtml } from './webview';
// @ts-ignore
import { ConnectConfig } from 'ssh2';

export function activate(context: vscode.ExtensionContext) {
  const treeDataProvider = new RemotixTreeDataProvider(context);
  vscode.window.registerTreeDataProvider('remotixView', treeDataProvider);

  context.subscriptions.push(vscode.commands.registerCommand('remotix.moreActions', async () => {
    const pick = await vscode.window.showQuickPick([
      { label: t('importSshConfig'), action: 'importSshConfig' },
      { label: t('importFileZilla'), action: 'importFileZilla' }
    ], { placeHolder: t('chooseAction') });
    if (!pick) return;
    if (pick.action === 'importSshConfig') {
      await vscode.commands.executeCommand('remotix.importSshConfig');
    } else if (pick.action === 'importFileZilla') {
      await vscode.commands.executeCommand('remotix.importFileZilla');
    }
  }));

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
          openLabel: t('chooseSitemanager'),
          defaultUri: vscode.Uri.file(homeDir)
        });
        if (!uris || uris.length === 0) return;
        filePath = uris[0].fsPath;
      }
      if (!fs.existsSync(filePath)) {
        vscode.window.showErrorMessage(t('fileNotFound', { file: filePath }));
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
          console.warn(`[remotix] Пропущено <Server> без host/protocol: host='${host}', protocol='${protocol}'`);
          if (block === serverBlocks[0]) {
            console.log('[remotix] Перший serverBlock:', block);
          }
          continue;
        }
        if (block === serverBlocks[0]) {
          console.log('[remotix] Перший serverBlock:', block);
        }
        const port = getTag(block, 'Port') || (protocol === '0' ? '21' : '22');
        const user = getTag(block, 'User');
        let pass = getTag(block, 'Pass');
        const passEncoding = (block.match(/<Pass[^>]*encoding=\"([^\"]+)\"/) || [])[1];
        if (pass && passEncoding === 'base64') {
          try { pass = Buffer.from(pass, 'base64').toString('utf8'); } catch {}
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
        } else {
          console.warn('[remotix] Невідомий protocol:', protocol, block);
        }
      }
      console.log('[remotix] Знайдено серверів:', serverBlocks.length, 'Підключень:', connections.length);
      if (!connections.length) {
        vscode.window.showWarningMessage(t('noFtpConnections'));
        return;
      }
      
      const picks = await vscode.window.showQuickPick(
        connections.map(c => ({
          label: c.label,
          picked: true,
          detail: `${c.user || ''}@${c.host || ''}:${c.port || ''}`,
          type: c.type
        })),
        { canPickMany: true, placeHolder: t('chooseConnectionsToImport') }
      );
      if (!picks || picks.length === 0) return;
      const toImport = connections.filter(c => picks.find(p => p.label === c.label && p.type === c.type));
      
      const config = getGlobalConfig(context);
      let added = 0;
      for (const conn of toImport) {
        const exists = config.connections.some(
          c => c.host === conn.host && c.port === conn.port && c.user === conn.user && c.type === (conn.type as 'ftp' | 'ssh')
        );
        if (!exists) {
          config.connections.push({ ...conn, type: conn.type as 'ftp' | 'ssh' });
          added++;
        }
      }
      saveGlobalConfig(context, config);
      
      if (added > 0) {
        if (Array.isArray((treeDataProvider as any).connections)) {
          (treeDataProvider as any).connections = config.connections.slice();
        }
        treeDataProvider.refresh();
      }
      vscode.window.showInformationMessage(t('importedConnectionsFz', { count: added }));
    } catch (e) {
      vscode.window.showErrorMessage(t('importErrorFz', { error: (e instanceof Error ? e.message : String(e)) }));
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.importSshConfig', async () => {
    try {
      const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: t('chooseSshConfig'),
        defaultUri: vscode.Uri.file(homeDir)
      });
      if (!uris || uris.length === 0) return;
      const sshConfigPath = uris[0].fsPath;
      if (!fs.existsSync(sshConfigPath)) {
        vscode.window.showErrorMessage(t('fileNotFound', { file: sshConfigPath }));
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
        vscode.window.showWarningMessage(t('noConnectionsFound'));
        return;
      }
      
      const picks = await vscode.window.showQuickPick(
        connections.map(c => ({ label: c.label, picked: true, detail: `${c.user || ''}@${c.host || ''}:${c.port || ''}` })),
        { canPickMany: true, placeHolder: t('chooseConnectionsToImport') }
      );
      if (!picks || picks.length === 0) return;
      const toImport = connections.filter(c => picks.find(p => p.label === c.label));
      
      const config = getGlobalConfig(context);
      for (const conn of toImport) {
        config.connections.push(conn);
        treeDataProvider.addConnection(conn);
      }
      saveGlobalConfig(context, config);
      vscode.window.showInformationMessage(t('importedConnections', { count: toImport.length, source: sshConfigPath }));
    } catch (e) {
      vscode.window.showErrorMessage(t('importErrorSsh', { error: (e instanceof Error ? e.message : String(e)) }));
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.editFile', async (item: { label: string, sshPath: string, connectionLabel: string }) => {
    try {
      console.log('[remotix.editFile] Запуск для', item);
      const treeDataProvider = vscode.workspace.getConfiguration('remotix').get('treeDataProvider') as any || new RemotixTreeDataProvider(context);
      const conn = treeDataProvider.getConnectionByLabel ? treeDataProvider.getConnectionByLabel(item.connectionLabel) : undefined;
      if (!conn) {
        vscode.window.showErrorMessage(t('noConnectionsFound'));
        return;
      }
      console.log('[remotix.editFile] Використовується підключення:', conn);
      const { Client } = require('ssh2');
      const os = require('os');
      const tmp = os.tmpdir();
      const pathMod = require('path');
      const safeHost = conn.host.replace(/[^\w]/g, '_');
      const safeRelPath = item.sshPath.replace(/^\/+/, '').split('/').map((p: string) => p.replace(/[^\w.\-]/g, '_')).join(pathMod.sep);
      const tmpDir = pathMod.join(tmp, `remotix_${safeHost}`);
      fs.mkdirSync(pathMod.dirname(pathMod.join(tmpDir, safeRelPath)), { recursive: true });
      const tmpFile = pathMod.join(tmpDir, safeRelPath);
      const ssh = new Client();
      const config: ConnectConfig = {
        host: conn.host || (conn.detail ? conn.detail.split('@')[1]?.split(':')[0] : ''),
        port: conn.port ? parseInt(conn.port) : 22,
        username: conn.user || (conn.detail ? conn.detail.split('@')[0] : ''),
      };
      if (conn.authMethod === 'privateKey' && conn.authFile) {
        try {
          (config as any).privateKey = fs.readFileSync(conn.authFile);
        } catch (e) {
          vscode.window.showErrorMessage(t('cannotReadKey', { error: (e instanceof Error ? e.message : String(e)) }));
          return;
        }
      } else if (conn.password) {
        (config as any).password = conn.password;
      }
      console.log('[remotix.editFile] Параметри підключення:', config);
      ssh.on('ready', () => {
        console.log('[remotix.editFile] SSH ready, отримуємо SFTP...');
        ssh.sftp((err: Error | undefined, sftp: any) => {
          if (err) {
            vscode.window.showErrorMessage(t('sftpError', { error: err.message }));
            ssh.end();
            return;
          }
          console.log('[remotix.editFile] SFTP готовий, качаємо файл', item.sshPath, '->', tmpFile);
          sftp.fastGet(item.sshPath, tmpFile, {}, async (err: Error | null) => {
            ssh.end();
            if (err) {
              vscode.window.showErrorMessage(t('fileDownloadError', { error: err.message }));
              return;
            }
            console.log('[remotix.editFile] Файл завантажено, відкриваємо у редакторі:', tmpFile);
            const doc = await vscode.workspace.openTextDocument(tmpFile);
            await vscode.window.showTextDocument(doc, {
              preview: false,
              viewColumn: vscode.ViewColumn.Active
            });
            vscode.window.setStatusBarMessage(t('remoteFile', { user: conn.user, host: conn.host, path: item.sshPath }), 5000);
            const saveListener = vscode.workspace.onDidSaveTextDocument(async (savedDoc) => {
              if (savedDoc.fileName === tmpFile) {
                const ssh2 = new Client();
                ssh2.on('ready', () => {
                  ssh2.sftp((err2: Error | undefined, sftp2: any) => {
                    if (err2) {
                      vscode.window.showErrorMessage(t('sftpError', { error: err2.message }));
                      ssh2.end();
                      return;
                    }
                    console.log('[remotix.editFile] Відвантажуємо назад', tmpFile, '->', item.sshPath);
                    sftp2.fastPut(tmpFile, item.sshPath, {}, (err3: Error | null) => {
                      ssh2.end();
                      if (err3) {
                        vscode.window.showErrorMessage(t('fileUploadError', { error: err3.message }));
                      } else {
                        vscode.window.setStatusBarMessage(t('fileSavedToServer'), 2000);
                      }
                    });
                  });
                }).connect(config);
              }
            });
            const closeListener = vscode.workspace.onDidCloseTextDocument((closedDoc) => {
              if (closedDoc.fileName === tmpFile) {
                saveListener.dispose();
                closeListener.dispose();
                try { fs.unlinkSync(tmpFile); } catch {}
              }
            });
          });
        });
      }).on('error', (err: Error) => {
        vscode.window.showErrorMessage(t('sshError', { error: err.message }));
      }).connect(config);
    } catch (e) {
      vscode.window.showErrorMessage(t('fileDownloadError', { error: (e instanceof Error ? e.message : String(e)) }));
      console.error('[remotix.editFile] Exception:', e);
    }
  }));
      
  context.subscriptions.push(vscode.commands.registerCommand('remotixView.itemClick', async (item: any) => {
    console.log('[remotixView.itemClick] item:', item);
    await vscode.commands.executeCommand('remotix.editFile', item);
  }));


  context.subscriptions.push(vscode.commands.registerCommand('remotix.addConnection', async () => {
    const panel = vscode.window.createWebviewPanel(
      'remotixAddConnection',
      t('addConnection'),
      vscode.ViewColumn.One,
      { enableScripts: true }
    );
    panel.webview.html = getAddConnectionHtml();

    panel.webview.onDidReceiveMessage(
      async (message) => {
        if (message.command === 'add') {
          const conn = message.data;
          saveConnection(conn, !!conn.global, context);
          treeDataProvider.addConnection(conn);
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
    const conn = treeDataProvider.getConnectionByLabel(item.label as string);
    if (!conn) return;
    const panel = vscode.window.createWebviewPanel(
      'remotixEditConnection',
      t('editConnection'),
      vscode.ViewColumn.One,
      { enableScripts: true }
    );
    panel.webview.html = getAddConnectionHtml(conn);
    panel.webview.onDidReceiveMessage(
      (message) => {
        if (message.command === 'add') {
          Object.assign(conn, message.data);
          conn.label = `${conn.type.toUpperCase()}: ${conn.label}`;
          conn.detail = `${conn.user}@${conn.host}:${conn.port}`;
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

  context.subscriptions.push(vscode.commands.registerCommand('remotix.openSshTerminal', async (item: vscode.TreeItem) => {
    const conn = treeDataProvider.getConnectionByLabel(item.label as string);
    if (!conn || conn.type !== 'ssh') return;
    const sshCmd = `ssh${conn.port ? ' -p ' + conn.port : ''} ${conn.user}@${conn.host}`;
    const terminal = vscode.window.createTerminal({ name: conn.label });
    terminal.sendText(sshCmd);
    terminal.show();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.deleteConnection', async (item: vscode.TreeItem) => {
    const label = item.label as string;
    const conn = treeDataProvider.getConnectionByLabel(label);
    if (!conn) return;
    const confirm = await vscode.window.showWarningMessage(
      t('confirmDeleteConnection', { label }),
      { modal: true },
      t('delete')
    );
    if (confirm !== t('delete')) return;
    // Remove from global config
    const globalConfig = getGlobalConfig(context);
    const idx = globalConfig.connections.findIndex(c => c.label === label);
    if (idx !== -1) {
      globalConfig.connections.splice(idx, 1);
      saveGlobalConfig(context, globalConfig);
    }
    // Remove from project config
    const projectConfig = getProjectConfig();
    const idx2 = projectConfig.connections.findIndex(c => c.label === label);
    if (idx2 !== -1) {
      projectConfig.connections.splice(idx2, 1);
      saveProjectConfig(projectConfig);
    }
    treeDataProvider.removeConnection(label);
    vscode.window.showInformationMessage(t('connectionDeleted', { label }));
  }));
}

function saveConnection(conn: ConnectionItem, global: boolean, context: vscode.ExtensionContext) {
  if (global) {
    const config = getGlobalConfig(context);
    config.connections.push(conn);
    saveGlobalConfig(context, config);
  } else {
    const config = getProjectConfig();
    config.connections.push(conn);
    saveProjectConfig(config);
  }
}

export function deactivate() {}
