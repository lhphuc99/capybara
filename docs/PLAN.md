# Capybara — Kế hoạch MVP

> Tên chính thức là Capybara, đổi từ Devsight ngày 16/10/2026. Trên npm các gói mang tên `capybara-devtools` (CLI) và `@capybara-devtools/*`, vì scope `@capybara` đã thuộc về một tài khoản npm khác.

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
| State qua SDK: Redux, Zustand, TanStack Query, SWR, React Context (timeline, diff, state hiện tại; lệnh cho query và key SWR) | |
| Nhiều app/thiết bị cùng lúc, tự kết nối lại, rớt mạng ngắn không mất log | Export/import phiên |
| UI web do CLI phục vụ (`npx capybara-devtools`); app desktop (macOS, Windows, Linux) bọc cùng server và UI | Next.js server, time travel/sửa state, Jotai/MobX/XState/Apollo, MCP |

## Kiến trúc

```
App (RN / web)                                 Máy dev
@capybara-devtools/react-native | web          capybara-devtools (CLI) hoặc app desktop
  └─ @capybara-devtools/core      ── ws ──►      ├─ /client   nhận event từ app
       plugin console                            ├─ /viewer   đẩy event cho UI, chuyển lệnh UI → app
       plugin network                            └─ HTTP      phục vụ UI (@capybara-devtools/ui)
       plugin storage
       plugin state
```

| Package | Vai trò |
|---|---|
| `packages/protocol` | Kiểu message, event và hằng số (port, path), dùng chung cho mọi package. |
| `packages/core` | Runtime phía app: ring buffer, gửi theo batch, kết nối lại, serialize an toàn, plugin console/network/storage/state. |
| `packages/web` | `init()` cho browser: lỗi của window, localStorage/sessionStorage/cookie. |
| `packages/react-native` | `init()` cho RN: tự tìm IP máy dev từ URL bundle của Metro, `ErrorUtils`, adapter AsyncStorage/MMKV. |
| `packages/cli` | `npx capybara-devtools`: HTTP + WebSocket server, lưu event theo phiên, chuyển lệnh UI → app, tự `adb reverse`. |
| `packages/ui` | UI React (Vite) với tab Logs / Network / Storage / State. Bản build được copy vào CLI và app desktop. |
| `apps/desktop` | App desktop (Electron, private): main process gọi `createServer()` của `capybara-devtools` rồi mở cửa sổ tới `http://localhost:<port>`. |
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
- **RN luôn patch XHR, chỉ patch `fetch` khi cần**: RN thuần dùng whatwg-fetch chạy trên XHR (`fetch.polyfill === true`), patch thêm `fetch` sẽ ra request trùng. Plugin network trong core tự nhận biết: khi đó chỉ patch XHR, và bọc `fetch` mỏng để XHR gửi trong lúc `fetch()` đang chạy được ghi là fetch (whatwg-fetch mở và gửi XHR ngay trong lời gọi). Expo SDK 57 thay `fetch` bằng `expo/fetch` chạy native, không qua XHR, nên patch riêng. Web patch cả hai.
- **Event được `JSON.stringify` một lần lúc ghi**: buffer biết dung lượng thật, gửi lại không phải serialize lại.
- **Giới hạn bộ nhớ**: buffer phía app tối đa 2000 event / 8 MB; body request/response cắt ở 128 KB; mỗi message WebSocket cắt ở 16 KB; server giữ 5000 event mỗi phiên, 20 phiên; UI giữ 2000 message gần nhất mỗi socket.
- **WebSocket**: một hàm hook tự chứa trong core (`hookWebSockets`) dùng chung cho SDK và bridge (bridge tiêm qua `toString()`). Trên web chỉ bọc constructor `WebSocket` vì trình duyệt phát event từ native. Trên React Native bọc thêm `dispatchEvent` và `send` trên prototype, nên bắt cả socket tạo trước khi hook gắn và socket tạo qua constructor mà thư viện lưu từ lúc import (engine.io của socket.io làm vậy). Transport của SDK giữ constructor gốc từ trước khi plugin chạy và đánh dấu socket của nó, nếu không hook sẽ tự ghi chính kết nối tới Capybara thành vòng lặp. Bridge gửi event về qua `Runtime.addBinding`, hook có lease 15 giây như hook MMKV. Mặc định bỏ qua socket của công cụ dev: HMR của Metro (RN mở với URL `http://`), `/message`, React DevTools (8097), Reactotron (9090), Vite (theo subprotocol), Next.js HMR.
- **Lý do request lỗi**: trình duyệt không cho trang biết vì sao request lỗi, chỉ ghi vào console của nó. SDK web tự phân loại những gì trang biết được: offline, mixed content, CSP (qua event `securitypolicyviolation`; event này có thể đến sau khi request đã lỗi nên SDK chờ 30 ms) và cross-origin. Còn lại, nút "Find out why" nhờ server Capybara chạy lại các bước CORS từ máy dev (preflight, rồi GET/HEAD kèm `Origin` của trang, đi theo redirect và gửi `Origin: null` như trình duyệt), đọc header mà trình duyệt giấu rồi áp luật của trình duyệt. Server dùng `node:http` chứ không dùng `fetch`: thấy được header bị lặp, tự kiểm tra danh sách port trình duyệt chặn, và gặp chứng chỉ do CA nội bộ ký (mkcert) thì vẫn kiểm tra tiếp mà không xác minh, kèm ghi chú. Không bao giờ gửi lại `Authorization`, cookie hay header đã che; chỉ gửi lại GET/HEAD, method khác thì hỏi bằng `OPTIONS`. Luật khác nhau theo trình duyệt nên dùng user agent: Chrome vẫn cho `*` trong `Access-Control-Allow-Headers` bao cả `Authorization` (chỉ cảnh báo deprecation) và miễn mixed content cho IP nội bộ và tên `.local` (Local Network Access). Trên React Native, chuỗi lỗi native chỉ được truyền vào `XMLHttpRequest.__didCompleteResponse`, nên SDK bọc method đó.
- **Bảo mật**: server bind `0.0.0.0` để máy thật trong LAN gửi event vào `/client`. UI và viewer socket chỉ mở cho chính máy chạy Capybara: kết nối loopback, hoặc kết nối có địa chỉ nguồn trùng địa chỉ đích (UI mở ở IP LAN của chính máy; máy khác không bắt tay TCP được bằng địa chỉ đó). `--remote-ui` (hoặc `CAPYBARA_REMOTE_UI=1`, app desktop cũng đọc) mở cho máy khác, kể cả `capybara mcp --host`. Viewer còn phải cùng origin, và header `Host` phải là `localhost` hoặc IP. Như vậy trang web lạ mở trong browser của dev không đọc được dữ liệu qua WebSocket, kể cả bằng DNS rebinding. Chế độ dev không che header (có tuỳ chọn `redactHeaders`); chế độ QA sau này sẽ che mặc định. Banner của CLI và `server.addresses` (UI gợi ý địa chỉ cho điện thoại) lấy từ địa chỉ server thật sự bind: bind loopback thì không có địa chỉ LAN nào.
  - Người dùng có thể không biết `--remote-ui`, nên nó được nhắc ở chỗ họ cần: banner của CLI có dòng `Network   use --remote-ui to open the UI on other devices` như Vite gợi ý `--host` (bind loopback thì không có, bật cờ thì là URL LAN); máy bị chặn nhận trang 403 nói cách mở, và CLI in địa chỉ máy đó một lần; `capybara mcp --host` báo bị từ chối thay vì "not running".
  - Nút thiết bị ở góc trên phải của UI: đã bật thì popover có mã QR để điện thoại quét và địa chỉ có nút Copy, chưa bật thì có lệnh để copy; ẩn khi không có địa chỉ LAN. UI biết trạng thái qua `ServerInfo.remoteUi`. Mã QR tạo bằng `uqr` (MIT, không dependency), luôn tối trên nền trắng vì camera đọc dễ nhất.
