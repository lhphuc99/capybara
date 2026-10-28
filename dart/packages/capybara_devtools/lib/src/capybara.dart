import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart' show FlutterVersion;
import 'package:web_socket_channel/web_socket_channel.dart';

import 'core/client.dart';
import 'core/serialize.dart';
import 'core/socket.dart';
import 'network/plugin.dart';
import 'network/recorder.dart';
import 'network/websocket.dart';
import 'state/plugin.dart';
import 'state/registry.dart';
import 'storage/storage.dart';
import 'platform_stub.dart' if (dart.library.io) 'platform_io.dart';
import 'version.dart';

/// Debug builds only, unless the app is built with `--dart-define=CAPYBARA_ENABLED=true` (a build for testers, say).
/// A constant, so release builds drop everything this package does.
const bool _enabled = kDebugMode || bool.fromEnvironment('CAPYBARA_ENABLED');

const String _definedHost = String.fromEnvironment('CAPYBARA_HOST');
const Symbol _zoneKey = #capybara;
const int _definedPort = int.fromEnvironment('CAPYBARA_PORT', defaultValue: 7357);

final class CapybaraOptions {
  const CapybaraOptions({
    this.appName,
    this.host,
    this.port,
    this.enabled = true,
    this.network = true,
    this.ignoreUrls = const [],
  });

  /// The app's name in Capybara. Defaults to its package name.
  final String? appName;

  /// Where Capybara runs, when the app cannot find it on its own: a phone on Wi‑Fi needs the computer's address.
  /// `--dart-define=CAPYBARA_HOST=…` sets it without changing code.
  final String? host;

  /// Capybara's port, 7357 unless it runs with `--port` (or `--dart-define=CAPYBARA_PORT=…`).
  final int? port;

  /// False turns the package off at run time.
  final bool enabled;

  /// Records requests made through dart:io's `HttpClient`: `package:http`'s default client, dio's default adapter,
  /// `Image.network`. False leaves only those of [CapybaraHttpClient] and [Capybara.webSocket].
  final bool network;

  /// Requests and WebSockets whose URL contains one of these strings, or matches one of these patterns, are not
  /// recorded.
  final List<Pattern> ignoreUrls;
}

/// Sends the app's logs and errors to Capybara, the local devtools for React Native, Flutter and web apps.
///
/// ```dart
/// void main() => Capybara.run(() {
///   runApp(const MyApp());
/// }, options: const CapybaraOptions(appName: 'Shop'));
/// ```
abstract final class Capybara {
  static CapybaraClient? _client;
  static NetworkPlugin? _network;
  static final StoragePlugin _storage = StoragePlugin();
  static final StatePlugin _state = StatePlugin();
  static CapybaraOptions _options = const CapybaraOptions();
  static List<String>? _connectHosts;
  static int? _connectPort;
  static bool _extensions = false;
  // Each handler Capybara installed, and the one it replaced, for stop to put back.
  static FlutterExceptionHandler? _flutterHandler;
  static FlutterExceptionHandler? _flutterReplaced;
  static bool Function(Object, StackTrace)? _platformHandler;
  static bool Function(Object, StackTrace)? _platformReplaced;
  static DebugPrintCallback? _debugPrint;
  static DebugPrintCallback? _debugPrintReplaced;
  static Timer? _watcher;
  static final Expando<bool> _reported = Expando('capybara.reported');
  static final Expando<bool> _reportedDetails = Expando('capybara.reportedDetails');
  static (Object, StackTrace?)? _lastReported;

  /// The client, while the package runs. For the packages that add state libraries to Capybara.
  static CapybaraClient? get client => _client;

  /// Replaces the WebSocket to Capybara in tests.
  @visibleForTesting
  static SocketConnector? connectForTesting;

