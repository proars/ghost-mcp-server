# Ghost MCP Server: manage Ghost CMS from Claude, Cursor and other AI clients

[![CI](https://github.com/proars/ghost-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/proars/ghost-mcp-server/actions/workflows/ci.yml)
![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)
![Tools](https://img.shields.io/badge/tools-59-blue)
![Routes](https://img.shields.io/badge/Admin%20API%20routes-253-orange)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

Ghost MCP Server is an open-source [Model Context Protocol](https://modelcontextprotocol.io) server for Ghost CMS, written in TypeScript. It connects an MCP client such as Claude Desktop, Claude Code or Cursor to the Ghost Admin API over stdio. With it, an AI assistant can create and edit posts and pages, set SEO metadata, manage tags, members and newsletters, upload images and themes, and export content.

It exposes **59 tools**: 55 dedicated API tools, two shortcuts for SEO and tags, a route search and a generic request tool. The built-in catalog covers **253 Admin API routes** taken from a pinned Ghost source snapshot. What works on your site depends on your credentials, your Ghost version and its feature flags. Routes and sources are listed in [GHOST_API.list](GHOST_API.list).

## Quick start

You need Node.js 20 or newer and a Ghost site with Admin API access.

1. In Ghost Admin, open **Settings → Integrations → Add custom integration** and copy the **Admin API Key** (`id:secret`). Do not use the Content API key.
2. Add the server to your client configuration. For Claude Desktop or Cursor:

```json
{
  "mcpServers": {
    "ghost": {
      "command": "npx",
      "args": ["-y", "@proars/ghost-mcp-server"],
      "env": {
        "GHOST_API_URL": "https://your-blog.com",
        "GHOST_ADMIN_API_KEY": "64f1a2b3c4d5e6f7a8b9c0d1:3e5f7a9b1c2d4e6f8a0b2c4d6e8f0a1b3c5d7e9f1a2b4c6d8e0f2a3b5c7d9e1f"
      }
    }
  }
}
```

The key above is a made-up example in the real format: 24 hex characters, a colon, then 64 hex characters. Replace both values with your own.

When you run the server with `npx`, pass the settings through `env` as shown. A `.env` file is read only from a source checkout (see below), or from the path in `GHOST_MCP_ENV_FILE`.

3. Restart the client and ask something like "List my latest posts with their SEO titles."

`GHOST_API_URL` is the canonical Admin domain, including any site subdirectory, without `/ghost/api/admin`. For a local site, use an address such as `http://localhost:2368`.

Config file locations: Claude Desktop on macOS uses `~/Library/Application Support/Claude/claude_desktop_config.json`. Cursor uses `~/.cursor/mcp.json` or `.cursor/mcp.json` in your project.

**Claude Code:**

```bash
claude mcp add ghost --scope user \
  -e GHOST_API_URL=https://your-blog.com \
  -e GHOST_ADMIN_API_KEY=64f1a2b3c4d5e6f7a8b9c0d1:3e5f7a9b1c2d4e6f8a0b2c4d6e8f0a1b3c5d7e9f1a2b4c6d8e0f2a3b5c7d9e1f \
  -- npx -y @proars/ghost-mcp-server
```

`--scope user` makes the server available in every folder. Without it, the server is registered only for the folder where you ran the command. Claude Code starts and stops the server itself, so you don't need to keep a terminal open.

Check the connection with `claude mcp get ghost`, which should report `Connected`, or type `/mcp` inside a `claude` session. To remove the server, run `claude mcp remove ghost -s user`.

**Updating:** `npx` keeps a cached copy and may not fetch a new release right away. To update, run `rm -rf ~/.npm/_npx` and restart your client, or use `@proars/ghost-mcp-server@latest` in the command so npx checks the registry on every start. To stay on one version, pin it, for example `@proars/ghost-mcp-server@2.1.0`. See the [changelog](CHANGELOG.md) for what changed in each release.

Don't run `npx` from inside a clone of this repository: npm finds the local `package.json` with the same name and fails with `ghost-mcp-server: command not found`. Run it from any other folder.

Any other stdio MCP client can run the same command, `npx -y @proars/ghost-mcp-server`, with the two environment variables.

## Install from source

Use this if you want to change the code or run an unpublished version.

```bash
git clone https://github.com/proars/ghost-mcp-server.git
cd ghost-mcp-server
npm install
npm run build
cp .env.example .env
```

Fill in `GHOST_API_URL` and `GHOST_ADMIN_API_KEY` in `.env`, then point the client at the build. Keep `--silent`: npm's startup banner would otherwise end up in the MCP protocol stream on stdout.

```json
{
  "mcpServers": {
    "ghost": {
      "command": "npm",
      "args": ["--silent", "--prefix", "/ABSOLUTE/PATH/ghost-mcp-server", "start"]
    }
  }
}
```

The `.env` file in the project root is read regardless of the directory the client starts the server from. Variables that are already set take priority, and if both required variables are set, the file is not read at all. `GHOST_MCP_ENV_FILE` selects a different env file, and `GHOST_MCP_SKIP_DOTENV=1` turns file loading off.

## What can the server do?

| Resource | Tools |
|---|---|
| Posts | `get_posts`, `get_post`, `get_post_by_slug`, `create_post`, `update_post`, `delete_post`, `copy_post` |
| Pages | `get_pages`, `get_page`, `get_page_by_slug`, `create_page`, `update_page`, `delete_page`, `copy_page` |
| Tags | `get_tags`, `get_tag`, `get_tag_by_slug`, `create_tag`, `update_tag`, `delete_tag` |
| Tiers | `get_tiers`, `get_tier`, `create_tier`, `update_tier` |
| Newsletters | `get_newsletters`, `get_newsletter`, `create_newsletter`, `update_newsletter` |
| Offers | `get_offers`, `get_offer`, `create_offer`, `update_offer` |
| Members | `get_members`, `get_member`, `create_member`, `update_member`, `delete_member` |
| Labels | `get_labels`, `create_label`, `update_label`, `delete_label` |
| Staff | `get_users`, `get_user`, `update_user`, `delete_user`, `get_roles`, `invite_user` |
| Images and themes | `upload_image`, `upload_theme`, `activate_theme` |
| Webhooks | `create_webhook`, `update_webhook`, `delete_webhook` |
| Site | `get_site`, `get_settings` |
| Shortcuts | `update_post_seo`, `update_post_tags` |
| Discovery and generic calls | `ghost_list_endpoints`, `ghost_api_request` |

Ghost has no delete endpoint for tiers, newsletters or offers, so those resources have no `delete_*` tool.

> **Warning: this server exposes every supported function, including destructive ones.** `delete_post`, `delete_page`, `delete_tag`, `delete_member`, `delete_user`, `activate_theme`, `upload_theme` and `ghost_api_request` can permanently remove or overwrite content, subscribers and site settings. Deleted records usually cannot be restored. Create a separate integration key for the server, make a backup (Ghost Admin → Settings → Labs → Export) before bulk work, and turn on manual approval for all `update_*`, `delete_*` and generic calls in your client.

### How do I call the tools?

- **Create and update:** put the record fields in `data` and pass the record `id` as a separate argument. Post and page updates need `data.updated_at` from a fresh read. The SEO and tag shortcuts take `updated_at` directly.
- **Lists:** use `limit`, `page`, `filter`, `order`, `include` and `fields`. Posts and pages come back with compact fields and tags by default. Single-record reads return the full record.
- **Tags:** setting tags replaces the whole set. Tags that don't exist yet are created, and an empty array removes all tags.
- **Publishing:** call `update_post` with `data.status="published"`, or with `"scheduled"` and a future `data.published_at`. To send the post by email, add `newsletter` (a slug) and, optionally, `email_segment`.
- **Images:** `upload_image` takes `file_path`, an optional `purpose` (`image`, `profile_image` or `icon`) and `ref`.

### How do I reach routes that have no dedicated tool?

Use `ghost_list_endpoints` to search by `group`, `method`, `access` or `search`. Set `without_dedicated_tool=true` to list the other 198 routes. Each entry shows access requirements, feature flags and upload fields.

Call any route with `ghost_api_request`. Its `path` is relative to `/ghost/api/admin`, contains real IDs or slugs, and has no query string.

```text
ghost_api_request method=GET  path=/labels/slug/vip/
ghost_api_request method=POST path=/members/upload/ files={membersfile: "/Users/me/members.csv"}
ghost_api_request method=GET  path=/posts/export/   save_to="/Users/me/posts.csv"
```

Send JSON payloads in `body`, using the structure Ghost expects. Put query parameters in `query`. Send multipart files as `files={formField: "/absolute/path"}`, with optional text `fields`.

For downloads, `save_to` must name a new file in an existing, writable folder. Trailing separators are rejected and existing files are never overwritten. When a POST, PUT or DELETE returns a file, set `save_to` on the first call, because repeating a mutation to get its response can repeat its effect.

## Which Ghost permissions does it need?

| Class | Routes | Requirement |
|---|---:|---|
| `I` / `PUBLIC` | 125 | Integration-key allowlist or public access. Handler permissions still apply. |
| `U` | 116 | A staff user's access token with the required role, or a user session. |
| `SESSION` | 3 | User cookie session. Integration keys and staff tokens are blocked. |
| `FLOW` | 9 | Login, recovery and setup flows with their own authentication. |

To use a staff token, put the token from the user's Ghost Admin profile into `GHOST_ADMIN_API_KEY`. Its permissions follow the user's role. Staff tokens cannot call `DELETE /db/`, `PUT /users/owner/` or `POST /authentication/reset/`.

The server does not implement cookie sessions, login or 2FA. Those routes are in the catalog for discovery only.

Requests send `Accept-Version: v5.0`. The catalog is a snapshot of Ghost's `main` branch, so it includes newer or experimental routes that may return 404 on your installation. The public Content API is not included.

## Is it safe to give an AI client access to my site?

Treat it like any account with write access to your blog, and keep a human in the loop.

- Keep keys in your client's environment or in `.env`, and never commit them. Turn on manual approval for destructive tools: all `update_*` and `delete_*` tools, `activate_theme`, `upload_theme` and `ghost_api_request`.
- If a mutation fails after it was sent, check Ghost before retrying, because it may have gone through. Use the read tools to inspect the result of a truncated response.
- Redirects are never followed. Configure the canonical Admin URL, and after a mutation receives a redirect, check the result before sending another request.
- Local file paths must be absolute. Hidden path components are refused, both as written and after symlink resolution. Uploads require regular files, and downloads are reserved before the request with owner-only permissions.
- The file checks are not a sandbox. They don't protect sensitive files that have visible names, and they don't stop a local process from rewriting directories during a call. Treat site content as untrusted and review upload requests.
- Uploads and downloads are buffered in memory. HTTP requests time out after 120 seconds, and tool responses longer than 100,000 characters are truncated.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # regression tests with synthetic credentials and a local fake Ghost server
npm run catalog     # regenerate src/catalog.ts from GHOST_API.list
npm run build       # compile to dist/
npm start           # run the build over stdio (requires configuration)
```

The route list lives in `GHOST_API.list`. `scripts/generate-catalog.mjs` turns it into `src/catalog.ts`, which you should never edit by hand. To change routes, edit the list, run `npm run catalog`, then run the tests. Logs go to stderr, because stdout is reserved for MCP messages.

GitHub Actions runs typecheck, build and tests on Node 20 and 22 for every push to `main` and every pull request.

The tests check catalog and tool consistency, request construction, file safety, redirects, retry guidance and configuration isolation. They don't prove compatibility with a live Ghost instance.

## FAQ

**Does it work with self-hosted Ghost and Ghost(Pro)?**
Yes, as long as you can reach the Admin API and have a key. Use the Admin domain of your site as `GHOST_API_URL`.

**Which clients does it support?**
Any MCP client that can start a stdio server, including Claude Desktop, Claude Code and Cursor.

**Can it read my public content without an Admin key?**
No. It uses the Admin API only. The public Content API is not covered.

**Can it delete my content?**
Yes, `delete_post`, `delete_page` and similar tools are permanent. Require manual approval for them in your client.

## License

[MIT](LICENSE).
