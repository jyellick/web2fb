/**
 * Framebuffer Management
 *
 * Handles all interactions with the Linux framebuffer device:
 * - Detection and initialization
 * - Image format conversion
 * - Full and partial screen writes
 */

const sharp = require('sharp');
const fs = require('fs');

class Framebuffer {
  constructor(config, perfMonitor) {
    this.config = config;
    this.perfMonitor = perfMonitor;
    this.fd = null;
    this.info = null;
    this.bufferPool = {
      rgb565: null,
      maxSize: 0
    };
  }

  /**
   * Detect framebuffer properties from sysfs
   */
  detect() {
    try {
      const fbPath = this.config.display.framebufferDevice.replace('/dev/', '/sys/class/graphics/');
      const xres = parseInt(fs.readFileSync(`${fbPath}/virtual_size`).toString().split(',')[0]);
      const yres = parseInt(fs.readFileSync(`${fbPath}/virtual_size`).toString().split(',')[1]);
      const bpp = parseInt(fs.readFileSync(`${fbPath}/bits_per_pixel`).toString());

      console.log(`Framebuffer detected: ${xres}x${yres} @ ${bpp}bpp`);

      return {
        width: xres,
        height: yres,
        bpp: bpp,
        bytesPerPixel: bpp / 8,
        stride: xres * (bpp / 8)
      };
    } catch (_err) {
      console.warn('Could not detect framebuffer properties, using config values');
      return {
        width: this.config.display.width,
        height: this.config.display.height,
        bpp: 32,
        bytesPerPixel: 4,
        stride: this.config.display.width * 4
      };
    }
  }

  /**
   * Open framebuffer device for writing
   */
  open() {
    try {
      this.fd = fs.openSync(this.config.display.framebufferDevice, 'w');
      this.info = this.detect();
      console.log(`Framebuffer opened: ${this.config.display.framebufferDevice}`);
      return true;
    } catch (err) {
      console.error(`Failed to open framebuffer ${this.config.display.framebufferDevice}:`, err);
      return false;
    }
  }

  /**
   * Render and display splash screen from config
   */
  async displaySplashScreen() {
    const splashConfig = this.config.splash || {};
    const text = splashConfig.text || 'web2fb - Loading...';
    const style = splashConfig.style || {};

    try {
      console.log('Rendering splash screen...');

      const { createCanvas } = require('@napi-rs/canvas');

      const width = this.config.display.width || 1920;
      const height = this.config.display.height || 1080;

      // Create canvas
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');

      // Black background
      ctx.fillStyle = 'rgb(0, 0, 0)';
      ctx.fillRect(0, 0, width, height);

      // Text styling
      const fontSize = style.fontSize || 48;
      const fontFamily = style.fontFamily || 'sans-serif';
      const fontWeight = style.fontWeight || 'normal';
      const color = style.color || 'rgb(255, 255, 255)';

      ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Draw text centered
      ctx.fillText(text, width / 2, height / 2);

      // Convert to buffer
      const splashBuffer = await canvas.encode('png');

      await this.writeFull(splashBuffer);
      console.log('Splash screen displayed - starting browser...');
      return true;
    } catch (err) {
      console.warn('Could not display splash screen:', err.message);
      return false;
    }
  }

  /**
   * Convert image buffer to framebuffer format
   */
  async convertToFramebufferFormat(imageBuffer, operationName = 'convert') {
    const sharpImage = sharp(imageBuffer, {
      sequentialRead: true,
      limitInputPixels: false
    });

    const convOpId = this.perfMonitor.start(`${operationName}:sharpConvert`, { bpp: this.info.bpp });
    let rawBuffer;

    if (this.info.bpp === 32) {
      rawBuffer = await sharpImage.ensureAlpha().raw().toBuffer();
    } else if (this.info.bpp === 24) {
      rawBuffer = await sharpImage.removeAlpha().raw().toBuffer();
    } else if (this.info.bpp === 16) {
      const rgbBuffer = await sharpImage.removeAlpha().raw().toBuffer();
      this.perfMonitor.end(convOpId);
      rawBuffer = this.convertToRGB565(rgbBuffer);
    } else {
      throw new Error(`Unsupported framebuffer format: ${this.info.bpp}bpp`);
    }

    if (this.info.bpp !== 16) {
      this.perfMonitor.end(convOpId);
    }

    return { rawBuffer, sharpImage };
  }

