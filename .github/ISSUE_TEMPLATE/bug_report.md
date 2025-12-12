---
name: Bug Report
about: Report a bug or issue with web2fb
title: '[BUG] '
labels: bug
assignees: ''
---

## Bug Description

A clear and concise description of what the bug is.

## Environment

**Hardware:**
- Device: [e.g., Raspberry Pi Zero 2 W, Pi 4]
- RAM: [e.g., 512MB, 1GB, 2GB]
- OS: [e.g., Raspberry Pi OS Lite, Ubuntu]
- Node.js version: [e.g., 18.x, 20.x]

**web2fb:**
- Version: [e.g., 1.0.0 or commit hash]
- Installation method: [npm, git clone]

## Configuration

Please provide your `config.json` (remove sensitive URLs/tokens):

```json
{
  "display": {
    "url": "https://...",
    ...
  }
}
```

## Steps to Reproduce

1. Go to '...'
2. Run command '...'
3. See error

## Expected Behavior

What you expected to happen.

## Actual Behavior

What actually happened.

## Logs

Please include relevant logs:

```bash
# For systemd service:
sudo journalctl -u web2fb.service -n 100

# For manual run:
node web2fb.js
```

<details>
<summary>Log output</summary>

```
Paste logs here
```

</details>

## Screenshots

If applicable, add screenshots of the framebuffer output or error messages.

## Additional Context

Any other context about the problem (e.g., network issues, specific website behavior, etc.)

## Checklist

- [ ] I've checked the [troubleshooting guide](../docs/troubleshooting.md)
- [ ] I've searched for similar issues
- [ ] I've included my configuration (with sensitive data removed)
- [ ] I've included relevant logs
