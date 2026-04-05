import * as vscode from 'vscode';

export class TreeViewLocker {
  private _locked = false;
  private _lockMessage = '';
  private _lockedConnectionLabel?: string;
  private _lastNotifyTs = 0;
  private _statusBarItem: vscode.StatusBarItem;

  constructor() {
    this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this._statusBarItem.hide();
  }

  lock(message: string, connectionLabel?: string) {
    this._locked = true;
    this._lockMessage = message;
    this._lockedConnectionLabel = connectionLabel;
    this._statusBarItem.text = `$(lock) ${message}`;
    this._statusBarItem.show();
  }

  unlock() {
    this._locked = false;
    this._lockMessage = '';
    this._lockedConnectionLabel = undefined;
    this._statusBarItem.hide();
  }

  isLocked() {
    return this._locked;
  }

  isLockedFor(connectionLabel?: string) {
    if (!this._locked) {
      return false;
    }
    if (!this._lockedConnectionLabel) {
      return true;
    }
    return this._lockedConnectionLabel === connectionLabel;
  }

  notifyBlockedActivity() {
    if (!this._locked) {
      return;
    }
    const now = Date.now();
    const message = this._lockMessage || 'Remotix: tree is temporarily locked by an active operation.';

    vscode.window.setStatusBarMessage(`Remotix: ${message}`, 2500);

    if (now - this._lastNotifyTs > 5000) {
      this._lastNotifyTs = now;
      vscode.window.showInformationMessage(message);
    }
  }

  dispose() {
    this._statusBarItem.dispose();
  }
}
