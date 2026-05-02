export class PropertiesFormatHelper {
  static formatDate(value: any, unknownLabel: string, numberAsEpochSeconds: boolean = false): string {
    if (value === undefined || value === null || value === '') {
      return unknownLabel;
    }

    if (typeof value === 'number' && value <= 0) {
      return unknownLabel;
    }

    const date = value instanceof Date
      ? value
      : new Date(typeof value === 'number' && numberAsEpochSeconds ? value * 1000 : value);

    if (Number.isNaN(date.getTime())) {
      return unknownLabel;
    }

    return date.toLocaleString();
  }

  static formatSize(size: number | undefined, isDirectory: boolean, unknownLabel: string): string {
    if (isDirectory) {
      return '-';
    }

    if (!Number.isFinite(size as number)) {
      return unknownLabel;
    }

    const bytes = Number(size);
    if (bytes < 1024) {
      return `${Math.floor(bytes)} B`;
    }

    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let value = bytes / 1024;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }

    const maximumFractionDigits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
    const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value);
    return `${formatted} ${units[unitIndex]}`;
  }
}
