export function isAllowedOrigin(origin: string | undefined, bindHost: string, port: number): boolean {
  if (!origin) {
    return true;
  }

  const parsedOrigin = parseOrigin(origin);
  if (!parsedOrigin) {
    return false;
  }

  return allowedOrigins(bindHost, port).has(parsedOrigin);
}

export function allowedOrigins(bindHost: string, port: number): Set<string> {
  const hosts = new Set([normalizeHostname(bindHost)]);

  if (isLoopbackHost(bindHost)) {
    hosts.add("localhost");
    hosts.add("127.0.0.1");
    hosts.add("::1");
  }

  return new Set(
    [...hosts].flatMap((host) => {
      const formattedHost = host.includes(":") ? `[${host}]` : host;
      return [`http://${formattedHost}:${port}`, `https://${formattedHost}:${port}`];
    })
  );
}

function parseOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }

    return `${url.protocol}//${formatHost(normalizeHostname(url.hostname))}:${url.port || defaultPort(url.protocol)}`;
  } catch {
    return "";
  }
}

function normalizeHostname(value: string): string {
  return value.replace(/^\[|\]$/g, "").toLowerCase();
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHostname(host);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}
