import { Client as SshClient } from 'ssh2';
import { Client as FtpClient } from 'basic-ftp';

// Тип для сесії: може бути SSH або FTP
export type RemoteSession = SshClient | FtpClient;

export class SessionProvider {
  private static sessions: Record<string, RemoteSession> = {};

  static getSession<T extends RemoteSession>(key: string): T | undefined {
    return this.sessions[key] as T | undefined;
  }

  static setSession(key: string, session: RemoteSession) {
    this.sessions[key] = session;
  }

  static closeSession(key: string) {
    const session = this.sessions[key];
    if (session) {
      if (typeof (session as any).end === 'function') {
        (session as any).end();
      } else if (typeof (session as any).close === 'function') {
        (session as any).close();
      }
      delete this.sessions[key];
    }
  }

  static closeAllSessions() {
    for (const key of Object.keys(this.sessions)) {
      this.closeSession(key);
    }
  }
}
