#!/bin/bash

# Convert raw framebuffer to viewable PNG

set -e

# Configuration
FB_WIDTH=${WIDTH:-1920}
FB_HEIGHT=${HEIGHT:-1080}
FB_BPP=32  # 32-bit RGBA
TEST_FB_DEVICE="./test-fb/fb0"
OUTPUT_FILE="framebuffer-preview.png"

if [ ! -f "$TEST_FB_DEVICE" ]; then
  echo "Error: Test framebuffer not found at $TEST_FB_DEVICE"
  echo "Run ./test-framebuffer.sh first"
  exit 1
fi

echo "Converting framebuffer to PNG..."
echo "Input: $TEST_FB_DEVICE"
echo "Output: $OUTPUT_FILE"
echo "Resolution: ${FB_WIDTH}x${FB_HEIGHT} @ ${FB_BPP}bpp"

# Use Node.js with Sharp to convert raw framebuffer to PNG
node -e "
const sharp = require('sharp');
const fs = require('fs');

const width = ${FB_WIDTH};
const height = ${FB_HEIGHT};
const bpp = ${FB_BPP};

const rawBuffer = fs.readFileSync('${TEST_FB_DEVICE}');

let sharpImage;
if (bpp === 32) {
  // RGBA8888
  sharpImage = sharp(rawBuffer, {
    raw: {
      width: width,
      height: height,
      channels: 4
    }
  });
} else if (bpp === 24) {
  // RGB888
  sharpImage = sharp(rawBuffer, {
    raw: {
      width: width,
      height: height,
      channels: 3
    }
  });
} else {
  console.error('Unsupported BPP:', bpp);
  process.exit(1);
}

sharpImage
  .png()
  .toFile('${OUTPUT_FILE}')
  .then(() => {
    console.log('');
    console.log('✓ Framebuffer converted successfully!');
    console.log('  View it: open ${OUTPUT_FILE}');
  })
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
"

echo ""
echo "Done! View the image with:"
echo "  open $OUTPUT_FILE"
echo "  # or"
echo "  xdg-open $OUTPUT_FILE"
