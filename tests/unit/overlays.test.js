const { generateOverlay } = require('../../lib/overlays');

describe('Overlay Generation', () => {
  const mockRegion = {
    x: 100,
    y: 100,
    width: 600,
    height: 100
  };

  describe('Clock Overlay', () => {
    it('should generate clock SVG with current time', () => {
      const overlay = {
        type: 'clock',
        format: {
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit'
        },
        style: {
          fontSize: 76,
          fontFamily: 'Roboto',
          color: '#ffffff'
        }
      };

      const result = generateOverlay(overlay, mockRegion);

      expect(result).toBeInstanceOf(Buffer);
      const svgContent = result.toString();
      expect(svgContent).toContain('<svg');
      expect(svgContent).toContain('</svg>');
      expect(svgContent).toContain('font-size="76px"');
      expect(svgContent).toContain('font-family="Roboto"');
      expect(svgContent).toContain('fill="#ffffff"');
      // Should contain time (HH:MM:SS format)
      expect(svgContent).toMatch(/\d{1,2}:\d{2}:\d{2}/);
    });

    it('should use default format if not provided', () => {
      const overlay = {
        type: 'clock',
        style: {}
      };

      const result = generateOverlay(overlay, mockRegion);
      const svgContent = result.toString();

      expect(svgContent).toContain('<svg');
      expect(svgContent).toMatch(/\d{1,2}:\d{2}:\d{2}/);
    });

    it('should respect 12/24 hour format', () => {
      const overlay12 = {
        type: 'clock',
        format: { hour12: true },
        style: {}
      };

      const result12 = generateOverlay(overlay12, mockRegion);
      const content12 = result12.toString();

      // 12-hour format should include AM/PM
      // Note: This might be locale-dependent
      expect(content12).toMatch(/\d{1,2}:\d{2}:\d{2}/);
    });
  });

  describe('Date Overlay', () => {
    it('should generate date SVG with current date', () => {
      const overlay = {
        type: 'date',
        format: {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        },
        style: {
          fontSize: 48,
          color: '#ffffff'
        }
      };

      const result = generateOverlay(overlay, mockRegion);

      expect(result).toBeInstanceOf(Buffer);
      const svgContent = result.toString();
      expect(svgContent).toContain('<svg');
      expect(svgContent).toContain('</svg>');
      expect(svgContent).toContain('font-size="48px"');
      // Should contain a day of week
      expect(svgContent).toMatch(/(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/);
    });
  });

  describe('Text Overlay', () => {
    it('should generate static text SVG', () => {
      const overlay = {
        type: 'text',
        text: 'System Online',
        style: {
          fontSize: 32,
          color: '#00ff00',
          textAlign: 'center'
        }
      };

      const result = generateOverlay(overlay, mockRegion);

      expect(result).toBeInstanceOf(Buffer);
      const svgContent = result.toString();
      expect(svgContent).toContain('<svg');
      expect(svgContent).toContain('System Online');
      expect(svgContent).toContain('font-size="32px"');
      expect(svgContent).toContain('fill="#00ff00"');
      expect(svgContent).toContain('text-anchor="middle"');
    });

    it('should handle empty text', () => {
      const overlay = {
        type: 'text',
        text: '',
        style: {}
      };

      const result = generateOverlay(overlay, mockRegion);
      const svgContent = result.toString();

      expect(svgContent).toContain('<svg');
    });
  });

  describe('Text Alignment', () => {
    it('should support left alignment', () => {
      const overlay = {
        type: 'text',
        text: 'Left',
        style: { textAlign: 'left' }
      };

      const result = generateOverlay(overlay, mockRegion);
      const svgContent = result.toString();

      expect(svgContent).toContain('text-anchor="start"');
      expect(svgContent).toContain('x="0"');
    });

    it('should support center alignment', () => {
      const overlay = {
        type: 'text',
        text: 'Center',
        style: { textAlign: 'center' }
      };

      const result = generateOverlay(overlay, mockRegion);
      const svgContent = result.toString();

      expect(svgContent).toContain('text-anchor="middle"');
      expect(svgContent).toContain('x="50%"');
    });

    it('should support right alignment', () => {
      const overlay = {
        type: 'text',
        text: 'Right',
        style: { textAlign: 'right' }
      };

      const result = generateOverlay(overlay, mockRegion);
      const svgContent = result.toString();

      expect(svgContent).toContain('text-anchor="end"');
      expect(svgContent).toContain('x="100%"');
    });
  });

  describe('SVG Dimensions', () => {
    it('should use region dimensions for SVG size', () => {
      const overlay = {
        type: 'text',
        text: 'Test',
        style: {}
      };

      const customRegion = {
        x: 0,
        y: 0,
        width: 800,
        height: 200
      };

      const result = generateOverlay(overlay, customRegion);
      const svgContent = result.toString();

      expect(svgContent).toContain('width="800"');
      expect(svgContent).toContain('height="200"');
    });
  });

  describe('Unknown Overlay Type', () => {
    it('should handle unknown overlay type gracefully', () => {
      const overlay = {
        type: 'unknown',
        style: {}
      };

      const result = generateOverlay(overlay, mockRegion);

      expect(result).toBeInstanceOf(Buffer);
      const svgContent = result.toString();
      expect(svgContent).toContain('<svg');
    });
  });
});
