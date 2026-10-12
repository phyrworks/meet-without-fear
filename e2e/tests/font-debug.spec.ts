/**
 * Font Rendering Debug Test
 * 
 * Verifies text visibility and font rendering on the homepage.
 * Useful for debugging platform-specific text visibility issues.
 */

import { test, expect } from '@playwright/test';

test.describe('Font Rendering Debug', () => {
  test.beforeEach(async ({ page }) => {
    // Set E2E auth headers
    await page.setExtraHTTPHeaders({
      'x-e2e-user-id': '00000000-0000-4000-8000-000000000123',
      'x-e2e-user-email': 'test@example.com',
      'X-E2E-Fixture-ID': 'user-a-full-journey',
    });

    // Seed user
    await page.request.get('/api/e2e/seed', {
      headers: {
        'x-e2e-user-id': '00000000-0000-4000-8000-000000000123',
        'x-e2e-user-email': 'test@example.com',
      },
    });
  });

  test('inspects text element styles and font metrics', async ({ page }) => {
    await page.goto('/');

    // Wait for loading to complete
    await page.waitForFunction(
      () => !document.body.innerText.includes('Loading...'),
      { timeout: 15000 }
    );

    // Wait a bit more for rendering
    await page.waitForTimeout(2000);

    // Find the "Hi" text element
    const hiElements = await page.locator('text=/^Hi\s/i').all();
    console.log(`Found ${hiElements.length} elements matching "Hi"`);

    if (hiElements.length > 0) {
      const textEl = hiElements[0];

      // Get computed styles
      const computedStyles = await textEl.evaluate((el) => {
        const style = window.getComputedStyle(el);
        return {
          color: style.color,
          backgroundColor: style.backgroundColor,
          fontSize: style.fontSize,
          fontFamily: style.fontFamily,
          fontWeight: style.fontWeight,
          opacity: style.opacity,
          display: style.display,
          visibility: style.visibility,
          textIndent: style.textIndent,
          letterSpacing: style.letterSpacing,
          wordSpacing: style.wordSpacing,
          textShadow: style.textShadow,
        };
      });

      console.log('Text element computed styles:', JSON.stringify(computedStyles, null, 2));

      // Also check the outer HTML
      const outerHTML = await textEl.evaluate((el) => el.outerHTML);
      console.log('Element HTML:', outerHTML);

      // Check parent elements
      const parentStyles = await textEl.evaluate((el) => {
        const parent = el.parentElement;
        if (!parent) return null;
        
        const style = window.getComputedStyle(parent);
        return {
          display: style.display,
          opacity: style.opacity,
          visibility: style.visibility,
          color: style.color,
          fontSize: style.fontSize,
        };
      });

      console.log('Parent element styles:', JSON.stringify(parentStyles, null, 2));

      // Check available fonts in browser
      const fontInfo = await page.evaluate(() => {
        return {
          fontsReady: (document as any).fonts?.ready ? 'yes' : 'no',
          fontsCount: (document as any).fonts?.size || 0,
          navigator: {
            platform: navigator.platform,
            userAgent: navigator.userAgent.substring(0, 100),
          },
        };
      });

      console.log('Font info:', JSON.stringify(fontInfo, null, 2));

      // Verify the text is actually visible
      const isVisible = await textEl.isVisible();
      console.log('Is text visible:', isVisible);

      // Get the text content
      const textContent = await textEl.textContent();
      console.log('Text content:', textContent);

      // Take a screenshot to compare
      await page.screenshot({ path: 'test-results/font-debug-screenshot.png' });

      // Expect the text to be visible
      expect(isVisible).toBe(true);
    } else {
      // If we can't find the text element, log the full page text
      const allText = await page.textContent('body');
      console.log('All page text:', allText);

      // Log the entire DOM structure
      const domStructure = await page.evaluate(() => {
        return (document.documentElement.innerHTML).substring(0, 2000);
      });
      console.log('DOM structure (first 2000 chars):', domStructure);

      throw new Error('Could not find "Hi" text element');
    }
  });
});