  /// Runs [body], usually what calls `runApp`, in a zone that also sends what it prints, and its uncaught errors,
  /// to Capybara. In release builds it only runs [body]. Call `WidgetsFlutterBinding.ensureInitialized()` inside
  /// [body], not before: Flutter warns when the binding and `runApp` are in different zones.
  static void run(FutureOr<void> Function() body, {CapybaraOptions options = const CapybaraOptions()}) {
    if (!_enabled || !options.enabled || kIsWeb) {
      unawaited(Future.sync(body));
      return;
    }
    _start(options, StackTrace.current);
    runZoned(
      zoneValues: {_zoneKey: true},
      () {
        // Nothing waits on body's future, or its errors' async stacks would end in Capybara's code.
        unawaited(Future.sync(body));
        // The synchronous part of body has run: runApp may have set the binding up already.
        _wrapErrorHandlers();
        _network?.check();
      },
      zoneSpecification: ZoneSpecification(
        print: (self, parent, zone, line) {
          _logLine(line);
          parent.print(zone, line);
        },
        handleUncaughtError: (self, parent, zone, error, stack) {
          _reportUncaught(error, stack);
          parent.handleUncaughtError(zone, error, stack);
        },
      ),
    );
    _watchErrorHandlers();
  }

  /// Starts sending without a zone around the app: `debugPrint` output and errors are sent, but `print` is not.
  /// [run] sends both.
  static void init([CapybaraOptions options = const CapybaraOptions()]) {
    if (!_enabled || !options.enabled || kIsWeb) return;
    _start(options, StackTrace.current);
    // Inside run's zone, debugPrint output reaches Capybara as printed lines already.
    if (Zone.current[_zoneKey] != true && !identical(debugPrint, _debugPrint)) {
      final previous = debugPrint;
      void wrapper(String? message, {int? wrapWidth}) {
        if (message != null) _logLine(message);
        previous(message, wrapWidth: wrapWidth);
      }

      _debugPrint = wrapper;
      _debugPrintReplaced = previous;
      debugPrint = wrapper;
    }
    _wrapErrorHandlers();
    _watchErrorHandlers();
  }

  /// A log entry from the app's own logger, with structured [data] shown as a value in Capybara.
  static void log(String message, {String level = 'log', Object? data}) {
    if (!_enabled) return;
    _client?.log(_logLevel(level), [message, ?data]);
  }

  /// Records a WebSocket's messages, both ways, and how it closes. Wrap the channel where the app makes it, and use
  /// what this returns in its place:
  ///
  /// ```dart
  /// final channel = Capybara.webSocket(WebSocketChannel.connect(url), url: url);
  /// ```
  ///
  /// A WebSocket that is not wrapped shows only as its handshake request, when Capybara records requests.
  static WebSocketChannel webSocket(WebSocketChannel channel, {required Uri url}) {
    if (!_enabled) return channel;
    final recorder = activeRecorder;
    return recorder == null ? channel : trackWebSocket(channel, url, recorder);
  }

  /// Shows one of the app's stores in Capybara's Storage tab, where it can be edited:
  ///
  /// ```dart
  /// Capybara.addStorage(CapybaraSharedPreferences.legacy(await SharedPreferences.getInstance()));
  /// Capybara.addStorage(CapybaraSecureStorage(secureStorage));
  /// Capybara.addStorage(CapybaraHiveBox(await Hive.openBox('settings')));
  /// ```
  ///
  /// Call it before or after [run]; a store added again with the same id replaces the first.
  static void addStorage(CapybaraStorage storage) {
    if (!_enabled) return;
    _storage.add(storage);
  }

