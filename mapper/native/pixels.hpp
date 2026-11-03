#pragma once
#include <cstdint>
#include <cstring>
#include <vector>
// Copy only active pixels, skipping SDK row padding. RGBX's unused channel
// must become opaque alpha before uploading into an RGBA texture.
inline bool copyRgba(const uint8_t* source, int width, int height, int stride,
                     bool hasAlpha, std::vector<uint8_t>& destination) {
  if (!source || width <= 0 || height <= 0 || width > 16384 || height > 8192 || stride < width * 4) return false;
  const size_t row = static_cast<size_t>(width) * 4;
  destination.resize(row * height);
  for (int y = 0; y < height; y++) {
    auto* output = destination.data() + y * row;
    std::memcpy(output, source + static_cast<size_t>(y) * stride, row);
    if (!hasAlpha) for (int x = 0; x < width; x++) output[x * 4 + 3] = 255;
  }
  return true;
}
