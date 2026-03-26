import { ConnectionItem } from '../types';

export class ConnectionManager {
  private connections: ConnectionItem[];
  private onChange: () => void;

  constructor(connections: ConnectionItem[], onChange: () => void) {
    this.connections = connections;
    this.onChange = onChange;
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
    const dragged = this.connections.filter(c => draggedLabels.includes(c.label));
    this.connections = this.connections.filter(c => !draggedLabels.includes(c.label));
    const idx = this.connections.findIndex(c => c.label === targetLabel);
    if (idx !== -1) {
      this.connections.splice(idx, 0, ...dragged);
      this.onChange();
    }
  }
}