- **Port mặc định 7357.**
- **App desktop là Electron bọc server sẵn có**: cửa sổ load UI qua HTTP từ chính server, không dùng `file://`, nên các kiểm tra origin và `Host` ở trên giữ nguyên. Main process được bundle bằng rolldown (có sẵn qua Vite) thành một file CJS, mọi dependency là devDependencies, nên electron-builder chỉ đóng gói `dist/` mà không kéo `node_modules` của workspace. `backgroundThrottling: false` để cửa sổ bị ẩn vẫn cập nhật đều: đo trên Electron 44, timer 100 ms trong cửa sổ ẩn chạy 30 lần/3 s, bật throttling thì chỉ còn 3 lần.
- **Đóng gói Windows và Linux**: build được ngay trên Mac, không cần Wine hay Docker. Windows có bộ cài NSIS (cài cho user hiện tại, không cần quyền admin) và `.zip`, bản x64. Linux có AppImage và `.tar.gz`, bản x64 và arm64; chưa có deb/rpm vì gói deb bắt buộc có email người bảo trì. AppImage dùng runtime tĩnh (`toolsets.appimage: "1.0.3"`): runtime cũ cần libfuse2, và bản arm64 không chạy được vì thiếu `libz.so`. Runtime cũ còn luôn tắt sandbox của Chromium; launcher của bản mới thử `unshare -Ur` và chỉ thêm `--no-sandbox` khi máy không cho tạo user namespace (Ubuntu 24.04+ chặn qua AppArmor). Đặt `desktopName` trong package.json kèm `linux.syncDesktopName` để tên file `.desktop`, `StartupWMClass` và WM_CLASS của cửa sổ cùng là `capybara-desktop`. Thiếu nó thì cửa sổ có class `capybara` còn file `.desktop` ghi `Capybara`, nên desktop environment không gắn cửa sổ với app. Binary Linux không chứa icon, nên cửa sổ được gán `dist/icon.png`. Icon Windows/Linux (`build/icon.png`) vẽ từ cùng file SVG nhưng cắt bỏ lề, vì chỉ macOS chừa lề quanh icon.
- **Cổng của app desktop đang bận**: nếu là một Capybara khác (vd. `npx capybara-devtools`), cửa sổ hiện server đó và app thử nhận cổng mỗi 2 giây, nên tắt CLI là app tự thay chỗ. Nếu là chương trình khác thì báo lỗi, có nút thử lại. macOS vẫn cho bind mọi interface khi chương trình khác giữ cùng cổng trên `0.0.0.0`, `127.0.0.1` hoặc `::1`, và localhost vẫn đi tới chương trình đó, nên app thử bind từng địa chỉ này trước. CLI chưa có kiểm tra này.
- **Stack trace của React Native**: server map stack của error trong log có frame trỏ vào bundle Metro (`.bundle`, cả URL jsc-safe `…bundle//&platform=…` RN dùng) qua `/symbolicate` của Metro, như LogBox, trước khi lưu và gửi cho UI, nên UI và MCP cùng thấy file nguồn, với SDK lẫn qua Metro. Chỉ hỏi Metro trên chính máy này (`localhost`, `10.0.2.2` của máy ảo Android, hoặc một địa chỉ của máy), ở cổng trong URL. Metro nhận và trả cột 0-based. Batch có stack chờ Metro (tối đa 5 s, quá thì giữ stack gốc); batch sau và lệnh `clear` xếp hàng sau nó để giữ thứ tự.
- **Fetch hay XHR**: RN 0.86 tự báo request qua CDP thì không có `type` nhưng có stack JS của request (`initiator.stack`); có frame tên `fetch` là fetch (whatwg-fetch gửi XHR từ bên trong `fetch()`), còn lại là XHR. Network inspector của Expo (Expo Go) báo mọi request, cả XHR, với `type: "Other"` và không có stack, nên ghi là `other`. Vì vậy UI gộp nút lọc thành Fetch/XHR như Chrome DevTools, gồm cả `other`.
- **adb trên Linux**: adb chạy qua `bash` đóng mọi fd thừa hưởng trước khi `exec`. Electron mở file tài nguyên (app.asar, các file .pak, icudtl.dat, snapshot V8) không có `O_CLOEXEC`; adb server mà lệnh adb đầu tiên khởi động sống tiếp sau khi app thoát và giữ 9 file đó, nên AppImage không unmount được và tiến trình FUSE của nó không thoát. libuv chỉ dọn stdio khi spawn, còn Node không có API đặt `FD_CLOEXEC`.
- **Bridge Metro (React Native không cần SDK)**: CLI/desktop nối vào `/inspector/debug` của Metro như một debugger thứ hai (CDP, kênh React Native DevTools dùng). Mỗi JS context là một phiên, gửi vào server qua `/client` như SDK. Hermes chỉ mô tả Date/Map/Set là "Object", nên tham số log được serialize ngay trong app bằng chính `serialize()` của SDK (hàm tự chứa, gửi qua `serialize.toString()`). App có SDK (`__CAPYBARA_CLIENT__`) thì bỏ qua; quyết định đợi tới khi app chạy xong file entry (`RN$AppRegistry` hoặc log `Running "…"`), vì SDK khởi tạo trong đó. Expo CLI chỉ giữ socket debugger khi Origin đúng địa chỉ của nó (`http://127.0.0.1:<port>`); Metro thường nhận mọi origin localhost.
- **State**: một plugin `state` trong core, adapter duck-typed nên core không phụ thuộc thư viện state nào. Store đăng ký vào registry trên `globalThis` (`__CAPYBARA_STATE_V1__`), nên adapter gọi trước hay sau `init()` đều được và sống qua HMR.
  - **Mô hình kéo**: event chỉ mang đăng ký store, bản ghi thay đổi gọn (tên action, tối đa 100 op diff kèm preview nhỏ, `rev` tăng 1 mỗi bản ghi) và summary của entry TanStack/SWR. State đầy đủ và data của entry đọc qua command theo path khi UI hay MCP cần, cắt ở 128 KB như body. Snapshot định kỳ tốn băng thông và chỗ trong ring theo cỡ state, kể cả khi không ai xem. SDK chỉ diff và gửi bản ghi khi đang nối server, tối đa 30 bản ghi/giây mỗi store, dư thì gộp vào bản ghi sau kèm `skipped`.
  - **Shim Redux DevTools**: `init()` đặt `__REDUX_DEVTOOLS_EXTENSION__` và `__REDUX_DEVTOOLS_EXTENSION_COMPOSE__`, bọc extension thật nếu có. Enhancer của Capybara nằm dưới `applyMiddleware` nên thấy cả action từ thunk. Nhờ vậy `configureStore()` của RTK và `devtools()` của zustand hiện mà không sửa code. RTK đọc global lúc module evaluate, nên file gọi `init()` phải import trước RTK; dự phòng là `capybaraReduxEnhancer()`. Không làm entry `/register`: các gói khai báo `"sideEffects": false`, nên bundler có thể bỏ một import chỉ để lấy side effect.
  - **Retention riêng**: server giữ `state.*` trong ring riêng 2000 event/phiên và ghim bản đăng ký mới nhất của mỗi store (tối đa 200), để event state dày không đẩy log và network ra, không làm hỏng "Find out why". `clear` xoá timeline, giữ store. Protocol chỉ thêm, `PROTOCOL_VERSION` giữ 1; `SessionInfo.plugins` cho UI phân biệt SDK cũ với app chưa có store.
  - **Context qua hook React DevTools**: bọc property `onCommitFiberRoot` của `__REACT_DEVTOOLS_GLOBAL_HOOK__` đang có (React giữ object hook từ lúc react-dom nạp), chưa có hook thì cài hook tối giản. Mỗi commit chỉ duyệt cây con có `child` đổi; lần duyệt đầu chia chunk 5 ms. Chỉ đọc, không bao giờ đặt `isDisabled`; sổ sách nằm trong `WeakMap` vì fiber bị `preventExtensions` ở bản dev.

