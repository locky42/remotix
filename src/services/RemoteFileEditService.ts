import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { LangService } from './LangService';
import { RemoteFileEditOptions } from '../types';
import { LoggerService } from './LoggerService';

export class RemoteFileEditService {
  public async openWithTempFiles(options: RemoteFileEditOptions): Promise<void> {
    LoggerService.log(`openWithTempFiles: remoteFiles count=${options.remoteFiles.length}`, 'RemoteFileEditService', 'info');
    LoggerService.log(options, 'DEBUG openWithTempFiles')
    const activeTmpFiles = new Map<string, string>();
    for (const remotePath of options.remoteFiles) {
      const tmpFile = this.buildTempFilePath(remotePath, options.host, options.tmpFolderPrefix);
      fs.mkdirSync(path.dirname(tmpFile), { recursive: true });

      await options.downloadToTemp(tmpFile);
      activeTmpFiles.set(tmpFile, remotePath);

      const doc = await vscode.workspace.openTextDocument(tmpFile);
      await vscode.window.showTextDocument(doc, { preview: false });
    }

    vscode.window.setStatusBarMessage(LangService.t('remoteFilesOpened', {
      count: options.remoteFiles.length
    }), 5000);

    const subscriptions: vscode.Disposable[] = [];

    subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (savedDoc) => {
      if (!activeTmpFiles.has(savedDoc.fileName)) return;

      try {
        await options.uploadFromTemp(savedDoc.fileName);
        vscode.window.setStatusBarMessage(LangService.t('fileSavedToServer'), 2000);
      } catch (uploadError: unknown) {
        options.logCleanupError?.(uploadError);
        vscode.window.showErrorMessage(LangService.t('fileUploadError', {
          error: uploadError instanceof Error ? uploadError.message : String(uploadError),
        }));
      }
    }));

    subscriptions.push(vscode.workspace.onDidCloseTextDocument((closedDoc) => {
      if (!activeTmpFiles.has(closedDoc.fileName)) return;

      const tmpFile = closedDoc.fileName;
      activeTmpFiles.delete(tmpFile);

      try {
        if (fs.existsSync(tmpFile)) {
          fs.unlinkSync(tmpFile);
        }
      } catch (cleanupError) {
        options.logCleanupError?.(cleanupError);
      }

      if (activeTmpFiles.size === 0) {
        subscriptions.forEach((sub) => sub.dispose());
      }
    }));
  }

  private buildTempFilePath(remotePath: string, host: string | undefined, tmpFolderPrefix: string): string {
    const safeHost = String(host || 'unknown_host').replace(/[^\w]/g, '_');
    
    const fileName = path.basename(remotePath).replace(/[^\w.\-]/g, '_');
    const safeRelPath = String(remotePath || '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .split('/')
      .slice(0, -1)
      .map((segment) => segment.replace(/[^\w.\-]/g, '_'))
      .join(path.sep);

    const tmpDir = path.join(os.tmpdir(), `${tmpFolderPrefix}_${safeHost}`, safeRelPath);
    
    return path.join(tmpDir, `${Date.now()}_${fileName}`);
  }
}
