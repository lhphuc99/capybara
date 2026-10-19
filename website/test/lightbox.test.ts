import { describe, expect, it } from 'vitest';
import { srcsetUrl } from '../src/lightbox';

describe('srcsetUrl', () => {
  it('picks the file for a density, as Vite writes srcsets with hashed names', () => {
    const srcset = '/assets/state-dark-Bq1x.webp 1x, /assets/state-dark@2x-C9z2.webp 2x';
    expect(srcsetUrl(srcset, '2x')).toBe('/assets/state-dark@2x-C9z2.webp');
    expect(srcsetUrl(srcset, '1x')).toBe('/assets/state-dark-Bq1x.webp');
  });

  it('gives nothing when the density is missing', () => {
    expect(srcsetUrl('/assets/logs-light@2x.webp 2x', '1x')).toBeUndefined();
    expect(srcsetUrl('', '2x')).toBeUndefined();
  });
});