## Lộ trình

**M1 — MVP (repo này)**: các mục ở cột trái bảng phạm vi.

**M2 — Hoàn thiện cho người dùng đầu tiên**

- Script `dev` chạy watch song song, thêm bản CJS. CI (typecheck + test) và publish npm bằng changesets: đã có (xem Trạng thái).
- Plugin state: Redux, Zustand, TanStack Query, SWR, React Context: đã có (xem Trạng thái). RN không SDK: đang làm.
- Stack trace qua source map (gọi `/symbolicate` của Metro): đã có (xem Trạng thái).
- Lệnh tuỳ biến từ UI xuống app (clear storage, đổi env, logout…).

**M3 — Tạo khác biệt**

- Chế độ QA: panel trong app, export/import phiên.
- Next.js server (`instrumentation.ts`) và nối request client ↔ server bằng trace id.
- MCP server để Claude Code/Cursor đọc log/network: đã có bản chỉ đọc (xem Trạng thái).
- Đóng gói desktop app: đã có bản macOS, Windows, Linux chưa ký (xem Trạng thái). Còn ký code (Developer ID + notarize, chứng chỉ ký Windows), bản macOS Intel/universal, Windows arm64, gói deb/rpm, tự cài bản cập nhật trên macOS (Squirrel.Mac cần app ký bằng một danh tính cố định: Developer ID hoặc chứng chỉ tự ký, cần thử).

## Trạng thái (19/10/2026)

**Đã xong và đã chạy thử**

- Các lỗi đồng nghiệp báo còn ở 0.4.0 (19/10/2026), sẽ có từ 0.5.0:
  - Lộ dữ liệu ra LAN: máy cùng mạng mở `http://<IP>:7357` đọc được token, state và gửi lệnh cho app. Giờ chỉ chính máy này xem được (xem mục Bảo mật), `--remote-ui` mở lại. Đã thử với CLI build mới: kết nối từ IP LAN vào loopback (đóng vai máy khác) bị 403 cả trang lẫn viewer, app vẫn nối `/client`; có `--remote-ui` thì vào được. Test tự động dùng cùng cách đó.
  - `--host 127.0.0.1` vẫn in địa chỉ LAN: banner, URL mở trình duyệt và `server.addresses` giờ theo địa chỉ server bind.
  - Stack lỗi RN chỉ ra `index.bundle…:86171:28`: Expo Go 57 trên simulator iPhone Duo (iOS 27.1), RN 0.86.2, app `examples/expo` (Expo Go cài tạm rồi gỡ): nút "info, warn and error" ra `at run (…/examples/expo/App.tsx:48:52)` cả qua Metro lẫn khi có SDK, trong UI và qua viewer.
  - Nút lọc Fetch ra 0 với app RN: cùng lần chạy đó, qua Metro mọi request của Expo Go đều là `type: "Other"` không stack (xem Khi thử bridge Metro), có SDK thì fetch và XHR ghi đúng. Nút lọc giờ là Fetch/XHR.
  - App desktop để adb giữ file sau khi tắt: Docker Ubuntu 24.04 arm64 với Xvfb, adb từ apt, user thường. AppImage 0.4.0: adb server giữ 9 file trong mount (app.asar, 3 file .pak, `locales/en-US.pak`, icudtl.dat, 2 lần v8_context_snapshot.bin và thư mục mount), thoát Electron xong vẫn còn tiến trình `app.AppImage` và mount. AppImage build lại với bản sửa: adb giữ 0 file, AppImage thoát hẳn, không còn mount; adb server vẫn chạy nền như với công cụ Android khác.
  - Website: link "Build from source" trỏ `#quick-start-from-this-repo`, heading đã đổi từ lúc publish npm; giờ trỏ `#desktop-app` và `#quick-start`, có test so link với heading của README. Copy bị chặn thì nút ghi `Press ⌘C` trên Mac, `Press Ctrl+C` trên Windows/Linux, `Selected` trên điện thoại, và chọn sẵn đoạn lệnh; đã thử bằng Chrome headless với user agent từng hệ điều hành.
  - Thanh trên cùng ở màn hình nhỏ (người dùng báo thêm): nút chọn app là phần duy nhất được co (`min-width: 0`) nên nhận hết phần thiếu chỗ, nút bên trong vẫn rộng như cũ và đè lên tab; thanh còn `overflow-x: auto` nên cắt mọi menu thả xuống. Giờ nút không rộng hơn chỗ của nó, ≤860px bỏ chữ "Capybara", ≤720px tab xuống dòng riêng (`--topbar-height` 84px, chỉ khi có tab), ≤480px trạng thái còn chấm; các menu ghim ngay dưới thanh. Đã chụp ở 860, 720, 640, 480 và 390px, cả lúc chưa có app.
  - Chưa thử: RN tự báo request qua CDP kèm stack (cần dev build bật network inspection của RN, Expo Go không bật), nhánh whatwg-fetch có SDK trên máy thật (mới có unit test).

