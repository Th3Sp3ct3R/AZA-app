export function compareOrdinal(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
export function asciiLowercase(value) {
    return value.replace(/[A-Z]/gu, (character) => String.fromCharCode(character.charCodeAt(0) + 0x20));
}
export function asciiUppercase(value) {
    return value.replace(/[a-z]/gu, (character) => String.fromCharCode(character.charCodeAt(0) - 0x20));
}
export function lowercaseInvariant(value) {
    return value.toLowerCase();
}
