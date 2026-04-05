export function getAuthHeader(): { Authorization: string } {
  const token = localStorage.getItem("jwt") ?? "";
  return { Authorization: `Bearer ${token}` };
}

export function clearAuth() {
  localStorage.removeItem("jwt");
  window.location.href = "/";
}

async function refreshJwt(authUrl: string): Promise<string | null> {
  const res = await fetch(`${authUrl}/api/auth/token`, {
    method: "GET",
    credentials: "include",
  });
  if (!res.ok) return null;
  const { token } = await res.json();
  if (!token) return null;
  localStorage.setItem("jwt", token);
  return token;
}

export async function fetchWithAuth(
  input: RequestInfo | URL,
  init: RequestInit = {},
  authUrl: string
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", getAuthHeader().Authorization);

  const res = await fetch(input, {
    ...init,
    headers,
  });

  if (res.status !== 401) return res;

  const newToken = await refreshJwt(authUrl);
  if (!newToken) {
    clearAuth();
    throw new Error("Session expired. Please log in again.");
  }

  const retryHeaders = new Headers(init.headers);
  retryHeaders.set("Authorization", `Bearer ${newToken}`);

  const retry = await fetch(input, {
    ...init,
    headers: retryHeaders,
  });

  if (retry.status === 401) {
    clearAuth();
    throw new Error("Session expired. Please log in again.");
  }

  return retry;
}
