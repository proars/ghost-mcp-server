#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  assertSafePath,
  assertSafeSegment,
  buildForm,
  ghostRequest,
  GhostError,
  type Method,
  type Query,
  type RequestOptions,
} from "./client.js";
import { accessNote, filterRoutes, hintFor, matchRoute, routeKey, ROUTES, type RouteInfo } from "./routes.js";

type Args = Record<string, unknown>;

const SERVER_VERSION = "2.1.1";
const MAX_RESULT_CHARS = 100_000;

/** Calls Ghost and, on 401, 403 and 404, adds what the route catalog knows about the failure. */
async function request(
  method: Method,
  path: string,
  query: Query = {},
  body?: unknown,
  form?: FormData,
  options?: RequestOptions
): Promise<unknown> {
  try {
    return await ghostRequest(method, path, query, body, form, options);
  } catch (error) {
    if (error instanceof GhostError) {
      const hint = hintFor(method, path, error.status);
      if (hint) {
        throw new GhostError(`${error.message}. Hint: ${hint}`, error.status, error.type);
      }
    }
    throw error;
  }
}

interface QueryDoc {
  type: "string" | "number" | "boolean";
  description: string;
}

const QUERY_DOCS: Record<string, QueryDoc> = {
  include: {
    type: "string",
    description: "Comma-separated relations to include, for example tags,authors.",
  },
  fields: {
    type: "string",
    description: "Comma-separated list of fields to return, for example id,title,slug.",
  },
  filter: {
    type: "string",
    description: "NQL filter, for example status:published+tag:news.",
  },
  limit: {
    type: "number",
    description: "Records per page (Ghost default 15, maximum 100).",
  },
  page: { type: "number", description: "Page number, starting at 1." },
  order: { type: "string", description: "Sort order, for example published_at desc." },
  formats: {
    type: "string",
    description: "Comma-separated content formats to return: html, plaintext, lexical.",
  },
  source: {
    type: "string",
    description: "Set to html to send the post body as HTML instead of Lexical.",
  },
  save_revision: {
    type: "boolean",
    description: "Set to true to save a revision of the post with this update.",
  },
  newsletter: {
    type: "string",
    description: "Newsletter slug. When publishing a post, emails it to that newsletter.",
  },
  email_segment: {
    type: "string",
    description: "NQL member filter limiting email recipients: all, status:free or status:-free.",
  },
};

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  /** Catalog route this tool is dedicated to; shortcut and helper tools have none. */
  route?: { method: Method; path: string };
  /** True when the call sends a POST, PUT or DELETE, so its answer must never suggest repeating it. */
  isMutation?: (args: Args) => boolean;
  run: (args: Args) => Promise<unknown>;
}

interface ToolSpec {
  name: string;
  description: string;
  method: Method;
  path: string;
  query?: string[];
  defaults?: Record<string, string>;
  bodyKey?: string;
  bodyDescription?: string;
  requireUpdatedAt?: boolean;
  upload?: { purpose?: boolean };
  /** Overrides the default for a POST that replaces something that already exists. */
  destructive?: boolean;
}

/**
 * MCP hints describe the effect of a tool, not its HTTP method. destructiveHint false promises that
 * the tool only adds things; anything that overwrites or removes existing data must say true.
 * - GET only reads.
 * - POST creates (a record, a copy, an upload, an invite) and is additive unless the spec says it
 *   replaces something, like uploading a theme with the name of an installed one.
 * - PUT overwrites fields, tags or the active theme, and DELETE removes: both are destructive.
 */
function annotationsFor(method: Method, destructive?: boolean) {
  if (method === "GET") {
    return { readOnlyHint: true, destructiveHint: false };
  }
  if (method === "POST") {
    return { readOnlyHint: false, destructiveHint: destructive ?? false };
  }
  return { readOnlyHint: false, destructiveHint: true };
}

function pathParamsOf(path: string): string[] {
  return Array.from(path.matchAll(/\{(\w+)\}/g), (match) => match[1]);
}

function requireString(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Argument "${key}" is required and must be a non-empty string.`);
  }
  return value;
}

function requireObject(args: Args, key: string): Record<string, unknown> {
  const value = args[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Argument "${key}" is required and must be an object.`);
  }
  return value as Record<string, unknown>;
}

