// Receiver-only adaptation of Ghost Arcade's native NDI bridge. SDK headers
// and runtime are supplied separately under NDI's license. No import-library
// dependency: missing runtime is a recoverable application input error.
#include <napi.h>
#include <windows.h>
#include <Processing.NDI.Lib.h>
#include <Processing.NDI.DynamicLoad.h>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <mutex>
#include <thread>
#include <vector>
#include <string>
#include <cstring>
#include "pixels.hpp"

namespace {
const NDIlib_v5* api = nullptr;
HMODULE library = nullptr;
NDIlib_find_instance_t finder = nullptr;
NDIlib_recv_instance_t receiver = nullptr;
std::atomic<bool> running{false};
std::thread worker;
std::mutex pixelsMutex;
std::vector<uint8_t> pixels;
int width = 0, height = 0;
int rateN = 0, rateD = 1;
uint64_t sequence = 0;
double arrivedMs = 0;

std::wstring env(const wchar_t* name) {
  const DWORD n = GetEnvironmentVariableW(name, nullptr, 0);
  if (!n) return {};
  std::wstring value(n, L'\0'); GetEnvironmentVariableW(name, value.data(), n); value.resize(n - 1); return value;
}
void stop() {
  running = false;
  if (worker.joinable()) worker.join();
  if (receiver) { api->NDIlib_recv_destroy(receiver); receiver = nullptr; }
  std::lock_guard<std::mutex> lock(pixelsMutex);
  pixels.clear(); sequence = 0; width = height = 0;
}
void cleanup() {
  stop();
  if (finder) { api->NDIlib_find_destroy(finder); finder = nullptr; }
  if (api) api->NDIlib_destroy(); api = nullptr;
  if (library) FreeLibrary(library); library = nullptr;
}
Napi::Value initialize(const Napi::CallbackInfo& info) {
  auto js = info.Env();
  if (api) return js.Undefined();
  std::vector<std::filesystem::path> candidates;
  const auto explicitPath = env(L"MAPPER_NDI_RUNTIME");
  if (!explicitPath.empty()) candidates.emplace_back(explicitPath);
  wchar_t executable[MAX_PATH]; GetModuleFileNameW(nullptr, executable, MAX_PATH);
  candidates.push_back(std::filesystem::path(executable).parent_path() / L"Processing.NDI.Lib.x64.dll");
  for (const auto* key : { L"NDI_RUNTIME_DIR_V6", L"NDI_RUNTIME_DIR_V5" }) {
    auto value = env(key); if (!value.empty()) candidates.push_back(std::filesystem::path(value) / L"Processing.NDI.Lib.x64.dll");
  }
  for (const auto* suffix : { L"NDI/NDI 6 Runtime", L"NDI/NDI 6 Tools/Runtime", L"NDI/NDI SDK/Bin/x64", L"NDI/NDI 5 Runtime", L"NDI/NDI 5 Tools/Runtime" })
    candidates.push_back(std::filesystem::path(env(L"ProgramFiles")) / suffix / L"Processing.NDI.Lib.x64.dll");
  for (const auto& p : candidates) {
    if (p.is_absolute() && std::filesystem::exists(p)) {
      library = LoadLibraryExW(p.c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
      if (library) break;
    }
  }
  if (!library) { Napi::Error::New(js, "NDI runtime missing. Install the official x64 runtime, or set MAPPER_NDI_RUNTIME to its DLL path and restart.").ThrowAsJavaScriptException(); return js.Undefined(); }
  using Loader = const NDIlib_v5* (*)();
  auto load = reinterpret_cast<Loader>(GetProcAddress(library, "NDIlib_v5_load"));
  api = load ? load() : nullptr;
  if (!api || !api->NDIlib_initialize()) { cleanup(); Napi::Error::New(js, "NDI runtime initialization failed.").ThrowAsJavaScriptException(); return js.Undefined(); }
  NDIlib_find_create_t config{}; config.show_local_sources = true;
  finder = api->NDIlib_find_create_v2(&config);
  if (!finder) { cleanup(); Napi::Error::New(js, "NDI discovery initialization failed.").ThrowAsJavaScriptException(); }
  return js.Undefined();
}
Napi::Value sources(const Napi::CallbackInfo& info) {
  const auto js = info.Env(); auto list = Napi::Array::New(js);
  if (!finder) return list;
  uint32_t count = 0;
  const auto* found = api->NDIlib_find_get_current_sources(finder, &count);
  for (uint32_t i = 0; i < count; i++) list.Set(i, Napi::String::New(js, found[i].p_ndi_name ? found[i].p_ndi_name : ""));
  return list;
}
Napi::Value connect(const Napi::CallbackInfo& info) {
  auto js = info.Env();
  if (!api || info.Length() < 1 || !info[0].IsString()) { Napi::Error::New(js, "NDI not initialized or source invalid.").ThrowAsJavaScriptException(); return js.Undefined(); }
  const auto name = info[0].As<Napi::String>().Utf8Value();
  uint32_t count = 0; const auto* found = api->NDIlib_find_get_current_sources(finder, &count);
  const NDIlib_source_t* match = nullptr;
  for (uint32_t i = 0; i < count; i++) if (found[i].p_ndi_name && name == found[i].p_ndi_name) { match = found + i; break; }
  if (!match) { Napi::Error::New(js, "Source unavailable. Refresh and select it again.").ThrowAsJavaScriptException(); return js.Undefined(); }
  stop();
  NDIlib_recv_create_v3_t config{};
  config.source_to_connect_to = *match;
  config.color_format = NDIlib_recv_color_format_RGBX_RGBA;
  config.bandwidth = NDIlib_recv_bandwidth_highest;
  config.allow_video_fields = false;
  receiver = api->NDIlib_recv_create_v3(&config);
  if (!receiver) { Napi::Error::New(js, "Could not create NDI receiver.").ThrowAsJavaScriptException(); return js.Undefined(); }
  running = true;
  worker = std::thread([] {
    std::vector<uint8_t> nextPixels;
    while (running) {
      NDIlib_video_frame_v2_t frame{};
      if (api->NDIlib_recv_capture_v2(receiver, &frame, nullptr, nullptr, 50) != NDIlib_frame_type_video) continue;
      const bool valid = frame.p_data && frame.xres > 0 && frame.yres > 0 && frame.xres <= 16384 && frame.yres <= 8192 &&
        frame.line_stride_in_bytes >= frame.xres * 4 && (frame.FourCC == NDIlib_FourCC_type_RGBX || frame.FourCC == NDIlib_FourCC_type_RGBA);
      if (valid) {
        try {
          copyRgba(frame.p_data, frame.xres, frame.yres, frame.line_stride_in_bytes,
                   frame.FourCC == NDIlib_FourCC_type_RGBA, nextPixels);
          std::lock_guard<std::mutex> lock(pixelsMutex);
          pixels.swap(nextPixels);
          width = frame.xres; height = frame.yres; rateN = frame.frame_rate_N; rateD = frame.frame_rate_D;
          sequence++; arrivedMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
        } catch (...) { running = false; }
      }
      api->NDIlib_recv_free_video_v2(receiver, &frame);
    }
  });
  return js.Undefined();
}
Napi::Value frame(const Napi::CallbackInfo& info) {
  auto js = info.Env(); const auto after = info.Length() && info[0].IsNumber() ? info[0].As<Napi::Number>().DoubleValue() : 0;
  std::lock_guard<std::mutex> lock(pixelsMutex);
  if (!sequence || sequence <= after || pixels.empty()) return js.Null();
  auto result = Napi::Object::New(js);
  result.Set("width", width); result.Set("height", height); result.Set("sequence", static_cast<double>(sequence));
  result.Set("fps", rateD > 0 ? static_cast<double>(rateN) / rateD : 0);
  const double now = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
  result.Set("ageMs", now - arrivedMs);
  result.Set("data", Napi::Buffer<uint8_t>::Copy(js, pixels.data(), pixels.size()));
  return result;
}
// Low-frequency diagnostics; SDK counters distinguish receiver drops from UI skips.
Napi::Value statistics(const Napi::CallbackInfo& info) {
  auto js=info.Env();auto out=Napi::Object::New(js);
  out.Set("running",running.load());
  if(receiver){
    NDIlib_recv_performance_t total{},dropped{};NDIlib_recv_queue_t queue{};
    api->NDIlib_recv_get_performance(receiver,&total,&dropped);
    api->NDIlib_recv_get_queue(receiver,&queue);
    out.Set("received",static_cast<double>(total.video_frames));
    out.Set("dropped",static_cast<double>(dropped.video_frames));
    out.Set("queued",queue.video_frames);
    out.Set("connections",api->NDIlib_recv_get_no_connections(receiver));
  }
  return out;
}
// Packaged-build diagnostic: exercises the real SDK sender/receiver locally.
// This is not an operator-facing NDI send feature.
Napi::Value selfTest(const Napi::CallbackInfo& info) {
  auto js = info.Env(); auto result = Napi::Object::New(js);
  result.Set("received", false);
  if (!api || running) return result;
  NDIlib_send_create_t sendConfig{};
  sendConfig.p_ndi_name = "Mapper bundled runtime self-test";
  sendConfig.clock_video = false; sendConfig.clock_audio = false;
  const auto sender = api->NDIlib_send_create(&sendConfig);
  if (!sender) return result;
  NDIlib_recv_create_v3_t recvConfig{};
  recvConfig.source_to_connect_to = *api->NDIlib_send_get_source_name(sender);
  recvConfig.color_format = NDIlib_recv_color_format_RGBX_RGBA;
  recvConfig.bandwidth = NDIlib_recv_bandwidth_highest; recvConfig.allow_video_fields = false;
  const auto testReceiver = api->NDIlib_recv_create_v3(&recvConfig);
  if (!testReceiver) { api->NDIlib_send_destroy(sender); return result; }
  std::vector<uint8_t> source(1920 * 1080 * 4, 0);
  for (size_t i = 0; i < source.size(); i += 4) { source[i] = 255; source[i + 3] = 255; }
  NDIlib_video_frame_v2_t video{};
  video.xres = 1920; video.yres = 1080; video.FourCC = NDIlib_FourCC_type_RGBX;
  video.frame_rate_N = 30; video.frame_rate_D = 1; video.picture_aspect_ratio = 1920.f / 1080.f;
  video.frame_format_type = NDIlib_frame_format_type_progressive;
  video.line_stride_in_bytes = 1920 * 4; video.p_data = source.data();
  for (int attempt = 0; attempt < 80; attempt++) {
    api->NDIlib_send_send_video_v2(sender, &video);
    NDIlib_video_frame_v2_t incoming{};
    if (api->NDIlib_recv_capture_v2(testReceiver, &incoming, nullptr, nullptr, 100) == NDIlib_frame_type_video) {
      const bool rgba = incoming.FourCC == NDIlib_FourCC_type_RGBA || incoming.FourCC == NDIlib_FourCC_type_RGBX;
      std::vector<uint8_t> received;
      const bool valid = rgba && copyRgba(incoming.p_data, incoming.xres, incoming.yres, incoming.line_stride_in_bytes, incoming.FourCC == NDIlib_FourCC_type_RGBA, received);
      result.Set("received", valid && received[0] > 200 && received[2] < 60);
      result.Set("width", incoming.xres); result.Set("height", incoming.yres);
      if (valid) { result.Set("red", received[0]); result.Set("blue", received[2]); }
      api->NDIlib_recv_free_video_v2(testReceiver, &incoming);
      break;
    }
  }
  api->NDIlib_recv_destroy(testReceiver); api->NDIlib_send_destroy(sender);
  return result;
}
Napi::Object init(Napi::Env js, Napi::Object out) {
  js.AddCleanupHook(cleanup);
  out.Set("initialize", Napi::Function::New(js, initialize));
  out.Set("sources", Napi::Function::New(js, sources));
  out.Set("connect", Napi::Function::New(js, connect));
  out.Set("disconnect", Napi::Function::New(js, [](const Napi::CallbackInfo& info) { stop(); return info.Env().Undefined(); }));
  out.Set("frame", Napi::Function::New(js, frame));
  out.Set("statistics",Napi::Function::New(js,statistics));
  out.Set("selfTest", Napi::Function::New(js, selfTest)); return out;
}
}
NODE_API_MODULE(ndi_receiver, init)
