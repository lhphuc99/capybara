import 'core/socket.dart';
import 'core/socket_stub.dart' as stub;

/// Without dart:io, as on the web: nothing to tell.
final class HostInfo {
  static String? get dartVersion => null;

  static SocketConnector get connect => stub.connectSocket;

  static Future<Map<String, Object?>> device() async => const {};
}
