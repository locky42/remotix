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

    return `${size} B`;
  }
}