function collectQuery(
  args: Args,
  names: string[],
  defaults: Record<string, string>
): Record<string, string | number | boolean> {
  const query: Record<string, string | number | boolean> = {};
  for (const name of names) {
    const doc = QUERY_DOCS[name];
    const value = args[name];
    if (value === undefined || value === null || value === "") {
      if (defaults[name] !== undefined) {
        query[name] = defaults[name];
      }
      continue;
    }
    if (typeof value !== doc.type) {
      throw new Error(`Argument "${name}" must be of type ${doc.type}.`);
    }
    if (doc.type === "number") {
      const number = value as number;
      if (!Number.isFinite(number) || number < 1) {
        throw new Error(`Argument "${name}" must be a positive number.`);
      }
      query[name] = Math.floor(number);
    } else {
      query[name] = value as string | boolean;
    }
  }
  return query;
}

function toolFromSpec(spec: ToolSpec): ToolDef {
  const pathParams = pathParamsOf(spec.path);
  const queryNames = spec.query ?? [];
  const defaults = spec.defaults ?? {};

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of pathParams) {
    properties[param] = { type: "string", description: `Value for {${param}} in the path.` };
    required.push(param);
  }
  for (const name of queryNames) {
    const doc = QUERY_DOCS[name];
    const defaultNote = defaults[name] !== undefined ? ` Default: ${defaults[name]}.` : "";
    properties[name] = { type: doc.type, description: `${doc.description}${defaultNote}` };
  }
  if (spec.bodyKey) {
    properties.data = {
      type: "object",
      description:
        spec.bodyDescription ??
        `Fields of the ${spec.bodyKey} object, as in the Ghost Admin API docs.`,
    };
    required.push("data");
  }
  if (spec.upload) {
    properties.file_path = {
      type: "string",
      description: "Absolute path to the local file to upload.",
    };
    required.push("file_path");
    if (spec.upload.purpose) {
      properties.purpose = {
        type: "string",
        enum: ["image", "profile_image", "icon"],
        description:
          "Image purpose. profile_image and icon must be square; icon also accepts .ico. Default: image.",
      };
      properties.ref = {
        type: "string",
        description: "Optional reference string returned with the upload result.",
      };
    }
  }

  return {
    name: spec.name,
    description: `${spec.description}${accessNote(spec.method, spec.path)} [${spec.method} /admin${spec.path}]`,
    inputSchema: { type: "object", properties, required },
    annotations: annotationsFor(spec.method, spec.destructive),
    route: { method: spec.method, path: spec.path },
    isMutation: () => spec.method !== "GET",
    run: async (args) => {
      let path = spec.path;
      for (const param of pathParams) {
        const value = requireString(args, param);
        assertSafeSegment(param, value);
        path = path.replace(`{${param}}`, encodeURIComponent(value));
      }
      const query = collectQuery(args, queryNames, defaults);

      if (spec.upload) {
        const fields: Record<string, string> = {};
        if (spec.upload.purpose) {
          const purpose = args.purpose ?? "image";
          if (purpose !== "image" && purpose !== "profile_image" && purpose !== "icon") {
            throw new Error('Argument "purpose" must be image, profile_image or icon.');
          }
          fields.purpose = purpose;
          if (typeof args.ref === "string" && args.ref.length > 0) {
            fields.ref = args.ref;
          }
        }
        const form = await buildForm({ file: requireString(args, "file_path") }, fields);
        return request(spec.method, path, query, undefined, form);
      }

      if (spec.bodyKey) {
        const data = requireObject(args, "data");
        if (spec.requireUpdatedAt && (typeof data.updated_at !== "string" || !data.updated_at)) {
          throw new Error(
            "data.updated_at is required: pass the current updated_at of the record (Ghost rejects stale updates)."
          );
        }
        return request(spec.method, path, query, { [spec.bodyKey]: [data] });
      }

      return request(spec.method, path, query);
    },
  };
}

type Op = "browse" | "read" | "readSlug" | "add" | "edit" | "delete" | "copy";

interface ResourceSpec {
  path: string;
  plural: string;
  singular: string;
  label: string;
  ops: Op[];
  formats?: boolean;
  requireUpdatedAt?: boolean;
  browseDefaults?: Record<string, string>;
  addQuery?: string[];
  editQuery?: string[];
}

