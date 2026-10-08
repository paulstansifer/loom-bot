import assert from 'node:assert/strict';
import { test } from 'node:test';

import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

import { decodePicture, pictureFormat } from './decode.ts';

/** A small picture with some of everything: a gradient, and a hard edge. */
function picture(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba.set([x * 8, y * 8, x < width / 2 ? 0 : 255, 128], i);
    }
  return rgba;
}

void test('PNG, exactly, without its alpha', () => {
  const png = new PNG({ width: 16, height: 8 });
  png.data = Buffer.from(picture(16, 8));
  const bytes = new Uint8Array(PNG.sync.write(png));
  assert.equal(pictureFormat(bytes), 'png');
  const raster = decodePicture(bytes);
  assert.equal(raster.width, 16);
  assert.equal(raster.height, 8);
  assert.deepEqual([...raster.data.subarray(0, 6)], [0, 0, 0, 8, 0, 0]);
  assert.deepEqual([...raster.data.subarray(-3)], [120, 56, 255]);
});

void test('JPEG, approximately', () => {
  const bytes = jpeg.encode(
    { width: 16, height: 8, data: picture(16, 8) },
    95
  ).data;
  assert.equal(pictureFormat(bytes), 'jpeg');
  const raster = decodePicture(bytes);
  assert.equal(raster.data.length, 16 * 8 * 3);
  // The bottom right is blue-ish, the top left dark.
  assert.ok(raster.data.at(-1)! > 200);
  assert.ok(raster.data[2]! < 50);
});

void test('other formats are named', () => {
  const webp = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ');
  assert.equal(pictureFormat(webp), 'webp');
  assert.throws(() => decodePicture(webp), /webp/);
  assert.equal(pictureFormat(new TextEncoder().encode('GIF89a')), 'gif');
  assert.equal(pictureFormat(new Uint8Array([1, 2, 3])), 'unknown');
});
