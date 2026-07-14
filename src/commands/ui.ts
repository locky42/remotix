import * as vscode from 'vscode';
import { ConnectionStatus } from '../types';
import { Container } from '../services/Container';
import { LangService } from '../services/LangService';
import { ConfigService } from '../services/ConfigService';
import { TreeDataProvider } from '../ui/TreeDataProvider';
import { SessionProvider } from '../services/SessionProvider';
import { DoubleClickHelper } from '../helpers/DoubleClickHelper';

export const expandingConnections = new Set<string>();

export function registerUiCommands() {
    const context = Container.get('extensionContext') as vscode.ExtensionContext;
    const treeDataProvider = Container.get('treeDataProvider') as TreeDataProvider;

    context.subscriptions.push(vscode.commands.registerCommand('tentacle.moreActions', async () => {
        const pick = await vscode.window.showQuickPick([
            { label: LangService.t('export'), action: 'export' },
            { label: LangService.t('import'), action: 'import' },
            { label: LangService.t('importSshConfig'), action: 'importSshConfig' },
            { label: LangService.t('importFileZilla'), action: 'importFileZilla' }
        ], { placeHolder: LangService.t('chooseAction') });
        if (!pick) return;
        switch (pick.action) {
           case 'export':
            await vscode.commands.executeCommand('tentacle.export');
            break;
           case 'import':
            await vscode.commands.executeCommand('tentacle.import');
            break;
          case 'importSshConfig':
            await vscode.commands.executeCommand('tentacle.importSshConfig');
            break;
          case 'importFileZilla':
            await vscode.commands.executeCommand('tentacle.importFileZilla');
            break;
          default:
            console.warn(`Unknow action: ${pick.action}`);
            break;
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tentacle.openSettings', async () => {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:locky42.tentacle');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tentacle.setLanguage', async () => {
        const current = vscode.workspace.getConfiguration('tentacle').get<string>('language', 'auto');
        const pick = await vscode.window.showQuickPick([
            { label: LangService.t('languageAuto'), value: 'auto' },
            { label: LangService.t('languageEnglish'), value: 'en' },
            { label: LangService.t('languageUkrainian'), value: 'uk' }
        ], {
            placeHolder: LangService.t('chooseLanguage')
        });

        if (!pick || pick.value === current) {
            return;
        }

        await vscode.workspace.getConfiguration('tentacle').update('language', pick.value, vscode.ConfigurationTarget.Global);
        const effectiveLang = pick.value === 'auto'
            ? (vscode.env.language.toLowerCase().startsWith('uk') ? 'uk' : 'en')
            : pick.value;

        LangService.setLang(effectiveLang);
        treeDataProvider.refresh();
        vscode.window.showInformationMessage(LangService.t('languageChanged'));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tentacle.refresh', async (item?: vscode.TreeItem) => {
        if (item) {
            const label = (item as any).connectionLabel || (typeof item.label === 'string' ? item.label : undefined);
            if (label && (((item as any).contextValue === ConnectionStatus.Cold) || ((item as any).contextValue === ConnectionStatus.Active))) {
                SessionProvider.clearManualClose(String(label));
            }
            treeDataProvider.refresh(item);
            return;
        }
        treeDataProvider.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tentacle.showConfig', async () => {
        const config = ConfigService.getGlobalConfig();
        vscode.window.showInformationMessage(LangService.t('globalConfigPrefix') + JSON.stringify(config));
    }));

    const doubleClickCommand = vscode.commands.registerCommand(
        'tentacle.expandConnectionOnDoubleClick',
        async (item: vscode.TreeItem) => {
            const label = (item as any).connectionLabel || String(item.label);

            if (SessionProvider.hasSession(label)) {
                return;
            }

            if (DoubleClickHelper.isDoubleClick(label)) {
                (treeDataProvider as any).allowExpandOnce = label;
                const treeView = Container.get('treeView') as vscode.TreeView<vscode.TreeItem>;
                
                if (treeView) {
                    item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
                    treeDataProvider.refresh(item);
                    try {
                        await treeView.reveal(item, {
                            select: true,
                            focus: true,
                            expand: true
                        });
                    } catch (err) {
                        treeDataProvider.refresh(item);
                    }
                }

                (treeDataProvider as any).allowExpandOnce = undefined;
            }
        }
    );

    context.subscriptions.push(doubleClickCommand);

    context.subscriptions.push(vscode.commands.registerCommand('tentacle.elementDoubleClick', async (item: any) => {
        if (!item) return;

        const itemKey = (item as any).sshPath || (item as any).ftpPath || String(item.label);

        if (DoubleClickHelper.isDoubleClick(itemKey)) {
            await vscode.commands.executeCommand('tentacle.editFile', item);
        }
    }));
}