function specsForResource(resource: ResourceSpec): ToolSpec[] {
  const specs: ToolSpec[] = [];
  const readQuery = resource.formats ? ["include", "fields", "formats"] : ["include", "fields"];
  const listQuery = [...readQuery, "filter", "limit", "page", "order"];

  for (const op of resource.ops) {
    switch (op) {
      case "browse":
        specs.push({
          name: `get_${resource.plural}`,
          description: `List ${resource.label}s (paginated).${resource.browseDefaults ? " Returns a compact set of fields by default; pass fields to override." : ""}`,
          method: "GET",
          path: `/${resource.path}/`,
          query: listQuery,
          defaults: resource.browseDefaults,
        });
        break;
      case "read":
        specs.push({
          name: `get_${resource.singular}`,
          description: `Get one ${resource.label} by id.`,
          method: "GET",
          path: `/${resource.path}/{id}/`,
          query: readQuery,
        });
        break;
      case "readSlug":
        specs.push({
          name: `get_${resource.singular}_by_slug`,
          description: `Get one ${resource.label} by slug.`,
          method: "GET",
          path: `/${resource.path}/slug/{slug}/`,
          query: readQuery,
        });
        break;
      case "add":
        specs.push({
          name: `create_${resource.singular}`,
          description: `Create a ${resource.label}.`,
          method: "POST",
          path: `/${resource.path}/`,
          query: resource.addQuery,
          bodyKey: resource.path,
        });
        break;
      case "edit":
        specs.push({
          name: `update_${resource.singular}`,
          description: `Update a ${resource.label} by id.${resource.requireUpdatedAt ? " data must include the current updated_at." : ""}`,
          method: "PUT",
          path: `/${resource.path}/{id}/`,
          query: resource.editQuery,
          bodyKey: resource.path,
          requireUpdatedAt: resource.requireUpdatedAt,
        });
        break;
      case "delete":
        specs.push({
          name: `delete_${resource.singular}`,
          description: `Permanently delete a ${resource.label} by id.`,
          method: "DELETE",
          path: `/${resource.path}/{id}/`,
        });
        break;
      case "copy":
        specs.push({
          name: `copy_${resource.singular}`,
          description: `Duplicate a ${resource.label} by id.`,
          method: "POST",
          path: `/${resource.path}/{id}/copy/`,
        });
        break;
    }
  }
  return specs;
}

const COMPACT_FIELDS =
  "id,title,slug,status,updated_at,published_at,meta_title,meta_description,og_title,og_description";

const RESOURCES: ResourceSpec[] = [
  {
    path: "posts",
    plural: "posts",
    singular: "post",
    label: "post",
    ops: ["browse", "read", "readSlug", "add", "edit", "delete", "copy"],
    formats: true,
    requireUpdatedAt: true,
    browseDefaults: { fields: COMPACT_FIELDS, include: "tags" },
    addQuery: ["source"],
    editQuery: ["source", "save_revision", "newsletter", "email_segment"],
  },
  {
    path: "pages",
    plural: "pages",
    singular: "page",
    label: "page",
    ops: ["browse", "read", "readSlug", "add", "edit", "delete", "copy"],
    formats: true,
    requireUpdatedAt: true,
    browseDefaults: { fields: COMPACT_FIELDS, include: "tags" },
    addQuery: ["source"],
    editQuery: ["source", "save_revision"],
  },
  {
    path: "tags",
    plural: "tags",
    singular: "tag",
    label: "tag",
    ops: ["browse", "read", "readSlug", "add", "edit", "delete"],
  },
  {
    path: "tiers",
    plural: "tiers",
    singular: "tier",
    label: "membership tier",
    ops: ["browse", "read", "add", "edit"],
  },
  {
    path: "newsletters",
    plural: "newsletters",
    singular: "newsletter",
    label: "newsletter",
    ops: ["browse", "read", "add", "edit"],
  },
  {
    path: "offers",
    plural: "offers",
    singular: "offer",
    label: "offer",
    ops: ["browse", "read", "add", "edit"],
  },
  {
    path: "members",
    plural: "members",
    singular: "member",
    label: "member",
    ops: ["browse", "read", "add", "edit", "delete"],
  },
  {
    path: "labels",
    plural: "labels",
    singular: "label",
    label: "member label",
    ops: ["browse", "add", "edit", "delete"],
  },
  {
    path: "users",
    plural: "users",
    singular: "user",
    label: "staff user",
    ops: ["browse", "read", "edit", "delete"],
  },
  {
    path: "webhooks",
    plural: "webhooks",
    singular: "webhook",
    label: "webhook",
    ops: ["add", "edit", "delete"],
  },
];

