import 'dart:io';

import 'core/socket.dart';
import 'core/socket_io.dart' as io;

/// What dart:io tells about where the app runs.
final class HostInfo {
  /// "3.13.7" of "3.13.7 (stable) (Thu Oct 22 …) on "ios_arm64"".
  static String? get dartVersion => Platform.version.split(' ').first;

  static SocketConnector get connect => io.connectSocket;

  /// The device as the session shows it, in the words the React Native package uses.
  static Future<Map<String, Object?>> device() async {
    final version = RegExp(r'Version (\S+)').firstMatch(Platform.operatingSystemVersion)?.group(1);
    if (Platform.isIOS) {
      return {
        if (version != null) 'osVersion': 'iOS $version',
        // iOS keeps the environment from Dart, so the simulator is told by where it installs apps.
        if (Platform.resolvedExecutable.contains('/CoreSimulator/Devices/')) 'isEmulator': true,
      };
    }
    if (Platform.isMacOS) return {if (version != null) 'osVersion': 'macOS $version'};
    if (Platform.isAndroid) return _android();
    return {'osVersion': Platform.operatingSystemVersion.split(' #').first};
  }

  // dart:io gives Android's kernel, not its version or model; the system properties have both, and apps may
  // read them with getprop.
  static Future<Map<String, Object?>> _android() async {
    final result = await Process.run('getprop', const []);
    final props = {
      for (final match in RegExp(r'^\[([^\]]+)\]: \[(.*)\]$', multiLine: true).allMatches('${result.stdout}'))
        match.group(1)!: match.group(2)!,
    };
    final model = [props['ro.product.manufacturer'], props['ro.product.model']].nonNulls.join(' ');
    final release = props['ro.build.version.release'];
    return {
      if (model.isNotEmpty) 'model': model,
      if (release != null) 'osVersion': 'Android $release',
      if (RegExp('generic|emulator|sdk_gphone', caseSensitive: false).hasMatch(props['ro.build.fingerprint'] ?? ''))
        'isEmulator': true,
    };
  }
}
