/** A decoded picture: 8-bit RGB, row by row, with no padding. (Decoding is up to the caller.) */
export type Raster = {
  width: number;
  height: number;
  data: Uint8Array;
};

/** The same picture, flipped over its diagonal: columns become rows. */
export function transpose(raster: Raster): Raster {
  const { width, height, data } = raster;
  const out = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 3;
      const to = (x * height + y) * 3;
      out[to] = data[from]!;
      out[to + 1] = data[from + 1]!;
      out[to + 2] = data[from + 2]!;
    }
  }
  return { width: height, height: width, data: out };
}
