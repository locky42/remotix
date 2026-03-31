import * as vscode from 'vscode';
import { LangService } from '../services/LangService';
import { ConfigService } from '../services/ConfigService';

export function registerUiCommands(context: vscode.ExtensionContext, treeDataProvider: any) {
    context.subscriptions.push(vscode.commands.registerCommand('remotixView.itemClick', async (item: any) => {
        console.log('[remotixView.itemClick] item:', item);
        await vscode.commands.executeCommand('remotix.editFile', item);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('remotix.moreActions', async () => {
        const pick = await vscode.window.showQuickPick([
        { label: LangService.t('importSshConfig'), action: 'importSshConfig' },
        { label: LangService.t('importFileZilla'), action: 'importFileZilla' }
        ], { placeHolder: LangService.t('chooseAction') });
        if (!pick) return;
        if (pick.action === 'importSshConfig') {
        await vscode.commands.executeCommand('remotix.importSshConfig');
        } else if (pick.action === 'importFileZilla') {
        await vscode.commands.executeCommand('remotix.importFileZilla');
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('remotix.refresh', async () => {
        treeDataProvider.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('remotix.showConfig', async () => {
        const config = ConfigService.getGlobalConfig(context);
        vscode.window.showInformationMessage(LangService.t('globalConfigPrefix') + JSON.stringify(config));
    }));
}
