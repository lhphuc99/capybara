# Phát hành Capybara

## Phát hành lên đâu

| Thứ phát hành | Nơi chứa | Người dùng cài bằng |
|---|---|---|
| 5 gói npm: `capybara-devtools` (CLI), `@capybara-devtools/web`, `@capybara-devtools/react-native`, `@capybara-devtools/core`, `@capybara-devtools/protocol` | registry npm | `npx capybara-devtools`, `npm`/`yarn`/`pnpm`/`bun add @capybara-devtools/web` |
| 3 gói Dart: `capybara_devtools`, `capybara_devtools_riverpod`, `capybara_devtools_bloc` | pub.dev, publisher `lhphuc.com` | `flutter pub add capybara_devtools` |
| App desktop: `.dmg`, `.zip` (macOS arm64), `.exe`, `.zip` (Windows x64), `.AppImage`, `.tar.gz` (Linux x64, arm64) | GitHub Releases của `lhphuc99/capybara`, tag `vX.Y.Z` | tải trực tiếp hoặc qua website; Homebrew, winget, Scoop, AUR trỏ về các file này |

yarn, pnpm và bun đều tải từ registry npm, nên publish một lần lên npm là cài được bằng cả bốn.

Tên trên npm là `capybara-devtools`, vì scope `@capybara` đã thuộc về một tài khoản npm khác. Tên sản phẩm, lệnh `capybara` (sau khi cài global), biến môi trường `CAPYBARA_*`, global `__CAPYBARA_*__` và bundle ID `dev.capybara.*` vẫn giữ là Capybara.

Năm gói npm, UI và app desktop dùng chung một số version (nhóm `fixed` trong `.changeset/config.json`). `privatePackages.version` cho changesets nâng version và viết `CHANGELOG.md` cho cả hai package private; thiếu changelog thì bước mở PR version của changesets/action dừng lỗi. Các app mẫu nằm trong `ignore` và lấy SDK của workspace qua `"*"`. Sau `changeset version`, `scripts/sync-versions.mjs` cập nhật `SDK_VERSION` trong hai SDK và `package-lock.json`.

## Trạng thái

