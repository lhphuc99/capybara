# Devsight — Kế hoạch MVP

> "Devsight" là tên tạm. Đổi tên = tìm/thay `devsight` trong repo. Trên npm, tên `devsight` và scope `@devsight` hiện chưa có package nào.

## Mục tiêu

Tool debug dùng chung cho React Native và web (React, phía client của Next.js): xem **log**, **network**, **storage** của app đang chạy trong một UI riêng trên máy dev.

**Cập nhật hướng kết nối React Native:** CLI và desktop tự tìm app qua Metro/CDP ở cổng 8081/8082, không cần SDK cho log, network và xem storage có thể dò được. Storage qua CDP chỉ đọc: AsyncStorage, MMKV export và instance private bắt qua runtime hook. Nhắm tới MMKV 2.x/3.x/4.x; v2/v3 bắt khi app dùng lại instance, v4 bắt khi app tạo instance sau lúc hook được gắn. Instance private v4 đã tồn tại vẫn có thể không tìm được. Chỉ attach target hỗ trợ nhiều debugger. SDK vẫn dùng cho web, sửa storage và theo dõi thay đổi tự động. App đã có SDK được bỏ qua để tránh trùng phiên. Metro port khác cấu hình bằng CLI `--metro-port`; `--no-metro` tắt discovery. Hướng dẫn và giới hạn hiện tại ở [README](../README.md#react-native--expo--no-sdk-needed).

Định hướng sản phẩm: **một SDK, hai chế độ**

- **Chế độ dev** (MVP này): app gửi dữ liệu qua WebSocket tới UI trên máy dev.
- **Chế độ QA** (sau MVP): panel ngay trong app, export phiên debug để đính kèm bug report, chạy được trên build staging.

SDK tách phần **thu thập** (plugin ghi event vào ring buffer) khỏi phần **hiển thị** (nơi đọc buffer). Chế độ QA, export hay MCP sau này chỉ là thêm nơi đọc, không phải viết lại phần thu thập.

## Phạm vi MVP

| Có trong MVP | Để sau |
|---|---|
| Log `console.debug/log/info/warn/error`; lỗi chưa bắt (`window.onerror`, `unhandledrejection`, `ErrorUtils` của RN) | `console.table/group/time`, stack trace qua source map |
| Network `fetch` + `XMLHttpRequest` (axios dùng XHR): header, body, status, thời gian, copy cURL | WebSocket, request native (ảnh, SDK native), `expo/fetch`, mock/replay request |
| Storage web: localStorage, sessionStorage, cookie | IndexedDB |
| Storage RN: AsyncStorage, MMKV (best-effort) | SecureStore, Keychain |
| Xem/sửa/xoá/clear storage, tự refresh khi app ghi | |
| Nhiều app/thiết bị cùng lúc, tự kết nối lại, rớt mạng ngắn không mất log | Export/import phiên |
| UI web do CLI phục vụ (`npx devsight`); app desktop macOS bọc cùng server và UI | Next.js server, state (Redux/Zustand/TanStack Query), MCP |

## Kiến trúc

```
App (RN / web)                        Máy dev
@devsight/react-native | web          devsight (CLI) hoặc app desktop
  └─ @devsight/core      ── ws ──►      ├─ /client   nhận event từ app
       plugin console                   ├─ /viewer   đẩy event cho UI, chuyển lệnh UI → app
       plugin network                   └─ HTTP      phục vụ UI (@devsight/ui)
       plugin storage
```

| Package | Vai trò |
|---|---|
| `packages/protocol` | Kiểu message, event và hằng số (port, path), dùng chung cho mọi package. |
| `packages/core` | Runtime phía app: ring buffer, gửi theo batch, kết nối lại, serialize an toàn, plugin console/network/storage. |
| `packages/web` | `init()` cho browser: lỗi của window, localStorage/sessionStorage/cookie. |
| `packages/react-native` | `init()` cho RN: tự tìm IP máy dev từ URL bundle của Metro, `ErrorUtils`, adapter AsyncStorage/MMKV. |
| `packages/cli` | `npx devsight`: HTTP + WebSocket server, lưu event theo phiên, chuyển lệnh UI → app, tự `adb reverse`. |
| `packages/ui` | UI React (Vite) với tab Logs / Network / Storage. Bản build được copy vào CLI và app desktop. |
| `apps/desktop` | App desktop (Electron, private): main process gọi `createServer()` của `devsight` rồi mở cửa sổ tới `http://localhost:<port>`. |
| `examples/web`, `examples/expo` | App mẫu để chạy thử. |

## Protocol v1

- App kết nối `ws://<máy dev>:7357/client`, UI kết nối `ws://<máy dev>:7357/viewer`.
- Mỗi lần mở app hoặc tải trang là một **phiên** (session id ngẫu nhiên). Event trong phiên có `seq` tăng dần.
- Kết nối lại không trùng, không mất:
  1. app gửi `hello { session }`
  2. server trả `welcome { lastSeq }`: event cuối cùng server đã có của phiên đó
  3. app gửi các event có `seq > lastSeq` từ ring buffer, rồi stream tiếp
- Lệnh UI → app (vd. đọc/sửa storage): `command { id, plugin, method, params }`, app trả `result { id, ok, result | error }`. Server chỉ chuyển tiếp.
- Định nghĩa đầy đủ: [`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts).

## Quyết định kỹ thuật

- **npm workspaces**: có sẵn, hoisting hợp với Metro. Chuyển sang pnpm sau nếu cần.
- **TypeScript 6.0, React 19.2.3**: khớp Expo SDK 57, tránh có hai bản React trong monorepo.
- **ESM, build bằng `tsc`**: đơn giản nhất. Thêm bản CJS khi có người dùng cần (vd. Jest cấu hình cũ).
- **RN luôn patch XHR, chỉ patch `fetch` khi cần**: RN thuần dùng whatwg-fetch chạy trên XHR (`fetch.polyfill === true`), patch thêm `fetch` sẽ ra request trùng. Expo SDK 57 thay `fetch` bằng `expo/fetch` chạy native, không qua XHR, nên phải patch riêng. SDK tự nhận biết lúc `init()`. Web patch cả hai.
- **Event được `JSON.stringify` một lần lúc ghi**: buffer biết dung lượng thật, gửi lại không phải serialize lại.
- **Giới hạn bộ nhớ**: buffer phía app tối đa 2000 event / 8 MB; body request/response cắt ở 128 KB; server giữ 5000 event mỗi phiên, 20 phiên.
- **Bảo mật**: server bind `0.0.0.0` để máy thật trong LAN kết nối được. UI chỉ kết nối được từ cùng origin, và header `Host` phải là `localhost` hoặc IP. Như vậy trang web lạ mở trong browser của dev không đọc được dữ liệu qua WebSocket, kể cả bằng DNS rebinding. Chế độ dev không che header (có tuỳ chọn `redactHeaders`); chế độ QA sau này sẽ che mặc định.
- **Port mặc định 7357.**
- **App desktop là Electron bọc server sẵn có**: cửa sổ load UI qua HTTP từ chính server, không dùng `file://`, nên các kiểm tra origin và `Host` ở trên giữ nguyên. Main process được bundle bằng rolldown (có sẵn qua Vite) thành một file CJS, mọi dependency là devDependencies, nên electron-builder chỉ đóng gói `dist/` mà không kéo `node_modules` của workspace. `backgroundThrottling: false` để cửa sổ bị ẩn vẫn cập nhật đều: đo trên Electron 44, timer 100 ms trong cửa sổ ẩn chạy 30 lần/3 s, bật throttling thì chỉ còn 3 lần.
- **Cổng của app desktop đang bận**: nếu là một Devsight khác (vd. `npx devsight`), cửa sổ hiện server đó và app thử nhận cổng mỗi 2 giây, nên tắt CLI là app tự thay chỗ. Nếu là chương trình khác thì báo lỗi, có nút thử lại. macOS vẫn cho bind mọi interface khi chương trình khác giữ cùng cổng trên `0.0.0.0`, `127.0.0.1` hoặc `::1`, và localhost vẫn đi tới chương trình đó, nên app thử bind từng địa chỉ này trước. CLI chưa có kiểm tra này.
- **Bridge Metro (React Native không cần SDK)**: CLI/desktop nối vào `/inspector/debug` của Metro như một debugger thứ hai (CDP, kênh React Native DevTools dùng). Mỗi JS context là một phiên, gửi vào server qua `/client` như SDK. Hermes chỉ mô tả Date/Map/Set là "Object", nên tham số log được serialize ngay trong app bằng chính `serialize()` của SDK (hàm tự chứa, gửi qua `serialize.toString()`). App có SDK (`__DEVSIGHT_CLIENT__`) thì bỏ qua; quyết định đợi tới khi app chạy xong file entry (`RN$AppRegistry` hoặc log `Running "…"`), vì SDK khởi tạo trong đó. Expo CLI chỉ giữ socket debugger khi Origin đúng địa chỉ của nó (`http://127.0.0.1:<port>`); Metro thường nhận mọi origin localhost.

## Lộ trình

**M1 — MVP (repo này)**: các mục ở cột trái bảng phạm vi.

**M2 — Hoàn thiện cho người dùng đầu tiên**

- Script `dev` chạy watch song song, CI (typecheck + test), publish npm bằng changesets, thêm bản CJS.
- Plugin state: Redux, Zustand, TanStack Query.
- Stack trace qua source map (gọi `/symbolicate` của Metro).
- Lệnh tuỳ biến từ UI xuống app (clear storage, đổi env, logout…).

**M3 — Tạo khác biệt**

- Chế độ QA: panel trong app, export/import phiên.
- Next.js server (`instrumentation.ts`) và nối request client ↔ server bằng trace id.
- MCP server để Claude Code/Cursor đọc log/network.
- Đóng gói desktop app: đã có bản macOS chưa ký (xem Trạng thái). Còn ký + notarize, icon riêng, bản Intel/universal, Windows/Linux.

## Trạng thái (16/10/2026)

**Đã xong và đã chạy thử**

- Monorepo gồm 6 package, app desktop và 2 app mẫu. `npm run build`, `npm run typecheck` và `npm test` (87 test) đều pass.
- Metro/CDP bridge chạy trong CLI và desktop: có 11 test tích hợp với Metro giả lập cho log object, request/response/body, lỗi mạng, reload, reconnect, bỏ qua app có SDK, target không hỗ trợ nhiều debugger và bắt/gỡ MMKV private. App Expo mẫu mặc định không nạp SDK. Đã chạy thử với app này trên Expo Go (iPhone 17 simulator), qua cả CLI lẫn app desktop: log có object, Date, Map/Set, Error, unhandled rejection; network `fetch` + XHR có status, header và body (cả 404); app có SDK thì bị bỏ qua đúng. Chưa thử trên máy thật.
- Storage không SDK: đã thử trên app Expo/Hermes đang chạy trong iPhone 17 simulator, đọc được danh sách store, 2 key và giá trị được chọn. Reader hỗ trợ Metro lazy-loading của AsyncStorage và export getter ESM. Runtime hook MMKV có lease 15 giây, tự khôi phục method khi disconnect/lease hết hạn, hỗ trợ nhiều debugger cùng lúc và giữ tối đa 100 instance. V4 shadow method trên factory object vì Nitro khóa prototype; không thể bắt lại mọi instance cũ. Đọc dữ liệu qua instance gốc, không tạo store mới hay ghi key, không giữ encryption config. `test:mmkv-compat` kiểm tra source package 2.12.2/3.3.3/4.3.2 với native giả lập.
- MMKV 4.3.2 native (Nitro 0.35.9, Expo SDK 57, RN 0.86.3, Hermes) trên simulator riêng `Devsight-MMKV-Test` (iPhone 17, iOS 26.5), với app mẫu riêng `dev.devsight.mmkvtest` chỉ có dữ liệu giả, không dùng app có sẵn của người dùng ([`packages/cli/test/native-fixture`](../packages/cli/test/native-fixture/README.md), runner `packages/cli/scripts/check-mmkv-native.mjs`). Đi qua đường thật CDP → bridge → server → lệnh Storage của viewer, 11 bước đều pass: store export, AsyncStorage, instance private tạo sau khi gắn hook (string, Unicode, JSON, số, boolean khớp với lệnh đọc có kiểu của native), key có emoji, store mã hoá, refresh thấy giá trị app vừa ghi, từ chối ghi, gỡ hook khi ngắt kết nối và app vẫn đọc/ghi bình thường. Giới hạn đã biết vẫn đúng: instance private v4 tạo trước khi gắn hook không tìm được.
- MMKV 3.3.3 native (C++ TurboModule, không có Nitro) build được với Expo SDK 57 / RN 0.86.3, dù package được phát triển trên RN 0.77. Chạy trên cùng simulator với app mẫu riêng `dev.devsight.mmkv3test` ([`packages/cli/test/native-fixture-mmkv3`](../packages/cli/test/native-fixture-mmkv3/README.md)); lockfile chỉ khác fixture v4 ở MMKV và Nitro. Runner dùng chung, 12 bước đều pass, kể cả sau khi mở lại app và khi gắn lại trên cùng tiến trình JS. Các bước giống v4, thêm một bước riêng của v3: instance private tạo trước khi gắn hook chưa hiện cho tới khi app gọi một method của nó, sau đó đọc được. Ngắt kết nối thì `MMKV.prototype.getFunctionFromCache` trở về đúng hàm gốc. Sau khi sửa runner đã chạy lại fixture v4, 11 bước vẫn pass.
- Web (Chrome, app mẫu Vite):
  - log, kể cả lỗi uncaught và unhandled rejection
  - network `fetch` + XHR: header, body, request lỗi
  - localStorage / sessionStorage / cookie: xem, sửa, tự refresh khi app ghi
  - tải lại trang thì UI tự chuyển sang phiên mới
- React Native (Expo SDK 57, Expo Go trên iPhone 17 simulator):
  - tự tìm máy dev qua Metro
  - log
  - network (`expo/fetch` + XHR, có body response)
  - AsyncStorage: sửa từ UI, app đọc lại đúng giá trị
- App desktop (Electron 44, macOS 26, Apple Silicon):
  - `npm run desktop` mở cửa sổ Devsight; app mẫu web hiện log, network, storage giống bản browser, kể cả sửa storage từ UI và tự refresh khi app ghi
  - `npx devsight` đang chạy thì cửa sổ dùng server đó; tắt CLI thì app tự nhận cổng và tải lại UI
  - cổng bị chương trình khác giữ (kể cả chỉ trên `::1`, như Vite) thì báo lỗi, thử lại được
  - cửa sổ ẩn vẫn nhận và hiện event ngay
  - `npm run desktop:package` ra `.dmg` và `.zip` (ad-hoc signed); app đóng gói chạy được, UI phục vụ từ `app.asar`

**Chưa kiểm tra**

- Android (emulator, máy thật qua `adb reverse`), máy thật qua Wi-Fi. App desktop cũng chạy `adb reverse` (tìm `adb` trong Android SDK khi mở từ Dock, vì không có PATH của shell) nhưng chưa thử với máy thật.
- RN thuần không có Expo (nhánh whatwg-fetch, chỉ patch XHR).
- MMKV 2.x native, MMKV trên Android và máy thật. MMKV 3/4 native mới chạy trên iOS simulator với app mẫu. MMKV 2.x cần kiến trúc cũ, nên không chạy được trên RN 0.82 trở lên.
- Next.js.
- App desktop: mở bản đóng gói trên máy Mac khác (Gatekeeper với app chưa notarize), bản Intel, Windows/Linux.

**Rút ra từ lần chạy thật**: ban đầu SDK chỉ patch XHR trên RN, nên mọi request `fetch` trong app Expo đều bị bỏ sót. Đã sửa bằng cách tự nhận biết lúc `init()` (xem mục Quyết định kỹ thuật). Với app desktop, macOS cho server bind cổng 7357 dù chương trình khác đang giữ cổng đó trên loopback, nên phải kiểm tra trước (xem mục Quyết định kỹ thuật).

Khi thử MMKV native:

- MMKV không lưu kiểu, mọi getter giải mã cùng một dãy byte. Số luôn chiếm 8 byte (double), boolean 1 byte, chuỗi là varint độ dài cộng UTF-8. Vì vậy `getString` đọc số 42 ra `''`, và reader cũ (thử `getString` trước) hiện số và `false` thành chuỗi rỗng. Mock có kiểu trong unit test đã che lỗi này. Reader mới coi chuỗi giải mã được từ 7 byte trở lên là chuỗi, ngắn hơn thì thử `getNumber` (chỉ thành công khi dữ liệu ≥ 8 byte), rồi mới `getBoolean`. `false` và `''` cùng là một byte 0 nên đều hiện là `false`. Byte UTF-8 không hợp lệ thì Hermes trả `''`. Unit test giờ dùng mô hình MMKV ở mức byte.
- `Runtime.evaluate` của Hermes không biên dịch được source có ký tự ngoài BMP (lỗi `Invalid UTF-8 code point 0xd83d`). Tham số của reader (key, adapter id) được escape thành `\uXXXX`. Ký tự BMP như `·`, `à` vẫn chạy được.
- Hermes chỉ cho dùng object handle (`Runtime.callFunctionOn`, `releaseObject`) sau khi phiên debugger đó gọi `Runtime.enable`. Bridge đã gọi sẵn; script hay công cụ khác nối CDP riêng thì phải tự gọi.
- Khi đọc store, MMKV in các dòng `[E]` như `getDouble reach end` vào log native vì phải thử từng getter. Các dòng này vô hại.

Khi thử bridge Metro:

- Expo Go 57 (iPhone 17 simulator): sau mỗi lần JS reload (⌘R, Metro reload khi file đổi, hay `Page.reload`), một số module native như `ExpoFetchModule`, `ExpoAsset`, `ExponentConstants` không còn, app lỗi ngay lúc khởi động. Tắt hẳn Expo Go rồi mở lại project thì hết. Lỗi xảy ra cả khi không có debugger nào gắn và không có SDK, nên không do Devsight. App có SDK còn lỗi sớm hơn, vì `init()` đọc `globalThis.fetch` và kích hoạt getter lười của `expo/fetch`.
- Expo không báo request lỗi qua CDP: `ExpoRequestCdpInterceptor` (iOS) chỉ gửi `requestWillBeSent`, `responseReceived`, `loadingFinished`, nên request `fetch` bị lỗi mạng hiện mãi là pending, kể cả trong React Native DevTools.

## Câu hỏi còn mở

- License: MIT, Apache-2.0 hay đóng nguồn?
- Tên chính thức và đăng ký npm org. Bundle ID của app desktop (`dev.devsight.desktop`) cũng là tạm, đi theo tên.
- Có cần hỗ trợ RN kiến trúc cũ (< 0.76) không?
