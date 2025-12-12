# Contributing to web2fb

Thank you for your interest in contributing to web2fb! This document provides guidelines and information for contributors.

## Code of Conduct

Be respectful, inclusive, and constructive. We want this project to be welcoming to everyone.

## How to Contribute

### Reporting Bugs

Use the [Bug Report template](.github/ISSUE_TEMPLATE/bug_report.md) and include:
- Hardware details (Pi model, RAM)
- Configuration file (remove sensitive data)
- Complete logs
- Steps to reproduce

### Suggesting Features

Use the [Feature Request template](.github/ISSUE_TEMPLATE/feature_request.md) and explain:
- What problem it solves
- Your use case
- How it fits web2fb's goal of resource-constrained rendering

### Pull Requests

1. **Fork the repository** and create a branch from `main`
2. **Make your changes** following our code style
3. **Test thoroughly** - especially on actual Pi hardware if possible
4. **Update documentation** - Keep README and docs/ in sync
5. **Add tests** - New features need test coverage
6. **Update CHANGELOG.md** - Add your changes under [Unreleased]
7. **Submit PR** using our [PR template](.github/pull_request_template.md)

## Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/web2fb.git
cd web2fb

# Install dependencies
npm install

# Configure Chromium path
echo "PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium" > .env

# Run tests
npm test

# Check code style
npm run lint
npm run format:check
```

## Testing

### Local Development

Use the development server for quick testing without Pi hardware:

```bash
# Terminal 1: Start dev server
npm run dev

# Terminal 2: Run web2fb
FRAMEBUFFER_DEVICE=test-fb/fb0 node web2fb.js --config=examples/simple.json

# Open http://localhost:3000 to see output
```

### On Pi Hardware

**Always test on actual Raspberry Pi hardware** before submitting performance-related changes. The memory constraints and CPU limitations are what make web2fb challenging.

### Running Tests

```bash
# All tests
npm test

# Watch mode
npm run test:watch

# Coverage
npm run test:coverage

# Linting
npm run lint
```

## Code Style

### General Guidelines

- **Keep memory usage low** - This is critical for Pi Zero 2 W (512MB RAM)
- **Optimize for constrained hardware** - Not for powerful machines
- **Prioritize simplicity** - Clear code over clever code
- **Comment complex logic** - Especially performance optimizations
- **No console.log** - Use console.error/warn/info appropriately

### JavaScript Style

We use ESLint and Prettier:

```bash
# Auto-fix style issues
npm run lint:fix
npm run format

# Check before committing
npm run lint
npm run format:check
```

Key conventions:
- Use `const` and `let`, not `var`
- Prefix unused variables with `_` (e.g., `_err`)
- Use async/await over promises when possible
- CommonJS modules (`require`, `module.exports`)

### Configuration

- **All new config options** must be added to `config.schema.json`
- Provide sensible defaults
- Document in `docs/configuration.md`
- Add example to `examples/` if complex

### Documentation

- Update README if adding major features
- Update relevant docs/ files
- Keep examples up to date
- Add inline comments for complex code

## Architecture

### Key Components

- **web2fb.js** - Main application, browser management
- **lib/overlays.js** - Overlay rendering system
- **lib/stress-monitor.js** - Memory protection
- **lib/config.js** - Configuration loading
- **lib/cleanup.js** - Chrome profile management

### Performance Principles

1. **Prioritize user-visible operations** - Clock updates over page re-renders
2. **Use overlays** - Render dynamic content locally
3. **Buffer pooling** - Reuse buffers to reduce GC pressure
4. **Drop frames** - Don't queue updates, skip them
5. **Monitor stress** - Throttle before crashing

## Commit Messages

Write clear, descriptive commit messages:

```
Add custom overlay type for weather data

- Implement weather overlay renderer
- Add configuration schema
- Update documentation  
- Add tests

Fixes #123
```

## Testing on Different Hardware

If you have access to different Pi models, test your changes on:
- Pi Zero 2 W (512MB) - Most constrained, most important
- Pi 3 (1GB) - Common model
- Pi 4 (2GB+) - Less constrained, but still relevant
- Pi 5 - Latest hardware

Document which hardware you tested on in your PR.

## Memory Considerations

When adding features:
- Monitor memory usage: `watch -n 1 'ps aux | grep node'`
- Check for leaks: Run for extended periods
- Profile if needed: `node --prof web2fb.js`
- Test stress management: Verify throttling works

## Questions?

- Check [documentation](docs/)
- Search [existing issues](https://github.com/jyellick/web2fb/issues)
- Create a new issue if needed

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
