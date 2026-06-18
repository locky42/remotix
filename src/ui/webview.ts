import * as fs from 'fs';
import * as path from 'path';
import { ConnectionItem } from '../types';
import { LangService } from '../services/LangService';
import { ViewHelper } from '../helpers/ViewHelper';
import { ConfigService } from '../services/ConfigService';
import { LoggerService } from '../services/LoggerService';

export async function getAddConnectionHtml(init?: Partial<ConnectionItem>): Promise<string> {
    let htmlPath = path.join(__dirname, '../static/ui/addConnection.html');
    if (!fs.existsSync(htmlPath)) {
        htmlPath = path.join(__dirname, '../../static/ui/addConnection.html');
    }

    let hostValue = '';
    if (typeof init?.host === 'string') {
        hostValue = init.host;
    } else if (typeof init?.detail === 'string') {
        const parts = init.detail.split('@');
        hostValue = parts[1]?.split(':')[0] || '';
    }
    
    let userValue = typeof init?.user === 'string' ?
    init.user :
    (typeof init?.detail === 'string') ? init.detail.split('@')[0] || '' : '';
    const passwordValue = init?.password ?? await ConfigService.getPassword(init?.label || '') ?? '';
    let html = ViewHelper.setDynamicValues(htmlPath, {
        TITLE: init ? LangService.t('editConnectionTitle') : LangService.t('addConnectionTitle'),
        SUBMIT: init ? LangService.t('submitSave') : LangService.t('submitAdd'),
        GLOBAL: LangService.t('global'),
        TYPE_LABEL: LangService.t('typeLabel'),
        SSH: LangService.t('ssh'),
        FTP: LangService.t('ftp'),
        NAME: LangService.t('name'),
        HOST: LangService.t('host'),
        PORT: LangService.t('port'),
        USER: LangService.t('user'),
        AUTH_METHOD_LABEL: LangService.t('authMethodLabel'),
        PASSWORD: LangService.t('password'),
        SHOW_PASSWORD: LangService.t('showPassword'),
        HIDE_PASSWORD: LangService.t('hidePassword'),
        COPY_PASSWORD: LangService.t('copyPassword'),
        SSH_KEY: LangService.t('sshKey'),
        PASSWORD_SELECTED: init?.authMethod === 'password' ? 'selected' : '',
        KEY_SELECTED: init?.authMethod === 'privateKey' ? 'selected' : '',
        PASSWORD_VALUE: passwordValue,
        AUTH_FILE_LABEL: LangService.t('authFileLabel'),
        AUTH_FILE_PLACEHOLDER: LangService.t('authFilePlaceholder'),
        AUTH_FILE_VALUE: init?.authFile || '',
        PICK_FILE: LangService.t('pickFile'),
        CANCEL: LangService.t('cancel'),
        SSH_SELECTED: init?.type === 'ssh' ? 'selected' : '',
        FTP_SELECTED: init?.type === 'ftp' ? 'selected' : '',
        LABEL_VALUE: init?.label ? (init.label.replace(/^\w+: /, '')) : '',
        HOST_VALUE: hostValue,
        PORT_VALUE: String(init?.port ?? '22'),
        USER_VALUE: userValue
    });

    LoggerService.log(`[password]:${passwordValue}`);

    return html;
}
