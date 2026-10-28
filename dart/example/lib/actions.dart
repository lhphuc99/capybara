import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;
import 'dart:io';
import 'dart:math';

import 'package:capybara_devtools/capybara_devtools.dart';
import 'package:cupertino_http/cupertino_http.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:hive_ce_flutter/hive_flutter.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'state.dart';

/// tool/mock_server.mjs on this computer. The Android emulator reaches the computer's loopback at 10.0.2.2; a phone on
/// USB reaches it at 127.0.0.1 after `adb reverse tcp:4100 tcp:4100`, with `--dart-define=MOCK_HOST=127.0.0.1`.
const String _definedMockHost = String.fromEnvironment('MOCK_HOST');
final String mockHost = _definedMockHost.isNotEmpty
    ? _definedMockHost
    : Platform.isAndroid
    ? '10.0.2.2'
    : '127.0.0.1';
const int mockPort = 4100;

Uri mockUri(String path) => Uri.parse('http://$mockHost:$mockPort$path');

/// What the home screen renders instead of its content: `build` throws, `assert` fails an assert,
/// `overflow` lays out a row too wide for the screen. Each is undone after one frame.
final ValueNotifier<String?> breakage = ValueNotifier(null);

/// The last thing an action did, shown under the buttons.
final ValueNotifier<String> status = ValueNotifier('Ready');

typedef Action = Future<void> Function();

const httpClients = ['dio', 'http', 'io', 'cupertino'];
const httpRequests = ['get10k', 'get1m', 'post', 'multipart', '404', 'offline', 'timeout'];

/// Every button of the screen by id, so tool/drive.mjs can press them through `ext.example.run`.
final Map<String, Action> actions = {
  'log.print': () async => print('Hello from print at ${DateTime.now().toIso8601String()}'),
  'log.debugPrint': () async => debugPrint('Hello from debugPrint, with a map: ${{'cart': 3, 'total': 42.5}}'),
  'log.developer': () async => developer.log(
    'A long message from developer.log: ${'abcdefghij' * 50}',
    name: 'example.checkout',
    level: 900,
    error: StateError('Payment declined'),
    stackTrace: StackTrace.current,
  ),
  'log.capybara': () async => Capybara.log(
    'Cart saved',
    level: 'info',
    data: {
      'items': [
        {'sku': 'CAPY-1', 'qty': 2},
      ],
      'total': 42.5,
      'savedAt': DateTime.now(),
    },
  ),
  'log.burst': () async {
    for (var i = 1; i <= 1000; i++) {
      print('burst $i/1000');
    }
  },
  'error.build': () => _break('build'),
  'error.assert': () => _break('assert'),
  'error.overflow': () => _break('overflow'),
  'error.async': () async {
    // Nobody awaits this future, so its error reaches the zone and PlatformDispatcher.onError.
    unawaited(Future<void>(() => throw StateError('Async failure nobody awaited')));
  },
  for (final client in httpClients)
    for (final request in httpRequests) 'http.$client.$request': () => _request(client, request),
  'http.images': _loadImages,
  'ws.echo': _webSocketEcho,
  'state.counter': () async {
    providers.read(counterProvider.notifier).increment();
    await providers.read(cartTotalProvider.future);
  },
  'state.cart': () async {
    cart.add(ItemAdded('CAPY-${_random.nextInt(3)}', 1 + _random.nextInt(2)));
  },
  'state.clear': () async => cart.add(CartCleared()),
  'state.theme': () async => theme.toggle(),
  'state.settings': () async => settings.change(),
  'storage.prefs': _writePreferences,
  'storage.secure': () =>
      const FlutterSecureStorage().write(key: 'authToken', value: 'secret-${_random.nextInt(1 << 32)}'),
  'storage.hive': () async {
    final box = Hive.box<Object>('settings');
    await box.put('locale', 'vi');
    await box.put('opened', ((box.get('opened') as int?) ?? 0) + 1);
    await box.put('profile', {
      'name': 'Capy',
      'tags': ['yuzu', 'onsen'],
    });
  },
};

/// Lets a debugger press the buttons: `ext.example.run` with `{action: id}` runs one, `ext.example.actions` lists them.
void registerExampleExtensions() {
  if (!kDebugMode) return;
  developer.registerExtension('ext.example.actions', (method, params) async {
    return developer.ServiceExtensionResponse.result(jsonEncode({'actions': actions.keys.toList()}));
  });
  developer.registerExtension('ext.example.run', (method, params) async {
    final id = params['action'];
    final action = actions[id];
    if (action == null) {
      return developer.ServiceExtensionResponse.error(
        developer.ServiceExtensionResponse.invalidParams,
        'No action "$id"',
      );
    }
    return developer.ServiceExtensionResponse.result(jsonEncode(await run(id!, action)));
  });
}

/// Runs an action as the button does, reporting how it went instead of throwing.
Future<Map<String, Object?>> run(String id, Action action) async {
  try {
    await action();
    status.value = '$id: done';
    return {'action': id, 'ok': true};
  } catch (error) {
    status.value = '$id: $error';
    return {'action': id, 'ok': false, 'error': '$error'};
  }
}

final _random = Random();

Future<void> _break(String how) async {
  breakage.value = how;
  await WidgetsBinding.instance.endOfFrame;
  breakage.value = null;
}

