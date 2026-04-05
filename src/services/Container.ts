export class Container {
    private static instances: Map<string, any> = new Map();

    public static get<T>(key: string): T {
        return this.instances.get(key);
    }

    public static set<T>(key: string, instance: T): void {
        this.instances.set(key, instance);
    }

    public static has(key: string): boolean {
        return this.instances.has(key);
    }

    public static delete(key: string): void {
        this.instances.delete(key);
    }

    public static clear(): void {
        this.instances.clear();
    }
}
