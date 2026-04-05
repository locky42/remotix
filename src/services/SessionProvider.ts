import { Client as SshClient } from 'ssh2';
import { Client as FtpClient } from 'basic-ftp';
import { LoggerService } from './LoggerService';

export type RemoteSession = SshClient | FtpClient;

export class SessionProvider {
  private static sessions: Record<string, RemoteSession> = {};
  private static manuallyClosed: Set<string> = new Set();

  static async checkConnection(key: string): Promise<boolean> {
    const session = this.sessions[key];
    if (!session) return false;

    try {
      if (session instanceof SshClient || ('exec' in session && typeof (session as any).exec === 'function')) {
        const ssh = session as SshClient;
        
        if ((ssh as any)._sock && (ssh as any)._sock.destroyed) return false;

        return await new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => resolve(false), 2000);
          ssh.exec('true', (err, stream) => {
            if (err) {
              clearTimeout(timeout);
              return resolve(false);
            }
            stream.on('close', () => {
              clearTimeout(timeout);
              resolve(true);
            }).resume();
          });
        });
      }

      if ('closed' in session && 'pwd' in session) {
        const ftp = session as FtpClient;
        
        if (ftp.closed) return false;

        await Promise.race([
          ftp.pwd(),
          new Promise((_, reject) => setTimeout(() => reject(), 2000))
        ]);
        return true;
      }

      return false;
    } catch (e: any) {
      LoggerService.log(`[SessionProvider] Connection dead for ${key}: ${e.message || e}`);
      return false;
    }
  }

  static async getSession<T>(key: string, service?: any): Promise<T> {
    const session = this.sessions[key];
    
    if (session) {
      const isAlive = await this.checkConnection(key);
      if (isAlive) {
        return session as T;
      }
      LoggerService.log(`[SessionProvider] Session ${key} is dead. Cleaning up...`);
    }
    
    this.closeSession(key);

    if (!service) {
      throw new Error(`No active session for ${key} and no service provided.`);
    }

    LoggerService.log(`[SessionProvider] Establishing new connection for: ${key}`);
    const newClient = await service.connect(key); 
    
    if (!newClient) {
      throw new Error(`Failed to connect ${key}`);
    }

    return newClient as T;
  }

  static setSession(key: string, session: RemoteSession) {
    this.manuallyClosed.delete(key);
    this.sessions[key] = session;
  }

  static hasSession(key: string): boolean {
    return key in this.sessions;
  }

  static isManuallyClosed(key: string): boolean {
    return this.manuallyClosed.has(key);
  }

  static clearManualClose(key: string) {
    this.manuallyClosed.delete(key);
  }

  static closeSession(key: string, manual: boolean = false) {
    if (manual) {
      this.manuallyClosed.add(key);
    }
    const session = this.sessions[key];
    if (session) {
      try {
        if ('end' in session && typeof (session as any).end === 'function') {
          (session as any).end();
        } else if ('close' in session && typeof (session as any).close === 'function') {
          (session as any).close();
        }
      } catch (e) {
      }
      delete this.sessions[key];
    }
  }
}