- 0.1.0 đã lên npm ngày 16/10/2026, publish từ máy bằng tài khoản `phucle2303`, org `capybara-devtools`.
- Chưa dùng được trusted publishing: npm từ chối OIDC token của các repo GitHub tạo sau 15/7/2026, mà repo này tạo ngày 16/10/2026 ([npm/cli#9969](https://github.com/npm/cli/issues/9969), chưa sửa). Vì vậy job publish trong `release.yml` chỉ chạy khi biến repo `NPM_TRUSTED_PUBLISHING` là `true`. Trước lúc đó, mỗi lần phát hành đều publish từ máy.

## Mỗi lần phát hành

1. Với mỗi thay đổi cần phát hành: chạy `npx changeset`, chọn gói và mức tăng (patch, minor, major), viết mô tả cho người dùng, rồi commit file trong `.changeset/`. Vì version dùng chung, chỉ cần chọn gói thật sự đổi; các gói còn lại tự lên cùng version. Thay đổi chỉ ở app desktop thì chọn `@capybara-devtools/desktop`.
2. Push lên `main`: workflow Release mở (hoặc cập nhật) PR "chore(release): version packages" với version mới và `CHANGELOG.md` của từng gói. CI không chạy trên PR này vì nó do `GITHUB_TOKEN` tạo; PR chỉ đổi version và changelog.
3. Merge PR đó trên GitHub.
4. Publish từ máy:

   ```bash
   git pull
   npm run release      # build, publish các gói theo thứ tự phụ thuộc (hỏi 2FA), rồi đẩy tag của từng gói
   ```

   Khi npm mở trang xác nhận 2FA, tick "skip 2FA for 5 minutes" để các gói sau không phải xác nhận lại. Lỗi giữa chừng thì chạy lại `npm run release`: changesets bỏ qua các version đã có trên npm.
5. Kiểm tra từng gói bằng `npm view <gói>@<version> version`. Kể cả khi `npm run release` báo thành công, npm có thể cần tới khoảng 5 phút mới cho cài một version. Trong lúc đó, publish lại sẽ bị `409 Cannot publish over previously staged version`. Lần 0.2.0, `@capybara-devtools/core` hiện ra sau 5 phút. Vì vậy hãy đợi khoảng 10 phút rồi mới coi là lỗi và nâng version. Trang npm và registry đi qua CDN còn có thể hiện dữ liệu cũ thêm vài phút.
6. Build và upload app desktop (mục dưới).

## Khi npm sửa lỗi OIDC

1. Với từng gói trong 5 gói, ngay trước một lần phát hành (cấu hình mới hết hạn nếu không có lần publish thành công trong 48 giờ):

   ```bash
   npx npm@11 trust github <tên gói> --repo lhphuc99/capybara --file release.yml --allow-publish
   ```

   Phải có `--allow-publish`: cấu hình tạo sau 3/9/2026 mặc định chỉ cho `npm stage publish`, mà changesets publish trực tiếp. `npm trust` không chạy theo workspace, nên chạy lần lượt từng gói.
2. Đặt biến `NPM_TRUSTED_PUBLISHING` = `true` trong Settings → Secrets and variables → Actions → Variables của repo.
3. Từ đó, merge PR version là workflow tự build, test và publish, npm tự gắn provenance (repo public), workflow đẩy tag của từng gói. Bỏ bước 4 ở trên.
4. Tuỳ chọn: trong Settings của từng gói trên npmjs.com, bật Publishing access → "Require two-factor authentication and disallow tokens".

## Gói Dart trên pub.dev

Ba gói trong `dart/packages`: `capybara_devtools`, `capybara_devtools_riverpod`, `capybara_devtools_bloc`. Version của chúng riêng, không theo nhóm npm (version ở `pubspec.yaml`, với gói lõi còn ở `lib/src/version.dart`, test kiểm hai chỗ khớp nhau). UI chỉ so version của gói Dart với pub.dev, không với version server.

### Lần đầu (người dùng làm)

1. Publisher đã xác minh `lhphuc.com`: pub.dev → Create publisher, thêm bản ghi DNS TXT Google đưa ra.
2. Publish tay từng gói, gói lõi trước vì hai gói kia phụ thuộc nó, từ máy, đăng nhập bằng tài khoản Google:

   ```bash
   cd dart/packages/capybara_devtools && fvm flutter pub publish
   cd ../capybara_devtools_riverpod && fvm flutter pub publish
   cd ../capybara_devtools_bloc && fvm flutter pub publish
   ```

3. Trên trang Admin của từng gói: chuyển sang publisher `lhphuc.com`; bật "Automated publishing" từ GitHub Actions, repo `lhphuc99/capybara`, tag pattern `<tên gói>-v{{version}}` (vd `capybara_devtools-v{{version}}`), bắt buộc environment `pub.dev`.
4. Trên GitHub: tạo environment `pub.dev` (Settings → Environments) với required reviewers, và ruleset chỉ cho người duyệt tạo tag `capybara_devtools*`.

### Mỗi lần phát hành

1. Nâng `version` trong `pubspec.yaml` (gói lõi: cả `lib/src/version.dart`), thêm mục vào `CHANGELOG.md` của gói, merge vào `main` qua PR.
2. Tạo và đẩy tag trên commit đó, một tag cho mỗi gói:

   ```bash
   git tag capybara_devtools-v0.2.0 && git push origin refs/tags/capybara_devtools-v0.2.0
   ```

3. Workflow `publish-pub.yml` chờ duyệt ở environment `pub.dev`, kiểm tag khớp `pubspec.yaml`, chạy test rồi `flutter pub publish --force`.

`npm run release` chỉ đẩy tag `tên@version` của npm (`scripts/push-release-tags.mjs`), không đẩy tag của gói Dart, để không vô tình publish lên pub.dev.

## App desktop

Build trên máy mình (cần Mac, Xcode 26), không build trên CI. Push `main` trước, vì tag `vX.Y.Z` được tạo trên `main` của GitHub lúc publish bản nháp:

```bash
GH_TOKEN=<token> npm run desktop:release
```

Lệnh này build cả ba hệ điều hành như `desktop:package:all`, viết ghi chú từ `CHANGELOG.md` (`scripts/release-notes.mjs`), rồi upload lên một bản **nháp** GitHub Release `vX.Y.Z`. Chạy lại thì file cùng tên được ghi đè. Vào trang Releases kiểm tra rồi bấm Publish. Website lấy link tải từ release mới nhất này.

Ngoài bản cài, release còn có các file `latest.yml`, `latest-mac.yml`, `latest-linux.yml`, `latest-linux-arm64.yml` và `.blockmap`: app desktop đọc chúng để tự cập nhật, nên đừng xoá. Từ 0.2.0, app đã cài sẽ thấy release mới khi bản nháp được Publish (không thấy bản nháp). Bản 0.1.0 không có phần tự cập nhật, nên người dùng 0.1.0 phải tải bản mới bằng tay một lần.

`GH_TOKEN` là fine-grained personal access token của tài khoản `lhphuc99`: Repository access chỉ chọn `capybara`, Permissions → Contents: Read and write. Nếu đã cài GitHub CLI và đăng nhập thì dùng `GH_TOKEN=$(gh auth token)`.

## Đưa app desktop lên package manager

Mỗi kênh cần tài khoản hoặc repo riêng, và đều trỏ về file trên GitHub Releases. Tra cứu ngày 16/10/2026:

- **Homebrew (macOS)**: làm tap riêng, tức repo `lhphuc99/homebrew-tap` có file `Casks/capybara.rb` (kèm `depends_on arch: :arm64`). Người dùng cài bằng `brew install --cask lhphuc99/tap/capybara`. Homebrew 6 luôn gắn quarantine, nên lần mở đầu vẫn phải vào System Settings → Privacy & Security → Open Anyway như khi tải trực tiếp. Kho chính `homebrew/cask` chỉ nhận app đã ký và notarize bằng Apple Developer ID (99 USD/năm). Repo cũng phải đủ nổi: chủ repo tự nộp thì cần 90 fork, 90 watcher hoặc 225 sao, và repo dưới 30 ngày tuổi thường bị từ chối.
- **winget (Windows)**: không bắt buộc ký. Gửi manifest cho file `.exe` (InstallerType `nullsoft`) vào `microsoft/winget-pkgs` bằng [Komac](https://github.com/russellbanks/Komac) (chạy được trên Mac) hoặc `wingetcreate`. Bản đầu nộp tay; các bản sau tự động được bằng winget-releaser. Người dùng vẫn thấy cảnh báo SmartScreen.
- **Scoop (Windows)**: tạo bucket riêng từ [BucketTemplate](https://github.com/ScoopInstaller/BucketTemplate), dùng file `.zip` x64. Bucket Extras cần từ 100 sao hoặc 50 fork.
- **AUR (Arch Linux)**: gói `capybara-bin`, PKGBUILD lấy file `.tar.gz` (x86_64, aarch64). Cần tài khoản AUR và SSH key. Ít việc nhất.
- **Snap, Flathub**: để sau. Snap cần tài khoản Snapcraft và target `snapcraft` của electron-builder. Flathub bắt build từ source và có quy định riêng về code do AI viết.

## Lưu ý

- Trong tài liệu, website và lệnh MCP luôn ghi `npx capybara-devtools`, không bao giờ ghi `npx capybara`: gói `capybara` trên npm không phải của mình, nên ai publish tên đó thì `npx capybara` sẽ chạy code của người đó.
- npm không cho dùng lại một version đã từng publish, kể cả sau khi gỡ.
- npm hạn chế gỡ (unpublish) gói đã publish, nhất là sau 72 giờ hay khi đã có gói khác phụ thuộc. Lỡ phát hành bản lỗi thì publish bản sửa, và đánh dấu bản lỗi bằng `npm deprecate`.
- Khi publish một gói mới, npm tạo thêm version `0.0.0-stage` làm chỗ giữ tên. Version này vô hại: tag `latest` vẫn trỏ vào bản thật.
- Publish từ máy thì không có provenance; provenance chỉ có khi publish qua trusted publishing.
