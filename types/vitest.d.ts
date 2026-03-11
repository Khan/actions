import "vitest";

declare module "vitest" {
    interface Assertion<T = any> {
        toContainNone(forbidden: T): void;
    }
    interface AsymmetricMatchersContaining<T = any> {
        toContainNone(forbidden: T): void;
    }
}
