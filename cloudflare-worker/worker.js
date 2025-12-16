/**
 * Cloudflare Worker for web2fb Screenshot Service
 *
 * This worker uses Cloudflare's Browser Rendering API to capture screenshots
 * of web pages (like DakBoard) and return them to the Pi for local processing.
 *
 * Setup:
 * 1. npm install
 * 2. wrangler login
 * 3. wrangler deploy --env=""
 * 4. wrangler secret put API_KEY
 *
 * Cost: ~$5 per million requests (~$0.11/month for typical usage)
 */

import puppeteer from "@cloudflare/puppeteer";

export default {
  async fetch(request, env, ctx) {
    // CORS headers for Pi requests
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // API key authentication (optional but recommended)
    if (env.API_KEY) {
      const apiKey = request.headers.get('X-API-Key');
      if (apiKey !== env.API_KEY) {
        return new Response('Unauthorized', {
          status: 401,
          headers: corsHeaders
        });
      }
    }

    try {
      // Parse request parameters
      const url = new URL(request.url);
      const targetUrl = url.searchParams.get('url');
      const width = parseInt(url.searchParams.get('width') || '1920');
      const height = parseInt(url.searchParams.get('height') || '1080');
      const userAgent = url.searchParams.get('userAgent') ||
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      const timeout = parseInt(url.searchParams.get('timeout') || '180000');
      const waitForImages = url.searchParams.get('waitForImages') !== 'false';
      const waitForSelector = url.searchParams.get('waitForSelector');
      const waitDelay = parseInt(url.searchParams.get('waitDelay') || '0');
      const waitForNetworkIdle = url.searchParams.get('waitForNetworkIdle') === 'true';
      const hideSelectors = url.searchParams.get('hideSelectors')?.split(',').filter(Boolean) || [];

      if (!targetUrl) {
        return new Response('Missing url parameter', {
          status: 400,
          headers: corsHeaders
        });
      }

      console.log(`Capturing screenshot: ${targetUrl} (${width}x${height})`);

      // Launch browser using Cloudflare's Browser Rendering API
      // Pass the BROWSER binding to puppeteer.launch()
      const browser = await puppeteer.launch(env.BROWSER);
      const page = await browser.newPage();

      // Set viewport and user agent
      await page.setViewport({ width, height });
      await page.setUserAgent(userAgent);

      // Navigate to page
      // Use networkidle2 (2 connections) by default, or networkidle0 if explicitly requested
      const waitUntil = waitForNetworkIdle ? 'networkidle0' : 'networkidle2';
      await page.goto(targetUrl, {
        waitUntil,
        timeout
      });

      // Scroll to trigger lazy loading
      console.log('Scrolling page to trigger lazy-loaded content...');
      await page.evaluate(async () => {
        await new Promise((resolve) => {
          let scrollCount = 0;
          const scrollInterval = setInterval(() => {
            window.scrollBy(0, window.innerHeight);
            scrollCount++;
            if (scrollCount >= 3 || window.scrollY + window.innerHeight >= document.body.scrollHeight) {
              clearInterval(scrollInterval);
              window.scrollTo(0, 0);
              setTimeout(resolve, 500);
            }
          }, 200);
        });
      });

      // Wait for page to be fully stable (no loading indicators, document ready)
      console.log('Waiting for page to stabilize...');
      await page.waitForFunction(() => {
        // Check document is fully loaded
        if (document.readyState !== 'complete') return false;

        // Check for common loading indicators
        const loadingElements = document.querySelectorAll(
          '[class*="loading"], [class*="spinner"], [class*="Loading"], ' +
          '[aria-busy="true"], [data-loading="true"]'
        );
        if (Array.from(loadingElements).some(el => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden';
        })) {
          return false;
        }

        return true;
      }, { timeout: 30000 });

      // Wait for specific selector(s) if provided
      // Use waitForFunction instead of waitForSelector to avoid Puppeteer internal race conditions
      if (waitForSelector) {
        const selectors = waitForSelector.split(',').map(s => s.trim()).filter(Boolean);
        console.log(`Waiting for ${selectors.length} selector(s): ${selectors.join(', ')}`);

        // Wait for all selectors using waitForFunction (more reliable than waitForSelector)
        await page.waitForFunction((selectorList) => {
          return selectorList.every(selector => {
            const element = document.querySelector(selector);
            if (!element) return false;

            // Ensure element is visible
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden';
          });
        }, { timeout }, selectors).catch(err => {
          console.error(`Timeout waiting for selectors:`, err.message);
          throw new Error(`Selectors not found: ${selectors.join(', ')}`);
        });

        console.log('All selectors found');
      }

      // Wait for images to load (DakBoard-specific)
      if (waitForImages) {
        console.log('Waiting for images to load...');
        await page.evaluate(async (imageTimeout) => {
          const images = Array.from(document.querySelectorAll('img'));
          const bgElements = Array.from(document.querySelectorAll('[style*="background"]'));

          const imagePromises = images.map(img => {
            if (img.complete) return Promise.resolve();
            return new Promise((resolve) => {
              img.addEventListener('load', resolve);
              img.addEventListener('error', resolve);
              setTimeout(resolve, imageTimeout);
            });
          });

          const bgPromises = bgElements.map(el => {
            return new Promise((resolve) => {
              const bg = window.getComputedStyle(el).backgroundImage;
              if (bg === 'none') {
                resolve();
                return;
              }

              const urls = bg.match(/url\(['"]?([^'"]+)['"]?\)/g);
              if (!urls) {
                resolve();
                return;
              }

              const img = new Image();
              img.onload = resolve;
              img.onerror = resolve;
              img.src = urls[0].replace(/url\(['"]?([^'"]+)['"]?\)/, '$1');
              setTimeout(resolve, imageTimeout);
            });
          });

          await Promise.all([...imagePromises, ...bgPromises]);
        }, timeout);
      }

      // Additional delay if requested (for any remaining async content)
      if (waitDelay > 0) {
        console.log(`Waiting additional ${waitDelay}ms for async content...`);
        await new Promise(resolve => setTimeout(resolve, waitDelay));
      }

      // Hide overlay elements (for local rendering)
      if (hideSelectors.length > 0) {
        console.log(`Hiding ${hideSelectors.length} overlay element(s): ${hideSelectors.join(', ')}`);
        await page.addStyleTag({
          content: hideSelectors.map(selector => `${selector} { visibility: hidden !important; }`).join('\n')
        });
      }

      // Capture screenshot
      console.log('Capturing screenshot...');
      const screenshot = await page.screenshot({
        type: 'png',
        fullPage: false
      });

      await browser.close();

      console.log(`Screenshot captured: ${screenshot.byteLength} bytes`);

      // Return screenshot with CORS headers
      return new Response(screenshot, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'image/png',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Content-Length': screenshot.byteLength.toString(),
        }
      });

    } catch (error) {
      console.error('Screenshot error:', error);
      return new Response(JSON.stringify({
        error: error.message,
        stack: error.stack
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
  }
};
