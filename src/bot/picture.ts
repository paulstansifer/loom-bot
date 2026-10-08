/**
 * Finding and downloading the first picture in a post. (This is the Rust bot's `first_picture`
 * and `download`, for Devvit's `Post` rather than Reddit's listing JSON.)
 */

import { decodePicture } from '../ocr/decode.ts';
import type { Raster } from '../ocr/raster.ts';

/** What `firstPicture` needs of a post: Devvit's `Post` has all of it. */
export type PostMedia = {
  url: string;
  body?: string | undefined;
  /** `status` is Devvit's `GalleryMediaStatus`: 1 for a picture that's ready. */
  gallery: { url: string; status: number }[];
};

/** The hosts pictures are downloaded from. (They have to be in `devvit.json`'s `http.domains`.) */
export const PICTURE_HOSTS = ['i.redd.it', 'preview.redd.it'];

/** `GalleryMediaStatus.VALID`. */
const VALID = 1;

const PICTURE = /\.(png|jpe?g|webp)$/i;

/** Where the first picture in a post is, if it has one (on a host we can download from). */
export function firstPicture(post: PostMedia): string | undefined {
  const usable = (url: string) => {
    let parsed: URL;
    try {
      parsed = new URL(url.replaceAll('&amp;', '&'));
    } catch {
      return undefined;
    }
    if (
      !PICTURE_HOSTS.includes(parsed.hostname) ||
      !PICTURE.test(parsed.pathname)
    )
      return undefined;
    return parsed.href;
  };
  // A gallery, in its own order.
  for (const item of post.gallery) {
    if (item.status !== VALID) continue;
    const url = usable(item.url);
    if (url) return url;
  }
  // A link straight to a picture (which is how Reddit stores a post of a single picture).
  const linked = usable(post.url);
  if (linked) return linked;
  // Pictures in the text of a post, in the order they appear.
  for (const match of (post.body ?? '').matchAll(/https:\/\/[^\s)\]"]+/g)) {
    const url = usable(match[0]);
    if (url) return url;
  }
  return undefined;
}

/**
 * Download and decode the picture at `url`. Preview pictures are converted to WebP for browsers
 * that ask for it, which we can't decode, so this asks for PNG or JPEG.
 */
export async function downloadPicture(url: string): Promise<Raster> {
  const response = await fetch(url, {
    headers: { Accept: 'image/png,image/jpeg' },
  });
  if (!response.ok)
    throw new Error(
      `downloading ${url}: ${response.status} ${response.statusText}`
    );
  return decodePicture(new Uint8Array(await response.arrayBuffer()));
}
