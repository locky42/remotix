import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { LangService } from './LangService';
import { RemoteFileEditOptions } from '../types';

export class RemoteFileEditService {
  public async openWithTempFile(options: RemoteFileEditOptions): Promise<void> {
    const tmpFile = this.buildTempFilePath(options.remotePath, options.host, options.tmpFolderPrefix);
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });

    await options.downloadToTemp(tmpFile);

    const doc = await vscode.workspace.openTextDocument(tmpFile);
    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Active });

    vscode.window.setStatusBarMessage(LangService.t('remoteFile', {
      user: options.user ?? '',
      host: options.host ?? '',
      path: options.remotePath,
    }), 5000);

    const subscriptions: vscode.Disposable[] = [];

    const saveSub = vscode.workspace.onDidSaveTextDocument(async (savedDoc) => {
      if (savedDoc.fileName !== tmpFile) {
        return;
      }

      try {
        await options.uploadFromTemp(tmpFile);
        vscode.window.setStatusBarMessage(LangService.t('fileSavedToServer'), 2000);
      } catch (uploadError: any) {
        vscode.window.showErrorMessage(LangService.t('fileUploadError', {
          error: uploadError instanceof Error ? uploadError.message : String(uploadError),
        }));
      }
    });
    subscriptions.push(saveSub);

    const closeSub = vscode.workspace.onDidCloseTextDocument((closedDoc) => {
      if (closedDoc.fileName !== tmpFile) {
        return;
      }

      subscriptions.forEach((sub) => sub.dispose());
      try {
        if (fs.existsSync(tmpFile)) {
          fs.unlinkSync(tmpFile);
        }
      } catch (cleanupError) {
        options.logCleanupError?.(cleanupError);
      }
    });
    subscriptions.push(closeSub);
  }

  private buildTempFilePath(remotePath: string, host: string | undefined, tmpFolderPrefix: string): string {
    const safeHost = String(host || 'unknown_host').replace(/[^\w]/g, '_');
    const safeRelPath = String(remotePath || '')
      .replace(/^\/+/, '')
      .split('/')
      .map((segment) => segment.replace(/[^\w.\-]/g, '_'))
      .join(path.sep);

    const tmpDir = path.join(os.tmpdir(), `${tmpFolderPrefix}_${safeHost}`);
    return path.join(tmpDir, safeRelPath);
  }
}
