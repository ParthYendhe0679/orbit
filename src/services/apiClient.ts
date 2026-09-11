/**
 * ORBIT Trading Terminal — Centralized Typed HTTP Client
 *
 * Every call goes to the Go gateway (same origin). The gateway authenticates
 * it from the HttpOnly `orbit_session` cookie it issued at sign-in, or from a
 * Clerk session token sent as `Authorization: Bearer`. The account is derived
 * server-side; nothing here is trusted for identity.
 */

export class ApiError extends Error {
    constructor(
        public status: number,
        public message: string,
        public data?: unknown
    ) {
        super(message);
        this.name = "ApiError";
    }
}

type TokenProvider = () => Promise<string | null | undefined>;
let tokenProvider: TokenProvider | null = null;

/** Registers the Clerk session-token getter (clerk.session.getToken). */
export function setAuthTokenProvider(provider: TokenProvider | null): void {
    tokenProvider = provider;
}

/** Fired when the gateway rejects the session; the auth controller signs out. */
export const UNAUTHORIZED_EVENT = "orbit:unauthorized";

async function authHeaders(base?: HeadersInit): Promise<Headers> {
    const headers = new Headers(base || {});
    if (tokenProvider && !headers.has("Authorization")) {
        try {
            const token = await tokenProvider();
            if (token) headers.set("Authorization", `Bearer ${token}`);
        } catch {
            // No Clerk session: the gateway session cookie is used instead.
        }
    }
    return headers;
}

/**
 * fetch() for the gateway: attaches the Clerk token when there is one, always
 * sends the session cookie, and announces a 401 so the app can sign out.
 */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const headers = await authHeaders(init.headers);
    const response = await fetch(input, { ...init, headers, credentials: "same-origin" });
    if (response.status === 401 && !input.startsWith("/api/login") && !input.startsWith("/api/register")) {
        window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: { url: input } }));
    }
    return response;
}

export async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const headers = new Headers(options.headers || {});
    if (options.body && typeof options.body === "string" && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
    }

    try {
        const response = await authFetch(endpoint, { ...options, headers });

        if (!response.ok) {
            let errorDetail = `Request failed with status ${response.status}`;
            let errorData: unknown = null;
            try {
                errorData = await response.json();
                if (errorData && typeof errorData === "object" && "detail" in errorData) {
                    const detail = (errorData as { detail: unknown }).detail;
                    errorDetail = typeof detail === "string" ? detail : JSON.stringify(detail);
                }
            } catch {
                // Non-JSON response body
            }
            throw new ApiError(response.status, errorDetail, errorData);
        }

        return (await response.json()) as T;
    } catch (err) {
        if (err instanceof ApiError) {
            throw err;
        }
        const message = err instanceof Error ? err.message : "Network connection error";
        throw new ApiError(0, message);
    }
}

export const apiClient = {
    get: <T>(url: string, headers?: HeadersInit) => request<T>(url, { method: "GET", headers }),
    post: <T>(url: string, body?: unknown, headers?: HeadersInit) =>
        request<T>(url, {
            method: "POST",
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined
        }),
    delete: <T>(url: string, headers?: HeadersInit) => request<T>(url, { method: "DELETE", headers })
};

/** Unwraps the ai-service's {"ok": true, "data": ...} envelope. */
export function unwrapData<T>(res: { ok?: boolean; data?: T; detail?: unknown }): T {
    if (!res || res.ok === false || res.data === undefined || res.data === null) {
        const detail = res && typeof res.detail === "string" ? res.detail : "The service returned no data.";
        throw new ApiError(502, detail, res);
    }
    return res.data;
}
