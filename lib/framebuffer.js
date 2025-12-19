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
    // Enhanced buffer pool with pre-allocated common sizes
    this.bufferPools = new Map(); // size -> Buffer[]
    this.maxBuffersPerSize = 3;
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
      this._preAllocateBuffers(); // Pre-allocate buffers for common sizes
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

      const width = this.config.display.width || 1920;
      const height = this.config.display.height || 1080;

      // Text styling
      const fontSize = style.fontSize || 48;
      const fontFamily = style.fontFamily || 'sans-serif';
      const fontWeight = style.fontWeight || 'normal';
      const color = style.color || 'rgb(255, 255, 255)';

      // Generate SVG with centered text on black background
      const svg = Buffer.from(`
        <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
          <rect width="${width}" height="${height}" fill="rgb(0, 0, 0)"/>
          <text
            x="50%"
            y="50%"
            font-family="${fontFamily}"
            font-size="${fontSize}px"
            font-weight="${fontWeight}"
            fill="${color}"
            text-anchor="middle"
            dominant-baseline="middle"
          >${text}</text>
        </svg>
      `);

      // Convert SVG to PNG using sharp
      const splashBuffer = await sharp(svg).png().toBuffer();

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
   * Acquire a buffer from the pool or allocate a new one
   * @private
   */
  _acquireBuffer(size) {
    const pool = this.bufferPools.get(size);
    if (pool && pool.length > 0) {
      return pool.pop();
    }
    return Buffer.allocUnsafe(size);
  }

  /**
   * Return a buffer to the pool for reuse
   * @private
   */
  _releaseBuffer(buffer) {
    const size = buffer.length;
    let pool = this.bufferPools.get(size);
    if (!pool) {
      pool = [];
      this.bufferPools.set(size, pool);
    }
    // Only keep up to maxBuffersPerSize buffers per size
    if (pool.length < this.maxBuffersPerSize) {
      pool.push(buffer);
    }
  }

  /**
   * Pre-allocate buffers for common sizes
   * @private
   */
  _preAllocateBuffers() {
    if (!this.info) return;

    // Pre-allocate for full screen RGB565
    if (this.info.bpp === 16) {
      const fullScreenSize = this.info.width * this.info.height * 2;
      this._releaseBuffer(Buffer.allocUnsafe(fullScreenSize));
    }

    // Pre-allocate common clock region size (estimated)
    const clockRegionSize = 300 * 100 * 2; // Width x Height x 2 bytes (RGB565)
    this._releaseBuffer(Buffer.allocUnsafe(clockRegionSize));
  }

  /**
   * Convert RGB888 to RGB565 format (with enhanced buffer pooling)
   */
  convertToRGB565(rgbBuffer) {
    const perfOpId = this.perfMonitor.start('convertToRGB565', { inputBytes: rgbBuffer.length });

    const requiredSize = (rgbBuffer.length / 3) * 2;
    const rgb565Buffer = this._acquireBuffer(requiredSize);

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

    return rgb565Buffer.length === requiredSize ? rgb565Buffer : rgb565Buffer.subarray(0, requiredSize);
  }

  /**
   * Write full image to framebuffer
   * @param {Buffer} imageBuffer - PNG buffer or raw pixel buffer
   * @param {Object} metadata - Optional metadata for raw buffers { width, height, channels }
   */
  async writeFull(imageBuffer, metadata = null) {
    const perfOpId = this.perfMonitor.start('writeToFramebuffer:total');

    try {
      let rawBuffer;

      if (metadata) {
        // Raw buffer path - skip PNG decode, just convert pixel format
        const convOpId = this.perfMonitor.start('writeToFramebuffer:rawConvert', {
          format: 'raw',
          width: metadata.width,
          height: metadata.height,
          channels: metadata.channels
        });

        if (this.info.bpp === 32 && metadata.channels === 4) {
          // Already RGBA, no conversion needed
          rawBuffer = imageBuffer;
        } else if (this.info.bpp === 24 && metadata.channels === 3) {
          // Already RGB, no conversion needed
          rawBuffer = imageBuffer;
        } else if (this.info.bpp === 16 && metadata.channels === 3) {
          // RGB → RGB565 conversion needed
          rawBuffer = this.convertToRGB565(imageBuffer);
        } else if (this.info.bpp === 16 && metadata.channels === 4) {
          // RGBA → RGB565: need to remove alpha first
          const rgbBuffer = Buffer.allocUnsafe((imageBuffer.length / 4) * 3);
          for (let i = 0, j = 0; i < imageBuffer.length; i += 4, j += 3) {
            rgbBuffer[j] = imageBuffer[i];       // R
            rgbBuffer[j + 1] = imageBuffer[i + 1]; // G
            rgbBuffer[j + 2] = imageBuffer[i + 2]; // B
            // Skip alpha
          }
          rawBuffer = this.convertToRGB565(rgbBuffer);
        } else {
          throw new Error(`Unsupported raw format conversion: ${metadata.channels} channels to ${this.info.bpp}bpp`);
        }

        this.perfMonitor.end(convOpId);
      } else {
        // PNG buffer path - legacy
        const { rawBuffer: converted } = await this.convertToFramebufferFormat(imageBuffer, 'writeToFramebuffer');
        rawBuffer = converted;
      }

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

      // Write line by line (cannot batch because framebuffer lines are not contiguous)
      // Each region line must be written to the correct position in the framebuffer,
      // which includes pixels to the left and right of the region
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
