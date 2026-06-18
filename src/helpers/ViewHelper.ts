import * as fs from 'fs';

export class ViewHelper {
    static setDynamicValue(html: string, placeholder: string, value: string): string {
        const regex = new RegExp(`\\{\\{${placeholder}\\}\\}`, 'g');
        return html.replace(regex, value);
    }

    static setDynamicValues(htmlPath: string, values: { [key: string]: string }): string {
        let html = fs.readFileSync(htmlPath, 'utf8');
        for (const key in values) {
            html = this.setDynamicValue(html, key, values[key]);
        }
        return html;
    }
}