- Context của Expo Router 58 trên React Native (19/10/2026), sẽ có từ 0.4.0: trước đây app Expo Router (template mặc định của Expo SDK 58) liệt kê khoảng 25 context nội bộ của Expo Router và React Navigation như context của app. Giờ nhận ra chúng bằng: tên các provider của Expo Router 58 (tra trong mã của expo-router 58.0.23, bản có kèm React Navigation riêng); `Content` và `Route` chỉ khi do `ContextNavigator` và `Route(…)` render; tên route `Route(…)`; layout của Expo Router (Stack là arrow function không tên, nhận qua static `Screen` và `Protected`); Map context có tên toàn cục của React Navigation; theme của React Navigation qua dạng giá trị.
  - Đã thử: app mới tạo từ template Expo SDK 58, cài SDK build local, chạy trên iPhone 17 simulator với layout NativeTabs, Tabs và Stack: `get_state` chỉ còn context của app (`Auth`), context của thư viện nằm sau "Show library contexts". Component của app trùng tên (`Content`, `Route`) vẫn được tính là của app.
- Cài Capybara bằng AI (19/10/2026), sẽ có từ 0.4.0: tool MCP `get_setup_guide` (chỉ đọc, chạy được khi Capybara chưa mở) và lệnh `capybara setup-guide [folder]` trả về hướng dẫn cài cho đúng project. Nó đọc `package.json`, lockfile và vài file để biết loại app (Vite, Next.js, Expo có hoặc không Expo Router, React Native CLI, web khác), trình quản lý gói (npm, Yarn 1, Yarn 4, pnpm, bun, cả trong monorepo), thư viện state, SDK đã cài và phiên bản, file entry; ở root monorepo thì liệt kê các app. Có thêm prompt MCP `setup` (`/mcp__capybara__setup` trong Claude Code) và một câu trong instructions của server. Tool không sửa file: AI làm theo, user duyệt từng thay đổi như bình thường. Lệnh CLI dành cho AI chưa có MCP, cuối hướng dẫn có cách thêm MCP.
  - Đã thử: Claude Code (Sonnet, headless, chỉ có MCP Capybara) tự cài vào 3 project mới tạo: Vite + zustand + TanStack Query (prompt tiếng Việt), Next.js 16.4 (thư mục `src/`, Redux Toolkit, SWR; qua `/mcp__capybara__setup`), Expo SDK 58 có Expo Router (zustand, AsyncStorage). Cả 3 lần AI tự tìm ra tool, sửa đúng chỗ và typecheck qua. Chạy thật (Chrome headless, iPhone 17 simulator) thì Capybara nhận đủ log, request, store, query và AsyncStorage.
- Chặn SDK ở bản production (19/10/2026), đã có từ 0.3.1: `init()` của SDK web không làm gì khi `process.env.NODE_ENV === 'production'` (bundler thay biểu thức này lúc build; không có bundler thì không có `process` và việc đọc bị bắt lỗi); `init()` của SDK RN không làm gì khi `__DEV__` là false. Cả hai chạy ở production khi truyền `allowProduction: true`, vd bản staging cho tester. Điều kiện dev trong snippet vẫn giữ, vì trên web nó còn loại hẳn SDK khỏi bundle (0 byte), còn thiếu nó thì code SDK vẫn nằm trong bundle (khoảng 54 KB, 19 KB gzip) nhưng không chạy.
  - Đã thử: build Vite thật một trang gọi `init()` không có điều kiện dev, mở bằng Chrome: không có client, `console` không bị patch, không có shim Redux DevTools; cùng trang với `allowProduction: true` thì có cả ba. Test SDK web và RN (RN mock `react-native`, đặt `__DEV__` false).
