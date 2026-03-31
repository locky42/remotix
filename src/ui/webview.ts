import * as path from 'path';
import * as fs from 'fs';
import { LangService } from '../services/LangService';
import { ConnectionItem } from '../types';

export function getAddConnectionHtml(init?: Partial<ConnectionItem>): string {
    let htmlPath = path.join(__dirname, '../static/ui/addConnection.html');
    if (!fs.existsSync(htmlPath)) {
        htmlPath = path.join(__dirname, '../../static/ui/addConnection.html');
    }
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace(/\{\{TITLE\}\}/g, init ? LangService.t('editConnectionTitle') : LangService.t('addConnectionTitle'));
    html = html.replace(/\{\{SUBMIT\}\}/g, init ? LangService.t('submitSave') : LangService.t('submitAdd'));
    html = html.replace(/\{\{GLOBAL\}\}/g, LangService.t('global'));
    html = html.replace(/\{\{TYPE_LABEL\}\}/g, LangService.t('typeLabel'));
    html = html.replace(/\{\{SSH\}\}/g, LangService.t('ssh'));
    html = html.replace(/\{\{FTP\}\}/g, LangService.t('ftp'));
    html = html.replace(/\{\{NAME\}\}/g, LangService.t('name'));
    html = html.replace(/\{\{HOST\}\}/g, LangService.t('host'));
    html = html.replace(/\{\{PORT\}\}/g, LangService.t('port'));
    html = html.replace(/\{\{USER\}\}/g, LangService.t('user'));
    html = html.replace(/\{\{AUTH_METHOD_LABEL\}\}/g, LangService.t('authMethodLabel'));
    html = html.replace(/\{\{PASSWORD\}\}/g, LangService.t('password'));
    html = html.replace(/\{\{SSH_KEY\}\}/g, LangService.t('sshKey'));
    html = html.replace(/\{\{PASSWORD_SELECTED\}\}/g, init?.authMethod === 'password' ? 'selected' : '');
    html = html.replace(/\{\{KEY_SELECTED\}\}/g, init?.authMethod === 'privateKey' ? 'selected' : '');
    html = html.replace(/\{\{PASSWORD_VALUE\}\}/g, init?.password || '');
    html = html.replace(/\{\{AUTH_FILE_LABEL\}\}/g, LangService.t('authFileLabel'));
    html = html.replace(/\{\{AUTH_FILE_PLACEHOLDER\}\}/g, LangService.t('authFilePlaceholder'));
    html = html.replace(/\{\{AUTH_FILE_VALUE\}\}/g, init?.authFile || '');
    html = html.replace(/\{\{PICK_FILE\}\}/g, LangService.t('pickFile'));
    html = html.replace(/\{\{CANCEL\}\}/g, LangService.t('cancel'));
    html = html.replace(/\{\{SSH_SELECTED\}\}/g, init?.type === 'ssh' ? 'selected' : '');
    html = html.replace(/\{\{FTP_SELECTED\}\}/g, init?.type === 'ftp' ? 'selected' : '');
    html = html.replace(/\{\{LABEL_VALUE\}\}/g, init?.label ? (init.label.replace(/^\w+: /, '')) : '');
    // HOST
    let hostValue = '';
    if (typeof init?.host === 'string') {
        hostValue = init.host;
    } else if (typeof init?.detail === 'string') {
        const parts = init.detail.split('@');
        hostValue = parts[1]?.split(':')[0] || '';
    }
    html = html.replace(/\{\{HOST_VALUE\}\}/g, hostValue);
    // PORT
    html = html.replace(/\{\{PORT_VALUE\}\}/g, init?.port || '22');
    // USER
    let userValue = '';
    if (typeof init?.user === 'string') {
        userValue = init.user;
    } else if (typeof init?.detail === 'string') {
        userValue = init.detail.split('@')[0] || '';
    }
    html = html.replace(/\{\{USER_VALUE\}\}/g, userValue);
    return html;
}
