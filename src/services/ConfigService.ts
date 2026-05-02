import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Container } from './Container';
import { RemotixConfig } from '../types';

export class ConfigService {
  static getConcurrencyLimit(settingKey: string, defaultValue: number, min: number = 1, max: number = 10): number {
    const configured = vscode.workspace.getConfiguration('remotix').get<number>(settingKey, defaultValue);
    const numeric = Number(configured);
    const fallback = Number(defaultValue);
    const value = Number.isFinite(numeric) ? numeric : fallback;
    const lowerBound = Number.isFinite(Number(min)) ? Number(min) : 1;
    const upperBound = Number.isFinite(Number(max)) ? Number(max) : 10;
    return Math.max(lowerBound, Math.min(upperBound, Math.floor(value)));
  }

  private static async migratePasswordsFromConfigFile(configPath: string, source: 'global' | 'project'): Promise<number> {
    if (!fs.existsSync(configPath)) {
      return 0;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!raw || !Array.isArray(raw.connections)) {
        return 0;
      }

      let migratedCount = 0;
      for (const conn of raw.connections) {
        const label = typeof conn?.label === 'string' ? conn.label : '';
        const password = typeof conn?.password === 'string' ? conn.password : '';
        if (label && password) {
          await ConfigService.storePassword(label, password);
          delete conn.password;
          migratedCount++;
        }
      }

      if (migratedCount > 0) {
        fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), 'utf8');
      }

      return migratedCount;
    } catch (error: any) {
      return 0;
    }
  }

  /**
   * One-time migration from legacy config-file passwords to SecretStorage.
   */
  static async migrateLegacyPasswordsFromConfigFiles(): Promise<void> {
    const globalPath = ConfigService.getGlobalConfigPath();
    const projectPath = ConfigService.getProjectConfigPath();

    await ConfigService.migratePasswordsFromConfigFile(globalPath, 'global');
    await ConfigService.migratePasswordsFromConfigFile(projectPath, 'project');
  }

  /**
   * Store a password in SecretStorage for a connection.
   */
  static async storePassword(label: string, password: string) {
    const context = Container.get('extensionContext') as vscode.ExtensionContext;
    if (label && password) {
      await context.secrets.store(`remotix:password:${label}`, password);
    }
  }

  /**
   * Retrieve a password from SecretStorage for a connection.
   */
  static async getPassword(label: string): Promise<string | undefined> {
    const context = Container.get('extensionContext') as vscode.ExtensionContext;
    if (!label) return undefined;
    const exact = await context.secrets.get(`remotix:password:${label}`);
    if (exact) {
      return exact;
    }

    // Backward compatibility for older key formats or label changes.
    const candidates = new Set<string>();
    const trimmed = label.trim();
    candidates.add(trimmed);

    if (/^(SSH|FTP):\s+/i.test(trimmed)) {
      candidates.add(trimmed.replace(/^(SSH|FTP):\s+/i, ''));
    } else {
      candidates.add(`SSH: ${trimmed}`);
      candidates.add(`FTP: ${trimmed}`);
    }

    for (const candidate of candidates) {
      const value = await context.secrets.get(`remotix:password:${candidate}`);
      if (value) {
        return value;
      }
    }

    return undefined;
  }

  /**
   * Delete a password from SecretStorage for a connection.
   */
  static async deletePassword(label: string) {
    const context = Container.get('extensionContext') as vscode.ExtensionContext;
    if (label) {
      await context.secrets.delete(`remotix:password:${label}`);
    }
  }

  /**
   * Move password secret from one connection label to another.
   */
  static async movePassword(oldLabel: string, newLabel: string) {
    if (!oldLabel || !newLabel || oldLabel === newLabel) {
      return;
    }

    const value = await ConfigService.getPassword(oldLabel);
    if (value) {
      await ConfigService.storePassword(newLabel, value);
    }
    await ConfigService.deletePassword(oldLabel);
  }

  /**
   * Loads global config, excluding passwords (passwords are managed in SecretStorage).
   */
  static getGlobalConfig(): RemotixConfig {
    const configPath = ConfigService.getGlobalConfigPath();
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (raw && Array.isArray(raw.connections)) {
        raw.connections.forEach((c: any) => {
          if ('password' in c) delete c.password;
        });
      }
      return raw;
    }
    return { connections: [] };
  }

  /**
   * Saves global config, excluding passwords (passwords are managed in SecretStorage).
   */
  static saveGlobalConfig(config: RemotixConfig) {
    const configPath = ConfigService.getGlobalConfigPath();
    const sanitized = {
      ...config,
      connections: config.connections.map(c => {
        const { password, ...rest } = c;
        return rest;
      })
    };
    fs.writeFileSync(configPath, JSON.stringify(sanitized, null, 2), 'utf8');
  }

  private static getGlobalConfigPath() {
    const context = Container.get('extensionContext') as vscode.ExtensionContext;
    const dir = context.globalStorageUri.fsPath;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'remotix-connections.json');
  }

  /**
   * Loads project config, excluding passwords (passwords are managed in SecretStorage).
   */
  static getProjectConfig(): RemotixConfig {
    const configPath = ConfigService.getProjectConfigPath();
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (raw && Array.isArray(raw.connections)) {
        raw.connections.forEach((c: any) => {
          if ('password' in c) delete c.password;
        });
      }
      return raw;
    }
    return { connections: [] };
  }

  /**
   * Saves project config, excluding passwords (passwords are managed in SecretStorage).
   */
  static saveProjectConfig(config: RemotixConfig) {
    const configPath = ConfigService.getProjectConfigPath();
    const sanitized = {
      ...config,
      connections: config.connections.map(c => {
        const { password, ...rest } = c;
        return rest;
      })
    };
    fs.writeFileSync(configPath, JSON.stringify(sanitized, null, 2), 'utf8');
  }

  private static getProjectConfigPath() {
    const wsFolders = vscode.workspace.workspaceFolders;
    if (!wsFolders || wsFolders.length === 0) return '.remotix-connections.json';
    return path.join(wsFolders[0].uri.fsPath, '.remotix-connections.json');
  }
}