- Tab State (18/10/2026), đã có từ 0.3.0.
  - SDK web và RN: plugin `state` bật mặc định (`state: false` để tắt). Tự thấy store từ `configureStore()` của Redux Toolkit, `devtools()` của zustand (qua shim Redux DevTools) và provider React Context (qua hook React DevTools). Phần còn lại mỗi thứ một dòng: `watchZustand`, `watchQueryClient`, `watchSWR` (thêm `swrMiddleware` khi `SWRConfig` có `provider` riêng, như trên RN), `capybaraReduxEnhancer` hoặc `connectReduxStore` cho store Redux mà shim không thấy. Chỉ chạy ở dev, không throw vào app, không làm gì khi không có `window`.
  - UI: tab State theo mockup A (bố cục như tab Storage), store nhóm theo thư viện. Redux, Zustand, Context có timeline, diff và cây state hiện tại. TanStack Query, SWR có danh sách entry lọc theo trạng thái, data, các lệnh refetch/invalidate/reset/cancel/remove và revalidate/clear/reset; xoá hay đặt lại phải xác nhận. Context của thư viện ẩn sau nút "Show library contexts". Không có dispatch, sửa state hay time travel.
  - MCP: 3 tool chỉ đọc `get_state`, `get_state_actions`, `get_queries`. Che thêm key tên `jwt`, `bearer`, `private key`; trong state còn che theo path, theo action type và theo key của query; JWT, `Bearer …`, khoá Stripe/GitHub/Slack/AWS trong key và lỗi của entry cũng bị che.
  - Đã thử: test với thư viện thật (redux 5.0.1, Redux Toolkit 2.13.0, zustand 5.0.15, @tanstack/query-core 5.104.4, swr 2.5.1, React 19.2.3 trên happy-dom). Đếm event TanStack thật: observer mount và fetch đầu ra 7 event, refetch ra 2 cộng 2 mỗi observer, mỗi đợt thành đúng 1 patch.
  - Spike React Context: cây ~10k fiber, ~200 provider, cập nhật 60 lần/giây. p95 thêm vào mỗi commit là 0,07–0,27 ms trên web (React 19.2.3 và 18.3.1, Chrome 155 headless, Apple M3 Pro) và 0,04–0,38 ms trên Hermes (Expo Go 57, RN 0.86.3, iPhone 17 simulator); lần duyệt đầu 1–3 ms trên web, 6,7–7,8 ms trên Hermes. Đạt cổng (< 1 ms mỗi commit, lần đầu < 50 ms) nên Context bật mặc định. Ca stress (cả cây render lại, 200 value đổi mỗi commit) có p95 2,2 ms trên Hermes, trong khi React tự mất ~125 ms mỗi commit. Chung sống với backend React DevTools (cùng hook với extension), React Refresh của Vite và `react-devtools-core` trên RN: Fast Refresh của Vite và Metro vẫn giữ state, không có cảnh báo.
  - Chạy thật SDK → server → UI → MCP với `examples/web` (Vite, Chrome) và `examples/nextjs` (Next.js 16.4.2, App Router), đủ 4 thư viện: thunk có pending/fulfilled, refetch và invalidate chạy, query lỗi hiện "error 404", `capybara mcp` đọc được store, state, timeline và query. Next.js nạp `instrumentation-client` trước component import RTK (cả Turbopack lẫn `next dev --webpack`), nên `configureStore()` và `devtools()` không cần thêm code. `next build` không còn code Capybara. Lần chạy này lộ ra 3 lỗi của MCP, đã sửa.
  - Expo: chạy `examples/expo` với SDK (`EXPO_PUBLIC_CAPYBARA_SDK=1 npx expo start`) trên Expo Go 57.0.9, iPhone 17 simulator (iOS 26.5): đủ store Redux `shop`, zustand `ui` (`devtools()`) và `counter` (`watchZustand`), TanStack `QueryClient`, SWR `cache #1` (provider + `swrMiddleware`), context `AuthProvider`; 6 context thư viện được ẩn. Lệnh TanStack (Refetch, Invalidate, Reset, Remove) và SWR (Revalidate, Clear, Reset) đều chạy; Cancel chưa thử vì cần fetch đang chạy. Trên Hermes, `set()` không đặt tên ra `anonymous` (Hermes in frame là `at anonymous` nên zustand không đoán được tên), action có tên giữ nguyên. Chạy lại không có biến môi trường: app không có SDK, session Metro hiện "State needs the SDK".
  - Project mới (18/10/2026): một app Vite và một app Expo tạo mới, cài Capybara từ tarball đóng gói chứ không qua workspace. Mọi bước kiểm đều pass trên web (Chrome), simulator iOS và máy ảo Android `Capybara-Android-Test` (API 34): lần đầu tab State chạy trên Android.
  - Lần chạy đó lộ ra các lỗi sau, đã sửa (19/10/2026):
    - Expo Go 57.0.9 trên Android có `supportsMultipleDebuggers`, nhưng engine của nó không debug được qua CDP nên `Runtime.evaluate` trả `-32601`. Bridge bỏ qua lỗi này khi dò SDK, và sau 30 giây vẫn mở session "Expo Go … via Metro", kể cả khi app có SDK. UI và MCP lại chọn mặc định session mới nhất, rỗng này: không có log, Storage báo "Runtime.evaluate", Network lẫn request của app khác vì proxy inspector gửi event cho mọi target. Giờ gặp `-32601` thì bridge không mở session cho target đó và CLI in gợi ý (mỗi target một lần); lỗi tạm thời lúc app khởi động vẫn xử lý như cũ. Chạy lại `examples/expo` trên máy ảo (19/10/2026): có SDK thì hơn 30 giây sau server chỉ có session của SDK (xem qua viewer và `list_sessions` của MCP); không có SDK thì không có session nào, CLI in gợi ý đúng một lần, kể cả sau khi reload.
    - CLI không chạy lại `adb reverse` khi thiết bị nối lại (`adb reconnect`, máy ảo khởi động lại), vì nhớ mọi serial đã làm suốt thời gian chạy, nên SDK nối qua localhost mất kết nối luôn. Giờ mỗi lần quét đọc `adb reverse --list` và đặt lại khi thiếu. Trên máy ảo, `adb reconnect` xoá rule, 6 giây sau rule có lại.
    - MCP: câu giải thích khi không có store bỏ sót React Context. Key tên như thông tin đăng nhập che cả `null`, `undefined`, `false` và `''` (`"token": "[hidden]"` cả khi đã đăng xuất), nên AI không phân biệt được đã đăng nhập hay chưa; giờ giá trị rỗng hiện nguyên, chỉ che giá trị thật.
    - UI: empty state của tab State gợi ý `watchSWR(SWRConfig)` cho cả React Native; phiên RN giờ thấy mẫu `<SWRConfig value={{ provider: () => new Map(), use: [swrMiddleware] }}>`.
    - Tài liệu: mẫu gọi `init()` ngay trong `main.tsx` hay `index.ts`, mà import của file chạy trước code của nó (import hoisting) nên store bị bỏ sót không báo gì; giờ mẫu dùng file `capybara.ts` riêng, import ở dòng đầu. Điều kiện đổi thành "trước khi các module store nạp", vì `devtools()` của zustand đọc global lúc tạo store: store tạo trước `init()` cũng bị sót, `watchZustand()` lấy lại được nhưng không có tên action. Thêm `port` và `enabled` của `init()`, `anonymous` cả trên web (Vite pre-bundling làm zustand không đoán được tên), `displayName` cho context (context không tên lấy tên component render provider, cái thứ hai thành `#2`), Expo Go trên Android, và đặt tên cache SWR bằng `swrProvider`.
  - Chưa thử: máy Android thật và iPhone thật, chưa đo Context trên Android (số đo mới có trên simulator iOS, Android tầm trung có thể chậm 2–4 lần); pages router của Next.js (mới đọc source); app React 18 thật (spike chỉ đo React 18.3.1 trong app tổng hợp); Windows; extension Redux DevTools thật (test dùng extension giả). RN không SDK: đang làm.
