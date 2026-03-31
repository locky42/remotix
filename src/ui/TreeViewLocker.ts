import * as vscode from 'vscode';

export class TreeViewLocker {
  private _locked = false;
  private _lockMessage = '';
  private _statusBarItem: vscode.StatusBarItem;

  constructor() {
    this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this._statusBarItem.hide();
  }

  lock(message: string) {
    this._locked = true;
    this._lockMessage = message;
    this._statusBarItem.text = `$(lock) ${message}`;
    this._statusBarItem.show();
  }

  unlock() {
    this._locked = false;
    this._lockMessage = '';
    this._statusBarItem.hide();
  }

  isLocked() {
    return this._locked;
  }

  dispose() {
    this._statusBarItem.dispose();
  }
}