  /// Shows a `ValueNotifier`'s value, or a `ChangeNotifier`'s state, in Capybara's State tab, recorded each time it
  /// notifies. For a ChangeNotifier, [read] gives its state, as a map of its fields say; without one, the notifier's
  /// `toJson()` is used. The function returned stops watching.
  ///
  /// ```dart
  /// Capybara.watch('cart', cart, read: () => {'items': cart.items, 'total': cart.total});
  /// ```
  static void Function() watch(String name, Listenable listenable, {Object? Function()? read}) {
    if (!_enabled || kIsWeb) return () {};
    final reader = read ?? (listenable is ValueListenable ? () => listenable.value : () => _plain(listenable));
    final store = StateRegistry.instance.track(
      library: 'watch',
      label: name,
      via: 'subscribe',
      actions: false,
      read: reader,
    );
    void listener() {
      try {
        store.record(reader());
      } catch (_) {
        // Never throw into the app's notifier.
      }
    }

    listenable.addListener(listener);
    return () {
      listenable.removeListener(listener);
      store.dispose();
    };
  }

  // A notifier changes in place, so each record is a copy: the diff would see the same objects otherwise.
  static Object? _plain(Object value) {
    try {
      return jsonDecode(
        jsonEncode(
          value,
          toEncodable: (object) {
            try {
              return (object as dynamic).toJson();
            } catch (_) {
              return '$object';
            }
          },
        ),
      );
    } catch (_) {
      return '$value';
    }
  }

  /// Stops sending, and puts back the handlers Capybara set unless others were set over them since.
  static Future<void> stop() async {
    final client = _client;
    _client = null;
    _network = null;
    _watcher?.cancel();
    _watcher = null;
    if (_flutterHandler != null && identical(FlutterError.onError, _flutterHandler)) {
      FlutterError.onError = _flutterReplaced;
    }
    final dispatcher = PlatformDispatcher.instance;
    if (_platformHandler != null && identical(dispatcher.onError, _platformHandler)) {
      dispatcher.onError = _platformReplaced;
    }
    final replacedPrint = _debugPrintReplaced;
    if (replacedPrint != null && identical(debugPrint, _debugPrint)) debugPrint = replacedPrint;
    _flutterHandler = _flutterReplaced = _platformHandler = _platformReplaced = null;
    _debugPrint = _debugPrintReplaced = null;
    await client?.stop();
  }

  static CapybaraClient _start(CapybaraOptions options, StackTrace caller) {
    final running = _client;
    // Started already, by an earlier run or init: the session goes on.
    if (running != null) return running;
    _options = options;
    final network = options.network ? NetworkPlugin(ignoreUrls: options.ignoreUrls, isCapybara: _isCapybara) : null;
    _network = network;
    final client = Zone.root.run(
      () => CapybaraClient(
        session: _sessionInfo(options, caller),
        targets: _targets,
        plugins: [?network, _storage, _state],
        connect: connectForTesting ?? HostInfo.connect,
        diagnostic: (message) => Zone.root.print('[capybara] $message'),
      ),
    );
    _client = client;
    _registerExtensions();
    // Android's device details take a moment to read; events wait in the buffer meanwhile.
    Zone.root.run(
      () => unawaited(
        HostInfo.device()
            .timeout(const Duration(seconds: 2))
            .then((device) => device, onError: (Object _) => const <String, Object?>{})
            .then((device) {
              if (device.isNotEmpty) client.session['device'] = device;
              client.start();
            }),
      ),
    );
    return client;
  }

  static List<Uri> _targets() {
    final port = _connectPort ?? _options.port ?? _definedPort;
    final hosts =
        _connectHosts ??
        (_definedHost.isNotEmpty
            ? [_definedHost]
            : _options.host != null
            ? [_options.host!]
            // The Android emulator reaches the computer at 10.0.2.2; devices on USB through `adb reverse`, which
            // Capybara runs for them, at 127.0.0.1 like simulators and desktop apps.
            : ['127.0.0.1', if (defaultTargetPlatform == TargetPlatform.android) '10.0.2.2']);
    return [for (final host in hosts) Uri(scheme: 'ws', host: host, port: port, path: '/client')];
  }

