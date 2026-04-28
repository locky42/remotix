import { ConnectionItem } from '../types';
import { ConfigService } from './ConfigService';

export class ConnectionManager {
  private connections: ConnectionItem[] = [];
  private onChange: (type?: string) => void;

  constructor(onChange: (type?: string) => void = () => {}) {
    this.onChange = onChange;
    this.load();
  }

  setOnChange(onChange: (type?: string) => void) {
    this.onChange = onChange;
  }

  load() {
    const connections = ConfigService.getGlobalConfig().connections;
    this.connections.length = 0;
    this.connections.push(...connections);
    this.onChange();
  }

  getAll() {
    return this.connections;
  }

  getByLabel(label: string): ConnectionItem | undefined {
    return this.connections.find(c => c.label === label);
  }

  add(conn: ConnectionItem) {
    if (!this.connections.some(c => c.host === conn.host && c.port === conn.port && c.user === conn.user && c.type === conn.type)) {
      this.connections.push(conn);
      this.onChange();
    }
  }

  remove(label: string) {
    const idx = this.connections.findIndex(c => c.label === label);
    if (idx !== -1) {
      this.connections.splice(idx, 1);
      this.onChange();
    }
  }

  reorder(draggedLabels: string[], targetLabel: string) {
    // Self-drop guard: if all dragged items are the same as target, nothing to do
    if (draggedLabels.length === 1 && draggedLabels[0] === targetLabel) return;

    const dragged = this.connections.filter(c => draggedLabels.includes(c.label));
    this.connections = this.connections.filter(c => !draggedLabels.includes(c.label));
    const idx = this.connections.findIndex(c => c.label === targetLabel);
    if (idx !== -1) {
      this.connections.splice(idx, 0, ...dragged);
    } else {
      // Target not found - append dragged at end to avoid losing connections
      this.connections.push(...dragged);
    }
    ConfigService.saveGlobalConfig({ connections: this.connections });
    // Don't fire onChange here - caller will do it after reorder mode is cleared
  }
}