const STANDALONE_SPECS: ToolSpec[] = [
  {
    name: "get_site",
    description: "Get basic site info: title, description, logo, URL and Ghost version.",
    method: "GET",
    path: "/site/",
  },
  {
    name: "get_settings",
    description: "Get the site settings.",
    method: "GET",
    path: "/settings/",
  },
  {
    name: "get_roles",
    description: "List staff roles.",
    method: "GET",
    path: "/roles/",
    query: ["fields", "limit", "page", "order"],
  },
  {
    name: "invite_user",
    description: "Invite a staff user (data: email, role_id).",
    method: "POST",
    path: "/invites/",
    bodyKey: "invites",
  },
  {
    name: "upload_image",
    description: "Upload one image from a local file path to Ghost storage; returns its URL.",
    method: "POST",
    path: "/images/upload/",
    upload: { purpose: true },
  },
  {
    name: "upload_theme",
    description:
      "Upload a theme from a local ZIP file. A theme with the same name is replaced, so this can overwrite an installed theme.",
    method: "POST",
    path: "/themes/upload/",
    upload: {},
    destructive: true,
  },
  {
    name: "activate_theme",
    description: "Activate an uploaded theme by name. This changes the live site design.",
    method: "PUT",
    path: "/themes/{name}/activate/",
  },
];

const SEO_FIELDS = ["meta_title", "meta_description", "og_title", "og_description"];

const seoTool: ToolDef = {
  name: "update_post_seo",
  description:
    "Shortcut to update SEO fields of a post (meta_title, meta_description, og_title, og_description). Requires id and the current updated_at. At least one SEO field must be provided. [PUT /admin/posts/{id}/]",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Post id." },
      updated_at: {
        type: "string",
        description: "Current updated_at value of the post, as returned by get_posts.",
      },
      meta_title: { type: "string", description: "SEO meta title." },
      meta_description: { type: "string", description: "SEO meta description." },
      og_title: { type: "string", description: "Open Graph title." },
      og_description: { type: "string", description: "Open Graph description." },
    },
    required: ["id", "updated_at"],
  },
  // Both overwrite existing values (SEO fields, or the whole tag list), so they are destructive.
  annotations: { readOnlyHint: false, destructiveHint: true },
  isMutation: () => true,
  run: async (args) => {
    const id = requireString(args, "id");
    const updated_at = requireString(args, "updated_at");
    const fields: Record<string, string> = {};
    for (const key of SEO_FIELDS) {
      const value = args[key];
      if (value !== undefined) {
        if (typeof value !== "string") {
          throw new Error(`Argument "${key}" must be a string.`);
        }
        fields[key] = value;
      }
    }
    if (Object.keys(fields).length === 0) {
      throw new Error(`Provide at least one of: ${SEO_FIELDS.join(", ")}.`);
    }
    assertSafeSegment("id", id);
    const result: any = await request(
      "PUT",
      `/posts/${encodeURIComponent(id)}/`,
      {},
      { posts: [{ updated_at, ...fields }] }
    );
    const post = result.posts?.[0] ?? {};
    return {
      id: post.id,
      updated_at: post.updated_at,
      meta_title: post.meta_title,
      meta_description: post.meta_description,
      og_title: post.og_title,
      og_description: post.og_description,
    };
  },
};

const tagsTool: ToolDef = {
  name: "update_post_tags",
  description:
    "Shortcut to replace the tags of a post (tag names; missing tags are created). Requires id and the current updated_at. An empty list removes all tags. [PUT /admin/posts/{id}/]",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Post id." },
      updated_at: {
        type: "string",
        description: "Current updated_at value of the post, as returned by get_posts.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: 'Tag names, for example ["SEO", "Ghost"].',
      },
    },
    required: ["id", "updated_at", "tags"],
  },
  // Both overwrite existing values (SEO fields, or the whole tag list), so they are destructive.
  annotations: { readOnlyHint: false, destructiveHint: true },
  isMutation: () => true,
  run: async (args) => {
    const id = requireString(args, "id");
    const updated_at = requireString(args, "updated_at");
    const tags = args.tags;
    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) {
      throw new Error('Argument "tags" is required and must be an array of strings.');
    }
    const tagNames = Array.from(new Set((tags as string[]).map((tagName) => tagName.trim())));
    if (tagNames.some((tagName) => tagName.length === 0)) {
      throw new Error('Argument "tags" must not contain empty tag names.');
    }
    assertSafeSegment("id", id);
    const result: any = await request(
      "PUT",
      `/posts/${encodeURIComponent(id)}/`,
      {},
      { posts: [{ updated_at, tags: tagNames.map((tagName) => ({ name: tagName })) }] }
    );
    const post = result.posts?.[0] ?? {};
    return {
      id: post.id,
      updated_at: post.updated_at,
      tags: (post.tags ?? []).map((tag: any) => tag.name),
    };
  },
};