String _jsonBody(int size) {
  final items = [
    for (var i = 0; size > 0; i++, size -= 64)
      {
        'id': i,
        'name': 'Item $i',
        'tags': ['a', 'b'],
      },
  ];
  return jsonEncode({'items': items});
}

List<int> _photo() => List<int>.generate(64 * 1024, (i) => i % 251);

Future<void> _request(String client, String request) async {
  final path = switch (request) {
    'get10k' => '/json?size=10240',
    'get1m' => '/json?size=1048576',
    'post' => '/echo',
    'multipart' => '/upload',
    '404' => '/status/404',
    'timeout' => '/slow?ms=3000',
    _ => '/',
  };
  // Port 9 has nothing listening, so the request fails without reaching any server.
  final uri = request == 'offline' ? Uri.parse('http://$mockHost:9/') : mockUri(path);
  const timeout = Duration(seconds: 1);
  switch (client) {
    case 'dio':
      final dio = Dio(BaseOptions(receiveTimeout: request == 'timeout' ? timeout : null, validateStatus: (_) => true));
      final response = switch (request) {
        'post' => await dio.postUri<Object?>(
          uri,
          data: _jsonBody(10240),
          options: Options(contentType: 'application/json'),
        ),
        'multipart' => await dio.postUri<Object?>(
          uri,
          data: FormData.fromMap({'note': 'hello', 'photo': MultipartFile.fromBytes(_photo(), filename: 'photo.bin')}),
        ),
        _ => await dio.getUri<Object?>(uri),
      };
      print('dio $request: ${response.statusCode}');
    case 'http' || 'cupertino':
      final http.Client httpClient = client == 'http'
          ? http.Client()
          : Platform.isIOS || Platform.isMacOS
          // Outside dart:io, so the package sees its requests only through CapybaraHttpClient.
          ? CapybaraHttpClient(CupertinoClient.defaultSessionConfiguration())
          : throw UnsupportedError('cupertino_http runs on iOS and macOS only');
      try {
        final http.BaseResponse response = switch (request) {
          'post' => await httpClient.post(uri, headers: {'content-type': 'application/json'}, body: _jsonBody(10240)),
          'multipart' => await http.Response.fromStream(
            await httpClient.send(
              http.MultipartRequest('POST', uri)
                ..fields['note'] = 'hello'
                ..files.add(http.MultipartFile.fromBytes('photo', _photo(), filename: 'photo.bin')),
            ),
          ),
          'timeout' => await httpClient.get(uri).timeout(timeout),
          _ => await httpClient.get(uri),
        };
        print('$client $request: ${response.statusCode}');
      } finally {
        httpClient.close();
      }
    case 'io':
      final ioClient = HttpClient();
      try {
        final HttpClientRequest ioRequest;
        if (request == 'post') {
          ioRequest = await ioClient.postUrl(uri);
          ioRequest.headers.contentType = ContentType.json;
          ioRequest.write(_jsonBody(10240));
        } else if (request == 'multipart') {
          ioRequest = await ioClient.postUrl(uri);
          ioRequest.headers.contentType = ContentType('application', 'octet-stream');
          ioRequest.add(_photo());
        } else {
          ioRequest = await ioClient.getUrl(uri);
        }
        final response = await ioRequest.close().timeout(timeout * (request == 'timeout' ? 1 : 30));
        final bytes = await response.fold<int>(0, (count, chunk) => count + chunk.length);
        print('io $request: ${response.statusCode}, $bytes bytes');
      } finally {
        ioClient.close(force: true);
      }
  }
}

Future<void> _loadImages() async {
  // NetworkImage keeps decoded images in a cache, so each run asks for new URLs.
  final run = _random.nextInt(1 << 32);
  await Future.wait([
    for (var i = 0; i < 20; i++)
      () {
        final done = Completer<void>();
        NetworkImage(mockUri('/image?run=$run&i=$i').toString())
            .resolve(ImageConfiguration.empty)
            .addListener(
              ImageStreamListener((_, _) => done.complete(), onError: (error, _) => done.completeError(error)),
            );
        return done.future;
      }(),
  ]);
}

Future<void> _webSocketEcho() async {
  final url = Uri.parse('ws://$mockHost:$mockPort/ws');
  final channel = Capybara.webSocket(WebSocketChannel.connect(url), url: url);
  await channel.ready;
  final replies = channel.stream.take(2).toList();
  channel.sink.add(jsonEncode({'type': 'hello', 'cart': 3}));
  channel.sink.add([1, 2, 3, 4]);
  print('ws: ${(await replies.timeout(const Duration(seconds: 5))).length} replies');
  await channel.sink.close(1000, 'done');
}

Future<void> _writePreferences() async {
  final prefs = await SharedPreferences.getInstance();
  await prefs.setString('user', jsonEncode({'id': 7, 'name': 'Capy'}));
  await prefs.setInt('launches', (prefs.getInt('launches') ?? 0) + 1);
  await prefs.setDouble('volume', 0.8);
  await prefs.setBool('onboarded', true);
  await prefs.setStringList('recent', ['yuzu', 'onsen']);
  await SharedPreferencesAsync().setString('theme', 'dark');
}
