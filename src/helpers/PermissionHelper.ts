export class PermissionHelper {
  static normalizePermissionMode(rawMode: string): string | undefined {
    const value = String(rawMode || '').trim();
    if (!/^[0-7]{3,4}$/.test(value)) {
      return undefined;
    }
    return value;
  }

  static parsePermissionTripletToOctal(triplet: string): number {
    let value = 0;
    if (triplet[0] === 'r') value += 4;
    if (triplet[1] === 'w') value += 2;
    if (triplet[2] === 'x' || triplet[2] === 's' || triplet[2] === 't') value += 1;
    return value;
  }

  static parsePermissionBlockToMode(permissionBlock: string): string | undefined {
    const value = String(permissionBlock || '').trim();
    if (value.length < 9) {
      return undefined;
    }

    const perms = value.length >= 10 ? value.slice(-9) : value;
    const owner = PermissionHelper.parsePermissionTripletToOctal(perms.slice(0, 3));
    const group = PermissionHelper.parsePermissionTripletToOctal(perms.slice(3, 6));
    const world = PermissionHelper.parsePermissionTripletToOctal(perms.slice(6, 9));
    return `${owner}${group}${world}`;
  }
}
