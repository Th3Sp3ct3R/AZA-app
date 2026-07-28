const DEFAULT_LOCAL_BASE = "http://127.0.0.1:11434";
const CLOUD_BASE = "https://ollama.com";
const MAX_MODELS = 500;
const MAX_MODEL_ID = 512;
export async function discoverOllamaModels(options = {}) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const environment = options.environment ?? process.env;
    const timeoutMs = options.timeoutMs ?? 5_000;
    const localBaseUrl = normalizeBaseUrl(environment.OLLAMA_HOST);
    const cloudKey = environment.OLLAMA_API_KEY?.trim();
    const [local, cloud] = await Promise.all([
        fetchTags(fetchImpl, `${localBaseUrl}/api/tags`, undefined, timeoutMs),
        cloudKey === undefined || cloudKey.length === 0
            ? Promise.resolve(null)
            : fetchTags(fetchImpl, `${CLOUD_BASE}/api/tags`, cloudKey, timeoutMs),
    ]);
    const localAvailable = local !== null;
    const cloudApiAvailable = cloud !== null;
    const merged = new Map();
    for (const model of local ?? []) {
        const cloudModel = isCloudModel(model);
        merged.set(model.id, {
            id: model.id,
            note: modelNote(cloudModel ? "cloud" : "local", model, true),
            source: cloudModel ? "cloud" : "local",
            endpoint: `${localBaseUrl}/v1/chat/completions`,
            ready: true,
        });
    }
    for (const model of cloud ?? []) {
        const existing = merged.get(model.id);
        if (existing !== undefined)
            continue;
        merged.set(model.id, {
            id: model.id,
            note: modelNote("cloud API", model, true),
            source: "cloud",
            endpoint: `${CLOUD_BASE}/v1/chat/completions`,
            ready: true,
        });
    }
    let publicCatalogAvailable = false;
    if (options.includePublicCatalog !== false) {
        const publicModels = await fetchPublicCloudCatalog(fetchImpl, timeoutMs);
        publicCatalogAvailable = publicModels !== null;
        for (const id of publicModels ?? []) {
            if (merged.has(id))
                continue;
            merged.set(id, {
                id,
                note: "cloud catalog · pulls on selection",
                source: "cloud-catalog",
                endpoint: `${localBaseUrl}/v1/chat/completions`,
                ready: false,
            });
        }
    }
    return {
        models: [...merged.values()],
        localAvailable,
        cloudApiAvailable,
        publicCatalogAvailable,
        localBaseUrl,
    };
}
export async function prepareOllamaModel(model, options) {
    if (model.ready || model.source !== "cloud-catalog")
        return;
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchWithTimeout(fetchImpl, `${options.localBaseUrl}/api/pull`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: model.id, stream: false }),
    }, Math.max(options.timeoutMs ?? 120_000, 10_000));
    if (!response.ok)
        throw new Error(await responseError(response, `Ollama could not pull ${model.id}`));
    const body = await response.json();
    if (!isRecord(body) || body.status !== "success") {
        throw new Error(`Ollama returned an invalid pull receipt for ${model.id}.`);
    }
}
function normalizeBaseUrl(configured) {
    const raw = configured?.trim() || DEFAULT_LOCAL_BASE;
    let url;
    try {
        url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    }
    catch {
        return DEFAULT_LOCAL_BASE;
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username.length > 0 || url.password.length > 0) {
        return DEFAULT_LOCAL_BASE;
    }
    return `${url.origin}${url.pathname.replace(/\/$/u, "")}`;
}
async function fetchTags(fetchImpl, url, bearer, timeoutMs) {
    try {
        const response = await fetchWithTimeout(fetchImpl, url, {
            headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
        }, timeoutMs);
        if (!response.ok)
            return null;
        const body = await response.json();
        if (!isRecord(body) || !Array.isArray(body.models) || body.models.length > MAX_MODELS)
            return null;
        const models = [];
        for (const raw of body.models) {
            if (!isRecord(raw))
                continue;
            const candidate = typeof raw.model === "string" ? raw.model : typeof raw.name === "string" ? raw.name : undefined;
            const id = candidate?.trim();
            if (id === undefined || id.length === 0 || id.length > MAX_MODEL_ID)
                continue;
            const details = isRecord(raw.details) ? raw.details : undefined;
            models.push({
                id,
                ...(typeof raw.size === "number" && Number.isFinite(raw.size) && raw.size >= 0 ? { size: raw.size } : {}),
                ...(typeof details?.parameter_size === "string" ? { parameterSize: details.parameter_size } : {}),
                ...(typeof details?.quantization_level === "string" ? { quantization: details.quantization_level } : {}),
            });
        }
        return models;
    }
    catch {
        return null;
    }
}
async function fetchPublicCloudCatalog(fetchImpl, timeoutMs) {
    try {
        const search = await fetchWithTimeout(fetchImpl, `${CLOUD_BASE}/search?c=cloud`, {}, timeoutMs);
        if (!search.ok)
            return null;
        const html = await search.text();
        const families = uniqueMatches(html, /href="\/library\/([^"?#/:]+)"/gu).slice(0, 80);
        const tags = await mapConcurrent(families, 6, async (family) => {
            try {
                const response = await fetchWithTimeout(fetchImpl, `${CLOUD_BASE}/library/${encodeURIComponent(family)}/tags`, {}, timeoutMs);
                if (!response.ok)
                    return [];
                const page = await response.text();
                return uniqueMatches(page, /href="\/library\/([^"?#]+(?:cloud))"/gu)
                    .filter((id) => id === `${family}:cloud` || id.startsWith(`${family}:`) || id.startsWith(`${family}-`));
            }
            catch {
                return [];
            }
        });
        return [...new Set(tags.flat())].slice(0, MAX_MODELS);
    }
    catch {
        return null;
    }
}
async function mapConcurrent(values, concurrency, operation) {
    const output = new Array(values.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
        while (next < values.length) {
            const index = next;
            next += 1;
            output[index] = await operation(values[index]);
        }
    });
    await Promise.all(workers);
    return output;
}
function uniqueMatches(input, pattern) {
    return [...new Set([...input.matchAll(pattern)].map((match) => match[1]).filter(Boolean))];
}
function isCloudModel(model) {
    return /(?:[:\-]cloud)$/iu.test(model.id) || (model.size !== undefined && model.size > 0 && model.size < 1_000_000);
}
function modelNote(kind, model, ready) {
    const details = [kind, ready ? "ready" : undefined, model.parameterSize, model.quantization]
        .filter((value) => value !== undefined && value.length > 0);
    return details.join(" · ");
}
async function fetchWithTimeout(fetchImpl, input, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
        return await fetchImpl(input, { ...init, signal: controller.signal });
    }
    finally {
        clearTimeout(timer);
    }
}
async function responseError(response, fallback) {
    try {
        const body = await response.json();
        if (isRecord(body) && typeof body.error === "string" && body.error.trim().length > 0) {
            return `${fallback}: ${body.error.trim()}`;
        }
    }
    catch {
    }
    return `${fallback} (HTTP ${response.status}).`;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
