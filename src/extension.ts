import * as vscode from 'vscode';
import { t } from './lang';
import * as path from 'path';
import * as fs from 'fs';
import { ConnectionItem } from './types';
import { RemotixTreeDataProvider } from './treeData';
import { getGlobalConfig, saveGlobalConfig, getProjectConfig, saveProjectConfig } from './config';
import { getAddConnectionHtml } from './ui/webview';
import { FtpOps } from './core/FtpOps';
// @ts-ignore
import { ConnectConfig } from 'ssh2';

export function activate(context: vscode.ExtensionContext) {
  const treeDataProvider = new RemotixTreeDataProvider(context);
  const treeView = vscode.window.createTreeView('remotixView', {
    treeDataProvider,
    dragAndDropController: treeDataProvider
  });
  context.subscriptions.push(treeView);

  context.subscriptions.push(vscode.commands.registerCommand('remotix.download', async (item: any) => {
    const connectionLabel = item?.connectionLabel;
    const remotePath = item?.sshPath || item?.ftpPath;
    const isDirectory = item?.contextValue === 'ssh-folder' || item?.contextValue === 'ftp-folder';

    if (!connectionLabel || !remotePath) {
        vscode.window.showErrorMessage(t('missingPathOrConnection'));
        return;
    }

    const treeDataProviderAny = treeDataProvider as any;
    const conn = treeDataProviderAny.getConnectionByLabel(connectionLabel);
    if (!conn) {
        vscode.window.showErrorMessage(t('connectionNotFound'));
        return;
    }

    const uri = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        openLabel: t('chooseDownloadTarget'),
        defaultUri: vscode.Uri.file(process.env.HOME || '.')
    });

    if (!uri || uri.length === 0) return;
    const localTarget = uri[0].fsPath;
    const pathMod = require('path');
    const localDest = pathMod.join(localTarget, pathMod.basename(remotePath));

    if (conn.type === 'ftp') {
        const { Client } = require('basic-ftp');
        const client = new Client();
        // Вмикаємо логування для відладки (можна прибрати потім)
        client.ftp.verbose = true; 

        try {
            await client.access({
                host: conn.host,
                port: Number(conn.port) || 21,
                user: conn.user,
                password: conn.password,
                secure: true,
                secureOptions: { rejectUnauthorized: false }
            });

            if (isDirectory) {
                // Завантаження папки
                await client.downloadToDir(localDest, remotePath);
            } else {
                // Завантаження файлу. 
                // ВАЖЛИВО: downloadTo приймає (локальний_шлях_до_файлу, віддалений_шлях)
                await client.downloadTo(localDest, remotePath);
            }

            vscode.window.showInformationMessage(t('downloadSuccess'));
        } catch (err: any) {
            console.error('FTP Error:', err);
            vscode.window.showErrorMessage(t('downloadError', { error: err.message }));
        } finally {
            client.close();
        }
        return;
    }
  
    // SSH download
    const { Client } = require('ssh2');
    const ssh = new Client();
    const config: any = {
      host: conn.host || (conn.detail ? conn.detail.split('@')[1]?.split(':')[0] : ''),
      port: conn.port ? parseInt(conn.port) : 22,
      username: conn.user || (conn.detail ? conn.detail.split('@')[0] : ''),
    };
    if (conn.authMethod === 'privateKey' && conn.authFile) {
      try {
        config.privateKey = fs.readFileSync(conn.authFile);
      } catch (e) {
        vscode.window.showErrorMessage(t('cannotReadKey', { error: (e instanceof Error ? e.message : String(e)) }));
        return;
      }
    } else if (conn.password) {
      config.password = conn.password;
    }
    ssh.on('ready', () => {
      ssh.sftp((err: Error | undefined, sftp: any) => {
        if (err) {
          vscode.window.showErrorMessage(t('sftpError', { error: err.message }));
          ssh.end();
          return;
        }
        const downloadFile = (remote: string, local: string, cb: (err?: Error | null) => void) => {
          let called = false;
          const done = (err?: Error | null) => {
            if (!called) {
              called = true;
              cb(err);
            }
          };
          const writeStream = fs.createWriteStream(local);
          const readStream = sftp.createReadStream(remote);
          writeStream.on('close', () => done());
          writeStream.on('error', done);
          readStream.on('error', done);
          readStream.pipe(writeStream);
        };
        const downloadDir = (remoteDir: string, localDir: string, cb: (err?: Error | null) => void) => {
          sftp.readdir(remoteDir, (err: Error | null, list: any[]) => {
            if (err) return cb(err);
            fs.mkdirSync(localDir, { recursive: true });
            let i = 0;
            let errorOccurred = false;
            const next = () => {
              if (errorOccurred) return;
              if (i >= list.length) return cb();
              const entry = list[i++];
              const remotePath = pathMod.join(remoteDir, entry.filename);
              const localPath = pathMod.join(localDir, entry.filename);
              if (entry.longname && entry.longname[0] === 'd') {
                downloadDir(remotePath, localPath, (err2) => {
                  if (err2) { errorOccurred = true; return cb(err2); }
                  next();
                });
              } else {
                downloadFile(remotePath, localPath, (err3) => {
                  if (err3) { errorOccurred = true; return cb(err3); }
                  next();
                });
              }
            };
            next();
          });
        };
        sftp.stat(remotePath, (err: Error | null, stats: any) => {
          if (err) { ssh.end(); vscode.window.showErrorMessage(t('downloadError', { error: err.message })); return; }
          const dest = pathMod.join(localTarget, pathMod.basename(remotePath));
          if (stats.isDirectory && stats.isDirectory()) {
            downloadDir(remotePath, dest, (err2) => {
              ssh.end();
              if (err2) {
                vscode.window.showErrorMessage(t('downloadError', { error: err2.message }));
              } else {
                vscode.window.showInformationMessage(t('downloadSuccess'));
              }
            });
          } else {
            downloadFile(remotePath, dest, (err2) => {
              ssh.end();
              if (err2) {
                vscode.window.showErrorMessage(t('downloadError', { error: err2.message }));
              } else {
                vscode.window.showInformationMessage(t('downloadSuccess'));
              }
            });
          }
        });
      });
    }).on('error', (err: Error) => {
      vscode.window.showErrorMessage(t('sshError', { error: err.message }));
    }).connect(config);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('remotix.upload', async (item: any) => {
    // Universal upload logic for files and folders
    const connectionLabel = item?.connectionLabel;
    const targetPath = item?.sshPath || item?.ftpPath;
    if (!connectionLabel || !targetPath) {
      vscode.window.showErrorMessage(t('missingPathOrConnection'));
      return;
    }
    const treeDataProviderAny = treeDataProvider as any;
    const conn = treeDataProviderAny.getConnectionByLabel
      ? treeDataProviderAny.getConnectionByLabel(connectionLabel)
      : undefined;
    if (!conn) {
      vscode.window.showErrorMessage(t('connectionNotFound'));
      return;
    }
    const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
    const uploadType = await vscode.window.showQuickPick(
        [
            { label: '$(file) File', value: 'file' },
            { label: '$(folder) Folder', value: 'folder' }
        ], 
        { placeHolder: t('selectUploadType') }
    );

    if (!uploadType) return;

    const isFolder = uploadType.value === 'folder';

    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: !isFolder,
        canSelectFolders: isFolder,
        canSelectMany: true,
        openLabel: t('select'),
        defaultUri: vscode.Uri.file(homeDir),
        filters: isFolder ? {} : { [t('allFiles')]: ['*'] }
    });
    if (!uris || uris.length === 0) return;
    const localPath = uris[0].fsPath;
    const pathMod = require('path');
    const fs = require('fs');
    let uploadTarget = targetPath;
    const stat = fs.statSync(localPath);
    if (stat.isDirectory()) {
      // Always create a subfolder in the target with the local folder's name
      uploadTarget = pathMod.join(targetPath, pathMod.basename(localPath));
    }
    if (conn.type === 'ftp') {
      const { Client } = require('basic-ftp');
      const client = new Client();
      try {
        await client.access({
          host: conn.host,
          port: conn.port ? Number(conn.port) : 21,
          user: conn.user,
          password: conn.password,
          secure: true,
          secureOptions: { rejectUnauthorized: false }
        });
        if (stat.isDirectory()) {
          await client.uploadFromDir(localPath, uploadTarget);
        } else {
          await client.uploadFrom(localPath, pathMod.join(uploadTarget, pathMod.basename(localPath)));
        }
        await client.close();
        vscode.window.showInformationMessage(t('uploadSuccess'));
        treeDataProvider.refresh();
      } catch (e) {
        await client.close();
        vscode.window.showErrorMessage(t('uploadError', { error: (e instanceof Error ? e.message : String(e)) }));
      }
      return;
    }
    // SSH upload
    const { Client } = require('ssh2');
    const ssh = new Client();
    const config: any = {
      host: conn.host || (conn.detail ? conn.detail.split('@')[1]?.split(':')[0] : ''),
      port: conn.port ? parseInt(conn.port) : 22,
      username: conn.user || (conn.detail ? conn.detail.split('@')[0] : ''),
    };
    if (conn.authMethod === 'privateKey' && conn.authFile) {
      try {
        config.privateKey = require('fs').readFileSync(conn.authFile);
      } catch (e) {
        vscode.window.showErrorMessage(t('cannotReadKey', { error: (e instanceof Error ? e.message : String(e)) }));
        return;
      }
    } else if (conn.password) {
      config.password = conn.password;
    }
    ssh.on('ready', () => {
      ssh.sftp((err: Error | undefined, sftp: any) => {
        if (err) {
          vscode.window.showErrorMessage(t('sftpError', { error: err.message }));
          ssh.end();
          return;
        }
        const uploadFile = (src: string, dest: string, cb: (err?: Error) => void) => {
          const readStream = fs.createReadStream(src);
          const writeStream = sftp.createWriteStream(dest);
          writeStream.on('close', () => cb());
          writeStream.on('error', cb);
          readStream.pipe(writeStream);
        };
        const uploadDir = (srcDir: string, destDir: string, cb: (err?: Error) => void) => {
          (async () => {
            try {
              // Always create the root destDir first, but only if it doesn't exist
              await new Promise<void>((resolve, reject) => {
                sftp.mkdir(destDir, (err2: Error | null) => {
                  if (err2 && (err2 as any).code !== 4) return reject(err2);
                  resolve();
                });
              });
              const entries = await fs.promises.readdir(srcDir, { withFileTypes: true });
              if (entries.length === 0) {
                cb();
                return;
              }
              let errorOccurred = false;
              let remaining = entries.length;
              for (const entry of entries) {
                const srcPath = pathMod.join(srcDir, entry.name);
                const destPath = pathMod.join(destDir, entry.name);
                if (entry.isDirectory()) {
                  uploadDir(srcPath, destPath, (err3) => {
                    if (err3 && !errorOccurred) {
                      errorOccurred = true;
                      return cb(err3);
                    }
                    if (--remaining === 0 && !errorOccurred) cb();
                  });
                } else {
                  uploadFile(srcPath, destPath, (err4) => {
                    if (err4 && !errorOccurred) {
                      errorOccurred = true;
                      return cb(err4);
                    }
                    if (--remaining === 0 && !errorOccurred) cb();
                  });
                }
              }
            } catch (err) {
              cb(err as Error);
            }
          })();
        };
        if (stat.isDirectory()) {
          uploadDir(localPath, uploadTarget, (err3) => {
            ssh.end();
            if (err3) {
              vscode.window.showErrorMessage(t('uploadError', { error: err3.message }));
            } else {
              vscode.window.showInformationMessage(t('uploadSuccess'));
              treeDataProvider.refresh();
            }
          });
        } else {
          uploadFile(localPath, targetPath + '/' + pathMod.basename(localPath), (err2) => {
            ssh.end();
            if (err2) {
              vscode.window.showErrorMessage(t('uploadError', { error: err2.message }));
            } else {
              vscode.window.showInformationMessage(t('uploadSuccess'));
              treeDataProvider.refresh();
            }
          });
        }
      });
    }).on('error', (err: Error) => {
      vscode.window.showErrorMessage(t('sshError', { error: err.message }));
    }).connect(config);
  }));

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
        // Витягуємо пароль: якщо encoding="base64" — декодуємо, інакше беремо як є
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

  context.subscriptions.push(vscode.commands.registerCommand('remotix.editFile', async (item: { label: string, sshPath?: string, ftpPath?: string, connectionLabel: string }) => {
        const filePath = item.ftpPath || item.sshPath;
        if (!filePath) {
          vscode.window.showErrorMessage(t('missingPathOrConnection'));
          return;
        }
    try {
      console.log('[remotix.editFile] Запуск для', item);
      const treeDataProvider = vscode.workspace.getConfiguration('remotix').get('treeDataProvider') as any || new RemotixTreeDataProvider(context);
      const conn = treeDataProvider.getConnectionByLabel ? treeDataProvider.getConnectionByLabel(item.connectionLabel) : undefined;
      if (!conn) {
        vscode.window.showErrorMessage(t('noConnectionsFound'));
        return;
      }
      console.log('[remotix.editFile] Використовується підключення:', conn);
      const os = require('os');
      const pathMod = require('path');
      const tmp = os.tmpdir();
      const safeHost = conn.host.replace(/[^\w]/g, '_');
      const relPathRaw = item.sshPath || item.ftpPath || '';
      const safeRelPath = relPathRaw.replace(/^\/+/, '').split('/').map((p) => p.replace(/[^\w.\-]/g, '_')).join(pathMod.sep);
      const tmpDir = pathMod.join(tmp, `remotix_${safeHost}`);
      fs.mkdirSync(pathMod.dirname(pathMod.join(tmpDir, safeRelPath)), { recursive: true });
      const tmpFile = pathMod.join(tmpDir, safeRelPath);

      if (conn.type === 'ftp') {
        // FTP: download file, open, upload on save
        const { Client } = require('basic-ftp');
        const client = new Client();
        try {
          await client.access({
            host: conn.host,
            port: conn.port ? Number(conn.port) : 21,
            user: conn.user,
            password: conn.password,
            secure: true,
            secureOptions: { rejectUnauthorized: false }
          });
          await client.downloadTo(tmpFile, item.ftpPath || item.sshPath);
          await client.close();
        } catch (e) {
          await client.close();
          vscode.window.showErrorMessage(t('fileDownloadError', { error: (e instanceof Error ? e.message : String(e)) }));
          return;
        }
        const doc = await vscode.workspace.openTextDocument(tmpFile);
        await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Active });
        vscode.window.setStatusBarMessage(t('remoteFile', { user: conn.user, host: conn.host, path: item.ftpPath || item.sshPath || '' }), 5000);
        const saveListener = vscode.workspace.onDidSaveTextDocument(async (savedDoc) => {
          if (savedDoc.fileName === tmpFile) {
            const client2 = new Client();
            try {
              await client2.access({
                host: conn.host,
                port: conn.port ? Number(conn.port) : 21,
                user: conn.user,
                password: conn.password,
                secure: true,
                secureOptions: { rejectUnauthorized: false }
              });
              await client2.uploadFrom(tmpFile, item.ftpPath || item.sshPath);
              await client2.close();
              vscode.window.setStatusBarMessage(t('fileSavedToServer'), 2000);
            } catch (e) {
              await client2.close();
              vscode.window.showErrorMessage(t('fileUploadError', { error: (e instanceof Error ? e.message : String(e)) }));
            }
          }
        });
        const closeListener = vscode.workspace.onDidCloseTextDocument((closedDoc) => {
          if (closedDoc.fileName === tmpFile) {
            saveListener.dispose();
            closeListener.dispose();
            try { fs.unlinkSync(tmpFile); } catch {}
          }
        });
        return;
      }

      const { Client } = require('ssh2');
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
          sftp.fastGet(item.sshPath || '', tmpFile, {}, async (err: Error | null) => {
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
            vscode.window.setStatusBarMessage(t('remoteFile', { user: conn.user, host: conn.host, path: item.sshPath || '' }), 5000);
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
                    sftp2.fastPut(tmpFile, item.sshPath || '', {}, (err3: Error | null) => {
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
        vscode.window.showInformationMessage(t('sshpassNotFound'));
      }
    }
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

  context.subscriptions.push(vscode.commands.registerCommand('remotix.rename', async (item: vscode.TreeItem) => {
    const labelStr = typeof item.label === 'string' ? item.label : (item.label && typeof item.label.label === 'string' ? item.label.label : String(item.label));
    vscode.window.showInformationMessage(t('renameClicked', { label: labelStr }));
    const oldLabel = labelStr;
    const sshPath = (item as any).sshPath;
    const connectionLabel = (item as any).connectionLabel;
    if (!sshPath || !connectionLabel) {
      vscode.window.showErrorMessage(t('missingSshPathOrConnectionLabel'));
      return;
    }
    const newName = await vscode.window.showInputBox({
      prompt: t ? t('rename') : 'Enter new name',
      value: oldLabel
    });
    if (!newName || newName === oldLabel) return;
    const treeDataProviderAny = treeDataProvider as any;
    const conn = treeDataProviderAny.getConnectionByLabel
      ? treeDataProviderAny.getConnectionByLabel(connectionLabel)
      : undefined;
    if (!conn) {
      vscode.window.showErrorMessage(t('connectionNotFound'));
      return;
    }
    const { Client } = require('ssh2');
    const ssh = new Client();
    const config: any = {
      host: conn.host || (conn.detail ? conn.detail.split('@')[1]?.split(':')[0] : ''),
      port: conn.port ? parseInt(conn.port) : 22,
      username: conn.user || (conn.detail ? conn.detail.split('@')[0] : ''),
    };
    if (conn.authMethod === 'privateKey' && conn.authFile) {
      try {
        config.privateKey = fs.readFileSync(conn.authFile);
      } catch (e) {
        vscode.window.showErrorMessage(t('cannotReadKey', { error: (e instanceof Error ? e.message : String(e)) }));
        return;
      }
    } else if (conn.password) {
      config.password = conn.password;
    }
    const oldPath = sshPath;
    const newPath = oldPath.replace(/[^/]+$/, newName);
    ssh.on('ready', () => {
      ssh.sftp((err: Error | undefined, sftp: any) => {
        if (err) {
          vscode.window.showErrorMessage(t('sftpError', { error: err.message }));
          ssh.end();
          return;
        }
        sftp.rename(oldPath, newPath, (err2: Error | null) => {
          ssh.end();
          if (err2) {
            vscode.window.showErrorMessage(t('renameFailed', { error: err2.message }));
          } else {
            vscode.window.showInformationMessage(t('renamedTo', { name: newName }));
            treeDataProvider.refresh();
          }
        });
      });
    }).on('error', (err: Error) => {
      vscode.window.showErrorMessage(t('sshError', { error: err.message }));
    }).connect(config);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('remotix.createFolder', async (item: any) => {
    const sshPath = item?.sshPath || item?.ftpPath;
    const connectionLabel = item?.connectionLabel;
    if (!sshPath || !connectionLabel) {
      vscode.window.showErrorMessage(t('missingPathOrConnection'));
      return;
    }
    const treeDataProviderAny = treeDataProvider as any;
    const conn = treeDataProviderAny.getConnectionByLabel
      ? treeDataProviderAny.getConnectionByLabel(connectionLabel)
      : undefined;
    if (!conn) {
      vscode.window.showErrorMessage(t('connectionNotFound'));
      return;
    }
    const newFolderName = await vscode.window.showInputBox({
      prompt: t('enterNewFolderName'),
      value: t('defaultNewFolderName')
    });
    if (!newFolderName) return;
    if (conn.type === 'ftp') {
      const ok = await FtpOps.createFolder(conn, sshPath, newFolderName);
      if (ok) {
        vscode.window.showInformationMessage(t('folderCreated', { path: sshPath + '/' + newFolderName }));
        treeDataProvider.refresh();
      }
      return;
    }
    
    const { Client } = require('ssh2');
    const ssh = new Client();
    const config: any = {
      host: conn.host || (conn.detail ? conn.detail.split('@')[1]?.split(':')[0] : ''),
      port: conn.port ? parseInt(conn.port) : 22,
      username: conn.user || (conn.detail ? conn.detail.split('@')[0] : ''),
    };
    if (conn.authMethod === 'privateKey' && conn.authFile) {
      try {
        config.privateKey = fs.readFileSync(conn.authFile);
      } catch (e) {
        vscode.window.showErrorMessage(t('cannotReadKey', { error: (e instanceof Error ? e.message : String(e)) }));
        return;
      }
    } else if (conn.password) {
      config.password = conn.password;
    }
    const newFolderPath = sshPath.replace(/\/[^/]*$/, '') + '/' + newFolderName;
    ssh.on('ready', () => {
      ssh.sftp((err: Error | undefined, sftp: any) => {
        if (err) {
          vscode.window.showErrorMessage(t('sftpError', { error: err.message }));
          ssh.end();
          return;
        }
        sftp.mkdir(newFolderPath, (err2: Error | null) => {
          ssh.end();
          if (err2) {
            vscode.window.showErrorMessage(t('createFolderFailed', { error: err2.message }));
          } else {
            vscode.window.showInformationMessage(t('folderCreated', { path: newFolderPath }));
            treeDataProvider.refresh();
          }
        });
      });
    }).on('error', (err: Error) => {
      vscode.window.showErrorMessage('SSH помилка: ' + err.message);
    }).connect(config);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('remotix.createFile', async (item: any) => {
    const sshPath = item?.sshPath || item?.ftpPath;
    const connectionLabel = item?.connectionLabel;
    if (!connectionLabel) {
      vscode.window.showErrorMessage(t('missingPathOrConnection'));
      return;
    }
    if (!sshPath) {
      vscode.window.showErrorMessage(t('ftpNoFolderForFile'));
      return;
    }
    const treeDataProviderAny = treeDataProvider as any;
    const conn = treeDataProviderAny.getConnectionByLabel
      ? treeDataProviderAny.getConnectionByLabel(connectionLabel)
      : undefined;
    if (!conn) {
      vscode.window.showErrorMessage(t('connectionNotFound'));
      return;
    }
    const newFileName = await vscode.window.showInputBox({
      prompt: t('enterNewFileName'),
      value: t('defaultNewFileName')
    });
    if (!newFileName) return;
    if (conn.type === 'ftp') {
      const ok = await FtpOps.createFile(conn, sshPath, newFileName);
      if (ok) {
        vscode.window.showInformationMessage(t('fileCreated', { path: sshPath + '/' + newFileName }));
        treeDataProvider.refresh();
      }
      return;
    }
    
    let newFilePath: string;
    if (item?.contextValue === 'ssh-folder') {
      newFilePath = (sshPath.endsWith('/') ? sshPath : sshPath + '/') + newFileName;
    } else {
      newFilePath = sshPath.replace(/\/[^/]*$/, '') + '/' + newFileName;
    }
    const { Client } = require('ssh2');
    const ssh = new Client();
    const config: any = {
      host: conn.host || (conn.detail ? conn.detail.split('@')[1]?.split(':')[0] : ''),
      port: conn.port ? parseInt(conn.port) : 22,
      username: conn.user || (conn.detail ? conn.detail.split('@')[0] : ''),
    };
    if (conn.authMethod === 'privateKey' && conn.authFile) {
      try {
        config.privateKey = fs.readFileSync(conn.authFile);
      } catch (e) {
        vscode.window.showErrorMessage(t('cannotReadKey', { error: (e instanceof Error ? e.message : String(e)) }));
        return;
      }
    } else if (conn.password) {
      config.password = conn.password;
    }
    ssh.on('ready', () => {
      ssh.sftp((err: Error | undefined, sftp: any) => {
        if (err) {
          vscode.window.showErrorMessage(t('sftpError', { error: err.message }));
          ssh.end();
          return;
        }
        const writeStream = sftp.createWriteStream(newFilePath, { flags: 'w', encoding: 'utf8' });
        writeStream.on('close', () => {
          ssh.end();
          vscode.window.showInformationMessage(t('fileCreated', { path: newFilePath }));
          treeDataProvider.refresh();
        });
        writeStream.on('error', (err2: Error) => {
          ssh.end();
          vscode.window.showErrorMessage(t('createFileFailed', { error: err2.message }));
        });
        writeStream.end('');
      });
    }).on('error', (err: Error) => {
      vscode.window.showErrorMessage('SSH помилка: ' + err.message);
    }).connect(config);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('remotix.deleteFile', async (item: any) => {
    const sshPath = item?.sshPath || item?.ftpPath;
    const connectionLabel = item?.connectionLabel;
    if (!sshPath || !connectionLabel) {
      vscode.window.showErrorMessage(t('missingPathOrConnection'));
      return;
    }
    const treeDataProviderAny = treeDataProvider as any;
    const conn = treeDataProviderAny.getConnectionByLabel
      ? treeDataProviderAny.getConnectionByLabel(connectionLabel)
      : undefined;
    if (!conn) {
      vscode.window.showErrorMessage(t('connectionNotFound'));
      return;
    }
    const isDir = item.contextValue === 'ftp-folder' || item.contextValue === 'ssh-folder';
    const confirm = await vscode.window.showWarningMessage(
      t(isDir ? 'confirmDeleteFolder' : 'confirmDeleteFile', { path: sshPath }),
      { modal: true },
      t('delete')
    );
    if (confirm !== t('delete')) return;

    if (conn.type === 'ftp') {
      let ok = false;
      if (item.contextValue === 'ftp-folder') {
        if (FtpOps.deleteFolderRecursive) {
          ok = await FtpOps.deleteFolderRecursive(conn, sshPath);
        } else {
          ok = await FtpOps.deleteFileOrFolder(conn, sshPath, true);
        }
      } else {
        ok = await FtpOps.deleteFileOrFolder(conn, sshPath, false);
      }
      if (ok) {
        vscode.window.showInformationMessage(t(isDir ? 'folderDeleted' : 'fileDeleted', { path: sshPath }));
        treeDataProvider.refresh();
      }
      return;
    }

    const { Client } = require('ssh2');
    const ssh = new Client();
    const config: any = {
      host: conn.host || (conn.detail ? conn.detail.split('@')[1]?.split(':')[0] : ''),
      port: conn.port ? parseInt(conn.port) : 22,
      username: conn.user || (conn.detail ? conn.detail.split('@')[0] : ''),
    };
    if (conn.authMethod === 'privateKey' && conn.authFile) {
      try {
        config.privateKey = fs.readFileSync(conn.authFile);
      } catch (e) {
        vscode.window.showErrorMessage('Не вдалося прочитати ключ: ' + (e instanceof Error ? e.message : String(e)));
        return;
      }
    } else if (conn.password) {
      config.password = conn.password;
    }
    ssh.on('ready', () => {
      ssh.sftp((err: Error | undefined, sftp: any) => {
        if (err) {
          vscode.window.showErrorMessage(t('sftpError', { error: err.message }));
          ssh.end();
          return;
        }
        if (item.contextValue === 'ssh-folder') {
          const rmDir = (dirPath: string, done: (err?: Error | null) => void) => {
            sftp.readdir(dirPath, (err: Error | null, list: any[]) => {
              if (err) return done(err);
              let i = 0;
              const next = () => {
                if (i >= list.length) return sftp.rmdir(dirPath, done);
                const entry = list[i++];
                const entryPath = dirPath + '/' + entry.filename;
                if (entry.longname && entry.longname[0] === 'd') {
                  rmDir(entryPath, (err2) => {
                    if (err2) return done(err2);
                    next();
                  });
                } else {
                  sftp.unlink(entryPath, (err2: Error | null) => {
                    if (err2) return done(err2);
                    next();
                  });
                }
              };
              next();
            });
          };
          rmDir(sshPath, (err2) => {
            ssh.end();
            if (err2) {
              vscode.window.showErrorMessage(t('deleteFolderFailed', { error: err2.message }));
            } else {
              vscode.window.showInformationMessage(t('folderDeleted', { path: sshPath }));
              treeDataProvider.refresh();
            }
          });
        } else {
          sftp.unlink(sshPath, (err2: Error | null) => {
            ssh.end();
            if (err2) {
              vscode.window.showErrorMessage(t('deleteFileFailed', { error: err2.message }));
            } else {
              vscode.window.showInformationMessage(t('fileDeleted', { path: sshPath }));
              treeDataProvider.refresh();
            }
          });
        }
      });
    }).on('error', (err: Error) => {
      vscode.window.showErrorMessage('SSH помилка: ' + err.message);
    }).connect(config);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('remotix.refresh', async () => {
    treeDataProvider.refresh();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('remotix.showConfig', async () => {
    const config = getGlobalConfig(context);
    vscode.window.showInformationMessage(t('globalConfigPrefix') + JSON.stringify(config));
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
