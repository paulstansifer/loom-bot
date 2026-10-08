/** A JPEG, decoded: 8-bit RGB (or RGBA), row by row. */
declare function decode(
  jpegData: Uint8Array,
  opts: {
    useTArray: true;
    formatAsRGBA?: boolean;
    colorTransform?: boolean;
    tolerantDecoding?: boolean;
    maxResolutionInMP?: number;
    maxMemoryUsageInMB?: number;
  }
): { width: number; height: number; data: Uint8Array };
export = decode;
