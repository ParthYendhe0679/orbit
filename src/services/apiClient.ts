/**
 * ORBIT Trading Terminal — Centralized Typed HTTP Client
 * Enforces typed promises, status validation, and clean error messages
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

export async function request<T>(
    endpoint: string,
    options: RequestInit = {}
): Promise<T> {
    const headers = new Headers(options.headers || {});
    if (options.body && typeof options.body === "string" && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
    }

    const config: RequestInit = {
        ...options,
        headers
    };

    try {
        const response = await fetch(endpoint, config);

        if (!response.ok) {
            let errorDetail = `Request failed with status ${response.status}`;
            let errorData: unknown = null;
            try {
                errorData = await response.json();
                if (errorData && typeof errorData === "object" && "detail" in errorData) {
                    errorDetail = String((errorData as { detail: unknown }).detail);
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
