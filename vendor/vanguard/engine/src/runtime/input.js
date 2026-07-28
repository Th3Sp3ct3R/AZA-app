export function objectInput(input) {
    if (input === null || Array.isArray(input) || typeof input !== "object") {
        throw new Error("Tool input must be an object.");
    }
    return input;
}
export function stringField(input, name) {
    const value = input[name];
    if (typeof value !== "string")
        throw new Error(`Field '${name}' must be a string.`);
    return value;
}
export function optionalStringField(input, name) {
    const value = input[name];
    if (value === undefined)
        return undefined;
    if (typeof value !== "string")
        throw new Error(`Field '${name}' must be a string.`);
    return value;
}
export function stringArrayField(input, name) {
    const value = input[name];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        throw new Error(`Field '${name}' must be an array of strings.`);
    }
    return value;
}
