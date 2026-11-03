#include "pixels.hpp"
#include <cassert>
int main() {
  // Two pixels per row, with four padding bytes that must never become pixels.
  const uint8_t source[] = {255,0,0,17, 0,255,0,19, 99,99,99,99,
                            0,0,255,23, 255,255,255,29, 88,88,88,88};
  std::vector<uint8_t> result;
  assert(copyRgba(source, 2, 2, 12, true, result));
  assert(result.size() == 16 && result[0] == 255 && result[3] == 17);
  assert(result[8] == 0 && result[10] == 255 && result[11] == 23);
  assert(copyRgba(source, 2, 2, 12, false, result));
  for (int i = 3; i < 16; i += 4) assert(result[i] == 255);
  assert(!copyRgba(source, 2, 2, 7, false, result));
  assert(!copyRgba(nullptr, 2, 2, 12, false, result));
  assert(!copyRgba(source, -1, 2, 12, false, result));
}
