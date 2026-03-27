import * as vscode from 'vscode';
import { Client } from 'basic-ftp';
import { ConnectionItem } from '../types';

export class FtpOps {
  static async createFolder(conn: ConnectionItem, parentPath: string, folderName: string): Promise<boolean> {
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
      const fullPath = (parentPath.endsWith('/') ? parentPath : parentPath + '/') + folderName;
      await client.ensureDir(fullPath);
      return true;
    } catch (e) {
      vscode.window.showErrorMessage('FTP: ' + (e instanceof Error ? e.message : String(e)));
      return false;
    } finally {
      client.close();
    }
  }

  static async createFile(conn: ConnectionItem, parentPath: string, fileName: string): Promise<boolean> {
    if (!parentPath || !fileName) {
      vscode.window.showErrorMessage('FTP: Не вказано шлях до папки або імʼя файлу для створення.');
      return false;
    }
    const client = new Client();
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    // Create a temporary empty file
    const tmpFile = path.join(os.tmpdir(), `remotix_empty_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`);
    fs.writeFileSync(tmpFile, '');
    try {
      await client.access({
        host: conn.host,
        port: conn.port ? Number(conn.port) : 21,
        user: conn.user,
        password: conn.password,
        secure: true,
        secureOptions: { rejectUnauthorized: false }
      });
      const fullPath = (parentPath.endsWith('/') ? parentPath : parentPath + '/') + fileName;
      await client.uploadFrom(tmpFile, fullPath);
      return true;
    } catch (e) {
      vscode.window.showErrorMessage('FTP: ' + (e instanceof Error ? e.message : String(e)));
      return false;
    } finally {
      client.close();
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }

  static async deleteFileOrFolder(conn: ConnectionItem, targetPath: string, isDir: boolean): Promise<boolean> {
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
      if (isDir) {
        await client.removeDir(targetPath);
      } else {
        await client.remove(targetPath);
      }
      return true;
    } catch (e) {
      vscode.window.showErrorMessage('FTP: ' + (e instanceof Error ? e.message : String(e)));
      return false;
    } finally {
      client.close();
    }
  }

    static async deleteFolderRecursive(conn: ConnectionItem, dirPath: string): Promise<boolean> {
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
      // List all items in the directory
      const list = await client.list(dirPath);
      for (const entry of list) {
        const entryPath = (dirPath.endsWith('/') ? dirPath : dirPath + '/') + entry.name;
        if (entry.isDirectory) {
          // Recursively delete subdirectory
          const ok = await FtpOps.deleteFolderRecursive(conn, entryPath);
          if (!ok) return false;
        } else {
          // Delete file
          await client.remove(entryPath);
        }
      }
      // Remove the (now empty) directory itself
      await client.removeDir(dirPath);
      return true;
    } catch (e) {
      vscode.window.showErrorMessage('FTP: ' + (e instanceof Error ? e.message : String(e)));
      return false;
    } finally {
      client.close();
    }
  }
}
