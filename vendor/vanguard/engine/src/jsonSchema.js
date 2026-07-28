const SUPPORTED_JSON_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
export function validateJsonSchema(value, schema) {
    const errors = [];
    validateNode(value, schema, "$", errors);
    return errors;
}
export function validateSchemaDefinition(schema, label) {
    if (schema === null || Array.isArray(schema) || typeof schema !== "object")
        throw new Error(`${label} must be an object.`);
    const allowed = new Set([
        "type", "properties", "required", "additionalProperties", "items", "enum", "oneOf",
        "minLength", "maxLength", "minimum", "maximum",
        "description", "title", "$comment", "$id", "$schema", "default", "examples",
        "deprecated", "readOnly", "writeOnly",
    ]);
    const unknown = Object.keys(schema).filter((key) => !allowed.has(key));
    if (unknown.length > 0)
        throw new Error(`${label} has unsupported schema keys: ${unknown.sort().join(", ")}.`);
    const type = own(schema, "type");
    if (type !== undefined) {
        const declaredTypes = Array.isArray(type) ? type : [type];
        if (declaredTypes.length === 0
            || !declaredTypes.every((type) => typeof type === "string" && SUPPORTED_JSON_TYPES.has(type))) {
            throw new Error(`${label} has an unsupported type.`);
        }
    }
    const properties = own(schema, "properties");
    if (properties !== undefined) {
        if (properties === null || Array.isArray(properties) || typeof properties !== "object")
            throw new Error(`${label}.properties must be an object.`);
        for (const [name, child] of Object.entries(properties))
            validateSchemaDefinition(child, `${label}.properties.${name}`);
    }
    const items = own(schema, "items");
    if (items !== undefined)
        validateSchemaDefinition(items, `${label}.items`);
    const oneOf = own(schema, "oneOf");
    if (oneOf !== undefined) {
        if (!Array.isArray(oneOf) || oneOf.length === 0) {
            throw new Error(`${label}.oneOf must be a non-empty array.`);
        }
        oneOf.forEach((child, index) => validateSchemaDefinition(child, `${label}.oneOf[${index}]`));
    }
    const required = own(schema, "required");
    if (required !== undefined && (!Array.isArray(required) || !required.every((item) => typeof item === "string"))) {
        throw new Error(`${label}.required must be an array of strings.`);
    }
    const additionalProperties = own(schema, "additionalProperties");
    if (additionalProperties !== undefined && typeof additionalProperties !== "boolean") {
        throw new Error(`${label}.additionalProperties must be boolean.`);
    }
    const enumValues = own(schema, "enum");
    if (enumValues !== undefined && (!Array.isArray(enumValues) || enumValues.length === 0)) {
        throw new Error(`${label}.enum must be a non-empty array.`);
    }
    for (const annotation of ["description", "title", "$comment", "$id", "$schema"]) {
        const value = own(schema, annotation);
        if (value !== undefined && typeof value !== "string") {
            throw new Error(`${label}.${annotation} must be a string.`);
        }
    }
    const examples = own(schema, "examples");
    if (examples !== undefined && !Array.isArray(examples))
        throw new Error(`${label}.examples must be an array.`);
    for (const annotation of ["deprecated", "readOnly", "writeOnly"]) {
        const value = own(schema, annotation);
        if (value !== undefined && typeof value !== "boolean") {
            throw new Error(`${label}.${annotation} must be boolean.`);
        }
    }
    for (const length of ["minLength", "maxLength"]) {
        const value = own(schema, length);
        if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
            throw new Error(`${label}.${length} must be a nonnegative safe integer.`);
        }
    }
    for (const bound of ["minimum", "maximum"]) {
        const value = own(schema, bound);
        if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
            throw new Error(`${label}.${bound} must be a finite number.`);
        }
    }
    const minLength = own(schema, "minLength");
    const maxLength = own(schema, "maxLength");
    if (typeof minLength === "number" && typeof maxLength === "number" && minLength > maxLength) {
        throw new Error(`${label}.minLength cannot exceed maxLength.`);
    }
    const minimum = own(schema, "minimum");
    const maximum = own(schema, "maximum");
    if (typeof minimum === "number" && typeof maximum === "number" && minimum > maximum) {
        throw new Error(`${label}.minimum cannot exceed maximum.`);
    }
}
function validateNode(value, schema, at, errors) {
    if (schema === null || Array.isArray(schema) || typeof schema !== "object") {
        errors.push(`${at}: invalid schema.`);
        return;
    }
    const enumValues = own(schema, "enum");
    if (Array.isArray(enumValues) && !enumValues.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
        errors.push(`${at}: value is not in enum.`);
    }
    const oneOf = own(schema, "oneOf");
    if (Array.isArray(oneOf)) {
        let matches = 0;
        for (const child of oneOf) {
            const branchErrors = [];
            validateNode(value, child, at, branchErrors);
            if (branchErrors.length === 0)
                matches += 1;
        }
        if (matches !== 1)
            errors.push(`${at}: expected exactly one oneOf schema to match.`);
    }
    const type = own(schema, "type");
    let declaredTypes = [];
    if (type !== undefined) {
        declaredTypes = typeof type === "string"
            ? [type]
            : Array.isArray(type) && type.length > 0 && type.every((item) => typeof item === "string")
                ? type
                : [];
        if (declaredTypes.length === 0 || declaredTypes.some((declared) => !SUPPORTED_JSON_TYPES.has(declared))) {
            errors.push(`${at}: invalid schema type declaration.`);
            return;
        }
    }
    if (declaredTypes.length > 0 && !declaredTypes.some((declared) => matchesType(value, declared))) {
        errors.push(`${at}: expected ${declaredTypes.join(" or ")}.`);
        return;
    }
    if (typeof value === "string") {
        const minLength = own(schema, "minLength");
        const maxLength = own(schema, "maxLength");
        if (typeof minLength === "number" && value.length < minLength)
            errors.push(`${at}: shorter than minLength.`);
        if (typeof maxLength === "number" && value.length > maxLength)
            errors.push(`${at}: longer than maxLength.`);
    }
    if (typeof value === "number") {
        const minimum = own(schema, "minimum");
        const maximum = own(schema, "maximum");
        if (typeof minimum === "number" && value < minimum)
            errors.push(`${at}: below minimum.`);
        if (typeof maximum === "number" && value > maximum)
            errors.push(`${at}: above maximum.`);
    }
    const items = own(schema, "items");
    if (Array.isArray(value) && items !== undefined) {
        value.forEach((item, index) => validateNode(item, items, `${at}[${index}]`, errors));
    }
    if (value !== null && !Array.isArray(value) && typeof value === "object") {
        const declaredProperties = own(schema, "properties");
        const properties = declaredProperties !== null && declaredProperties !== undefined && !Array.isArray(declaredProperties) && typeof declaredProperties === "object"
            ? declaredProperties
            : {};
        const declaredRequired = own(schema, "required");
        const required = Array.isArray(declaredRequired) ? declaredRequired.filter((item) => typeof item === "string") : [];
        for (const name of required) {
            if (!Object.prototype.hasOwnProperty.call(value, name))
                errors.push(`${at}.${name}: required.`);
        }
        if (own(schema, "additionalProperties") === false) {
            for (const name of Object.keys(value)) {
                if (!Object.prototype.hasOwnProperty.call(properties, name)) {
                    errors.push(`${at}.${name}: additional property is not allowed.`);
                }
            }
        }
        for (const [name, child] of Object.entries(value)) {
            const childSchema = Object.prototype.hasOwnProperty.call(properties, name)
                ? properties[name]
                : undefined;
            if (childSchema !== undefined)
                validateNode(child, childSchema, `${at}.${name}`, errors);
        }
    }
}
function own(record, key) {
    return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}
function matchesType(value, type) {
    switch (type) {
        case "object": return value !== null && !Array.isArray(value) && typeof value === "object";
        case "array": return Array.isArray(value);
        case "string": return typeof value === "string";
        case "number": return typeof value === "number" && Number.isFinite(value);
        case "integer": return typeof value === "number" && Number.isSafeInteger(value);
        case "boolean": return typeof value === "boolean";
        case "null": return value === null;
        default: return false;
    }
}
