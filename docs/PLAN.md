# Capybara — Kế hoạch MVP

> Tên chính thức là Capybara, đổi từ Devsight ngày 16/10/2026 (thư mục repo vẫn tên `devsight`). Trên npm, scope `@capybara` chưa có package nào; gói `capybara` từng có người đăng và đã bị gỡ ngày 3/10/2026, nên cần kiểm tra lại trước khi publish.

## Mục tiêu

Tool debug dùng chung cho React Native và web (React, phía client của Next.js): xem **log**, **network**, **storage** của app đang chạy trong một UI riêng trên máy dev.

**Cập nhật hướng kết nối React Native:** CLI và desktop tự tìm app qua Metro/CDP ở cổng 8081/8082, không cần SDK cho log, network và xem storage có thể dò được. Storage qua CDP chỉ đọc: AsyncStorage, MMKV export và instance private bắt qua runtime hook. MMKV ở đây là package `react-native-mmkv`, không phải MMKV lõi của Tencent (lõi đang ở 2.x). Nhắm tới react-native-mmkv 3.x/4.x và MMKV trên web; bản 2.x cần kiến trúc cũ nên nằm ngoài phạm vi. 3.x bắt khi app dùng lại instance, 4.x bắt khi app tạo instance sau lúc hook được gắn. Instance private 4.x đã tồn tại vẫn có thể không tìm được. Chế độ không SDK cần RN 0.85 trở lên: proxy Metro bản cũ hơn đá debugger đang mở khi có debugger mới nối vào. Chỉ attach target hỗ trợ nhiều debugger. SDK vẫn dùng cho web, sửa storage và theo dõi thay đổi tự động. App đã có SDK được bỏ qua để tránh trùng phiên. Metro port khác cấu hình bằng CLI `--metro-port`; `--no-metro` tắt discovery. Hướng dẫn và giới hạn hiện tại ở [README](../README.md#react-native--expo--no-sdk-needed).

Định hướng sản phẩm: **một SDK, hai chế độ**

- **Chế độ dev** (MVP này): app gửi dữ liệu qua WebSocket tới UI trên máy dev.
- **Chế độ QA** (sau MVP): panel ngay trong app, export phiên debug để đính kèm bug report, chạy được trên build staging.

SDK tách phần **thu thập** (plugin ghi event vào ring buffer) khỏi phần **hiển thị** (nơi đọc buffer). Chế độ QA, export hay MCP sau này chỉ là thêm nơi đọc, không phải viết lại phần thu thập.

## Phạm vi MVP

| Có trong MVP | Để sau |
|---|---|
| Log `console.debug/log/info/warn/error`; lỗi chưa bắt (`window.onerror`, `unhandledrejection`, `ErrorUtils` của RN) | `console.table/group/time`, stack trace qua source map |
| Network `fetch` + `XMLHttpRequest` (axios dùng XHR): header, body, status, thời gian, copy cURL, lý do request lỗi (CORS, mạng, mixed content, CSP); WebSocket: kết nối, message hai chiều, mã đóng, giải mã frame socket.io | Request native (ảnh, SDK native), `expo/fetch` khi không SDK và không có dev client, mock/replay request |
| Storage web: localStorage, sessionStorage, cookie | IndexedDB |
| Storage RN: AsyncStorage, MMKV (best-effort) | SecureStore, Keychain |
| Xem/sửa/xoá/clear storage, tự refresh khi app ghi | |
| Nhiều app/thiết bị cùng lúc, tự kết nối lại, rớt mạng ngắn không mất log | Export/import phiên |
| UI web do CLI phục vụ (`npx capybara`); app desktop macOS bọc cùng server và UI | Next.js server, state (Redux/Zustand/TanStack Query), MCP |

## Kiến trúc

```
App (RN / web)                        Máy dev
@capybara/react-native | web          capybara (CLI) hoặc app desktop
  └─ @capybara/core      ── ws ──►      ├─ /client   nhận event từ app
       plugin console                   ├─ /viewer   đẩy event cho UI, chuyển lệnh UI → app
       plugin network                   └─ HTTP      phục vụ UI (@capybara/ui)
       plugin storage
```

| Package | Vai trò |
|---|---|
| `packages/protocol` | Kiểu message, event và hằng số (port, path), dùng chung cho mọi package. |
| `packages/core` | Runtime phía app: ring buffer, gửi theo batch, kết nối lại, serialize an toàn, plugin console/network/storage. |
| `packages/web` | `init()` cho browser: lỗi của window, localStorage/sessionStorage/cookie. |
| `packages/react-native` | `init()` cho RN: tự tìm IP máy dev từ URL bundle của Metro, `ErrorUtils`, adapter AsyncStorage/MMKV. |
| `packages/cli` | `npx capybara`: HTTP + WebSocket server, lưu event theo phiên, chuyển lệnh UI → app, tự `adb reverse`. |
| `packages/ui` | UI React (Vite) với tab Logs / Network / Storage. Bản build được copy vào CLI và app desktop. |
| `apps/desktop` | App desktop (Electron, private): main process gọi `createServer()` của `capybara` rồi mở cửa sổ tới `http://localhost:<port>`. |
| `examples/web`, `examples/nextjs`, `examples/expo` | App mẫu để chạy thử. |

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
- **Giới hạn bộ nhớ**: buffer phía app tối đa 2000 event / 8 MB; body request/response cắt ở 128 KB; mỗi message WebSocket cắt ở 16 KB; server giữ 5000 event mỗi phiên, 20 phiên; UI giữ 2000 message gần nhất mỗi socket.
- **WebSocket**: một hàm hook tự chứa trong core (`hookWebSockets`) dùng chung cho SDK và bridge (bridge tiêm qua `toString()`). Trên web chỉ bọc constructor `WebSocket` vì trình duyệt phát event từ native. Trên React Native bọc thêm `dispatchEvent` và `send` trên prototype, nên bắt cả socket tạo trước khi hook gắn và socket tạo qua constructor mà thư viện lưu từ lúc import (engine.io của socket.io làm vậy). Transport của SDK giữ constructor gốc từ trước khi plugin chạy và đánh dấu socket của nó, nếu không hook sẽ tự ghi chính kết nối tới Capybara thành vòng lặp. Bridge gửi event về qua `Runtime.addBinding`, hook có lease 15 giây như hook MMKV. Mặc định bỏ qua socket của công cụ dev: HMR của Metro (RN mở với URL `http://`), `/message`, React DevTools (8097), Reactotron (9090), Vite (theo subprotocol), Next.js HMR.
- **Lý do request lỗi**: trình duyệt không cho trang biết vì sao request lỗi, chỉ ghi vào console của nó. SDK web tự phân loại những gì trang biết được: offline, mixed content, CSP (qua event `securitypolicyviolation`; event này có thể đến sau khi request đã lỗi nên SDK chờ 30 ms) và cross-origin. Còn lại, nút "Find out why" nhờ server Capybara chạy lại các bước CORS từ máy dev (preflight, rồi GET/HEAD kèm `Origin` của trang, đi theo redirect và gửi `Origin: null` như trình duyệt), đọc header mà trình duyệt giấu rồi áp luật của trình duyệt. Server dùng `node:http` chứ không dùng `fetch`: thấy được header bị lặp, tự kiểm tra danh sách port trình duyệt chặn, và gặp chứng chỉ do CA nội bộ ký (mkcert) thì vẫn kiểm tra tiếp mà không xác minh, kèm ghi chú. Không bao giờ gửi lại `Authorization`, cookie hay header đã che; chỉ gửi lại GET/HEAD, method khác thì hỏi bằng `OPTIONS`. Luật khác nhau theo trình duyệt nên dùng user agent: Chrome vẫn cho `*` trong `Access-Control-Allow-Headers` bao cả `Authorization` (chỉ cảnh báo deprecation) và miễn mixed content cho IP nội bộ và tên `.local` (Local Network Access). Trên React Native, chuỗi lỗi native chỉ được truyền vào `XMLHttpRequest.__didCompleteResponse`, nên SDK bọc method đó.
- **Bảo mật**: server bind `0.0.0.0` để máy thật trong LAN kết nối được. UI chỉ kết nối được từ cùng origin, và header `Host` phải là `localhost` hoặc IP. Như vậy trang web lạ mở trong browser của dev không đọc được dữ liệu qua WebSocket, kể cả bằng DNS rebinding. Chế độ dev không che header (có tuỳ chọn `redactHeaders`); chế độ QA sau này sẽ che mặc định.
- **Port mặc định 7357.**
- **App desktop là Electron bọc server sẵn có**: cửa sổ load UI qua HTTP từ chính server, không dùng `file://`, nên các kiểm tra origin và `Host` ở trên giữ nguyên. Main process được bundle bằng rolldown (có sẵn qua Vite) thành một file CJS, mọi dependency là devDependencies, nên electron-builder chỉ đóng gói `dist/` mà không kéo `node_modules` của workspace. `backgroundThrottling: false` để cửa sổ bị ẩn vẫn cập nhật đều: đo trên Electron 44, timer 100 ms trong cửa sổ ẩn chạy 30 lần/3 s, bật throttling thì chỉ còn 3 lần.
- **Cổng của app desktop đang bận**: nếu là một Capybara khác (vd. `npx capybara`), cửa sổ hiện server đó và app thử nhận cổng mỗi 2 giây, nên tắt CLI là app tự thay chỗ. Nếu là chương trình khác thì báo lỗi, có nút thử lại. macOS vẫn cho bind mọi interface khi chương trình khác giữ cùng cổng trên `0.0.0.0`, `127.0.0.1` hoặc `::1`, và localhost vẫn đi tới chương trình đó, nên app thử bind từng địa chỉ này trước. CLI chưa có kiểm tra này.
- **Bridge Metro (React Native không cần SDK)**: CLI/desktop nối vào `/inspector/debug` của Metro như một debugger thứ hai (CDP, kênh React Native DevTools dùng). Mỗi JS context là một phiên, gửi vào server qua `/client` như SDK. Hermes chỉ mô tả Date/Map/Set là "Object", nên tham số log được serialize ngay trong app bằng chính `serialize()` của SDK (hàm tự chứa, gửi qua `serialize.toString()`). App có SDK (`__CAPYBARA_CLIENT__`) thì bỏ qua; quyết định đợi tới khi app chạy xong file entry (`RN$AppRegistry` hoặc log `Running "…"`), vì SDK khởi tạo trong đó. Expo CLI chỉ giữ socket debugger khi Origin đúng địa chỉ của nó (`http://127.0.0.1:<port>`); Metro thường nhận mọi origin localhost.

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

- Đổi tên Devsight → Capybara (16/10/2026): package `@capybara/*` và CLI `capybara`, biến môi trường `CAPYBARA_PORT` và `VITE_CAPYBARA_SERVER`, global `__CAPYBARA_*__`, bundle ID `dev.capybara.*`, máy ảo test `Capybara-MMKV-Test` và `Capybara-Android-Test`. App mẫu native đổi bundle ID nên lần chạy fixture tới cần build lại; bản cũ (`dev.devsight.*`) vẫn còn trên simulator.
- Icon: capybara ngâm suối nước nóng, mắt nhắm, quả yuzu trên đầu, vẽ bằng nét thẳng và cung tròn trên nền cam yuzu. File gốc `assets/icon.svg`; giao diện dùng nó làm logo và favicon. App desktop dùng gói Icon Composer `apps/desktop/build/icon.icon`, electron-builder biên dịch bằng `actool` (Xcode 26) ra `Assets.car` cho macOS 26 và `icon.icns` cho bản cũ. Đã lấy icon của `Capybara.app` qua `NSWorkspace` trên macOS 26.6: hiện đúng kiểu Liquid Glass, không bị đóng khung xám như icon kiểu cũ.
- Monorepo gồm 6 package, app desktop và 3 app mẫu (web, Next.js, Expo). `npm run build`, `npm run typecheck` và `npm test` (114 test) đều pass.
- Metro/CDP bridge chạy trong CLI và desktop: có 11 test tích hợp với Metro giả lập cho log object, request/response/body, lỗi mạng, reload, reconnect, bỏ qua app có SDK, target không hỗ trợ nhiều debugger và bắt/gỡ MMKV private. App Expo mẫu mặc định không nạp SDK. Đã chạy thử với app này trên Expo Go (iPhone 17 simulator), qua cả CLI lẫn app desktop: log có object, Date, Map/Set, Error, unhandled rejection; network `fetch` + XHR có status, header và body (cả 404); app có SDK thì bị bỏ qua đúng. Chưa thử trên máy thật.
- Storage không SDK: đã thử trên app Expo/Hermes đang chạy trong iPhone 17 simulator, đọc được danh sách store, 2 key và giá trị được chọn. Reader hỗ trợ Metro lazy-loading của AsyncStorage và export getter ESM. Runtime hook MMKV có lease 15 giây, tự khôi phục method khi disconnect/lease hết hạn, hỗ trợ nhiều debugger cùng lúc và giữ tối đa 100 instance. V4 shadow method trên factory object vì Nitro khóa prototype; không thể bắt lại mọi instance cũ. Đọc dữ liệu qua instance gốc, không tạo store mới hay ghi key, không giữ encryption config. `test:mmkv-compat` kiểm tra source package 2.12.2/3.3.3/4.3.2 với native giả lập.
- react-native-mmkv 4.3.2 native (Nitro 0.35.9, Expo SDK 57, RN 0.86.3, Hermes) trên simulator riêng `Capybara-MMKV-Test` (iPhone 17, iOS 26.5), với app mẫu riêng `dev.capybara.mmkvtest` chỉ có dữ liệu giả, không dùng app có sẵn của người dùng ([`packages/cli/test/native-fixture`](../packages/cli/test/native-fixture/README.md), runner `packages/cli/scripts/check-mmkv-native.mjs`). Đi qua đường thật CDP → bridge → server → lệnh Storage của viewer, 11 bước đều pass: store export, AsyncStorage, instance private tạo sau khi gắn hook (string, Unicode, JSON, số, boolean khớp với lệnh đọc có kiểu của native), key có emoji, store mã hoá, refresh thấy giá trị app vừa ghi, từ chối ghi, gỡ hook khi ngắt kết nối và app vẫn đọc/ghi bình thường. Giới hạn đã biết vẫn đúng: instance private v4 tạo trước khi gắn hook không tìm được.
- react-native-mmkv 3.3.3 native (C++ TurboModule, MMKV lõi 2.0.0, không có Nitro) build được với Expo SDK 57 / RN 0.86.3, dù package được phát triển trên RN 0.77. Chạy trên cùng simulator với app mẫu riêng `dev.capybara.mmkv3test` ([`packages/cli/test/native-fixture-mmkv3`](../packages/cli/test/native-fixture-mmkv3/README.md)); lockfile chỉ khác fixture v4 ở MMKV và Nitro. Runner dùng chung, 12 bước đều pass, kể cả sau khi mở lại app và khi gắn lại trên cùng tiến trình JS. Các bước giống v4, thêm một bước riêng của v3: instance private tạo trước khi gắn hook chưa hiện cho tới khi app gọi một method của nó, sau đó đọc được. Ngắt kết nối thì `MMKV.prototype.getFunctionFromCache` trở về đúng hàm gốc. Sau khi sửa runner đã chạy lại fixture v4, 11 bước vẫn pass.
- Android, máy ảo riêng `Capybara-Android-Test` (Android 14, tạo từ image android-34, không dùng AVD có sẵn của người dùng): fixture react-native-mmkv 4.3.2 qua bridge Metro, 11 bước đều pass như trên iOS. Log (object, Date, Map/Set, Error có stack) và XHR (status, body) đến đủ; riêng `fetch` của Expo không hiện (xem mục Khi thử bridge Metro).
- Máy thật Pixel 7 (Android 17) với một app RN thuần thật của người dùng (RN 0.82, react-native-mmkv 4.0.1, axios), được người dùng cho phép dùng để test. RN 0.82 chưa có `supportsMultipleDebuggers` nên bridge Metro bỏ qua đúng thiết kế; test bằng SDK gắn tạm (một dòng import, đã hoàn tác, `git status` của app sạch). Qua USB (CLI tự `adb reverse` cổng 7357) và qua Wi-Fi (app tải bundle từ IP LAN, SDK tự nối IP đó): log, request axios có body, MMKV đọc/ghi qua SDK. Nhánh whatwg-fetch: `fetch.polyfill === true`, SDK chỉ patch XHR, request `fetch` được ghi đúng một lần.
- MMKV trên web (react-native-web, Expo SDK 57): hai fixture chạy được trên web. `packages/cli/scripts/check-mmkv-web.mjs` mở bằng Chrome headless có SDK web, 5 bước đều pass cho cả 3.3.3 và 4.3.2: giá trị MMKV nằm trong Local Storage dạng `<id>\<key>` với đúng chuỗi (số, boolean, Unicode, key emoji), sửa từ Capybara thì app đọc lại qua MMKV, app ghi thì có event thay đổi, log và `fetch` cùng trang.
- Next.js 16.4.2 (App Router, Turbopack) với `examples/nextjs`, SDK gắn trong `instrumentation-client.ts`. Chrome headless bấm từng nút: log (Date, Set, Error), `fetch` GET/POST và XHR tới route handler có body, mỗi request ghi một lần; localStorage/sessionStorage/cookie và sửa từ Capybara thì trang đọc lại. Không có lỗi hydration. `next build` pass, bundle production không còn code Capybara.
- iPhone thật (iPhone 14 Pro, iOS 26.6.1) với cùng app đó: người dùng cho phép build Debug bản dev của app cài đè bản đang có, ký bằng team và profile development có sẵn của project (không tạo profile mới). SDK gắn tạm phía JS qua Metro, qua Wi-Fi: log, 9 request axios có body, MMKV 4 đọc/ghi/xoá, WebSocket (socket có token mở rồi đóng, socket token rỗng bị từ chối với lý do "Received bad response code from server: 401."). Bridge bỏ qua target iOS của RN 0.82 đúng thiết kế. Sau đó đã hoàn tác, build lại và cài bản sạch.
- WebSocket (16/10/2026):
  - Web, `examples/web` có socket echo trong mock API, Chrome headless bấm nút: subprotocol, text và binary hai chiều, đóng sạch có mã và lý do, socket lỗi 1006; không ghi socket HMR của Vite hay kết nối của Capybara. Chụp màn hình UI: dòng WS trong tab Network, danh sách message, cây JSON, tab General.
  - Không SDK, fixture RN 0.86 trên máy ảo Android, server echo trên Mac: socket mở trước khi gắn, socket tạo qua constructor đã lưu (như engine.io), socket mới có subprotocol, text và binary, socket lỗi kèm lý do; ngắt kết nối thì `WebSocket` và prototype trở về như cũ, app vẫn dùng socket.
  - Có SDK, cùng fixture: bắt socket qua constructor đã patch và constructor native, không ghi kết nối của SDK, 0 event khi app rảnh (không có vòng lặp).
  - Cùng app RN 0.82 thật đó, có SDK gắn tạm, chạy trên máy ảo (Pixel 7 lúc đó đang tắt màn hình): socket `wss://…/ws?token=` của app hiện đủ kết nối → lỗi → đóng 1006 "Expected HTTP 101 response but was '401 Unauthorized'"; đã hoàn tác, gỡ app khỏi máy ảo.
  - Expo web: socket `/hot` và `/message` của Metro không lọt vào.
- Lý do request lỗi (16/10/2026):
  - Ma trận 18 trường hợp trên Chrome 155 headless, so với thông báo Chrome ghi trong console (trang không đọc được): thiếu `Access-Control-Allow-Origin`, cho origin khác, hai giá trị, `*` khi có cookie, thiếu `Access-Control-Allow-Credentials`, preflight 404, method hoặc header `Authorization` không được cho phép, redirect sang origin thứ ba (`Origin: null`), POST đơn giản, XHR `withCredentials`, port đóng, port bị chặn (6666), DNS, offline, CSP `connect-src`, mixed content tới host công khai, và http tới IP LAN từ trang https (Chrome cho qua, lỗi thật là connection refused). Capybara nêu đúng lý do ở cả 18 trường hợp.
  - Một app web thật của người dùng (React + Vite, chạy local, gọi API staging không cho phép origin localhost): Chrome báo "No 'Access-Control-Allow-Origin' header is present", Capybara báo "The response (401 Unauthorized) has no Access-Control-Allow-Origin header … The server has to allow http://localhost:6868", kèm chi tiết server có trả `Access-Control-Allow-Credentials: true`. Đã chụp màn hình UI.
  - React Native: chữ ký `__didCompleteResponse(requestId, error, timeOutError)` giống nhau ở RN 0.81.5, 0.82.0 và 0.86.3, và RN phát event lỗi ngay bên trong method đó nên SDK ghi lỗi trước khi gọi bản gốc. Có unit test, chưa chạy trên thiết bị.
- Web (Chrome, app mẫu Vite):
  - log, kể cả lỗi uncaught và unhandled rejection
  - network `fetch` + XHR: header, body, request lỗi
  - localStorage / sessionStorage / cookie: xem, sửa, tự refresh khi app ghi (cookie qua Cookie Store API, có trên Chrome)
  - tải lại trang thì UI tự chuyển sang phiên mới
- React Native (Expo SDK 57, Expo Go trên iPhone 17 simulator):
  - tự tìm máy dev qua Metro
  - log
  - network (`expo/fetch` + XHR, có body response)
  - AsyncStorage: sửa từ UI, app đọc lại đúng giá trị
- App desktop (Electron 44, macOS 26, Apple Silicon):
  - `npm run desktop` mở cửa sổ Capybara; app mẫu web hiện log, network, storage giống bản browser, kể cả sửa storage từ UI và tự refresh khi app ghi
  - `npx capybara` đang chạy thì cửa sổ dùng server đó; tắt CLI thì app tự nhận cổng và tải lại UI
  - cổng bị chương trình khác giữ (kể cả chỉ trên `::1`, như Vite) thì báo lỗi, thử lại được
  - cửa sổ ẩn vẫn nhận và hiện event ngay
  - `npm run desktop:package` ra `.dmg` và `.zip` (ad-hoc signed); app đóng gói chạy được, UI phục vụ từ `app.asar`

**Chưa kiểm tra**

- Chế độ không SDK trên máy thật (Android lẫn iOS): app thật đang có đều dưới RN 0.85. App desktop cũng chạy `adb reverse` (tìm `adb` trong Android SDK khi mở từ Dock) nhưng chưa thử với máy thật.
- RN thuần trên iOS (mới chạy trên Android).
- react-native-mmkv 3.x native trên Android (mới chạy 4.x).
- Next.js phía server (log, request trong server component và route handler), nằm trong lộ trình M3.
- App desktop: mở bản đóng gói trên máy Mac khác (Gatekeeper với app chưa notarize), bản Intel, Windows/Linux.

**Rút ra từ lần chạy thật**: ban đầu SDK chỉ patch XHR trên RN, nên mọi request `fetch` trong app Expo đều bị bỏ sót. Đã sửa bằng cách tự nhận biết lúc `init()` (xem mục Quyết định kỹ thuật). Với app desktop, macOS cho server bind cổng 7357 dù chương trình khác đang giữ cổng đó trên loopback, nên phải kiểm tra trước (xem mục Quyết định kỹ thuật).

Khi thử MMKV native:

- MMKV không lưu kiểu, mọi getter giải mã cùng một dãy byte. Số luôn chiếm 8 byte (double), boolean 1 byte, chuỗi là varint độ dài cộng UTF-8. Vì vậy `getString` đọc số 42 ra `''`, và reader cũ (thử `getString` trước) hiện số và `false` thành chuỗi rỗng. Mock có kiểu trong unit test đã che lỗi này. Reader mới coi chuỗi giải mã được từ 7 byte trở lên là chuỗi, ngắn hơn thì thử `getNumber` (chỉ thành công khi dữ liệu ≥ 8 byte), rồi mới `getBoolean`. `false` và `''` cùng là một byte 0 nên đều hiện là `false`. Byte UTF-8 không hợp lệ thì Hermes trả `''`. Unit test giờ dùng mô hình MMKV ở mức byte.
- `Runtime.evaluate` của Hermes không biên dịch được source có ký tự ngoài BMP (lỗi `Invalid UTF-8 code point 0xd83d`). Tham số của reader (key, adapter id) được escape thành `\uXXXX`. Ký tự BMP như `·`, `à` vẫn chạy được.
- Hermes chỉ cho dùng object handle (`Runtime.callFunctionOn`, `releaseObject`) sau khi phiên debugger đó gọi `Runtime.enable`. Bridge đã gọi sẵn; script hay công cụ khác nối CDP riêng thì phải tự gọi.
- Khi đọc store, MMKV in các dòng `[E]` như `getDouble reach end` vào log native vì phải thử từng getter. Các dòng này vô hại.
- Adapter MMKV của SDK React Native cũng thử `getString` trước như reader cũ, nên số và boolean hiện thành chuỗi rỗng; test cũ dùng mock có kiểu. Đã sửa bằng cùng cách suy kiểu, kiểm trên MMKV 4.3.2 native (Android) qua SDK. Trên web giữ nguyên chuỗi, vì MMKV web lưu text và `getNumber` là `Number(text)` (`'007'` sẽ thành 7).

Khi thử bridge Metro:

- Expo Go 57 (iPhone 17 simulator): sau mỗi lần JS reload (⌘R, Metro reload khi file đổi, hay `Page.reload`), một số module native như `ExpoFetchModule`, `ExpoAsset`, `ExponentConstants` không còn, app lỗi ngay lúc khởi động. Tắt hẳn Expo Go rồi mở lại project thì hết. Lỗi xảy ra cả khi không có debugger nào gắn và không có SDK, nên không do Capybara. App có SDK còn lỗi sớm hơn, vì `init()` đọc `globalThis.fetch` và kích hoạt getter lười của `expo/fetch`.
- Bridge từng mở phiên trùng cho app có SDK khi log `Running "App"` đến lúc lần thăm dò trước (đọc app trước khi SDK chạy) chưa trả lời: lời gọi quyết định mới bị bỏ qua và bridge dùng câu trả lời cũ. Giờ bridge thăm dò lại; test giữ câu trả lời thăm dò lại để tái hiện đúng thứ tự này. Lỗi chỉ lộ ra khi máy đang tải nặng.
- Proxy Metro dưới RN 0.85 không hỗ trợ nhiều debugger: debugger mới nối vào thì debugger cũ bị ngắt. Vì vậy chế độ không SDK cần RN 0.85+, app cũ hơn dùng SDK.
- `fetch` của Expo (`expo/fetch`, Android, bản debug không có `expo-dev-client`) gửi request thật nhưng không phát event CDP nào, kể cả khi debugger tự gọi `Network.enable`: delegate của `ExpoRequestCdpInterceptor` chỉ được `expo-dev-client` hoặc Expo Go gắn. Không SDK thì không thấy các request này; XHR và axios vẫn thấy.
- Expo không báo request lỗi qua CDP: `ExpoRequestCdpInterceptor` (iOS) chỉ gửi `requestWillBeSent`, `responseReceived`, `loadingFinished`, nên request `fetch` bị lỗi mạng hiện mãi là pending, kể cả trong React Native DevTools.

Khi thử WebSocket:

- React Native mở socket HMR của Metro với URL `http://…/hot`, nên mẫu bỏ qua phải nhận cả `http(s)://`. Ở SDK, danh sách này dùng chung với request HTTP, nên mẫu cho cổng Metro chỉ khớp đường dẫn nội bộ (`/hot`, `/message`, `/events`, `/inspector`, `/debugger-proxy`).
- Thay thư mục trong `node_modules` khi Metro đang chạy thì Metro vẫn phục vụ code cũ; phải khởi động lại Metro (`--reset-cache`).
- Máy thật tắt màn hình (Dozing) thì app mở bằng adb chạy nền, bị chặn mạng: không nối Metro inspector, SDK không nối Capybara.
- Bản Debug RN 0.82 build cho máy thật iOS nhúng sẵn `main.jsbundle` lấy từ code lúc build, nên dòng import SDK tạm cũng bị đóng gói vào app. Hoàn tác xong phải build lại và cài lại.
- Lý do lỗi WebSocket khác nhau theo nền tảng: Android "Expected HTTP 101 response but was '401 Unauthorized'", iOS "Received bad response code from server: 401."

Khi thử web và Next.js:

- Danh sách Logs, Network và message WebSocket không cuộn lên được bằng trackpad: đoạn ghim xuống cuối chạy sau mọi lần render, mà react-virtual render lại khi cuộn, nên mỗi bước cuộn vài pixel (chưa qua ngưỡng 32px) bị kéo về cuối. Bánh xe chuột cuộn từng nấc lớn nên không gặp. Giờ chỉ ghim khi chiều cao nội dung đổi, và cuộn lên là dừng theo dõi ngay (hook `useFollow`). Đã thử trên app desktop: 80 bước 3px cuộn đủ 240px; đang cuộn lên thì log mới không kéo xuống; ở cuối thì vẫn bám theo log mới.
- Dev overlay của Next.js gửi `/__nextjs_original-stack-frames` mỗi khi có `console.error`, lẫn vào tab Network. SDK web giờ bỏ qua `/__nextjs_*`, như SDK React Native bỏ qua `/symbolicate`.
- Ghi cookie trước đây không phát event nên tab Storage không tự refresh. Giờ dùng Cookie Store API ở trình duyệt có hỗ trợ (đã kiểm trên Chrome).

Khi thử lý do request lỗi:

- Preflight trả 404: Chrome báo thiếu `Access-Control-Allow-Origin`, Capybara báo preflight không được trả 2xx (lỗi gốc là server không xử lý `OPTIONS`). Cả hai lỗi đều có trong danh sách kiểm tra.
- Chrome 155 vẫn cho `Access-Control-Allow-Headers: *` bao cả `Authorization`, chỉ phát DeprecationIssue; Firefox và Safari làm đúng chuẩn.
- Từ trang https, Chrome 155 chỉ cảnh báo (vẫn gửi) request http tới IP literal nội bộ (10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, fc00::/7, fe80::/10) và tên `.local`; host công khai, IP công khai và 198.18/15 thì chặn. Tên miền trỏ về IP nội bộ (như `*.nip.io`) vẫn bị chặn.

## Câu hỏi còn mở

- License: MIT, Apache-2.0 hay đóng nguồn?
- Đăng ký tên trên npm: scope `@capybara` và gói CLI `capybara` (gói cũ cùng tên đã bị gỡ ngày 3/10/2026). Bundle ID của app desktop (`dev.capybara.desktop`) đi theo tên.
- Có cần hỗ trợ RN kiến trúc cũ (< 0.76) không?
- MMKV trên web đang hiện trong Local Storage dưới dạng key `<id>\<key>`. Có gom thành từng store "MMKV · id" riêng không?
- App dưới RN 0.85 chỉ dùng được SDK. Có thêm tuỳ chọn cho chế độ không SDK nối vào các app này khi người dùng chấp nhận đóng debugger đang mở không?
