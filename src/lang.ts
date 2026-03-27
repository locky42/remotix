import * as fs from 'fs';
import * as path from 'path';

let langData: Record<string, string> = {};
let currentLang = 'en';

export function setLang(lang: string) {
  currentLang = lang;
  loadLang();
}

export function t(key: string, vars?: Record<string, string|number>): string {
  let str = langData[key] || key;
  if (vars) {
    for (const k in vars) {
      str = str.replace(new RegExp(`{${k}}`, 'g'), String(vars[k]));
    }
  }
  return str;
}

function loadLang() {
  try {
    const langPath = path.join(__dirname, 'lang', `${currentLang}.json`);
    if (fs.existsSync(langPath)) {
      langData = JSON.parse(fs.readFileSync(langPath, 'utf8'));
      return;
    }
  } catch {}
  // fallback to en
  const enPath = path.join(__dirname, 'lang', 'en.json');
  if (fs.existsSync(enPath)) {
    langData = JSON.parse(fs.readFileSync(enPath, 'utf8'));
  } else {
    langData = {};
  }
}

// Load default language on import
loadLang();