  /**
   * Convert RGB888 to RGB565 format (with buffer pooling)
   */
  convertToRGB565(rgbBuffer) {
    const perfOpId = this.perfMonitor.start('convertToRGB565', { inputBytes: rgbBuffer.length });

    const requiredSize = (rgbBuffer.length / 3) * 2;

    if (!this.bufferPool.rgb565 || this.bufferPool.maxSize < requiredSize) {
      this.bufferPool.rgb565 = Buffer.allocUnsafe(requiredSize);
      this.bufferPool.maxSize = requiredSize;
    }

    const rgb565Buffer = this.bufferPool.rgb565;

    for (let i = 0; i < rgbBuffer.length; i += 3) {
      const r = rgbBuffer[i];
      const g = rgbBuffer[i + 1];
      const b = rgbBuffer[i + 2];

      const r5 = (r >> 3) & 0x1F;
      const g6 = (g >> 2) & 0x3F;
      const b5 = (b >> 3) & 0x1F;

      const rgb565 = (r5 << 11) | (g6 << 5) | b5;

      const offset = (i / 3) * 2;
      rgb565Buffer.writeUInt16LE(rgb565, offset);
    }

    this.perfMonitor.end(perfOpId, { outputBytes: requiredSize });

    return requiredSize === this.bufferPool.maxSize ? rgb565Buffer : rgb565Buffer.subarray(0, requiredSize);
  }

  /**
   * Write full image to framebuffer
   */
  async writeFull(imageBuffer) {
    const perfOpId = this.perfMonitor.start('writeToFramebuffer:total');

    try {
      const { rawBuffer } = await this.convertToFramebufferFormat(imageBuffer, 'writeToFramebuffer');

      const writeOpId = this.perfMonitor.start('writeToFramebuffer:fbWrite', { bytes: rawBuffer.length });
      fs.writeSync(this.fd, rawBuffer, 0, rawBuffer.length, 0);
      this.perfMonitor.end(writeOpId);

      this.perfMonitor.end(perfOpId, { success: true });
      return true;
    } catch (err) {
      console.error('Error writing to framebuffer:', err);
      this.perfMonitor.end(perfOpId, { success: false, error: err.message });
      return false;
    }
  }

  /**
   * Write partial image to framebuffer at specific region
   */
  async writePartial(imageBuffer, region) {
    const perfOpId = this.perfMonitor.start('writePartialToFramebuffer:total', { region });

    try {
      const { rawBuffer, sharpImage } = await this.convertToFramebufferFormat(imageBuffer, 'writePartialToFramebuffer');
      const metadata = await sharpImage.metadata();

      const regionWidth = metadata.width;
      const regionHeight = metadata.height;
      const bytesPerLine = regionWidth * this.info.bytesPerPixel;
      const fbBytesPerLine = this.info.width * this.info.bytesPerPixel;

      const writeOpId = this.perfMonitor.start('writePartialToFramebuffer:fbWrite', {
        width: regionWidth,
        height: regionHeight,
        lines: regionHeight
      });

      for (let y = 0; y < regionHeight; y++) {
        const srcOffset = y * bytesPerLine;
        const fbOffset = ((region.y + y) * fbBytesPerLine) + (region.x * this.info.bytesPerPixel);
        fs.writeSync(this.fd, rawBuffer, srcOffset, bytesPerLine, fbOffset);
      }

      this.perfMonitor.end(writeOpId);
      this.perfMonitor.end(perfOpId, { success: true });
      return true;
    } catch (err) {
      console.error('Error writing partial to framebuffer:', err);
      this.perfMonitor.end(perfOpId, { success: false, error: err.message });
      return false;
    }
  }

  /**
   * Close framebuffer device
   */
  close() {
    if (this.fd) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

module.exports = Framebuffer;