- Báo bản mới (16/10/2026), sẽ có từ 0.2.0:
  - Server tra version mới nhất của CLI và hai SDK trên registry npm (registry npm đang dùng, nếu chạy qua npm) khi khởi động và mỗi 12 giờ, rồi gửi cho UI qua `ServerInfo.latest` và message `server`. Tắt bằng `--no-update-check` hoặc `CAPYBARA_NO_UPDATE_CHECK`.
  - CLI in một dòng khi npm có bản mới.
  - UI hiện thông báo kèm lệnh cài khi SDK của app đang chọn cũ hơn. Không tra được npm thì so với version của server, vì mọi gói cùng version. CLI cũ hơn cũng có thông báo, trừ trong app desktop. Bấm × thì ẩn tới khi có bản mới hơn nữa.
  - App desktop hỏi GitHub (`releases/latest`) 10 giây sau khi mở và mỗi 12 giờ, có thêm mục Check for Updates…. Bản cài NSIS và AppImage tải và cài qua electron-updater; bản macOS, zip và tar.gz mở trang release.
  - Đã thử: CLI với registry giả (in dòng báo, viewer nhận `latest`), tắt bằng biến môi trường, chụp UI ở theme sáng và tối với cả hai loại thông báo.
  - Cập nhật thật trên Linux: hai bản AppImage arm64 build thử (0.1.1 và 0.1.2, provider `generic` trỏ về một server local) chạy trong Docker Ubuntu 24.04 với Xvfb, bằng user thường. Bản 0.1.1 tự hỏi sau 10 giây, xdotool bấm Update rồi Restart. App tải 0.1.2 (server thử không hỗ trợ Range nên tải cả file thay vì tải phần khác), thay file AppImage và mở lại; server của app mới báo version 0.1.2.
  - macOS: bản đóng gói ghi version 0.0.9 tìm thấy release 0.1.0 trên GitHub và hỏi theo kiểu mở trang tải.
  - Chưa thử trên Windows (bộ cài NSIS), vì không có máy Windows.
- Phát hành (16/10/2026): scope `@capybara` trên npm đã thuộc về tài khoản khác, nên các gói đổi tên thành `capybara-devtools` (CLI; lệnh sau khi cài vẫn là `capybara`) và `@capybara-devtools/*`. Có changesets (5 gói chung một version), workflow CI và Release (publish npm qua trusted publishing), lệnh `desktop:release` upload bản cài lên bản nháp GitHub Release. 0.1.0 đã lên npm ngày 16/10/2026, publish từ máy; các bước ở [RELEASING.md](RELEASING.md). Cài lại từ npm vào project trống: CLI chạy, có UI, SDK import được. Đã thử: đóng gói 5 gói, cài vào project trống, chạy CLI, server trả UI, import SDK, kiểm tra type.
- Đổi tên Devsight → Capybara (16/10/2026): package `@capybara/*` và CLI `capybara`, biến môi trường `CAPYBARA_PORT` và `VITE_CAPYBARA_SERVER`, global `__CAPYBARA_*__`, bundle ID `dev.capybara.*`, máy ảo test `Capybara-MMKV-Test` và `Capybara-Android-Test`. App mẫu native đổi bundle ID nên lần chạy fixture tới cần build lại; bản cũ (`dev.devsight.*`) vẫn còn trên simulator.
- Copy (16/10/2026): tab Logs có **Copy all** (các dòng khớp bộ lọc) và icon copy từng dòng khi rê chuột; object được copy đầy đủ dạng JSON (Date, Map, Set, giá trị bị cắt cũng ghi rõ), lỗi kèm stack. Tab Storage có **Copy** cho giá trị đang chọn, mọi nhánh trong cây JSON (cả ở Logs và Network) có icon copy riêng. Copy xong hiện dấu ✓ trên nút và toast "Copied to clipboard"; nếu không ghi được clipboard thì toast báo lỗi. Đã thử trên app desktop: bấm thật vào các nút rồi đọc lại clipboard, nội dung đúng như mong đợi.
- MCP cho AI (16/10/2026): lệnh `capybara mcp` là MCP server qua stdio (SDK chính thức `@modelcontextprotocol/sdk` 1.31), đọc server Capybara đang chạy qua đúng kênh viewer của UI, không đổi gì ở app hay SDK. 7 tool chỉ đọc: `list_sessions`, `get_logs`, `get_network`, `get_request`, `diagnose_request`, `get_websocket`, `get_storage`; lọc ngay trên dữ liệu, mặc định 50 dòng mới nhất, có `after`/`before` để lấy tiếp. Mặc định che giá trị trông như thông tin đăng nhập (header, khoá JSON, tham số URL, key storage), `--show-secrets` để tắt. Các hàm đọc giá trị (`preview`, `formatLogMessage`, `valueText`…) chuyển sang `@capybara-devtools/protocol` để UI và MCP mô tả giá trị giống nhau. 9 test tích hợp dùng client MCP của SDK với server thật; đã chạy `capybara mcp` qua stdio với app desktop và dữ liệu thật của app mẫu. Thử trên một app web thật của người dùng (bản staging, SDK gắn qua Chrome ẩn, không sửa code): các tool thấy 5 request bị chặn cross-origin, `diagnose_request` chỉ ra API trả 401 không có `Access-Control-Allow-Origin` cho localhost. Sau đó cho Claude Code (chế độ `-p`, chỉ được dùng tool Capybara) tự tìm nguyên nhân: nó gọi `list_sessions` → `get_network` → `get_request` → `diagnose_request` và kết luận đúng, kèm số liệu và cách sửa. `list_sessions` ẩn các phiên cũ đã ngắt không có dữ liệu, vì trang tải lại để lại nhiều phiên rỗng.
- Appearance (16/10/2026): nút ở góc phải thanh trên cùng, chọn System (mặc định, theo hệ điều hành), Light hoặc Dark; lưu trong localStorage. Bảng màu đặt theo `data-theme` trên `<html>`, một script nhỏ trong `index.html` đặt nó trước lần vẽ đầu nên không nháy màu; ở System thì đổi ngay khi hệ thống đổi. App desktop có preload báo lựa chọn cho tiến trình chính, đặt `nativeTheme.themeSource` (thanh tiêu đề macOS đổi theo) và lưu vào `settings.json` để lần mở sau cửa sổ có đúng màu nền ngay. Đã thử trên trình duyệt (giả lập hệ thống sáng/tối, tải lại trang) và trên cửa sổ desktop thật qua cổng debug tạm thời.
- Kéo đổi độ rộng (16/10/2026): đường chia giữa danh sách request và khung chi tiết (tab Network), giữa danh sách key và khung giá trị (tab Storage). Kéo chuột, phím mũi tên khi đang chọn đường chia, nhấp đúp để về mặc định; độ rộng lưu theo phần trăm trong localStorage. Mỗi bên có độ rộng tối thiểu, và hàng nút ở đầu khung tự xuống dòng thay vì bị cắt khi khung hẹp. Đã thử trên app desktop: kéo, giới hạn 25–75%, nhớ sau khi tải lại, nhấp đúp; ở cửa sổ 1000px kéo về mức tối thiểu không còn nút nào bị che.
- Icon: capybara ngâm suối nước nóng, mắt nhắm, quả yuzu trên đầu, vẽ bằng nét thẳng và cung tròn trên nền cam yuzu. File gốc `assets/icon.svg`; giao diện dùng nó làm logo và favicon. App desktop dùng gói Icon Composer `apps/desktop/build/icon.icon`, electron-builder biên dịch bằng `actool` (Xcode 26) ra `Assets.car` cho macOS 26 và `icon.icns` cho bản cũ. Đã lấy icon của `Capybara.app` qua `NSWorkspace` trên macOS 26.6: hiện đúng kiểu Liquid Glass, không bị đóng khung xám như icon kiểu cũ.
- Bản Windows và Linux của app desktop (16/10/2026): lệnh `desktop:package:win`, `desktop:package:linux` và `desktop:package:all` (xem README); cách đóng gói ở mục Quyết định kỹ thuật. App tìm `adb` ở vị trí Android SDK mặc định của từng hệ điều hành.
  - Linux: chạy trong Docker Ubuntu 24.04 với Xvfb, bằng user thường, bản arm64 chạy thẳng và x64 giả lập. Server trả UI, cửa sổ tải `http://localhost:7357/`, có icon và WM_CLASS `capybara-desktop` khớp file `.desktop`. Khi được tạo user namespace, cả tar.gz lẫn AppImage chạy có sandbox. Khi bị chặn (seccomp mặc định của Docker, cùng tác dụng với AppArmor của Ubuntu 24.04+), AppImage tự chạy không sandbox, còn tar.gz dừng với lỗi `chrome-sandbox` cho tới khi thêm `--no-sandbox`.
  - Windows: chưa chạy được vì không có máy Windows hay Wine. Đã đọc file exe: PE32+ GUI x86-64, icon capybara 16–256 px, thông tin phiên bản Capybara 0.1.0 (thiếu `author` thì CompanyName vẫn là "GitHub, Inc." của Electron); `app.asar` có đủ `dist/`.
