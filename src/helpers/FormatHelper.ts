export class FormatHelper {
  static formatData(data: any): string {
    if (typeof data === 'object') {
      return JSON.stringify(data, null, 2);
    } else if (Array.isArray(data)) {
      return JSON.stringify(data, null, 2);
    } else {
      return String(data);
    }
  }
}
