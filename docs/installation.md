# Installation Guide

Complete guide for setting up web2fb on Raspberry Pi.

## System Prerequisites

### 1. Update System

```bash
sudo apt-get update && sudo apt-get upgrade
```

### 2. Install Node.js 20+

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 3. Install Chromium

```bash
sudo apt-get install -y chromium-browser
```

### 4. Install Puppeteer Dependencies

```bash
sudo apt-get install -y \
  libx11-xcb1 libxcomposite1 libxcursor1 libxdamage1 \
  libxi6 libxtst6 libnss3 libcups2 libxss1 libxrandr2 \
  libasound2 libpangocairo-1.0-0 libatk1.0-0 \
  libatk-bridge2.0-0 libgtk-3-0
```

## Create Kiosk User (Recommended)

For security and isolation, run web2fb as a dedicated user:

```bash
# Create kiosk user
sudo useradd -m -s /bin/bash kiosk

# Add to video group for framebuffer access
sudo usermod -a -G video kiosk

# Switch to kiosk user for remaining steps
sudo su - kiosk
```

> **Note:** All paths in this guide assume the kiosk user home directory (`/home/kiosk/`). Adjust if using a different user.

## Optimize Pi for Framebuffer (Recommended)

For best performance and to prevent conflicts:

```bash
# Switch to console-only mode (no GUI login manager)
sudo raspi-config
# Navigate to: System Options → Boot → Console login

# Disable getty to prevent login prompt on framebuffer
sudo systemctl disable getty@tty1.service

# Reboot for changes to take effect
sudo reboot
```

After reboot, log back in as the kiosk user:
```bash
sudo su - kiosk
```

## Install web2fb

```bash
# Clone repository
git clone https://github.com/jyellick/web2fb.git /home/kiosk/web2fb
cd /home/kiosk/web2fb

# Install dependencies
npm install

# Configure Chromium path (required on Raspberry Pi)
echo "PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium" > .env
```

## Verify Installation

```bash
# Create test config
cp examples/simple.json config.json

# Run test (should display on your screen)
node web2fb.js

# Press Ctrl+C to stop
```

## Next Steps

- [Configure your display](configuration.md)
- [Set up systemd service](systemd.md)
- [Configure overlays](overlays.md)
