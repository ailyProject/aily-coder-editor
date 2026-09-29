// Pinned from https://github.com/espressif/esp-idf/blob/v6.1/tools/tools.json
// Windows ARM64 uses the official x64 binary through Windows x64 emulation.
export const ESP_CLANGD_VERSION = '21.1.3_20260408'
export const CLANGD_RELEASES = {
  "darwin-x64": {
    "sha256": "cb8ac31ea7f8e20da69cea9e1720500571c8f2bae335eb1721b676f7ef3950fe",
    "size": 12662520,
    "url": "https://github.com/espressif/llvm-project/releases/download/esp-21.1.3_20260408/clangd-esp-21.1.3_20260408-x86_64-apple-darwin.tar.xz"
  },
  "darwin-arm64": {
    "sha256": "6dccab9acc9766c90383e9b2585fa1cfabad6125bdc32987a86a02cea598970d",
    "size": 10995644,
    "url": "https://github.com/espressif/llvm-project/releases/download/esp-21.1.3_20260408/clangd-esp-21.1.3_20260408-aarch64-apple-darwin.tar.xz"
  },
  "linux-x64": {
    "sha256": "7133e67db271ca96b30ec9f5c34c903eaf5fe10120cfe44f85eb88db7ddbe230",
    "size": 17077740,
    "url": "https://github.com/espressif/llvm-project/releases/download/esp-21.1.3_20260408/clangd-esp-21.1.3_20260408-x86_64-linux-gnu.tar.xz"
  },
  "linux-arm64": {
    "sha256": "468e6fa03def6bcf0c0469d25b8d8b86212e5a94716d0b3db149f21b77791c54",
    "size": 14706612,
    "url": "https://github.com/espressif/llvm-project/releases/download/esp-21.1.3_20260408/clangd-esp-21.1.3_20260408-aarch64-linux-gnu.tar.xz"
  },
  "win32-x64": {
    "sha256": "1a91c04bb570e0740eede529b20c98c2dd0be6750eb7d91a7226e19f3d88d490",
    "size": 14144936,
    "url": "https://github.com/espressif/llvm-project/releases/download/esp-21.1.3_20260408/clangd-esp-21.1.3_20260408-x86_64-w64-mingw32.tar.xz"
  },
  "win32-arm64": {
    "sha256": "1a91c04bb570e0740eede529b20c98c2dd0be6750eb7d91a7226e19f3d88d490",
    "size": 14144936,
    "url": "https://github.com/espressif/llvm-project/releases/download/esp-21.1.3_20260408/clangd-esp-21.1.3_20260408-x86_64-w64-mingw32.tar.xz"
  }
}