function stringMap(value: unknown, name: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(requireObject({ [name]: value }, name))) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(`"${name}.${key}" must be a non-empty string.`);
    }
    result[key] = item;
  }
  return result;
}

const rawTool: ToolDef = {
  name: "ghost_api_request",
  description:
    "Call any Ghost Admin API endpoint directly, including every route without a dedicated tool (find routes with ghost_list_endpoints). The path is relative to /ghost/api/admin, for example /labels/slug/vip/. Supports JSON bodies, multipart file uploads (files) and saving file downloads (save_to). If a POST, PUT or DELETE returns a file, set save_to on that first call: its answer cannot be fetched again by repeating the call. Routes marked U, SESSION or FLOW in the catalog need a staff user or browser session and fail with an integration key. DELETE removes data permanently.",
  inputSchema: {
    type: "object",
    properties: {
      method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], description: "HTTP method." },
      path: {
        type: "string",
        description: "Path starting with /, relative to /ghost/api/admin, without query string.",
      },
      query: {
        type: "object",
        description: "Query parameters as a flat object, for example { limit: 20, include: 'tags' }.",
      },
      body: { type: "object", description: "JSON body for POST and PUT requests." },
      files: {
        type: "object",
        description:
          "Multipart upload: map of form field name to absolute local file path, for example { file: '/tmp/a.png' }. Field names per route are listed by ghost_list_endpoints (upload).",
      },
      fields: {
        type: "object",
        description: "Extra multipart text fields, for example { purpose: 'image' }. Used with files.",
      },
      save_to: {
        type: "string",
        description:
          "Absolute path of a new file to store the response in. Use it for downloads (CSV, YAML, ZIP). Existing files are never overwritten.",
      },
    },
    required: ["method", "path"],
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
  isMutation: (args) => args.method !== "GET",
  run: async (args) => {
    const method = args.method;
    if (method !== "GET" && method !== "POST" && method !== "PUT" && method !== "DELETE") {
      throw new Error('Argument "method" must be GET, POST, PUT or DELETE.');
    }
    const path = requireString(args, "path");
    assertSafePath(path);

    const query: Query = {};
    if (args.query !== undefined) {
      for (const [key, value] of Object.entries(requireObject(args, "query"))) {
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
          throw new Error(`Query parameter "${key}" must be a string, number or boolean.`);
        }
        query[key] = value;
      }
    }

    const options: RequestOptions = {};
    if (args.save_to !== undefined) {
      options.saveTo = requireString(args, "save_to");
    }

    const route = matchRoute(method, path);

    if (args.files !== undefined) {
      if (args.body !== undefined) {
        throw new Error('Use either "body" (JSON) or "files" (multipart), not both.');
      }
      const files = stringMap(args.files, "files");
      const fields = args.fields === undefined ? {} : stringMap(args.fields, "fields");
      const form = await buildForm(files, fields);
      return request(method, path, query, undefined, form, options);
    }

    if (route?.upload && args.body === undefined) {
      throw new Error(
        `This route takes a multipart upload. Pass files, for example { ${route.upload.map((field) => `${field}: "/absolute/path"`).join(", ")} }.`
      );
    }
    const body = args.body === undefined ? undefined : requireObject(args, "body");
    return request(method, path, query, body, undefined, options);
  },
};

const MAX_ENDPOINTS_PER_CALL = 300;

