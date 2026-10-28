import '../core/client.dart';
import 'http_stub.dart' if (dart.library.io) 'http_io.dart';
import 'recorder.dart';

/// Records requests through dart:io's `HttpClient`, and the clients and WebSockets the app wraps.
final class NetworkPlugin extends CapybaraPlugin {
  NetworkPlugin({this.ignoreUrls = const [], this.isCapybara});

  final List<Pattern> ignoreUrls;
  final bool Function(Uri url)? isCapybara;
  void Function()? _check;

  @override
  String get name => 'network';

  /// Puts Capybara's `HttpOverrides` back in front of ones the app set since.
  void check() => _check?.call();

  @override
  void Function()? setup(PluginContext context) {
    final recorder = NetworkRecorder(context.emit, ignoreUrls: ignoreUrls, isCapybara: isCapybara);
    activeRecorder = recorder;
    final overrides = installHttpOverrides();
    _check = overrides.check;
    return () {
      overrides.remove();
      _check = null;
      if (identical(activeRecorder, recorder)) activeRecorder = null;
    };
  }
}