  static Map<String, Object?> _sessionInfo(CapybaraOptions options, StackTrace caller) {
    final package = _appPackage(caller);
    final dart = FlutterVersion.dartVersion ?? HostInfo.dartVersion;
    return {
      'appName': options.appName ?? package ?? 'Flutter app',
      'platform': switch (defaultTargetPlatform) {
        TargetPlatform.iOS => 'ios',
        TargetPlatform.android => 'android',
        TargetPlatform.macOS => 'macos',
        TargetPlatform.windows => 'windows',
        TargetPlatform.linux => 'linux',
        TargetPlatform.fuchsia => 'unknown',
      },
      'sdk': {'name': 'capybara_devtools', 'version': capybaraVersion},
      'runtime': [
        if (FlutterVersion.version != null) 'Flutter ${FlutterVersion.version}',
        if (dart != null) 'Dart ${dart.split(' ').first}',
      ].join(' · '),
      if (package != null)
        'dartPackages': {
          'app': [package],
        },
    };
  }

  /// The package of the code that started Capybara, from the first frame that is neither this package's nor the
  /// SDK's. Code outside `lib/`, as tests are, has none.
  static String? _appPackage(StackTrace caller) {
    for (final line in caller.toString().split('\n')) {
      if (line.contains('package:capybara_devtools/') || line.contains('(dart:')) continue;
      final name = RegExp(r'\(package:([A-Za-z_]\w*)/').firstMatch(line)?.group(1);
      if (name == 'flutter') continue;
      if (name != null || line.contains('(file:') || line.contains('(org-dartlang')) return name;
    }
    return null;
  }

  // Lets a debugger find out whether the app runs this package, and tell it where Capybara is: the Dart VM service
  // bridge of Capybara leaves such apps alone, and gives phones the computer's address.
  static void _registerExtensions() {
    if (_extensions) return;
    _extensions = true;
    try {
      developer.registerExtension('ext.capybara.status', (method, params) async {
        final client = _client;
        return developer.ServiceExtensionResponse.result(
          jsonEncode({
            'version': capybaraVersion,
            'connected': client?.connected ?? false,
            'target': client?.target?.toString(),
            'session': client?.session['id'],
          }),
        );
      });
      developer.registerExtension('ext.capybara.connect', (method, params) async {
        final host = params['host'] ?? '';
        final port = int.tryParse(params['port'] ?? '') ?? _options.port ?? _definedPort;
        if (!_isHost(host) || port < 1 || port > 65535) {
          return developer.ServiceExtensionResponse.error(
            developer.ServiceExtensionResponse.invalidParams,
            'Give host as an IP address or host name, and port from 1 to 65535',
          );
        }
        _connectHosts = [host];
        _connectPort = port;
        _client?.retarget(_targets);
        return developer.ServiceExtensionResponse.result(jsonEncode({'target': _targets().first.toString()}));
      });
    } catch (_) {
      // Registered already by an earlier isolate run of this code.
    }
  }

  // Capybara's own socket goes around the overrides; this keeps it out should another client reach it.
  static bool _isCapybara(Uri url) =>
      url.path == '/client' && _targets().any((target) => target.host == url.host && target.port == url.port);

  static bool _isHost(String host) =>
      RegExp(r'^[A-Za-z0-9.-]{1,253}$').hasMatch(host) || RegExp(r'^[0-9A-Fa-f:]{2,39}$').hasMatch(host);

  static void _logLine(String line) {
    _client?.emit('log', {
      'level': 'log',
      'source': 'console',
      'args': [line],
    });
  }

  static String _logLevel(String level) =>
      const {'debug', 'log', 'info', 'warn', 'error'}.contains(level) ? level : (level == 'warning' ? 'warn' : 'log');

