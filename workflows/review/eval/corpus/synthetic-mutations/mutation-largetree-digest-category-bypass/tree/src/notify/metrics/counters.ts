const counters = new Map<string, number>();

export const bump = (name: string, by = 1): void => {
    counters.set(name, (counters.get(name) ?? 0) + by);
};

export const counterValue = (name: string): number => counters.get(name) ?? 0;
