import * as fs from 'fs';
import * as path from 'path';

export class LangService {
  private static langData: Record<string, string> = {};
  private static currentLang = 'en';

  static setLang(lang: string) {
    LangService.currentLang = lang;
    LangService.loadLang();
  }

  static t(key: string, vars?: Record<string, string|number>): string {
    let str = LangService.langData[key] || key;
    if (vars) {
      for (const k in vars) {
        str = str.replace(new RegExp(`{${k}}`, 'g'), String(vars[k]));
      }
    }
    return str;
  }

  public static loadLang() {
    try {
      const langPath = path.join(__dirname, '../static/lang', `${LangService.currentLang}.json`);
      if (fs.existsSync(langPath)) {
        LangService.langData = JSON.parse(fs.readFileSync(langPath, 'utf8'));
        return;
      }
    } catch {}

    const enPath = path.join(__dirname, '../static/lang', 'en.json');
    if (fs.existsSync(enPath)) {
      LangService.langData = JSON.parse(fs.readFileSync(enPath, 'utf8'));
    } else {
      LangService.langData = {};
    }
  }
}

LangService.loadLang();
