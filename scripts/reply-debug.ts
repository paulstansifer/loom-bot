/**
 * Prints what the bot would reply to a picture: a file, or a URL (such as a post's
 * `https://i.redd.it/....png`). Pictures are decoded the way the bot decodes them, except that
 * a WebP file (which the bot can't decode) is decoded with `sharp`, as the sample pictures are.
 *
 *   node --experimental-strip-types scripts/reply-debug.ts PICTURE_OR_URL... [--status]
 *     [--out DIR]
 *
 * With `--status`, it only prints one line per picture, saying how it went. With `--out`, it
 * writes the glyph view that "!debug" links to (`view.ts`), as `NAME-view.png`, if there is one.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

import { replyTo } from '../src/bot/reply.ts';
import { encodePng, glyphView } from '../src/bot/view.ts';
import { decodePicture, pictureFormat } from '../src/ocr/decode.ts';
import type { Raster } from '../src/ocr/raster.ts';
import { decode } from '../src/ocr/samples.ts';

const args = process.argv.slice(2);
const statusOnly = args.includes('--status');
const outAt = args.indexOf('--out');
const out = outAt < 0 ? undefined : args.splice(outAt, 2)[1];
if (out) mkdirSync(out, { recursive: true });

async function load(source: string): Promise<Raster> {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source, {
      headers: { Accept: 'image/png,image/jpeg' },
    });
    if (!response.ok)
      throw new Error(`${response.status} ${response.statusText}`);
    return decodePicture(new Uint8Array(await response.arrayBuffer()));
  }
  const bytes = new Uint8Array(readFileSync(source));
  return pictureFormat(bytes) === 'webp'
    ? decode(source)
    : decodePicture(bytes);
}

for (const source of args.filter((a) => !a.startsWith('--'))) {
  const start = performance.now();
  const reply = replyTo(await load(source));
  const ms = (performance.now() - start).toFixed(0);
  if (statusOnly) console.log(`${source}: ${reply.status} (${ms} ms)`);
  else
    console.log(
      `${source}: ${reply.status} (${ms} ms)\n\n${reply.text ?? '(no reply)'}\n\n---\n\n${reply.debugging}\n`
    );
  if (out && reply.reading && reply.picture)
    writeFileSync(
      join(out, `${basename(source, extname(source))}-view.png`),
      encodePng(glyphView(reply.picture, reply.reading))
    );
}
