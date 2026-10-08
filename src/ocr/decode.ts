/**
 * Decoding a downloaded picture into a `Raster`, in pure JavaScript, since Devvit can't run
 * `sharp` (it's native). PNG and JPEG are what r/nonograms' posts are; anything else is reported
 * as such.
 */

import { PNG } from 'pngjs';

import type { Raster } from './raster.ts';
import decodeJpeg from './vendor/jpeg-decoder.cjs';

/** What kind of picture `bytes` is, from how it starts. */
export function pictureFormat(bytes: Uint8Array): string {
  const starts = (...b: number[]) => b.every((x, i) => bytes[i] === x);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'png';
  if (starts(0xff, 0xd8, 0xff)) return 'jpeg';
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  )
    return 'webp';
  if (starts(0x47, 0x49, 0x46)) return 'gif';
  return 'unknown';
}

/** The picture in `bytes`, as 8-bit RGB. Any alpha is dropped (as `sharp`'s `removeAlpha` does). */
export function decodePicture(bytes: Uint8Array): Raster {
  const format = pictureFormat(bytes);
  if (format === 'png') {
    const png = PNG.sync.read(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)
    );
    return rgb(png.width, png.height, png.data, 4);
  }
  if (format === 'jpeg') {
    // (A copy of jpeg-js' decoder, made to decode as libjpeg does: see `vendor/`.)
    const decoded = decodeJpeg(bytes, {
      useTArray: true,
      formatAsRGBA: false,
      // (Phone screenshots are a few megapixels; this is jpeg-js' default, made explicit.)
      maxResolutionInMP: 100,
    });
    return { width: decoded.width, height: decoded.height, data: decoded.data };
  }
  throw new Error(`can't decode a ${format} picture`);
}

function rgb(
  width: number,
  height: number,
  data: Uint8Array,
  channels: number
): Raster {
  const out = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    out[i * 3] = data[i * channels]!;
    out[i * 3 + 1] = data[i * channels + 1]!;
    out[i * 3 + 2] = data[i * channels + 2]!;
  }
  return { width, height, data: out };
}
