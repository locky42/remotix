import * as vscode from 'vscode';
import { RemotePathHelper } from './RemotePathHelper';
import { RemoteClipboard } from '../types';

export class RemoteClipboardHelper {
  private static readonly REMOTIX_CLIPBOARD_PREFIX = 'remotix-clipboard:';

  static serializeRemoteClipboard(payload: RemoteClipboard): string {
    return `${RemoteClipboardHelper.REMOTIX_CLIPBOARD_PREFIX}${encodeURIComponent(JSON.stringify(payload))}`;
  }

  static parseRemoteClipboard(raw: string): RemoteClipboard | undefined {
    const text = String(raw || '').trim();
    if (!text.startsWith(RemoteClipboardHelper.REMOTIX_CLIPBOARD_PREFIX)) {
      return undefined;
    }

    const encoded = text.slice(RemoteClipboardHelper.REMOTIX_CLIPBOARD_PREFIX.length);
    if (!encoded) {
      return undefined;
    }

    try {
      const decoded = decodeURIComponent(encoded);
      const data = JSON.parse(decoded) as Partial<RemoteClipboard>;
      if (
        typeof data?.connectionLabel !== 'string' ||
        typeof data?.sourcePath !== 'string' ||
        typeof data?.sourceName !== 'string' ||
        typeof data?.isDirectory !== 'boolean'
      ) {
        return undefined;
      }

      return {
        connectionLabel: data.connectionLabel,
        sourcePath: data.sourcePath,
        sourceName: data.sourceName,
        isDirectory: data.isDirectory,
        sourceKind: data.sourceKind === 'local' ? 'local' : 'remote'
      };
    } catch {
      return undefined;
    }
  }

  static parsePlainClipboardPath(raw: string): string | undefined {
    const text = String(raw || '').trim();
    if (!text || text.startsWith(RemoteClipboardHelper.REMOTIX_CLIPBOARD_PREFIX)) {
      return undefined;
    }

    // Accept first line only to avoid accidental multiline clipboard contents.
    const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (!firstLine) {
      return undefined;
    }

    return firstLine;
  }

  static async buildClipboardFromPlainPath(
    pathText: string,
    connectionLabel: string
  ): Promise<RemoteClipboard | undefined> {
    const fs = await import('fs');
    const sourcePath = pathText.trim();
    if (!sourcePath) {
      return undefined;
    }

    const sourceName = RemotePathHelper.getRemoteLeafName(sourcePath) || sourcePath;

    let isDirectory = /\/$/.test(sourcePath);
    let sourceKind: 'remote' | 'local' = 'remote';

    try {
      const stat = fs.statSync(sourcePath);
      sourceKind = 'local';
      isDirectory = stat.isDirectory();
    } catch {
    }

    if (!isDirectory && sourceKind === 'remote') {
      const picked = await vscode.window.showQuickPick(
        [
          { label: '$(file) File', value: 'file' },
          { label: '$(folder) Folder', value: 'folder' }
        ],
        { placeHolder: 'Clipboard path type' }
      );
      if (!picked) {
        return undefined;
      }
      isDirectory = picked.value === 'folder';
    }

    return {
      connectionLabel,
      sourcePath,
      sourceName,
      isDirectory,
      sourceKind
    };
  }
}
