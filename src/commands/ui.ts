import * as vscode from 'vscode';
import { Container } from '../services/Container';
import { LangService } from '../services/LangService';
import { ConfigService } from '../services/ConfigService';
import { TreeDataProvider } from '../ui/TreeDataProvider';

export function registerUiCommands() {
    const context = Container.get('extensionContext') as vscode.ExtensionContext;
    const treeDataProvider = Container.get('treeDataProvider') as TreeDataProvider;

    context.subscriptions.push(vscode.commands.registerCommand('remotixView.itemClick', async (item: any) => {
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
        const config = ConfigService.getGlobalConfig();
        vscode.window.showInformationMessage(LangService.t('globalConfigPrefix') + JSON.stringify(config));
    }));
}
