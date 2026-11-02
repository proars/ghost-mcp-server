# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.1.1] - 2026-11-01

### Changed

- README: Claude Code install uses `--scope user`, with steps to check and remove the server, a note on updating, and a warning about running `npx` inside a clone of this repository.

## [2.1.0] - 2026-11-01

First release on npm as `@proars/ghost-mcp-server`.

### Added

- `delete_member` tool (`DELETE /members/{id}/`). The server now has 59 tools.
- `ghost-mcp-server` command (`bin` with a shebang), so the package runs with `npx -y @proars/ghost-mcp-server`.
- GitHub Actions workflow that runs typecheck, build and tests on Node 20 and 22.
- README warning that destructive tools are available, and an install section for `npx`.

### Changed

- `npm start` runs the compiled `dist/index.js` instead of `tsx`.
- Published files are limited to `dist`, `README.md`, `LICENSE` and `.env.example`.
- `prepublishOnly` builds the project and runs the tests before every publish.
- Minimum `@modelcontextprotocol/sdk` raised from `^1.0.0` to `^1.32.0`.
- README rewritten with a quick start, FAQ and access notes.
