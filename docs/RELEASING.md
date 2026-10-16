# Phát hành Capybara

## Phát hành lên đâu

| Thứ phát hành | Nơi chứa | Người dùng cài bằng |
|---|---|---|
| 5 gói npm: `capybara-devtools` (CLI), `@capybara-devtools/web`, `@capybara-devtools/react-native`, `@capybara-devtools/core`, `@capybara-devtools/protocol` | registry npm | `npx capybara-devtools`, `npm`/`yarn`/`pnpm`/`bun add @capybara-devtools/web` |
| App desktop: `.dmg`, `.zip` (macOS arm64), `.exe`, `.zip` (Windows x64), `.AppImage`, `.tar.gz` (Linux x64, arm64) | GitHub Releases của `lhphuc99/capybara`, tag `vX.Y.Z` | tải trực tiếp hoặc qua website; Homebrew, winget, Scoop, AUR trỏ về các file này |

yarn, pnpm và bun đều tải từ registry npm, nên publish một lần lên npm là cài được bằng cả bốn.

Tên trên npm là `capybara-devtools`, vì scope `@capybara` đã thuộc về một tài khoản npm khác. Tên sản phẩm, lệnh `capybara` (sau khi cài global), biến môi trường `CAPYBARA_*`, global `__CAPYBARA_*__` và bundle ID `dev.capybara.*` vẫn giữ là Capybara.

Năm gói npm và app desktop dùng chung một số version (nhóm `fixed` trong `.changeset/config.json`). App desktop là package private, nên `scripts/sync-versions.mjs` chép version của CLI sang nó, đồng thời cập nhật `SDK_VERSION` trong hai SDK và `package-lock.json`.

## Trạng thái

- 0.1.0 đã lên npm ngày 16/10/2026, publish từ máy bằng tài khoản `phucle2303`, org `capybara-devtools`.
- Chưa dùng được trusted publishing: npm từ chối OIDC token của các repo GitHub tạo sau 15/7/2026, mà repo này tạo ngày 16/10/2026 ([npm/cli#9969](https://github.com/npm/cli/issues/9969), chưa sửa). Vì vậy job publish trong `release.yml` chỉ chạy khi biến repo `NPM_TRUSTED_PUBLISHING` là `true`. Trước lúc đó, mỗi lần phát hành đều publish từ máy.

## Mỗi lần phát hành

1. Với mỗi thay đổi cần phát hành: chạy `npx changeset`, chọn gói và mức tăng (patch, minor, major), viết mô tả cho người dùng, rồi commit file trong `.changeset/`. Vì version dùng chung, chỉ cần chọn gói thật sự đổi; các gói còn lại tự lên cùng version.
2. Push lên `main`: workflow Release mở (hoặc cập nhật) PR "chore(release): version packages" với version mới và `CHANGELOG.md` của từng gói. CI không chạy trên PR này vì nó do `GITHUB_TOKEN` tạo; PR chỉ đổi version và changelog.
3. Merge PR đó trên GitHub.
4. Publish từ máy:

   ```bash
   git pull
   npm run release      # build, rồi publish các gói theo thứ tự phụ thuộc; hỏi 2FA
   git push --tags      # tag của từng gói, như capybara-devtools@0.2.0
   ```

   Khi npm mở trang xác nhận 2FA, tick "skip 2FA for 5 minutes" để các gói sau không phải xác nhận lại. Lỗi giữa chừng thì chạy lại `npm run release`: changesets bỏ qua các version đã có trên npm.
5. Kiểm tra bằng `npm view capybara-devtools version`. Trang npm và registry đi qua CDN có thể hiện dữ liệu cũ vài phút.
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

## App desktop

Build trên máy mình (cần Mac, Xcode 26), không build trên CI. Push `main` trước, vì tag `vX.Y.Z` được tạo trên `main` của GitHub lúc publish bản nháp:

```bash
GH_TOKEN=<token> npm run desktop:release
```

Lệnh này build cả ba hệ điều hành như `desktop:package:all`, viết ghi chú từ `CHANGELOG.md` (`scripts/release-notes.mjs`), rồi upload lên một bản **nháp** GitHub Release `vX.Y.Z`. Chạy lại thì file cùng tên được ghi đè. Vào trang Releases kiểm tra rồi bấm Publish. Website lấy link tải từ release mới nhất này.

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
