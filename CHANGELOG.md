# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Major Changes (v2.0.0)

#### Architecture Overhaul
- **Screenshot Provider Abstraction** - Pluggable system for local vs remote screenshot acquisition
- **Local Mode** (default) - Fresh browser launch per screenshot, prevents memory leaks
- **Remote Mode** - Offload screenshot capture to Cloudflare Worker
- **Removed Change Detection** - Simplified to periodic refresh (configurable interval)
- **Removed Stress Management** - No longer needed with fresh browser approach

#### New Features
- **YAML Configuration** - Primary config format (JSON still supported)
- **Dotenv Support** - Load environment variables from .env file
- **Wait Strategies** - Configurable page load timing (waitForSelector, waitDelay, waitForNetworkIdle)
- **Cloudflare Worker** - Complete worker implementation for remote screenshots
- **Periodic Refresh** - Works with or without overlays (5 minute default)
- **Docker Support** - Updated Dockerfile for new architecture

#### Configuration Changes
- `browser.mode` - New: "local" (default) or "remote"
- `browser.remoteScreenshotUrl` - New: Cloudflare Worker URL
- `browser.remoteApiKey` - New: API key for worker authentication
- `browser.waitDelay` - New: Additional wait after page load
- `browser.waitForSelector` - New: Wait for specific element(s)
- `browser.waitForNetworkIdle` - New: Wait for network idle
- `refreshInterval` - Replaces change detection configuration
- Removed `changeDetection` configuration section
- Removed `stressManagement` configuration section

#### Bug Fixes
- **Intermittent Screenshot Failures** - Fixed by removing temporary Chrome profiles
- **No Periodic Updates Without Overlays** - Fixed transition logic
- **Stale Chrome Processes** - Eliminated by fresh browser per screenshot
- **Missing Environment Variables** - Added dotenv support

#### Documentation
- Complete rewrite of configuration.md for local/remote modes
- Updated troubleshooting.md with recent debugging insights
- Removed duplicate SYSTEMD_SETUP.md (consolidated to docs/systemd.md)
- Updated README.md with screenshot mode examples
- Added cloudflare-worker/WAIT-STRATEGIES.md
- All documentation now reflects current architecture

#### Development
- Removed obsolete screenshot.js (replaced by screenshot-providers.js)
- All tests passing (93 tests)
- No TODO/FIXME comments in codebase
- Clean, maintainable code structure

### Changed
- Browser launches fresh for each screenshot instead of staying alive
- Simplified to periodic refresh model (no complex change detection)
- Configuration now primarily YAML (JSON still supported)
- Local mode no longer creates temporary Chrome profiles
- 2-second re-render delay (increased from 500ms)

## [1.0.0] - Initial Release

### Added
- Direct framebuffer rendering for Linux
- Puppeteer-based web page rendering
- Smart overlay system for local element rendering
- Clock, date, and text overlay types
- Auto-detect overlay styling from page
- Change detection with MutationObserver
- Periodic fallback checking
- Debounced change notifications
- JSON-based configuration
- Multiple framebuffer format support (RGB565, RGB, RGBA)
- Example configurations for DakBoard and other dashboards
- Comprehensive test suite
- ESLint and Prettier setup

[Unreleased]: https://github.com/jyellick/web2fb/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/jyellick/web2fb/releases/tag/v1.0.0
