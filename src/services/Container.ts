export class Container {
    private static instances: Map<string, any> = new Map();

    public static get<T>(key: string): T {
        if (!this.has(key)) {
            throw new Error(`Container dependency is not registered: ${key}`);
        }
        return this.instances.get(key) as T;
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
