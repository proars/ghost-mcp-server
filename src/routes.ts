import { CATALOG, type Access, type Route } from "./catalog.js";

export interface RouteInfo {
  method: Route[0];
  path: string;
  handler: string;
  access: Access;
  group: string;
  documented: boolean;
  summary: string;
  flag?: string;
  upload?: string[];
  tokenUrl?: true;
}

export const ROUTES: RouteInfo[] = CATALOG.map(
  ([method, path, handler, access, group, source, summary, extra]) => ({
    method,
    path,
    handler,
    access,
    group,
    documented: source === "doc",
    summary,
    ...extra,
  })
);

/** Key that ignores parameter names, so /posts/{id}/ and /posts/{post_id}/ are the same route. */
export function routeKey(method: string, path: string): string {
  return `${method} ${path.replace(/\{\w+\}/g, "{}")}`;
}

interface CompiledRoute {
  route: RouteInfo;
  pattern: RegExp;
  paramCount: number;
}

const COMPILED: CompiledRoute[] = ROUTES.map((route) => {
  const segments = route.path.split("/").filter((segment) => segment.length > 0);
  const source = segments
    .map((segment) =>
      /^\{\w+\}$/.test(segment) ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    )
    .join("/");
  return {
    route,
    pattern: new RegExp(`^/${source}/$`),
    paramCount: segments.filter((segment) => /^\{\w+\}$/.test(segment)).length,
  };
});

/** Finds the catalog route for a concrete request path. Static segments win over parameters. */
export function matchRoute(method: string, path: string): RouteInfo | undefined {
  const normalized = path.endsWith("/") ? path : `${path}/`;
  let best: CompiledRoute | undefined;
  for (const candidate of COMPILED) {
    if (candidate.route.method !== method || !candidate.pattern.test(normalized)) {
      continue;
    }
    if (!best || candidate.paramCount < best.paramCount) {
      best = candidate;
    }
  }
  return best?.route;
}

const ACCESS_HINTS: Record<Access, string> = {
  PUBLIC: "This route is public and needs no authentication.",
  I: "This route is on the integration-key allowlist, but Ghost still checks permissions, feature flags and your Ghost version.",
  U: "This route is not available to Admin API integration keys: it needs a staff user's access token (from the user's profile page in Ghost Admin, set as GHOST_ADMIN_API_KEY) with a role that allows it, or a user session.",
  SESSION:
    "This route needs a user cookie session. Neither integration keys nor staff access tokens can call it.",
  FLOW: "This route belongs to a browser login, recovery or setup flow and cannot be used with an integration key.",
};

/** Sentence for a tool description when its route is closed to Admin API integration keys. */
export function accessNote(method: string, path: string): string {
  const key = routeKey(method, path);
  const route = ROUTES.find((candidate) => routeKey(candidate.method, candidate.path) === key);
  if (!route || route.access === "I" || route.access === "PUBLIC") {
    return "";
  }
  return ` ${ACCESS_HINTS[route.access]}`;
}

/** Explains a 401, 403 or 404 using what the catalog knows about the route. */
export function hintFor(method: string, path: string, status: number): string | undefined {
  if (status !== 401 && status !== 403 && status !== 404) {
    return undefined;
  }
  const route = matchRoute(method, path);
  if (!route) {
    return status === 404
      ? "This path is not in the route catalog; check it with ghost_list_endpoints."
      : undefined;
  }
  const flag = route.flag ? ` Feature flag: ${route.flag}.` : "";
  if (status === 404) {
    return `The route exists in the catalog but Ghost returned 404: it may be missing in your Ghost version, disabled by a feature flag, or the record does not exist.${flag}`;
  }
  return `${ACCESS_HINTS[route.access]}${flag}`;
}

export interface EndpointFilter {
  group?: string;
  method?: string;
  access?: string;
  search?: string;
  withoutTool?: boolean;
}

export function filterRoutes(
  filter: EndpointFilter,
  toolForRoute: (route: RouteInfo) => string | undefined
): RouteInfo[] {
  const group = filter.group?.toLowerCase();
  const search = filter.search?.toLowerCase();
  return ROUTES.filter((route) => {
    if (filter.method && route.method !== filter.method.toUpperCase()) {
      return false;
    }
    if (filter.access && route.access !== filter.access.toUpperCase()) {
      return false;
    }
    if (group) {
      const firstSegment = route.path.split("/")[1] ?? "";
      if (!route.group.toLowerCase().includes(group) && !firstSegment.toLowerCase().includes(group)) {
        return false;
      }
    }
    if (search) {
      const haystack = `${route.path} ${route.summary} ${route.handler}`.toLowerCase();
      if (!haystack.includes(search)) {
        return false;
      }
    }
    if (filter.withoutTool && toolForRoute(route)) {
      return false;
    }
    return true;
  });
}
