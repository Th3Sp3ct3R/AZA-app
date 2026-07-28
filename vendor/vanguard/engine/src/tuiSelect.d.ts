export interface SelectItem<T> {
    readonly value: T;
    readonly label: string;
    /** Dimmed trailing detail, e.g. "most capable" or "signed in". */
    readonly note?: string;
}
export interface SelectOptions<T> {
    readonly title: string;
    readonly items: readonly SelectItem<T>[];
    /** Index highlighted first; clamped into range. */
    readonly initialIndex?: number;
    readonly hint?: string;
    /** Defaults on for catalogs larger than eight entries. */
    readonly searchable?: boolean;
    /** Erase the selector frame on close so the caller can print a recap line. */
    readonly collapseOnClose?: boolean;
}
export declare class SelectCancelled extends Error {
    constructor();
}
export declare function filterSelectItems<T>(items: readonly SelectItem<T>[], query: string): readonly SelectItem<T>[];
/** Resolve the chosen value, or reject with SelectCancelled on Esc / Ctrl+C. */
export declare function select<T>(options: SelectOptions<T>): Promise<T>;