- Trang web (16/10/2026): https://capybara-devtools.chanieshop.com, mã trong `website/`. Dùng Vite và TypeScript thuần, nằm ngoài npm workspaces và có lockfile riêng, nên Vercel chỉ cài vài package của trang.
  - Nội dung: giới thiệu, hướng dẫn bắt đầu, tải app.
  - Link tải: trình duyệt của người xem đọc GitHub release mới nhất và chọn file theo hệ điều hành của họ, nên phát hành bản mới không cần deploy lại trang.
  - Ảnh chụp: giao diện thật với app giả, tạo bằng `website/scripts/screenshots.mjs`.
  - Deploy: Vercel (project `capybara-devtools`, Root Directory `website`), đã nối Git. Push lên `main` có đổi `website/` thì Vercel chạy test, build rồi deploy; PR có bản preview.
  - Đã kiểm tra bằng Chrome:
    - link tải đúng cho Mac (Safari, Chrome báo chip Intel), Windows, Linux arm64, iPhone;
    - đúng ở các trạng thái chưa có release, GitHub API lỗi và khi tắt JS;
    - không cuộn ngang ở bề rộng 390, 768, 1440px, cả sáng lẫn tối.
- Monorepo gồm 6 package, app desktop và 3 app mẫu (web, Next.js, Expo). `npm run build`, `npm run typecheck` và `npm test` (347 test) đều pass.
- Metro/CDP bridge chạy trong CLI và desktop: có 15 test tích hợp với Metro giả lập cho log object, request/response/body, lỗi mạng, reload, reconnect, bỏ qua app có SDK, engine không debug được (Expo Go trên Android), target không hỗ trợ nhiều debugger và bắt/gỡ MMKV private. App Expo mẫu mặc định không nạp SDK. Đã chạy thử với app này trên Expo Go (iPhone 17 simulator), qua cả CLI lẫn app desktop: log có object, Date, Map/Set, Error, unhandled rejection; network `fetch` + XHR có status, header và body (cả 404); app có SDK thì bị bỏ qua đúng. Chưa thử trên máy thật.
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
  - `npx capybara-devtools` đang chạy thì cửa sổ dùng server đó; tắt CLI thì app tự nhận cổng và tải lại UI
  - cổng bị chương trình khác giữ (kể cả chỉ trên `::1`, như Vite) thì báo lỗi, thử lại được
  - cửa sổ ẩn vẫn nhận và hiện event ngay
  - `npm run desktop:package` ra `.dmg` và `.zip` (ad-hoc signed); app đóng gói chạy được, UI phục vụ từ `app.asar`

**Chưa kiểm tra**

- Chế độ không SDK trên máy thật (Android lẫn iOS): app thật đang có đều dưới RN 0.85. App desktop cũng chạy `adb reverse` (tìm `adb` trong Android SDK khi mở từ Dock) nhưng chưa thử với máy thật.
- RN thuần trên iOS (mới chạy trên Android).
- react-native-mmkv 3.x native trên Android (mới chạy 4.x).
- Next.js phía server (log, request trong server component và route handler), nằm trong lộ trình M3.
- State: máy Android thật (máy ảo đã chạy, xem tab State ở trên), pages router của Next.js (mới đọc source), app React 18 thật (spike chỉ đo app tổng hợp), Windows, extension Redux DevTools thật (test dùng extension giả).
- App desktop: mở bản đóng gói trên máy Mac khác (Gatekeeper với app chưa notarize), bản Intel. Bản Windows chưa chạy trên Windows (SmartScreen, hộp hỏi của tường lửa, `adb.exe`). Bản Linux mới chạy trong Docker với Xvfb, chưa chạy trên desktop thật (GNOME/KDE, Wayland, AppArmor của Ubuntu 24.04+).

**Rút ra từ lần chạy thật**: ban đầu SDK chỉ patch XHR trên RN, nên mọi request `fetch` trong app Expo đều bị bỏ sót. Đã sửa bằng cách tự nhận biết lúc `init()` (xem mục Quyết định kỹ thuật). Với app desktop, macOS cho server bind cổng 7357 dù chương trình khác đang giữ cổng đó trên loopback, nên phải kiểm tra trước (xem mục Quyết định kỹ thuật).

