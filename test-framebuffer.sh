#!/bin/bash

# Test script for local framebuffer simulation

set -e

# Configuration
FB_WIDTH=${WIDTH:-1920}
FB_HEIGHT=${HEIGHT:-1080}
FB_BPP=32  # 32-bit RGBA
TEST_FB_DIR="./test-fb"
TEST_FB_DEVICE="$TEST_FB_DIR/fb0"

echo "Setting up test framebuffer environment..."
echo "Resolution: ${FB_WIDTH}x${FB_HEIGHT} @ ${FB_BPP}bpp"

# Create test directory structure
mkdir -p "$TEST_FB_DIR"
mkdir -p "$TEST_FB_DIR/sys/class/graphics/fb0"

# Create fake sysfs files for framebuffer detection
echo "$FB_WIDTH,$FB_HEIGHT" > "$TEST_FB_DIR/sys/class/graphics/fb0/virtual_size"
echo "$FB_BPP" > "$TEST_FB_DIR/sys/class/graphics/fb0/bits_per_pixel"

# Calculate framebuffer size
FB_SIZE=$((FB_WIDTH * FB_HEIGHT * (FB_BPP / 8)))

# Create empty framebuffer file
dd if=/dev/zero of="$TEST_FB_DEVICE" bs=1 count=$FB_SIZE 2>/dev/null

echo "Test framebuffer created: $TEST_FB_DEVICE ($FB_SIZE bytes)"
echo ""
echo "Starting screenshot.js with test framebuffer..."
echo "Press Ctrl+C to stop"
echo ""

# Run screenshot.js with test framebuffer
FRAMEBUFFER_DEVICE="$TEST_FB_DEVICE" \
DISPLAY_URL="${DISPLAY_URL:-https://example.com}" \
node screenshot.js

# Note: To view the framebuffer, run: ./view-framebuffer.sh
