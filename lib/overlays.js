/**
 * Overlay rendering system
 * Generates SVG overlays for different content types
 */

/**
 * Generate clock overlay
 */
function generateClockOverlay(overlay, region) {
  // Use _renderTime for pre-rendering, or current time for live updates
  const now = overlay._renderTime || new Date();

  // Use format options from config or defaults
  const format = overlay.format || {};
  const timeString = now.toLocaleTimeString(undefined, {
    hour: format.hour || 'numeric',
    minute: format.minute || '2-digit',
    second: format.second || '2-digit',
    hour12: format.hour12
  });

  return generateTextSVG(timeString, overlay, region);
}

/**
 * Generate date overlay
 */
function generateDateOverlay(overlay, region) {
  const now = new Date();

  // Use format options from config or defaults
  const format = overlay.format || {};
  const dateString = now.toLocaleDateString(undefined, {
    weekday: format.weekday,
    year: format.year,
    month: format.month,
    day: format.day
  });

  return generateTextSVG(dateString, overlay, region);
}

/**
 * Generate static text overlay
 */
function generateTextOverlay(overlay, region) {
  const text = overlay.text || '';
  return generateTextSVG(text, overlay, region);
}

/**
 * Generate custom overlay (user-defined function)
 */
function generateCustomOverlay(overlay, region) {
  if (overlay.generator && typeof overlay.generator === 'function') {
    return overlay.generator(overlay, region);
  }
  return generateTextSVG('', overlay, region);
}

/**
 * Generate SVG with text
 */
function generateTextSVG(text, overlay, region) {
  const style = overlay.style || {};

  const fontSize = style.fontSize || 120;
  const fontFamily = style.fontFamily || 'Arial, sans-serif';
  const color = style.color || '#ffffff';
  const fontWeight = style.fontWeight || 'bold';
  const textAlign = style.textAlign || 'left';
  const letterSpacing = style.letterSpacing || 'normal';

  const svgWidth = region.width;
  const svgHeight = region.height;

  // Determine text anchor based on text-align
  let textAnchor = 'start';
  let xPos = '0';
  if (textAlign === 'center') {
    textAnchor = 'middle';
    xPos = '50%';
  } else if (textAlign === 'right') {
    textAnchor = 'end';
    xPos = '100%';
  }

  return Buffer.from(`
    <svg width="${svgWidth}" height="${svgHeight}">
      <text
        x="${xPos}"
        y="50%"
        font-family="${fontFamily}"
        font-size="${fontSize}px"
        font-weight="${fontWeight}"
        fill="${color}"
        text-anchor="${textAnchor}"
        dominant-baseline="middle"
        letter-spacing="${letterSpacing}">
        ${text}
      </text>
    </svg>
  `);
}

/**
 * Main overlay generator - routes to appropriate renderer
 */
function generateOverlay(overlay, region) {
  switch (overlay.type) {
    case 'clock':
      return generateClockOverlay(overlay, region);
    case 'date':
      return generateDateOverlay(overlay, region);
    case 'text':
      return generateTextOverlay(overlay, region);
    case 'custom':
      return generateCustomOverlay(overlay, region);
    default:
      console.warn(`Unknown overlay type: ${overlay.type}`);
      return generateTextOverlay({ text: '', style: {} }, region);
  }
}

/**
 * Detect element position and style from page
 */
async function detectOverlayRegion(page, overlay) {
  return await page.evaluate((selector) => {
    const element = document.querySelector(selector);
    if (!element) {
      console.error(`Overlay element not found: ${selector}`);
      return null;
    }

    const rect = element.getBoundingClientRect();
    const styles = window.getComputedStyle(element);

    console.log(`Detected element at selector "${selector}":`, JSON.stringify({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    }));

    return {
      region: {
        x: Math.floor(rect.left),
        y: Math.floor(rect.top),
        width: Math.ceil(rect.width),
        height: Math.ceil(rect.height)
      },
      style: {
        fontSize: parseInt(styles.fontSize),
        fontFamily: styles.fontFamily,
        color: styles.color,
        fontWeight: styles.fontWeight,
        textAlign: styles.textAlign,
        letterSpacing: styles.letterSpacing || 'normal'
      }
    };
  }, overlay.selector);
}

/**
 * Hide overlay elements from page
 */
async function hideOverlayElements(page, overlays) {
  const selectors = overlays.map(o => o.selector).filter(Boolean);
  if (selectors.length === 0) return;

  const css = selectors.map(selector => `${selector} { visibility: hidden !important; }`).join('\n');

  await page.addStyleTag({ content: css });
  console.log(`Hidden ${selectors.length} overlay element(s)`);
}

module.exports = {
  generateOverlay,
  detectOverlayRegion,
  hideOverlayElements
};
