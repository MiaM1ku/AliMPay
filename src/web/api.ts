export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code = "API_ERROR",
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

function cookie(name: string) {
  return document.cookie
    .split("; ")
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? "";
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.set("x-csrf-token", decodeURIComponent(cookie("alimpay_csrf")));
  }
  const response = await fetch(path, { ...init, method, headers, credentials: "same-origin" });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    throw new ApiClientError(
      String(body.message ?? body.msg ?? payload ?? `HTTP ${response.status}`),
      response.status,
      String(body.error ?? "API_ERROR"),
      body.details,
    );
  }
  return payload as T;
}

export function jsonBody(value: unknown): RequestInit {
  return { body: JSON.stringify(value), headers: { "content-type": "application/json" } };
}

export const swrFetcher = <T,>(path: string) => apiFetch<T>(path);
