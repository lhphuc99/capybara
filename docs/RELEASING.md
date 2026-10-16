# Phát hành Capybara

## Phát hành lên đâu

| Thứ phát hành | Nơi chứa | Người dùng cài bằng |
|---|---|---|
| 5 gói npm: `capybara-devtools` (CLI), `@capybara-devtools/web`, `@capybara-devtools/react-native`, `@capybara-devtools/core`, `@capybara-devtools/protocol` | registry npm | `npx capybara-devtools`, `npm`/`yarn`/`pnpm`/`bun add @capybara-devtools/web` |
| App desktop: `.dmg`, `.zip` (macOS arm64), `.exe`, `.zip` (Windows x64), `.AppImage`, `.tar.gz` (Linux x64, arm64) | GitHub Releases của `lhphuc99/capybara`, tag `vX.Y.Z` | tải trực tiếp; Homebrew, winget, Scoop, AUR trỏ về các file này |

yarn, pnpm và bun đều tải từ registry npm, nên publish một lần lên npm là cài được bằng cả bốn.

Tên trên npm là `capybara-devtools`, vì scope `@capybara` đã thuộc về một tài khoản npm khác. Tên sản phẩm, lệnh `capybara` (sau khi cài global), biến môi trường `CAPYBARA_*`, global `__CAPYBARA_*__` và bundle ID `dev.capybara.*` vẫn giữ là Capybara.

Năm gói npm và app desktop dùng chung một số version (nhóm `fixed` trong `.changeset/config.json`). App desktop là package private, nên `scripts/sync-versions.mjs` chép version của CLI sang nó, đồng thời cập nhật `SDK_VERSION` trong hai SDK và `package-lock.json`.

## Lần đầu (0.1.0)

Làm theo thứ tự này, vì workflow Release sẽ thử publish mọi version chưa có trên npm ngay khi được push lên `main`.

1. **Tài khoản npm**: đăng nhập npmjs.com, bật 2FA.
2. **Scope `@capybara-devtools`**: tạo organization tên `capybara-devtools` (gói Free, không giới hạn package public). Ngày 16/10/2026 tên này còn trống.
3. **Publish từ máy mình**:

   ```bash
   npm login
   npm run release      # build, rồi publish 5 gói theo thứ tự phụ thuộc; hỏi mã OTP
   git push --tags      # các tag capybara-devtools@0.1.0, @capybara-devtools/core@0.1.0, ...
   ```

   Lỗi giữa chừng thì chạy lại `npm run release`: changesets bỏ qua các version đã có trên npm.
4. **Trusted publishing**: với từng gói trong 5 gói, trên npmjs.com vào Settings → Trusted Publisher → GitHub Actions và điền
   - Organization or user: `lhphuc99`
   - Repository: `capybara`
   - Workflow filename: `release.yml`
   - Environment: để trống

   Sau đó có thể bật Publishing access → "Require two-factor authentication and disallow tokens", để chỉ workflow (và bạn, với 2FA) publish được.
5. **GitHub**: trong Settings → Actions → General của repo, bật "Allow GitHub Actions to create and approve pull requests" (changesets cần quyền này để mở PR version).
6. **App desktop**: xem mục [App desktop](#app-desktop).
7. **README và website**: bỏ các dòng "not published to npm yet" / "Until the package is published" ở README gốc, và đặt `NPM_PUBLISHED = true` trong `website/src/config.ts` để website bỏ nhãn "Coming to npm" ở các lệnh cài (xem `website/README.md`).

## Các lần sau

1. Mỗi thay đổi cần phát hành: `npx changeset`, chọn gói và mức tăng (patch, minor, major), viết mô tả cho người dùng, rồi commit file trong `.changeset/`. Vì version dùng chung, chỉ cần chọn gói thật sự đổi; các gói còn lại tự lên cùng version.
2. Push lên `main`: workflow Release mở (hoặc cập nhật) PR "chore(release): version packages" với version mới và `CHANGELOG.md` của từng gói.
3. Merge PR đó: workflow build, typecheck, test, đóng gói rồi publish lên npm qua OIDC, không cần token. npm tự gắn provenance vì repo public. Workflow cũng đẩy tag của từng gói.
4. `git pull`, rồi build và upload app desktop (mục dưới).

CI không chạy trên PR version vì PR đó do `GITHUB_TOKEN` tạo; PR này chỉ đổi version và changelog.

## App desktop

Build trên máy mình (cần Mac, Xcode 26), không build trên CI:

```bash
GH_TOKEN=<token> npm run desktop:release
```

Lệnh này build cả ba hệ điều hành như `desktop:package:all`, viết ghi chú từ `CHANGELOG.md` (`scripts/release-notes.mjs`), rồi upload lên một bản **nháp** GitHub Release `vX.Y.Z`. Chạy lại thì file cùng tên được ghi đè. Vào trang Releases kiểm tra rồi bấm Publish; lúc đó GitHub mới tạo tag `vX.Y.Z`.

`GH_TOKEN` là fine-grained personal access token của tài khoản `lhphuc99`: Repository access chỉ chọn `capybara`, Permissions → Contents: Read and write. Nếu đã cài GitHub CLI và đăng nhập thì dùng `GH_TOKEN=$(gh auth token)`.

## Lưu ý

- Trong tài liệu, website và lệnh MCP luôn ghi `npx capybara-devtools`, không bao giờ ghi `npx capybara`: gói `capybara` trên npm không phải của mình, nên ai publish tên đó thì `npx capybara` sẽ chạy code của người đó.
- npm không cho dùng lại một version đã từng publish, kể cả sau khi gỡ.
- npm hạn chế gỡ (unpublish) gói đã publish, nhất là sau 72 giờ hay khi đã có gói khác phụ thuộc. Lỡ phát hành bản lỗi thì publish bản sửa, và đánh dấu bản lỗi bằng `npm deprecate`.
- `npm run release` chỉ dùng cho lần đầu. Sau khi bật trusted publishing, mọi lần publish đi qua workflow.
