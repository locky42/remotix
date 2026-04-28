import * as vscode from 'vscode';
import { PermissionStatus, RemoteBaseIcon } from '../types';

export class PermissionIconHelper {
  static createPermissionIcon(baseIcon: RemoteBaseIcon, status: PermissionStatus): vscode.Uri | vscode.ThemeIcon {
    if (!status) {
      switch (baseIcon) {
        case 'folder':
          return new vscode.ThemeIcon('folder');
        case 'file-code':
          return new vscode.ThemeIcon('file-code');
        case 'file-media':
          return new vscode.ThemeIcon('file-media');
        case 'file-zip':
          return new vscode.ThemeIcon('file-zip');
        case 'lock-file':
          return new vscode.ThemeIcon('lock');
        case 'file':
        default:
          return new vscode.ThemeIcon('file');
      }
    }

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">
        ${PermissionIconHelper.getBaseSvg(baseIcon)}
        ${PermissionIconHelper.getBadgeSvg(status)}
      </svg>
    `;

    return PermissionIconHelper.encodeSvg(svg);
  }

  private static encodeSvg(svg: string): vscode.Uri {
    return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
  }

  private static getBaseSvg(baseIcon: RemoteBaseIcon): string {
    switch (baseIcon) {
      case 'folder':
        return '<path d="M3.5 6A1.5 1.5 0 0 1 5 4.5h3.2c.4 0 .78.16 1.06.44l.75.75c.19.2.45.31.73.31H16A1.5 1.5 0 0 1 17.5 7.5v6A1.5 1.5 0 0 1 16 15H5A1.5 1.5 0 0 1 3.5 13.5V6Z" fill="none" stroke="#c5c5c5" stroke-width="1.2" stroke-linejoin="round"/>';
      case 'file-code':
        return '<path d="M6 2.75h6l3.25 3.25v10.25A1.75 1.75 0 0 1 13.5 18h-7A1.75 1.75 0 0 1 4.75 16.25v-11.75A1.75 1.75 0 0 1 6.5 2.75Z" fill="none" stroke="#c5c5c5" stroke-width="1.2" stroke-linejoin="round"/><path d="M12 2.75V6h3.25" fill="none" stroke="#c5c5c5" stroke-width="1.2" stroke-linejoin="round"/><path d="M8.8 10.2 7.4 11.6 8.8 13" stroke="#7aa2f7" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M11.2 9.8 10.15 13.4" stroke="#7aa2f7" stroke-width="1.15" stroke-linecap="round"/><path d="M12.3 10.2 13.7 11.6 12.3 13" stroke="#7aa2f7" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" fill="none"/>';
      case 'file-media':
        return '<path d="M6 2.75h6l3.25 3.25v10.25A1.75 1.75 0 0 1 13.5 18h-7A1.75 1.75 0 0 1 4.75 16.25v-11.75A1.75 1.75 0 0 1 6.5 2.75Z" fill="none" stroke="#c5c5c5" stroke-width="1.2" stroke-linejoin="round"/><path d="M12 2.75V6h3.25" fill="none" stroke="#c5c5c5" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8.7" cy="9.7" r="1.1" fill="none" stroke="#78c2ad" stroke-width="1.1"/><path d="M7.2 14.1l2.1-2.2a.85.85 0 0 1 1.24 0l1.1 1.16 1.55-1.53a.85.85 0 0 1 1.2.02l1.1 1.16" stroke="#78c2ad" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
      case 'file-zip':
        return '<path d="M6 2.75h6l3.25 3.25v10.25A1.75 1.75 0 0 1 13.5 18h-7A1.75 1.75 0 0 1 4.75 16.25v-11.75A1.75 1.75 0 0 1 6.5 2.75Z" fill="none" stroke="#c5c5c5" stroke-width="1.2" stroke-linejoin="round"/><path d="M12 2.75V6h3.25" fill="none" stroke="#c5c5c5" stroke-width="1.2" stroke-linejoin="round"/><path d="M9.8 6.5h.9v.9h-.9zm0 1.8h.9v.9h-.9zm0 1.8h.9v.9h-.9zm0 1.8h.9V15h-.9z" fill="#d19a66"/>';
      case 'lock-file':
        return '<path d="M6 2.75h6l3.25 3.25v10.25A1.75 1.75 0 0 1 13.5 18h-7A1.75 1.75 0 0 1 4.75 16.25v-11.75A1.75 1.75 0 0 1 6.5 2.75Z" fill="none" stroke="#c5c5c5" stroke-width="1.2" stroke-linejoin="round"/><path d="M12 2.75V6h3.25" fill="none" stroke="#c5c5c5" stroke-width="1.2" stroke-linejoin="round"/><rect x="8.3" y="11.1" width="4.4" height="3.6" rx=".8" fill="none" stroke="#8b949e" stroke-width="1.05"/><path d="M9.3 11.1V10a1.2 1.2 0 1 1 2.4 0v1.1" fill="none" stroke="#8b949e" stroke-width="1.05" stroke-linecap="round"/>';
      case 'file':
      default:
        return '<path d="M6 2.75h6l3.25 3.25v10.25A1.75 1.75 0 0 1 13.5 18h-7A1.75 1.75 0 0 1 4.75 16.25v-11.75A1.75 1.75 0 0 1 6.5 2.75Z" fill="none" stroke="#c5c5c5" stroke-width="1.2" stroke-linejoin="round"/><path d="M12 2.75V6h3.25" fill="none" stroke="#c5c5c5" stroke-width="1.2" stroke-linejoin="round"/>';
    }
  }

  private static getBadgeSvg(status: Exclude<PermissionStatus, undefined>): string {
    if (status === 'no-read') {
      return '<circle cx="16" cy="16" r="2.7" fill="#f14c4c"/><path d="M14.75 16h2.5" stroke="#ffffff" stroke-width=".95" stroke-linecap="round"/><path d="M15.35 15.4v-.55a.95.95 0 1 1 1.9 0v.55" fill="none" stroke="#ffffff" stroke-width=".8" stroke-linecap="round"/>';
    }

    return '<circle cx="16" cy="16" r="2.7" fill="#3794ff"/><path d="M14.1 16c.42-.7 1.08-1.08 1.9-1.08s1.48.38 1.9 1.08c-.42.7-1.08 1.08-1.9 1.08s-1.48-.38-1.9-1.08Z" fill="none" stroke="#ffffff" stroke-width=".8" stroke-linejoin="round"/><circle cx="16" cy="16" r=".45" fill="#ffffff"/>';
  }
}
