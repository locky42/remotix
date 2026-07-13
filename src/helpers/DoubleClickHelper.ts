export class DoubleClickHelper {
    private static lastClickTimes = new Map<string, number>();

    public static isDoubleClick(key: string): boolean {
        const now = Date.now();
        const lastClick = this.lastClickTimes.get(key) || 0;
        
        if (now - lastClick < 400) {
            this.lastClickTimes.delete(key);
            return true;
        }
        
        this.lastClickTimes.set(key, now);
        return false;
    }
}
