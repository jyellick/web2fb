# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Stress management system with progressive throttling (NORMAL → MILD → MODERATE → SEVERE)
- In-process browser restart on severe stress (no process exit needed)
- Critical event decay - old stress events forgiven when system runs smoothly
- Drop-frame behavior for overlay updates - prevents clock "jumping"
- Chrome profile size monitoring (tmpfs/RAM-backed on Pi)
- Configurable profile size threshold (default 40MB)
- Development server for testing without Pi hardware
- Comprehensive documentation structure (docs/ folder)
- GitHub Actions CI/CD with Node 18/20/22 testing
- Example systemd service file
- Chrome profile cleanup utility

### Changed
- Restructured documentation - streamlined README with detailed guides
- README reduced from 740+ to ~120 lines
- Package.json completed with repository URLs and metadata
- Buffer pooling now uses subarray() instead of slice() for true reuse
- All intervals tracked and cleared on exit

### Fixed
- Memory leak from uncleared setInterval calls
- RGB565 buffer pooling creating copies instead of reusing
- Periodic check timer now resets when mutation-triggered update occurs
- Snapshot strings in change detection now limited to prevent unbounded growth

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