  // FlutterError.onError starts as presentError, read when first used: read before the binding exists, it holds
  // dumpErrorToConsole, and the errors DevTools and IDEs show as Flutter.Error would only be printed. So when the
  // handler found is a default one, errors go to presentError as it is when they happen.
  static void _wrapErrorHandlers() {
    final current = FlutterError.onError;
    if (current == null || !identical(current, _flutterHandler)) {
      final asDefault =
          current == null ||
          identical(current, FlutterError.dumpErrorToConsole) ||
          identical(current, FlutterError.presentError);
      void handler(FlutterErrorDetails details) {
        _reportFlutterError(details);
        if (asDefault) {
          FlutterError.presentError(details);
        } else {
          current(details);
        }
      }

      _flutterHandler = handler;
      _flutterReplaced = current;
      FlutterError.onError = handler;
    }
    final dispatcher = PlatformDispatcher.instance;
    final previous = dispatcher.onError;
    if (previous == null || !identical(previous, _platformHandler)) {
      bool handler(Object error, StackTrace stack) {
        _reportUncaught(error, stack);
        return previous?.call(error, stack) ?? false;
      }

      _platformHandler = handler;
      _platformReplaced = previous;
      dispatcher.onError = handler;
    }
  }

  /// Crash reporters set their handlers once the app has started, often after awaiting their setup; Capybara's go
  /// back in front of them.
  static void _watchErrorHandlers() {
    _watcher?.cancel();
    var checks = 0;
    _watcher = Zone.root.run(
      () => Timer.periodic(const Duration(seconds: 1), (timer) {
        if (_client == null || ++checks > 30) {
          timer.cancel();
          return;
        }
        _wrapErrorHandlers();
        _network?.check();
      }),
    );
  }

  static void _reportFlutterError(FlutterErrorDetails details) {
    try {
      final client = _client;
      // A handler set over Capybara's may pass the error on to an earlier one of Capybara's.
      if (client == null || _reportedDetails[details] == true) return;
      _reportedDetails[details] = true;
      _markReported(details.exception, details.stack);
      final error = serializeError(details.exception, details.stack);
      final context = details.context?.toDescription();
      // The transformers turn the element that failed into the widget the app created, with where it did.
      var nodes = details.informationCollector?.call() ?? const <DiagnosticsNode>[];
      for (final transform in FlutterErrorDetails.propertiesTransformers) {
        nodes = transform(nodes);
      }
      String? widget;
      final information = <String>[];
      for (final node in nodes.take(20)) {
        if (node.name == 'The relevant error-causing widget was') {
          widget ??= node.getChildren().firstOrNull?.toDescription();
        } else {
          final text = node.toString().trim();
          if (text.isNotEmpty) information.add(text);
        }
      }
      final informationText = information.join('\n');
      error['props'] = {
        if (details.library != null) 'library': 'Exception caught by ${details.library}',
        if (context != null && context.isNotEmpty) 'context': 'The following ${error['name']} was thrown $context',
        'widget': ?widget,
        if (informationText.isNotEmpty)
          'information': informationText.length > 4000 ? '${informationText.substring(0, 4000)}…' : informationText,
      };
      client.emit('log', {
        'level': details.silent ? 'warn' : 'error',
        'source': 'uncaught',
        'args': [error],
      });
    } catch (_) {
      // Never throw into the app.
    }
  }

  static void _reportUncaught(Object error, StackTrace stack) {
    try {
      final client = _client;
      if (client == null || _wasReported(error, stack)) return;
      _markReported(error, stack);
      client.emit('log', {
        'level': 'error',
        'source': 'uncaught',
        'args': [serializeError(error, stack)],
      });
    } catch (_) {
      // Never throw into the app.
    }
  }

  // The zone and PlatformDispatcher.onError may both see one error.
  static void _markReported(Object error, StackTrace? stack) {
    _lastReported = (error, stack);
    try {
      _reported[error] = true;
    } catch (_) {
      // Strings, numbers and null cannot carry an Expando.
    }
  }

  static bool _wasReported(Object error, StackTrace stack) {
    try {
      if (_reported[error] == true) return true;
    } catch (_) {
      // as above
    }
    final last = _lastReported;
    return last != null && identical(last.$1, error) && identical(last.$2, stack);
  }
}