Khi thử MMKV native:

- MMKV không lưu kiểu, mọi getter giải mã cùng một dãy byte. Số luôn chiếm 8 byte (double), boolean 1 byte, chuỗi là varint độ dài cộng UTF-8. Vì vậy `getString` đọc số 42 ra `''`, và reader cũ (thử `getString` trước) hiện số và `false` thành chuỗi rỗng. Mock có kiểu trong unit test đã che lỗi này. Reader mới coi chuỗi giải mã được từ 7 byte trở lên là chuỗi, ngắn hơn thì thử `getNumber` (chỉ thành công khi dữ liệu ≥ 8 byte), rồi mới `getBoolean`. `false` và `''` cùng là một byte 0 nên đều hiện là `false`. Byte UTF-8 không hợp lệ thì Hermes trả `''`. Unit test giờ dùng mô hình MMKV ở mức byte.
- `Runtime.evaluate` của Hermes không biên dịch được source có ký tự ngoài BMP (lỗi `Invalid UTF-8 code point 0xd83d`). Tham số của reader (key, adapter id) được escape thành `\uXXXX`. Ký tự BMP như `·`, `à` vẫn chạy được.
- Hermes chỉ cho dùng object handle (`Runtime.callFunctionOn`, `releaseObject`) sau khi phiên debugger đó gọi `Runtime.enable`. Bridge đã gọi sẵn; script hay công cụ khác nối CDP riêng thì phải tự gọi.
- Khi đọc store, MMKV in các dòng `[E]` như `getDouble reach end` vào log native vì phải thử từng getter. Các dòng này vô hại.
- Adapter MMKV của SDK React Native cũng thử `getString` trước như reader cũ, nên số và boolean hiện thành chuỗi rỗng; test cũ dùng mock có kiểu. Đã sửa bằng cùng cách suy kiểu, kiểm trên MMKV 4.3.2 native (Android) qua SDK. Trên web giữ nguyên chuỗi, vì MMKV web lưu text và `getNumber` là `Number(text)` (`'007'` sẽ thành 7).

Khi thử bridge Metro:

- Expo Go 57 (iOS 27.1, RN 0.86.2) báo mọi request qua network inspector của Expo, cả XHR, request tải asset của LogBox và `/symbolicate`: `type: "Other"`, `initiator: {type: "script"}`, không có stack. Không có event nào từ network reporting của RN, nên qua Metro không phân biệt được fetch với XHR.
- Reload JS (`Page.reload`) trong Expo Go 57 lại làm mất module native (`ExpoAsset`, `ExponentConstants`) như ghi ở dưới; tắt Expo Go (`simctl terminate`) rồi mở lại URL `exp://` thì chạy.

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
- React bản dev in "Download the React DevTools…" bằng `console.info` mỗi lần tải trang nếu chưa cài extension. SDK web không ghi câu này (tuỳ chọn `ignore` của `consolePlugin`), trình duyệt vẫn in.
- Dev overlay của Next.js gửi `/__nextjs_original-stack-frames` mỗi khi có `console.error`, lẫn vào tab Network. SDK web giờ bỏ qua `/__nextjs_*`, như SDK React Native bỏ qua `/symbolicate`.
- Ghi cookie trước đây không phát event nên tab Storage không tự refresh. Giờ dùng Cookie Store API ở trình duyệt có hỗ trợ (đã kiểm trên Chrome).
- Tab State: thời gian của bản ghi là lúc SDK gửi (gom mỗi 100 ms), không phải lúc action chạy. Chrome làm chậm timer ở tab nền, nên bản ghi của tab nền đến trễ và mang giờ trễ.

Khi thử lý do request lỗi:

- Preflight trả 404: Chrome báo thiếu `Access-Control-Allow-Origin`, Capybara báo preflight không được trả 2xx (lỗi gốc là server không xử lý `OPTIONS`). Cả hai lỗi đều có trong danh sách kiểm tra.
- Chrome 155 vẫn cho `Access-Control-Allow-Headers: *` bao cả `Authorization`, chỉ phát DeprecationIssue; Firefox và Safari làm đúng chuẩn.
- Từ trang https, Chrome 155 chỉ cảnh báo (vẫn gửi) request http tới IP literal nội bộ (10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, fc00::/7, fe80::/10) và tên `.local`; host công khai, IP công khai và 198.18/15 thì chặn. Tên miền trỏ về IP nội bộ (như `*.nip.io`) vẫn bị chặn.

Khi thử project mới (tab State):

- Expo Go 57.0.9 trên iOS: sửa file xong, reload toàn bộ thì app hiện màn hình đỏ `Cannot find native module 'ExpoFetchModule'`, kể cả khi không có Capybara; mở nguội thì chạy bình thường. Giống lỗi reload đã gặp khi thử bridge Metro.
- Expo Go 57.0.9 trên Android: gọi `Log.enable` thì React Native báo engine `HermesRuntime[RNBridgeless]` không hỗ trợ debug qua CDP. Mọi `Runtime.evaluate` trả `{"code":-32601,"message":"Runtime.evaluate"}` và không có event console, nên không có SDK thì không đọc được app trong Expo Go Android, dù target vẫn có `supportsMultipleDebuggers`.

## Câu hỏi còn mở

- MCP: có nên thêm tool ghi (sửa storage, xoá phiên, refetch/invalidate query) sau cờ riêng không? Hiện chỉ đọc.
- Gói deb/rpm cho Linux cần email người bảo trì (`author.email` hoặc `linux.maintainer`). Dùng email nào?
- Ký code: cần Apple Developer ID (để notarize) và chứng chỉ ký cho Windows. Chưa ký thì macOS chặn lần mở đầu, còn Windows hiện cảnh báo SmartScreen.
- License: MIT, Apache-2.0 hay đóng nguồn?
- Trusted publishing: npm từ chối OIDC token của repo GitHub tạo sau 15/7/2026 (npm/cli#9969), nên tạm publish từ máy. Khi npm sửa thì bật theo RELEASING.md.
- Có cần hỗ trợ RN kiến trúc cũ (< 0.76) không?
- MMKV trên web đang hiện trong Local Storage dưới dạng key `<id>\<key>`. Có gom thành từng store "MMKV · id" riêng không?
- App dưới RN 0.85 chỉ dùng được SDK. Có thêm tuỳ chọn cho chế độ không SDK nối vào các app này khi người dùng chấp nhận đóng debugger đang mở không?
