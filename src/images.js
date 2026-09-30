// Bounded PNG/JPEG structure and dimension checks shared by evidence readers.
function screenshotType(bytes) {
  const dimensionsAllowed = (width, height) => width > 0 && height > 0 && width <= 10000 && height <= 10000 && width * height <= 16000000;
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8, imageData = false, header = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      if (offset + 12 + length > bytes.length) return null;
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (!header) {
        if (type !== 'IHDR' || length !== 13 || !dimensionsAllowed(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12))) return null;
        header = true;
      } else if (type === 'IHDR') return null;
      if (type === 'IDAT' && length > 0) imageData = true;
      if (type === 'IEND') return imageData && length === 0 && offset + 12 === bytes.length ? { extension: 'png', mimeType: 'image/png' } : null;
      offset += 12 + length;
    }
    return null;
  }
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    let offset = 2, dimensions = false;
    const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) return null;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda) return dimensions ? { extension: 'jpg', mimeType: 'image/jpeg' } : null;
      if (marker === 0xd9 || marker === 0x00 || marker === 0xd8) return null;
      if (marker >= 0xd0 && marker <= 0xd7 || marker === 0x01) continue;
      if (offset + 2 > bytes.length) return null;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return null;
      if (frames.has(marker)) {
        if (length < 8 || !dimensionsAllowed(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))) return null;
        dimensions = true;
      }
      offset += length;
    }
  }
  return null;
}

module.exports = { screenshotType };