const endpointsTool: ToolDef = {
  name: "ghost_list_endpoints",
  description: `Search the catalog of all ${ROUTES.length} known Ghost Admin API routes (method, path, access class, feature flag, upload fields, and the dedicated tool if there is one). Use it to find a route, then call it with its dedicated tool or with ghost_api_request. Access classes: I = allowed for Admin API integration keys, U = needs a staff user token or session, SESSION = needs a browser cookie session, FLOW = login/setup flow, PUBLIC = no authentication.`,
  inputSchema: {
    type: "object",
    properties: {
      group: {
        type: "string",
        description: "Resource group or first path segment, for example posts, members, stats.",
      },
      method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], description: "HTTP method." },
      access: {
        type: "string",
        enum: ["I", "U", "SESSION", "FLOW", "PUBLIC"],
        description: "Access class.",
      },
      search: { type: "string", description: "Text to look for in the path, summary or handler." },
      without_dedicated_tool: {
        type: "boolean",
        description: "Only list routes that have no dedicated tool (reachable via ghost_api_request).",
      },
      offset: { type: "number", description: "Number of matching routes to skip. Default 0." },
      limit: {
        type: "number",
        description: `Maximum routes to return (default 50, maximum ${MAX_ENDPOINTS_PER_CALL}).`,
      },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
  run: async (args) => {
    const optionalString = (key: string): string | undefined => {
      const value = args[key];
      if (value === undefined) {
        return undefined;
      }
      if (typeof value !== "string") {
        throw new Error(`Argument "${key}" must be a string.`);
      }
      return value;
    };
    const optionalCount = (key: string, fallback: number, min: number, max: number): number => {
      const value = args[key];
      if (value === undefined) {
        return fallback;
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Argument "${key}" must be a number.`);
      }
      return Math.min(Math.max(Math.floor(value), min), max);
    };

    const matches = filterRoutes(
      {
        group: optionalString("group"),
        method: optionalString("method"),
        access: optionalString("access"),
        search: optionalString("search"),
        withoutTool: args.without_dedicated_tool === true,
      },
      (route) => toolNameForRoute(route)
    );
    const offset = optionalCount("offset", 0, 0, matches.length);
    const limit = optionalCount("limit", 50, 1, MAX_ENDPOINTS_PER_CALL);
    const page = matches.slice(offset, offset + limit);
    return {
      total: matches.length,
      returned: page.length,
      offset,
      endpoints: page.map((route) => ({
        method: route.method,
        path: route.path,
        access: route.access,
        group: route.group,
        summary: route.summary,
        documented: route.documented,
        tool: toolNameForRoute(route) ?? null,
        ...(route.flag ? { flag: route.flag } : {}),
        ...(route.upload ? { upload: route.upload } : {}),
        ...(route.tokenUrl ? { token_url: true } : {}),
      })),
    };
  },
};

const TOOLS: ToolDef[] = [
  ...RESOURCES.flatMap(specsForResource).map(toolFromSpec),
  ...STANDALONE_SPECS.map(toolFromSpec),
  seoTool,
  tagsTool,
  endpointsTool,
  rawTool,
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

const TOOL_BY_ROUTE = new Map<string, string>();
for (const tool of TOOLS) {
  if (tool.route) {
    TOOL_BY_ROUTE.set(routeKey(tool.route.method, tool.route.path), tool.name);
  }
}

function toolNameForRoute(route: RouteInfo): string | undefined {
  return TOOL_BY_ROUTE.get(routeKey(route.method, route.path));
}

const server = new Server(
  { name: "ghost-mcp-server", version: SERVER_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({
    name,
    description,
    inputSchema: inputSchema as { type: "object" },
    annotations,
  })),
}));

function serialize(result: unknown, mutation: boolean): string {
  const text = JSON.stringify(result, null, 2) ?? "null";
  if (text.length <= MAX_RESULT_CHARS) {
    return text;
  }
  const head = `${text.slice(0, MAX_RESULT_CHARS)}\n... truncated: the response has ${text.length} characters.`;
  if (mutation) {
    // The request has already changed something: never suggest running it again just to see more.
    return `${head} The request was already carried out: do not repeat it to see more. Check the result with a read tool (a get_* tool, or ghost_api_request with GET) and fields, filter or limit.`;
  }
  return `${head} Narrow it with fields, filter or limit, or save a download with save_to.`;
}

server.setRequestHandler(CallToolRequestSchema, async (call) => {
  const tool = TOOLS_BY_NAME.get(call.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${call.params.name}` }],
    };
  }
  try {
    const args = (call.params.arguments ?? {}) as Args;
    const result = await tool.run(args);
    return { content: [{ type: "text", text: serialize(result, tool.isMutation?.(args) ?? false) }] };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: "text", text }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`ghost-mcp-server running on stdio with ${TOOLS.length} tools`);
