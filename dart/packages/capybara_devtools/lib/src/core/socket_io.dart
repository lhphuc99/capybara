import 'dart:async';
import 'dart:io';

import 'socket.dart';

/// dart:io's WebSocket, opened with an HttpClient made outside any HttpOverrides: Capybara's own capture of the
/// app's requests, and test bindings that fake HTTP, must not see this connection.
Future<CapybaraSocket> connectSocket(Uri url) async {
  final client = HttpOverrides.runWithHttpOverrides(() => HttpClient(), _Raw());
  try {
    final socket = await WebSocket.connect(url.toString(), customClient: client).timeout(const Duration(seconds: 3));
    return _IoSocket(socket);
  } on SocketException catch (error) {
    // The macOS sandbox refuses connections out of apps without this entitlement, and Flutter's template leaves it
    // out.
    if (Platform.isMacOS && error.osError?.errorCode == 1) {
      throw const CapybaraSetupError(
        'macOS keeps this app from connecting to Capybara. Add com.apple.security.network.client to '
        'macos/Runner/DebugProfile.entitlements (and Release.entitlements for builds with CAPYBARA_ENABLED).',
      );
    }
    rethrow;
  }
}

final class _Raw extends HttpOverrides {}

final class _IoSocket implements CapybaraSocket {
  _IoSocket(this._socket);

  final WebSocket _socket;

  @override
  Stream<String> get messages => _socket.where((data) => data is String).cast<String>();

  @override
  void send(String data) => _socket.add(data);

  @override
  Future<void> close() => _socket.close();
}
